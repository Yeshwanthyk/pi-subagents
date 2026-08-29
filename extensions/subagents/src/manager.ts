/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Stream,
} from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentClient,
  SubagentMeta,
  CompletedOperation,
  SubagentResultDelivery,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
  ParentRef,
  WorkflowOwnership,
  SubagentFailureKind,
} from "./domain.ts";
import {
  failureKindFromProvenance,
  BackendUnavailableError,
  SendError,
  SpawnError,
  WorkflowObservationLimitError,
  WorkflowOwnershipError,
} from "./domain.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;
const FALLBACK_PARENT_REF: ParentRef = { epoch: 0, leafId: null };

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
  id: string;
  backend: BackendName;
  owner: string;
  workflow?: WorkflowOwnership;
  resultDelivery: SubagentResultDelivery;
  client?: SubagentClient;
  parentRef: ParentRef;
  title: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
  lastActivityAt: number;
  errorText?: string;
  failureKind?: SubagentFailureKind;
  outcome?: RunOutcome;
  meta: SubagentMeta;
  usage: { tokens?: number; contextWindow?: number };
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  completedOperations: number;
  lastCompletedOperation?: CompletedOperation;
  processTelemetry: "unavailable";
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
}

interface Entry {
  parentRef: ParentRef;
  backend: SubagentBackend;
  task: SpawnTask;
  snapshot: MutableSnapshot;
  session?: SubagentSession;
  scope?: Scope.Closeable;
  pump?: Fiber.Fiber<void>;
  admissionFiber?: Fiber.Fiber<void>;
  /** Completes when admission starts, or when the entry settles before it. */
  admission: Deferred.Deferred<SubagentSnapshot>;
  settlement: Deferred.Deferred<SubagentSnapshot>;
  slotHeld: boolean;
  /** Number of active owner claims keeping this entry/handle available. */
  workflowClaims: number;
  liveToolMap: Map<string, LiveToolState>;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
}

export interface WorkflowSubagentObservation {
  readonly id: string;
  readonly ownership: WorkflowOwnership;
  /** Snapshot at claim time; use the manager view for live progress. */
  readonly snapshot?: SubagentSnapshot;
  /** Resolves once admission starts or reaches terminal state first. */
  readonly admission: Effect.Effect<SubagentSnapshot>;
  /** Resolves once the child reaches its first terminal settlement. */
  readonly settlement: Effect.Effect<SubagentSnapshot>;
  /** Current live snapshot, if it has not been pruned. */
  readonly get: () => SubagentSnapshot | undefined;
  /** Releases the retention claim. Safe to call more than once. */
  readonly release: Effect.Effect<void>;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  /** Any-change notification (footer status, dashboard). */
  subscribe(listener: () => void): () => void;
  /** Per-subagent notification (takeover view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget: steer/continue a subagent (takeover input). */
  requestSend(id: string, text: string): void;
  /** Fire-and-forget: abort a queued/running subagent (dashboard `x`, takeover). */
  requestAbort(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when an active
   * subagent_wait/cancel is collecting the result (so it must not also be
   * delivered as a follow-up message).
   */
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

/**
 * Parent-facing read model. Client-correlated jobs remain in the manager's
 * full view for the client API, but are absent from every parent tool/UI
 * lookup and command path.
 */
export function parentSubagentView(view: SubagentReadModel): SubagentReadModel {
  const isVisible = (snapshot: SubagentSnapshot) =>
    snapshot.client === undefined && snapshot.resultDelivery !== "workflow";
  const included = (snapshot: SubagentSnapshot | undefined) =>
    snapshot !== undefined && isVisible(snapshot) ? snapshot : undefined;

  return {
    list: () => view.list().filter(isVisible),
    get: (id) => included(view.get(id)),
    size: () => view.list().filter(isVisible).length,
    subscribe: (listener) => view.subscribe(listener),
    subscribeTo: (id, listener) =>
      view.subscribeTo(id, () => {
        if (included(view.get(id)) !== undefined) listener();
      }),
    requestSend: (id, text) => {
      if (included(view.get(id)) !== undefined) view.requestSend(id, text);
    },
    requestAbort: (id) => {
      if (included(view.get(id)) !== undefined) view.requestAbort(id);
    },
    setOnSettled: () => {
      throw new Error("Filtered views cannot replace the manager settle hook.");
    },
  };
}

/** Operator view adds workflow-owned children without changing parent delivery. */
export function operatorSubagentView(
  view: SubagentReadModel,
): SubagentReadModel {
  const isVisible = (snapshot: SubagentSnapshot) =>
    snapshot.client === undefined &&
    (snapshot.resultDelivery === "parent" ||
      snapshot.resultDelivery === "workflow");
  const included = (snapshot: SubagentSnapshot | undefined) =>
    snapshot !== undefined && isVisible(snapshot) ? snapshot : undefined;

  return {
    list: () => view.list().filter(isVisible),
    get: (id) => included(view.get(id)),
    size: () => view.list().filter(isVisible).length,
    subscribe: (listener) => view.subscribe(listener),
    subscribeTo: (id, listener) =>
      view.subscribeTo(id, () => {
        if (included(view.get(id)) !== undefined) listener();
      }),
    requestSend: (id, text) => {
      const snapshot = included(view.get(id));
      if (snapshot?.resultDelivery === "parent") view.requestSend(id, text);
    },
    requestAbort: (id) => {
      const snapshot = included(view.get(id));
      if (snapshot?.resultDelivery === "parent") view.requestAbort(id);
    },
    setOnSettled: () => {
      throw new Error("Filtered views cannot replace the manager settle hook.");
    },
  };
}

/** Compatibility name for the parent-owned subagent dashboard view. */
export function standardSubagentView(
  view: SubagentReadModel,
): SubagentReadModel {
  return parentSubagentView(view);
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

export interface SubagentManagerApi {
  spawn(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<SubagentSnapshot, SpawnError | BackendUnavailableError>;
  /**
   * Await one stable terminal result. Calling this immediately after spawn is
   * safe even when the child is still queued; the per-entry settlement is
   * completed exactly once and survives later snapshot pruning.
   */
  awaitSettlement(
    id: string,
    expectedWorkflow?: WorkflowOwnership,
  ): Effect.Effect<SubagentSnapshot | undefined, WorkflowOwnershipError>;
  /** Wait until admission starts or reaches terminal state first. */
  readonly awaitAdmission?: (
    id: string,
    expectedWorkflow?: WorkflowOwnership,
  ) => Effect.Effect<SubagentSnapshot | undefined, WorkflowOwnershipError>;
  /** Claim a workflow child without replacing the manager's global settle hook. */
  readonly observeWorkflow?: (
    id: string,
    expectedWorkflow: WorkflowOwnership,
  ) => Effect.Effect<
    WorkflowSubagentObservation | undefined,
    WorkflowOwnershipError | WorkflowObservationLimitError
  >;
  /** Alias that makes the retention responsibility explicit at call sites. */
  readonly claimWorkflow?: (
    id: string,
    expectedWorkflow: WorkflowOwnership,
  ) => Effect.Effect<
    WorkflowSubagentObservation | undefined,
    WorkflowOwnershipError | WorkflowObservationLimitError
  >;
  /**
   * Wait until all listed subagents are settled. Unknown ids are treated as
   * settled (the tool layer validates ids first). While waiting, settles for
   * these ids are marked "consumed". Interruption (tool abort) releases the
   * interest and leaves the subagents running.
   */
  waitFor(
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ): Effect.Effect<void>;
  /** Cancel queued or running subagents; resolves when they have settled. */
  cancel(
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<CancelResult>>;
  send(id: string, text: string): Effect.Effect<void, SendError>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerApi
>()("subagents/SubagentManager") {}

// --- Implementation --------------------------------------------------------------

/** Bounded late-lookup window for settlement/admission observations. */
export const MAX_SETTLEMENT_HANDLES = MAX_TRACKED * 8;

interface ObservationHandle {
  readonly workflow?: WorkflowOwnership;
  readonly admission: Deferred.Deferred<SubagentSnapshot>;
  readonly settlement: Deferred.Deferred<SubagentSnapshot>;
  claims: number;
}

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry;
  // Detached forker for sync contexts (read-model commands, pruning) that
  // preserves the manager's services instead of using the global runtime.
  const runDetached = Effect.runForkWith(yield* Effect.context());

  const entries = new Map<string, Entry>();
  /** Stable lifecycle handles outlive snapshot pruning for bounded consumers. */
  const settlementHandles = new Map<string, ObservationHandle>();
  const settlementOrder: string[] = [];
  let workflowClaimCount = 0;
  const waitInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  let counter = 0;
  const admissionQueue: Entry[] = [];
  let activeSlots = 0;
  let disposed = false;
  let onSettled:
    ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // A failed status/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of Array.from(idListeners.get(id) ?? [])) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. Interruption unregisters the waiter. */
  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void);
    changeWaiters.push(waiter);
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter);
      if (index >= 0) changeWaiters.splice(index, 1);
    });
  });

  const runningCount = () => activeSlots;

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
  };
  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(id);
      else waitInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry) =>
    entry.scope
      ? Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)
      : Effect.void;

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          (e.snapshot.status === "done" || e.snapshot.status === "error") &&
          !waitInterest.has(e.snapshot.id) &&
          e.workflowClaims === 0,
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      const fiber = runDetached(closeEntryScope(entry));
      cleanups.add(fiber);
      fiber.addObserver(() => cleanups.delete(fiber));
    }
  };

  let drainQueue = () => {};

  const releaseSlot = (entry: Entry) => {
    if (!entry.slotHeld) return;
    entry.slotHeld = false;
    activeSlots = Math.max(0, activeSlots - 1);
  };

  const trimSettlementHandles = () => {
    let protectedSeen = 0;
    while (
      settlementHandles.size > MAX_SETTLEMENT_HANDLES &&
      settlementOrder.length > 0
    ) {
      const id = settlementOrder.shift();
      if (id === undefined) break;
      const handle = settlementHandles.get(id);
      if (!handle) continue;
      if (entries.has(id) || handle.claims > 0) {
        settlementOrder.push(id);
        protectedSeen++;
        if (protectedSeen >= settlementOrder.length) break;
        continue;
      }
      settlementHandles.delete(id);
      protectedSeen = 0;
    }
  };

  const settle = (entry: Entry, outcome: RunOutcome) => {
    const s = entry.snapshot;
    entry.restarting = false;
    if (s.status === "done" || s.status === "error") return;
    s.settledAt = Date.now();
    s.lastActivityAt = s.settledAt;
    s.outcome = outcome;
    s.failureKind =
      outcome._tag === "Failed"
        ? (outcome.failureKind ??
          failureKindFromProvenance(outcome.failureProvenance) ??
          s.failureKind)
        : undefined;
    switch (outcome._tag) {
      case "Completed":
        s.status = "done";
        s.errorText = undefined;
        s.finalText = outcome.finalText;
        break;
      case "Failed":
        s.status = "error";
        s.errorText = bounded(outcome.errorText);
        // Never let a failed run report the previous run's successful output.
        s.finalText = outcome.partialText ?? "";
        break;
      case "Interrupted":
        s.status = "error";
        s.errorText = "Run was aborted";
        s.finalText = outcome.partialText ?? "";
        break;
    }
    s.liveAssistant = undefined;
    entry.liveToolMap.clear();
    s.liveTools = [];
    s.queued = [];
    const terminal = Effect.succeed<SubagentSnapshot>(s);
    // Per-entry deferreds plus the terminal guard make result publication and
    // slot release exactly once even when cancellation races backend events.
    Deferred.doneUnsafe(entry.admission, terminal);
    Deferred.doneUnsafe(entry.settlement, terminal);
    releaseSlot(entry);
    // Refill capacity before publishing settlement so synchronous listeners
    // cannot let a restarted session leapfrog already-queued work.
    drainQueue();
    const consumed = (waitInterest.get(s.id) ?? 0) > 0;
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
    trimSettlementHandles();
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot;
    if (
      (s.status === "done" || s.status === "error") &&
      !(event._tag === "RunStarted" && entry.restarting === true)
    )
      return;
    const observedAt = Date.now();
    s.lastActivityAt = observedAt;
    switch (event._tag) {
      case "RunStarted":
        entry.restarting = false;
        s.status = "running";
        s.startedAt ??= observedAt;
        s.settledAt = undefined;
        s.errorText = undefined;
        s.failureKind = undefined;
        s.outcome = undefined;
        break;
      case "RunSettled":
        settle(entry, event.outcome);
        return; // settle() already notified
      case "UserMessage":
        s.transcript.push({ kind: "user", text: event.text });
        break;
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" };
        s.liveAssistant =
          event.kind === "text"
            ? { ...live, text: live.text + event.delta }
            : { ...live, thinking: live.thinking + event.delta };
        break;
      }
      case "AssistantMessage":
        s.transcript.push({ kind: "assistant", parts: event.parts });
        s.liveAssistant = undefined;
        s.turns++;
        break;
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview,
          startedAt: observedAt,
          updatedAt: observedAt,
        });
        s.liveTools = [...entry.liveToolMap.values()];
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview ?? current.outputPreview,
            updatedAt: observedAt,
          });
          s.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId);
        s.liveTools = [...entry.liveToolMap.values()];
        s.completedOperations++;
        s.lastCompletedOperation = {
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview,
          finishedAt: observedAt,
        };
        s.transcript.push({
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview,
        });
        break;
      case "QueueChanged":
        s.queued = event.queued;
        break;
      case "UsageChanged":
        s.usage = {
          tokens: event.tokens ?? s.usage.tokens,
          contextWindow: event.contextWindow ?? s.usage.contextWindow,
        };
        break;
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta };
        break;
      case "BackendError":
        s.errorText = bounded(event.message);
        s.failureKind =
          event.failureKind ??
          failureKindFromProvenance(event.failureProvenance);
        break;
    }
    notify(s.id);
  };

  const admissionErrorText = (error: SpawnError | BackendUnavailableError) =>
    error instanceof Error ? error.message : String(error);

  const admitEntry = (entry: Entry) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const available = yield* entry.backend.available;
          if (!available) {
            return yield* new BackendUnavailableError({
              message: `Backend "${entry.snapshot.backend}" is not available on this machine (binary/SDK/credentials missing).`,
            });
          }

          const scope = yield* Scope.make();
          entry.scope = scope;
          const session = yield* Scope.provide(
            entry.backend.spawn(entry.task),
            scope,
          ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
          if (
            disposed ||
            entry.snapshot.status === "done" ||
            entry.snapshot.status === "error"
          ) {
            yield* Scope.close(scope, Exit.void);
            return;
          }

          entry.session = session;
          const meta = yield* session.meta;
          const startedAt = Date.now();
          entry.snapshot.meta = meta;
          entry.snapshot.usage = { contextWindow: meta.contextWindow };
          entry.snapshot.status = "running";
          entry.snapshot.startedAt = startedAt;
          entry.snapshot.lastActivityAt = startedAt;
          Deferred.doneUnsafe(
            entry.admission,
            Effect.succeed<SubagentSnapshot>(entry.snapshot),
          );

          // Pump: fold the event stream into the snapshot. Tied to the entry
          // scope, so closing the scope stops it. If the stream ends while the
          // subagent still looks running, the backend died out from under us.
          const pump = Stream.runForEach(session.events, (event) =>
            Effect.sync(() => foldEvent(entry, event)),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (entry.snapshot.status === "running") {
                  settle(entry, {
                    _tag: "Failed",
                    errorText: "Backend event stream ended unexpectedly",
                    failureKind: "backend_failure",
                  });
                }
              }),
            ),
          );
          entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);
          notify(entry.snapshot.id);
        }),
      );

      if (
        Result.isFailure(result) &&
        entry.snapshot.status !== "done" &&
        entry.snapshot.status !== "error"
      ) {
        settle(entry, {
          _tag: "Failed",
          errorText: admissionErrorText(result.failure),
          failureKind: "backend_failure",
          failureProvenance: { _tag: "spawn" },
        });
      }
    });

  drainQueue = () => {
    if (disposed) return;
    while (activeSlots < MAX_RUNNING && admissionQueue.length > 0) {
      const entry = admissionQueue.shift()!;
      if (
        entry.snapshot.status === "done" ||
        entry.snapshot.status === "error"
      ) {
        continue;
      }
      entry.slotHeld = true;
      activeSlots++;
      const fiber = runDetached(admitEntry(entry));
      entry.admissionFiber = fiber;
      fiber.addObserver(() => {
        if (entry.admissionFiber === fiber) entry.admissionFiber = undefined;
      });
    }
  };

  const spawn = (backendName: BackendName, task: SpawnTask) =>
    Effect.suspend(
      (): Effect.Effect<
        SubagentSnapshot,
        SpawnError | BackendUnavailableError
      > => {
        if (disposed) {
          return new SpawnError({
            message: "Subagent manager is shutting down.",
          });
        }
        const backend = registry.get(backendName);
        if (!backend) {
          return new BackendUnavailableError({
            message: `Unknown backend "${backendName}".`,
          });
        }

        if (task.resultDelivery === "workflow" && task.workflow === undefined) {
          return new SpawnError({
            message: 'resultDelivery "workflow" requires WorkflowOwnership.',
          });
        }
        const id = `sa-${++counter}`;
        const now = Date.now();
        const parentRef: ParentRef = task.parentRef
          ? { ...task.parentRef }
          : { ...FALLBACK_PARENT_REF };
        const entry: Entry = {
          parentRef,
          backend,
          task,
          snapshot: {
            id,
            backend: backendName,
            owner: task.owner ?? "subagents",
            workflow: task.workflow ? { ...task.workflow } : undefined,
            // Workflow children use a private result lane. Backends only see
            // the opaque SpawnTask metadata and never learn workflow rules.
            resultDelivery: task.workflow
              ? "workflow"
              : (task.resultDelivery ?? "parent"),
            client: task.workflow
              ? undefined
              : task.client
                ? { ...task.client }
                : undefined,
            parentRef,
            title: task.title,
            prompt: task.prompt,
            cwd: task.cwd,
            status: "queued",
            createdAt: now,
            lastActivityAt: now,
            meta: {
              backend: backendName,
              modelLabel: task.model,
              reasoningEffort: task.reasoningEffort,
            },
            usage: {},
            transcript: [],
            liveTools: [],
            completedOperations: 0,
            processTelemetry: "unavailable",
            queued: [],
            finalText: "",
            turns: 0,
          },
          admission: Deferred.makeUnsafe<SubagentSnapshot>(),
          settlement: Deferred.makeUnsafe<SubagentSnapshot>(),
          slotHeld: false,
          workflowClaims: 0,
          liveToolMap: new Map(),
        };
        entries.set(id, entry);
        settlementHandles.set(id, {
          // Keep ownership separate from the mutable live snapshot; validation
          // must not be bypassed by a reader mutating its returned object.
          workflow: entry.snapshot.workflow
            ? { ...entry.snapshot.workflow }
            : undefined,
          admission: entry.admission,
          settlement: entry.settlement,
          claims: 0,
        });
        settlementOrder.push(id);
        admissionQueue.push(entry);
        notify(id);
        drainQueue();
        trimSettlementHandles();
        return Effect.succeed<SubagentSnapshot>(entry.snapshot);
      },
    );

  const waitFor = (
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      addInterest(unique);
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = unique.filter((id) => {
            const status = entries.get(id)?.snapshot.status;
            return status === "queued" || status === "running";
          });
          if (pending.length === 0) return;
          onPending?.(pending);
          yield* nextChange;
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(unique);
            pruneSettled();
          }),
        ),
      );
    });

  /** Cancel one queued/running entry, force-closing its scope after 5s. */
  const abortEntry = (entry: Entry) =>
    Effect.gen(function* () {
      if (entry.snapshot.status === "queued") {
        if (entry.admissionFiber) {
          yield* Fiber.interrupt(entry.admissionFiber).pipe(Effect.ignore);
        }
        yield* closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        );
        yield* Effect.sync(() => settle(entry, { _tag: "Interrupted" }));
        return;
      }
      if (entry.snapshot.status !== "running" || !entry.session) return;
      const graceful = yield* entry.session.interrupt.pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
      );
      if (Result.isFailure(graceful)) {
        // Settle before closing the scope so the pump's stream-ended
        // fallback ("Backend event stream ended unexpectedly") cannot win
        // the race and report the wrong terminal reason.
        yield* Effect.sync(() => {
          settle(entry, { _tag: "Interrupted" });
          entry.snapshot.errorText =
            "Abort deadline exceeded; session was force-disposed";
          notify(entry.snapshot.id);
        });
        // Bound the close like disposeAll does: a stuck backend finalizer
        // must not hang cancel after the run is already settled.
        yield* closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        );
      } else {
        // Some backends acknowledge interrupt before their notification
        // pump publishes RunSettled. Seal the manager record here so a
        // concurrent cancel cannot wait forever; any late event is ignored.
        yield* Effect.sync(() => settle(entry, { _tag: "Interrupted" }));
      }
    });

  const cancel = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const pending = unique
        .map((id) => entries.get(id))
        .filter(
          (entry): entry is Entry =>
            entry?.snapshot.status === "queued" ||
            entry?.snapshot.status === "running",
        );
      const pendingIds = pending.map((entry) => entry.snapshot.id);
      // Mark consumed before interrupting so cancellation does not also
      // enqueue duplicate automatic result messages into the parent.
      addInterest(pendingIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(pending, abortEntry, {
          concurrency: "unbounded",
        });
        while (
          pending.some(
            (entry) =>
              entry.snapshot.status === "queued" ||
              entry.snapshot.status === "running",
          )
        ) {
          yield* nextChange;
        }
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(pendingIds);
            pruneSettled();
          }),
        ),
        Effect.map((): ReadonlyArray<CancelResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot;
            return {
              id,
              title: snapshot?.title ?? "?",
              status: snapshot?.status ?? "error",
              cancelled: pendingIds.includes(id),
            };
          }),
        ),
      );
    });

  const send = (id: string, text: string) =>
    Effect.suspend((): Effect.Effect<void, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }
      if (entry.snapshot.status === "queued") {
        return new SendError({
          message: `Subagent "${id}" is queued and cannot receive messages until it starts.`,
        });
      }
      // Restarting a settled subagent occupies a running slot again, so it
      // must respect the same cap as spawn. Steering an already-running one
      // does not consume additional capacity.
      if (entry.snapshot.status !== "running") {
        if (runningCount() >= MAX_RUNNING) {
          return new SendError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
          });
        }
        // Occupy the slot synchronously: the RunStarted that flips status
        // arrives via the async pump, and two concurrent restarts must not
        // both pass the check in that window. Cleared by RunStarted/settle,
        // or here when the backend rejects the send.
        if (!entry.session) {
          return new SendError({
            message: `Subagent "${id}" has no backend session to restart.`,
          });
        }
        entry.slotHeld = true;
        activeSlots++;
        entry.restarting = true;
        return entry.session.send(text).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              entry.restarting = false;
              releaseSlot(entry);
              drainQueue();
            }),
          ),
        );
      }
      if (!entry.session) {
        return new SendError({
          message: `Subagent "${id}" has no active backend session.`,
        });
      }
      return entry.session.send(text);
    });

  const disposeAll = Effect.gen(function* () {
    disposed = true;
    const all = [...entries.values()];
    yield* Effect.sync(() => {
      admissionQueue.length = 0;
      for (const entry of all) {
        settle(entry, { _tag: "Interrupted" });
      }
    });
    yield* Effect.forEach(
      all,
      (entry) =>
        entry.admissionFiber
          ? Fiber.interrupt(entry.admissionFiber).pipe(Effect.ignore)
          : Effect.void,
      { concurrency: "unbounded" },
    );
    entries.clear();
    yield* Effect.forEach(
      all,
      (entry) =>
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      { concurrency: "unbounded" },
    );
    // Pruning cleanups are detached; bound them like everything else so a
    // stuck backend finalizer cannot block runtime shutdown indefinitely.
    yield* Effect.forEach(
      [...cleanups],
      (fiber) =>
        Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore);
    yield* Effect.sync(() => notify());
  });

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestSend: (id, text) => {
      const entry = entries.get(id);
      if (
        !entry ||
        (entry.snapshot.client && entry.snapshot.status !== "running")
      )
        return;
      runDetached(send(id, text).pipe(Effect.ignore));
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated aborts are not "consumed": the failed result still
      // flows back to the parent as a follow-up message, matching v1.
      runDetached(abortEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  const sameWorkflow = (
    actual: WorkflowOwnership | undefined,
    expected: WorkflowOwnership,
  ) =>
    actual?.runId === expected.runId &&
    actual.taskId === expected.taskId &&
    (expected.attemptId === undefined ||
      actual.attemptId === expected.attemptId);

  const handleFor = (id: string, expected?: WorkflowOwnership) =>
    Effect.suspend(() => {
      const handle = settlementHandles.get(id);
      if (!handle || expected === undefined) return Effect.succeed(handle);
      if (!sameWorkflow(handle.workflow, expected)) {
        return Effect.fail(
          new WorkflowOwnershipError({
            message: `Subagent "${id}" is not owned by workflow "${expected.runId}/${expected.taskId}".`,
            subagentId: id,
            expected: { ...expected },
            actual: handle.workflow ? { ...handle.workflow } : undefined,
          }),
        );
      }
      return Effect.succeed(handle);
    });

  const awaitSettlement = (id: string, expectedWorkflow?: WorkflowOwnership) =>
    handleFor(id, expectedWorkflow).pipe(
      Effect.flatMap((handle) =>
        handle ? Deferred.await(handle.settlement) : Effect.succeed(undefined),
      ),
    );

  const awaitAdmission = (id: string, expectedWorkflow?: WorkflowOwnership) =>
    handleFor(id, expectedWorkflow).pipe(
      Effect.flatMap((handle) =>
        handle ? Deferred.await(handle.admission) : Effect.succeed(undefined),
      ),
    );

  const observeWorkflow = (id: string, expectedWorkflow: WorkflowOwnership) =>
    handleFor(id, expectedWorkflow).pipe(
      Effect.flatMap((handle) => {
        if (!handle) return Effect.succeed(undefined);
        if (
          handle.claims === 0 &&
          workflowClaimCount >= MAX_SETTLEMENT_HANDLES
        ) {
          return Effect.fail(
            new WorkflowObservationLimitError({
              message: `At most ${MAX_SETTLEMENT_HANDLES} workflow observations may be retained at once.`,
            }),
          );
        }
        handle.claims++;
        workflowClaimCount++;
        const entry = entries.get(id);
        if (entry) entry.workflowClaims++;
        let released = false;
        const release = Effect.sync(() => {
          if (released) return;
          released = true;
          handle.claims = Math.max(0, handle.claims - 1);
          workflowClaimCount = Math.max(0, workflowClaimCount - 1);
          const current = entries.get(id);
          if (current)
            current.workflowClaims = Math.max(0, current.workflowClaims - 1);
          pruneSettled();
          trimSettlementHandles();
        });
        return Effect.succeed<WorkflowSubagentObservation>({
          id,
          ownership: { ...expectedWorkflow },
          snapshot: entries.get(id)?.snapshot,
          admission: Deferred.await(handle.admission),
          settlement: Deferred.await(handle.settlement),
          get: () => entries.get(id)?.snapshot,
          release,
        });
      }),
    );

  return SubagentManager.of({
    spawn,
    awaitSettlement,
    awaitAdmission,
    observeWorkflow,
    claimWorkflow: observeWorkflow,
    waitFor,
    cancel,
    send,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const SubagentManagerLive: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry
> = Layer.effect(SubagentManager, makeManager);
