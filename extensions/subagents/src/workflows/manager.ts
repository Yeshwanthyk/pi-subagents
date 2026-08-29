/* oxlint-disable anti-slop/no-unknown-parameters -- Workflow execution accepts validated graph state and opaque backend snapshots at the manager boundary. */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type {
  BackendName,
  ParentContext,
  ParentRef,
  SpawnTask,
  SubagentSnapshot,
  WorkflowOwnership,
} from "../domain.ts";
import type {
  SubagentManagerApi,
  WorkflowSubagentObservation,
} from "../manager.ts";
import { isSubagentTerminal } from "../domain.ts";
import { buildTaskHandoff, type CompletedHandoffResult } from "./handoff.ts";
import {
  isWorkflowTaskTerminal,
  isWorkflowTerminal,
  type WorkflowReadModel,
  type WorkflowTaskReadModel,
} from "./domain.ts";
import {
  boundWorkflowEvent,
  MAX_WORKFLOW_EVENTS,
  MAX_WORKFLOW_EVENT_TEXT_BYTES,
  truncateUtf8,
  type WorkflowEvent,
} from "./events.ts";
import { validateWorkflowDefinition } from "./graph.ts";
import { computeSchedule } from "./scheduler.ts";
import { foldWorkflowEvents, reduceWorkflowEvent } from "./reducer.ts";

/**
 * The narrow child seam owned by a workflow execution. It is intentionally
 * smaller than SubagentManagerApi: workflow children are correlated by the
 * workflow owner and never use parent/client delivery.
 */
export interface WorkflowChildExecutor {
  spawn(backend: BackendName, task: SpawnTask): Promise<SubagentSnapshot>;
  awaitSettlement(
    id: string,
    expectedWorkflow?: WorkflowOwnership,
  ): Promise<SubagentSnapshot | undefined>;
  /** Wait until admission starts or terminal settlement wins the race. */
  awaitAdmission?(
    id: string,
    expectedWorkflow?: WorkflowOwnership,
  ): Promise<SubagentSnapshot | undefined>;
  /** Owner-checked retention handle supplied by SubagentManager. */
  observeWorkflow?(
    id: string,
    expectedWorkflow: WorkflowOwnership,
  ): Promise<WorkflowChildObservation | undefined>;
  /** Compatibility alias for embedders using the explicit claim name. */
  claimWorkflow?(
    id: string,
    expectedWorkflow: WorkflowOwnership,
  ): Promise<WorkflowChildObservation | undefined>;
  /** Compatibility read seam for older embedding executors. */
  get?(
    id: string,
  ): SubagentSnapshot | undefined | Promise<SubagentSnapshot | undefined>;
  cancel(ids: ReadonlyArray<string>): Promise<ReadonlyArray<unknown>>;
  /** Compatibility notification seam for older embedding executors. */
  subscribeTo?(id: string, listener: () => void): () => void;
}

/** Private lifecycle handle. It does not copy a child transcript into a run. */
export interface WorkflowChildObservation {
  readonly snapshot?: SubagentSnapshot;
  readonly admission: Promise<SubagentSnapshot | undefined>;
  readonly settlement: Promise<SubagentSnapshot | undefined>;
  release(): Promise<void>;
}

/** Context captured at approval time and used for detached child execution. */
export interface WorkflowExecutionOptions {
  readonly executor?: WorkflowChildExecutor;
  readonly subagents?: SubagentManagerApi;
  /** Compatibility alias for embedders that name the service explicitly. */
  readonly subagentManager?: SubagentManagerApi;
  readonly cwd?: string;
  readonly owner?: string;
  readonly parent?: ParentContext;
  readonly parentRef?: ParentRef;
  readonly defaultBackend?: BackendName;
  /** Compatibility alias for the task field's backend terminology. */
  readonly defaultHarness?: BackendName;
}

export interface WorkflowRunHandle {
  readonly runId: string;
  /** Snapshot at the point the handle was returned. */
  readonly snapshot: WorkflowReadModel;
  /** Resolves once the authoritative workflow state is terminal. */
  readonly completion: Promise<WorkflowReadModel>;
  cancel(reason?: string): Promise<WorkflowReadModel>;
}

export class WorkflowExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowExecutionError";
  }
}

interface WorkflowEntry {
  state: WorkflowReadModel;
  readonly journal: WorkflowEvent[];
  readonly listeners: Set<WorkflowSubscription>;
}

interface ResolvedExecutionOptions {
  readonly executor: WorkflowChildExecutor;
  readonly cwd: string;
  readonly owner: string;
  readonly parent: ParentContext;
  readonly parentRef?: ParentRef;
  readonly defaultBackend: BackendName;
}

interface WorkflowChildSnapshot {
  readonly id: string;
  readonly workflow?: WorkflowOwnership;
  readonly status: SubagentSnapshot["status"];
  readonly startedAt?: number;
  readonly finalText: string;
  readonly errorText?: string;
}
interface ChildSettlement {
  readonly snapshot?: WorkflowChildSnapshot;
  readonly error?: unknown;
}
function projectChildSnapshot(
  snapshot: SubagentSnapshot | undefined,
): WorkflowChildSnapshot | undefined {
  if (!snapshot) return undefined;
  const failureText =
    snapshot.outcome?._tag === "Failed"
      ? snapshot.outcome.errorText
      : undefined;
  const error = snapshot.errorText ?? failureText;
  const projected = {
    id: snapshot.id,
    workflow: snapshot.workflow ? { ...snapshot.workflow } : undefined,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    finalText: truncateUtf8(snapshot.finalText, MAX_WORKFLOW_EVENT_TEXT_BYTES),
  };
  if (error === undefined) return projected;
  return {
    ...projected,
    errorText: truncateUtf8(error, MAX_WORKFLOW_EVENT_TEXT_BYTES),
  };
}

type ChildSignal =
  | { readonly kind: "cancel" }
  | {
      readonly kind: "admission" | "settlement";
      readonly child: ActiveChild;
      readonly result: ChildSettlement;
    };

interface ActiveChild {
  readonly taskId: string;
  readonly childId: string;
  readonly admission: Promise<ChildSettlement>;
  readonly settlement: Promise<ChildSettlement>;
  readonly release: () => Promise<void>;
  admissionHandled: boolean;
  settlementHandled: boolean;
  released: boolean;
}

interface WorkflowExecution {
  readonly runId: string;
  readonly options: ResolvedExecutionOptions;
  readonly active: Map<string, ActiveChild>;
  /** Bounded explicit outputs used by downstream consumes handoffs. */
  readonly results: Map<string, CompletedHandoffResult>;
  /** Tasks whose spawn call has not returned a child yet. */
  readonly spawningTaskIds: Set<string>;
  /** Child IDs between spawn and the workflow TaskQueued event. */
  readonly pendingChildIds: Set<string>;
  /** IDs already included in the serialized cancellation chain. */
  readonly cancellationIds: Set<string>;
  /** Admission operations still able to return a child after cancellation. */
  readonly inFlightAdmissions: Set<Promise<void>>;
  /** Observation-release cleanups still in flight. */
  readonly cleanups: Set<Promise<void>>;
  readonly completion: Promise<WorkflowReadModel>;
  readonly resolveCompletion: (state: WorkflowReadModel) => void;
  /** Wakes a driver waiting on child signals when cancellation seals the run. */
  readonly cancelSignal: Promise<void>;
  readonly resolveCancelSignal: () => void;
  driving: boolean;
  completionResolved: boolean;
  cancelReason?: string;
  cancellation: Promise<void>;
}

export type WorkflowSubscription = (snapshot: WorkflowReadModel) => void;

export interface WorkflowManagerOptions {
  readonly now?: () => number;
  readonly createId?: () => string;
  /** Test/embedding override; cannot exceed the production hard bound. */
  readonly maxEvents?: number;
  /** Default detached child seam used by approved runs. */
  readonly execution?: WorkflowExecutionOptions;
  readonly executor?: WorkflowChildExecutor;
  readonly subagents?: SubagentManagerApi;
  readonly subagentManager?: SubagentManagerApi;
}

async function adaptManagerObservation(
  observation: WorkflowSubagentObservation | undefined,
): Promise<WorkflowChildObservation | undefined> {
  if (!observation) return undefined;
  return {
    snapshot: observation.snapshot,
    admission: Effect.runPromise(observation.admission),
    settlement: Effect.runPromise(observation.settlement),
    release: () => Effect.runPromise(observation.release),
  };
}

function executorFromManager(
  manager: SubagentManagerApi,
): WorkflowChildExecutor {
  const executor: WorkflowChildExecutor = {
    spawn: (backend, task) => Effect.runPromise(manager.spawn(backend, task)),
    awaitSettlement: (id, expectedWorkflow) =>
      Effect.runPromise(manager.awaitSettlement(id, expectedWorkflow)),
    get: (id) => manager.view.get(id),
    cancel: (ids) => Effect.runPromise(manager.cancel(ids)),
    subscribeTo: (id, listener) => manager.view.subscribeTo(id, listener),
  if (manager.awaitAdmission) {
    executor.awaitAdmission = (id, expectedWorkflow) =>
      Effect.runPromise(manager.awaitAdmission!(id, expectedWorkflow));
  }
  };
  const observeWorkflow = manager.observeWorkflow;
  if (observeWorkflow) {
    executor.observeWorkflow = async (id, expectedWorkflow) =>
      adaptManagerObservation(
        await Effect.runPromise(observeWorkflow(id, expectedWorkflow)),
      );
  } else {
    const claimWorkflow = manager.claimWorkflow;
    if (claimWorkflow) {
      executor.claimWorkflow = async (id, expectedWorkflow) =>
        adaptManagerObservation(
          await Effect.runPromise(claimWorkflow(id, expectedWorkflow)),
        );
    }
  }
  return executor;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 4_096);
  return String(error).slice(0, 4_096);
}

function taskIsPending(task: WorkflowTaskReadModel): boolean {
  return (
    task.status === "blocked" ||
    task.status === "ready" ||
    task.status === "queued" ||
    task.status === "running"
  );
}

/**
 * Process-memory owner for bounded workflow journals, live folds, and the
 * detached execution loop. The loop is one serialized driver per run; the
 * SubagentManager remains the sole owner of child capacity and admission.
 */
export class WorkflowManager {
  private readonly entries = new Map<string, WorkflowEntry>();
  private readonly executions = new Map<string, WorkflowExecution>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxEvents: number;
  private readonly defaultExecution?: WorkflowExecutionOptions;

  constructor(options: WorkflowManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `wf-${randomUUID()}`);
    this.maxEvents = options.maxEvents ?? MAX_WORKFLOW_EVENTS;
    if (
      !Number.isInteger(this.maxEvents) ||
      this.maxEvents < 2 ||
      this.maxEvents > MAX_WORKFLOW_EVENTS
    ) {
      throw new RangeError(
        `maxEvents must be an integer between 2 and ${MAX_WORKFLOW_EVENTS}.`,
      );
    }
    const directExecutor =
      options.executor ??
      (options.subagents === undefined && options.subagentManager === undefined
        ? undefined
        : executorFromManager(options.subagents ?? options.subagentManager!));
    if (options.execution === undefined && directExecutor === undefined) {
      this.defaultExecution = undefined;
    } else {
      const defaults = { ...options.execution };
      this.defaultExecution =
        directExecutor === undefined
          ? defaults
          : { ...defaults, executor: directExecutor };
    }
  }

  createRun(definition: unknown): WorkflowReadModel {
    const validatedDefinition = validateWorkflowDefinition(definition);
    const runId = this.createId();
    if (this.entries.has(runId)) {
      throw new Error(
        `Workflow id generator returned duplicate id "${runId}".`,
      );
    }
    const event = boundWorkflowEvent({
      _tag: "WorkflowCreated",
      runId,
      at: this.eventTime(),
      definition: validatedDefinition,
    });
    const state = reduceWorkflowEvent(undefined, event);
    this.entries.set(runId, {
      state,
      journal: [event],
      listeners: new Set(),
    });
    return state;
  }

  append(event: WorkflowEvent): WorkflowReadModel {
    const entry = this.requireEntry(event.runId);
    let bounded = boundWorkflowEvent(event);
    const next = reduceWorkflowEvent(entry.state, bounded);
    // First-write-wins terminal events and exhausted logs are intentional no-ops.
    if (next === entry.state) return entry.state;
    if (bounded._tag === "WorkflowLogAdded") {
      const accepted = next.logs.at(-1);
      if (!accepted)
        throw new Error("Accepted workflow log was not projected.");
      bounded = { ...bounded, message: accepted.message };
    }
    const terminalEvent =
      bounded._tag === "WorkflowCompleted" ||
      bounded._tag === "WorkflowFailed" ||
      bounded._tag === "WorkflowCancelled";
    if (
      entry.journal.length >= this.maxEvents ||
      (entry.journal.length === this.maxEvents - 1 && !terminalEvent)
    ) {
      throw new WorkflowJournalLimitError(event.runId, this.maxEvents);
    }
    entry.journal.push(bounded);
    entry.state = next;
    const currentListeners = Array.from(entry.listeners);
    for (const listener of currentListeners) {
      try {
        listener(next);
      } catch {
        // Observers cannot roll back an accepted authoritative event.
      }
    }
    const execution = this.executions.get(event.runId);
    if (execution) {
      this.resolveExecution(execution);
      this.kick(execution);
    }
    return next;
  }

  /** Start a run and, when execution context is configured, kick it off detached. */
  start(
    runId: string,
    execution?: WorkflowExecutionOptions,
  ): WorkflowReadModel {
    const resolved =
      execution !== undefined || this.defaultExecution !== undefined
        ? this.resolveExecutionOptions(runId, execution)
        : undefined;
    const state = this.append({
      _tag: "WorkflowStarted",
      runId,
      at: this.eventTime(runId),
    });
    if (resolved) this.beginExecution(runId, resolved);
    return state;
  }

  /** Start (if needed) and return before any child settles. */
  execute(
    runId: string,
    execution?: WorkflowExecutionOptions,
  ): WorkflowRunHandle {
    const current = this.requireEntry(runId).state;
    let resolved = this.executions.get(runId)?.options;
    if (!resolved) resolved = this.resolveExecutionOptions(runId, execution);
    if (current.status === "pending_approval") {
      this.append({
        _tag: "WorkflowStarted",
        runId,
        at: this.eventTime(runId),
      });
    } else if (
      current.status !== "running" &&
      !isWorkflowTerminal(current.status)
    ) {
      throw new WorkflowExecutionError(
        `Workflow "${runId}" cannot execute from ${current.status}.`,
      );
    }
    const active =
      this.executions.get(runId) ?? this.beginExecution(runId, resolved);
    return this.handleFor(active);
  }

  /** Alias for callers that use run terminology for detached workflows. */
  run(runId: string, execution?: WorkflowExecutionOptions): WorkflowRunHandle {
    return this.execute(runId, execution);
  }

  queueTask(runId: string, taskId: string, childId: string): WorkflowReadModel {
    return this.append({
      _tag: "TaskQueued",
      runId,
      taskId,
      childId,
      at: this.eventTime(runId),
    });
  }

  startTask(runId: string, taskId: string): WorkflowReadModel {
    return this.append({
      _tag: "TaskStarted",
      runId,
      taskId,
      at: this.eventTime(runId),
    });
  }

  completeTask(
    runId: string,
    taskId: string,
    resultPreview?: string,
  ): WorkflowReadModel {
    return this.append({
      _tag: "TaskCompleted",
      runId,
      taskId,
      resultPreview,
      at: this.eventTime(runId),
    });
  }

  failTask(runId: string, taskId: string, error: string): WorkflowReadModel {
    return this.append({
      _tag: "TaskFailed",
      runId,
      taskId,
      error,
      at: this.eventTime(runId),
    });
  }

  cancelTask(runId: string, taskId: string, reason: string): WorkflowReadModel {
    return this.append({
      _tag: "TaskCancelled",
      runId,
      taskId,
      reason,
      at: this.eventTime(runId),
    });
  }

  complete(runId: string, summary?: string): WorkflowReadModel {
    return this.append({
      _tag: "WorkflowCompleted",
      runId,
      summary,
      at: this.eventTime(runId),
    });
  }

  fail(runId: string, error: string): WorkflowReadModel {
    return this.append({
      _tag: "WorkflowFailed",
      runId,
      error,
      at: this.eventTime(runId),
    });
  }

  /**
   * Synchronously seals the workflow, then starts child cancellation in the
   * background. `cancelRun` is the async companion for callers that need the
   * child cancellation/release barrier before returning.
   */
  cancel(runId: string, reason: string): WorkflowReadModel {
    const entry = this.requireEntry(runId);
    if (isWorkflowTerminal(entry.state.status)) return entry.state;
    if (entry.state.status !== "running") {
      return this.append({
        _tag: "WorkflowCancelled",
        runId,
        reason,
        at: this.eventTime(runId),
      });
    }

    const execution = this.executions.get(runId);
    // A listener can synchronously ask to cancel again while task-cancel events
    // are being published. The first request owns the terminal transition.
    if (execution?.cancelReason !== undefined) return entry.state;
    if (execution) {
      execution.cancelReason = reason;
      execution.resolveCancelSignal();
      const childIds = [
        ...execution.pendingChildIds,
        ...[...execution.active.values()].map((child) => child.childId),
      ];
      this.queueChildCancellation(execution, childIds);
      for (const child of execution.active.values()) {
        this.detachChild(execution, child);
      }
    }

    // Mark every not-yet-terminal task before sealing the workflow. This makes
    // the terminal snapshot useful immediately and makes late child events no-ops.
    for (const definition of entry.state.definition.tasks) {
      const task = this.requireEntry(runId).state.tasks[definition.id];
      if (task && taskIsPending(task)) {
        this.cancelTask(runId, definition.id, reason);
      }
    }
    return this.append({
      _tag: "WorkflowCancelled",
      runId,
      reason,
      at: this.eventTime(runId),
    });
  }

  async cancelRun(
    runId: string,
    reason = "Workflow cancelled",
  ): Promise<WorkflowReadModel> {
    this.cancel(runId, reason);
    const execution = this.executions.get(runId);
    if (execution) await this.waitForCancellation(execution);
    return this.requireEntry(runId).state;
  }

  /** Compatibility alias for async lifecycle callers. */
  async cancelWorkflow(
    runId: string,
    reason = "Workflow cancelled",
  ): Promise<WorkflowReadModel> {
    return this.cancelRun(runId, reason);
  }

  /** Stop all active runs before the underlying subagent runtime is disposed. */
  async shutdown(reason = "Session is shutting down"): Promise<void> {
    const active = [...this.executions.values()].filter((execution) => {
      const state = this.entries.get(execution.runId)?.state;
      return state !== undefined && !isWorkflowTerminal(state.status);
    });
    for (const execution of active) this.cancel(execution.runId, reason);
    await Promise.all(
      active.map((execution) => this.waitForCancellation(execution)),
    );
  }

  async dispose(reason = "Workflow manager disposed"): Promise<void> {
    await this.shutdown(reason);
  }

  log(
    runId: string,
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): WorkflowReadModel {
    return this.append({
      _tag: "WorkflowLogAdded",
      runId,
      level,
      message,
      at: this.eventTime(runId),
    });
  }

  get(runId: string): WorkflowReadModel | undefined {
    return this.entries.get(runId)?.state;
  }

  list(): ReadonlyArray<WorkflowReadModel> {
    return [...this.entries.values()].map((entry) => entry.state);
  }

  events(runId: string): ReadonlyArray<WorkflowEvent> {
    return structuredClone(this.requireEntry(runId).journal);
  }

  replay(runId: string): WorkflowReadModel {
    return foldWorkflowEvents(this.requireEntry(runId).journal);
  }

  subscribe(runId: string, listener: WorkflowSubscription): () => void {
    const listeners = this.requireEntry(runId).listeners;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  private requireEntry(runId: string): WorkflowEntry {
    const entry = this.entries.get(runId);
    if (!entry) throw new WorkflowNotFoundError(runId);
    return entry;
  }

  private eventTime(runId?: string): number {
    const observed = this.now();
    if (!Number.isFinite(observed) || observed < 0) {
      throw new Error("Workflow clock returned an invalid timestamp.");
    }
    const last = runId
      ? this.entries.get(runId)?.state.lastActivityAt
      : undefined;
    return last === undefined ? observed : Math.max(last, observed);
  }

  private resolveExecutionOptions(
    runId: string,
    overrides?: WorkflowExecutionOptions,
  ): ResolvedExecutionOptions {
    const merged = { ...this.defaultExecution, ...overrides };
    const manager = merged.subagents ?? merged.subagentManager;
    const executor =
      merged.executor ?? (manager ? executorFromManager(manager) : undefined);
    if (!executor) {
      throw new WorkflowExecutionError(
        `Workflow "${runId}" has no child executor configured.`,
      );
    }
    const cwd = merged.cwd ?? process.cwd();
    const parent =
      merged.parent ??
      ({ parentCwd: cwd, projectTrusted: true } satisfies ParentContext);
    return {
      executor,
      cwd,
      owner: merged.owner ?? `workflow:${runId}`,
      parent,
      parentRef: merged.parentRef,
      defaultBackend: merged.defaultBackend ?? merged.defaultHarness ?? "pi",
    };
  }

  private beginExecution(
    runId: string,
    options: ResolvedExecutionOptions,
  ): WorkflowExecution {
    const existing = this.executions.get(runId);
    if (existing) return existing;
    let resolveCompletion!: (state: WorkflowReadModel) => void;
    const completion = new Promise<WorkflowReadModel>((resolve) => {
      resolveCompletion = resolve;
    });
    let resolveCancelSignal!: () => void;
    const cancelSignal = new Promise<void>((resolve) => {
      resolveCancelSignal = resolve;
    });
    const execution: WorkflowExecution = {
      runId,
      options,
      active: new Map(),
      results: new Map(),
      spawningTaskIds: new Set(),
      pendingChildIds: new Set(),
      cancellationIds: new Set(),
      inFlightAdmissions: new Set(),
      cleanups: new Set(),
      completion,
      resolveCompletion,
      cancelSignal,
      resolveCancelSignal,
      driving: false,
      completionResolved: false,
      cancellation: Promise.resolve(),
    };
    this.executions.set(runId, execution);
    this.resolveExecution(execution);
    this.kick(execution);
    return execution;
  }

  private handleFor(execution: WorkflowExecution): WorkflowRunHandle {
    return {
      runId: execution.runId,
      snapshot: this.requireEntry(execution.runId).state,
      completion: execution.completion,
      cancel: (reason) =>
        this.cancelRun(execution.runId, reason ?? "Workflow cancelled"),
    };
  }

  private resolveExecution(execution: WorkflowExecution): void {
    if (execution.completionResolved) return;
    const state = this.entries.get(execution.runId)?.state;
    if (!state || !isWorkflowTerminal(state.status)) return;
    execution.completionResolved = true;
    execution.resolveCompletion(state);
  }

  private kick(execution: WorkflowExecution): void {
    if (execution.driving || execution.completionResolved) return;
    execution.driving = true;
    void this.drive(execution)
      .catch((error: unknown) => {
        const state = this.entries.get(execution.runId)?.state;
        if (state && !isWorkflowTerminal(state.status)) {
          try {
            this.fail(
              execution.runId,
              `Workflow execution failed: ${errorText(error)}`,
            );
          } catch {
            // Keep terminal ownership in the journal if failure reporting is
            // itself blocked by a malformed or exhausted journal.
          }
        }
      })
      .finally(() => {
        execution.driving = false;
        this.resolveExecution(execution);
        const state = this.entries.get(execution.runId)?.state;
        if (state && !isWorkflowTerminal(state.status)) this.kick(execution);
      });
  }

  private async drive(execution: WorkflowExecution): Promise<void> {
    while (true) {
      const state = this.requireEntry(execution.runId).state;
      if (isWorkflowTerminal(state.status)) return;
      if (execution.cancelReason !== undefined) return;

      const schedule = computeSchedule({
        target: state,
        activeTaskIds: state.definition.tasks
          .map((task) => task.id)
          .filter((taskId) => execution.active.has(taskId)),
      });
      if (schedule.readyTaskIds.length > 0) {
        await this.admitWave(execution, schedule.readyTaskIds);
        continue;
      }

      if (execution.active.size > 0) {
        await this.awaitOneSignal(execution);
        continue;
      }

      const tasks = state.definition.tasks.map((task) => state.tasks[task.id]!);
      if (tasks.every((task) => isWorkflowTaskTerminal(task.status))) {
        if (tasks.every((task) => task.status === "completed")) {
          this.complete(execution.runId, "All workflow tasks completed.");
        } else {
          this.fail(
            execution.runId,
            "Workflow reached a terminal task state without completing every task.",
          );
        }
        continue;
      }

      // A validated graph should not reach this state. Failing closed avoids a
      // detached loop that waits forever on a malformed external projection.
      this.fail(
        execution.runId,
        "Workflow scheduler stalled before all tasks reached a terminal state.",
      );
    }
  }

  /** Admit every task selected by one scheduler pass before awaiting a child. */
  private async admitWave(
    execution: WorkflowExecution,
    taskIds: ReadonlyArray<string>,
  ): Promise<void> {
    const operations: Array<Promise<void>> = [];
    for (const taskId of taskIds) {
      const operation = this.admitTask(execution, taskId).catch(
        (error: unknown) => {
          const state = this.entries.get(execution.runId)?.state;
          const task = state?.tasks[taskId];
          if (
            state &&
            !isWorkflowTerminal(state.status) &&
            task &&
            !isWorkflowTaskTerminal(task.status)
          ) {
            this.failTask(execution.runId, taskId, errorText(error));
          }
        },
      );
      execution.inFlightAdmissions.add(operation);
      void operation.then(
        () => execution.inFlightAdmissions.delete(operation),
        () => execution.inFlightAdmissions.delete(operation),
      );
      operations.push(operation);
    }
    await Promise.all(operations);
  }

  private async admitTask(
    execution: WorkflowExecution,
    taskId: string,
  ): Promise<void> {
    let state = this.requireEntry(execution.runId).state;
    if (
      isWorkflowTerminal(state.status) ||
      execution.cancelReason !== undefined
    ) {
      return;
    }
    const task = state.tasks[taskId];
    if (!task || task.status !== "ready") return;

    let handoff = "";
    try {
      if ((task.definition.consumes?.length ?? 0) > 0) {
        handoff = buildTaskHandoff(
          {
            id: task.definition.id,
            label: task.definition.label,
            consumes: task.definition.consumes,
          },
          execution.results,
        ).text;
      }
    } catch (error) {
      this.failTask(execution.runId, taskId, errorText(error));
      return;
    }

    const expected: WorkflowOwnership = {
      runId: execution.runId,
      taskId,
    };
    const prompt =
      handoff.length > 0
        ? `${task.definition.prompt}\n\n${handoff}`
        : task.definition.prompt;
    const spawnTask: SpawnTask = {
      prompt,
      title: task.definition.label,
      cwd: execution.options.cwd,
      owner: execution.options.owner,
      workflow: expected,
      // Workflow-owned children stay in the private manager result lane.
      resultDelivery: "workflow",
      parentRef: execution.options.parentRef,
      model: task.definition.model,
      reasoningEffort: task.definition.effort,
      parent: execution.options.parent,
    };

    execution.spawningTaskIds.add(taskId);
    let child: SubagentSnapshot;
    try {
      child = await execution.options.executor.spawn(
        task.definition.harness ?? execution.options.defaultBackend,
        spawnTask,
      );
    } catch (error) {
      state = this.requireEntry(execution.runId).state;
      if (
        !isWorkflowTerminal(state.status) &&
        execution.cancelReason === undefined
      ) {
        const current = state.tasks[taskId];
        if (current && !isWorkflowTaskTerminal(current.status)) {
          this.failTask(execution.runId, taskId, errorText(error));
        }
      }
      return;
    } finally {
      execution.spawningTaskIds.delete(taskId);
    }

    const childId = child.id;
    if (childId.length === 0) {
      state = this.requireEntry(execution.runId).state;
      if (
        !isWorkflowTerminal(state.status) &&
        execution.cancelReason === undefined
      ) {
        this.failTask(
          execution.runId,
          taskId,
          "Child executor returned an empty id.",
        );
      }
      return;
    }

    // The spawn result itself is part of the owner boundary. Do not attach a
    // child whose manager snapshot does not identify this workflow task.
    if (!this.ownedSnapshot(child, expected)) {
      state = this.requireEntry(execution.runId).state;
      if (
        !isWorkflowTerminal(state.status) &&
        execution.cancelReason === undefined
      ) {
        this.failTask(
          execution.runId,
          taskId,
          "Child executor returned a snapshot with the wrong workflow owner.",
        );
      }
      return;
    }

    execution.pendingChildIds.add(childId);
    if (
      execution.cancelReason !== undefined ||
      isWorkflowTerminal(this.requireEntry(execution.runId).state.status)
    ) {
      await this.queueChildCancellation(execution, [childId]);
      execution.pendingChildIds.delete(childId);
      return;
    }

    // Publish TaskQueued before waiting on any owner observation. A fast child
    // can settle while its manager handle is being claimed; the workflow
    // journal must still show the queue edge before that result is consumed.
    try {
      this.queueTask(execution.runId, taskId, childId);
    } catch (error) {
      await this.queueChildCancellation(execution, [childId]);
      execution.pendingChildIds.delete(childId);
      state = this.requireEntry(execution.runId).state;
      if (!isWorkflowTerminal(state.status)) {
        this.fail(
          execution.runId,
          `Could not queue workflow task: ${errorText(error)}`,
        );
      }
      return;
    }

    let observation: WorkflowChildObservation | undefined;
    try {
      observation = await this.observeChild(execution, child, expected);
    } catch (error) {
      execution.pendingChildIds.delete(childId);
      await this.queueChildCancellation(execution, [childId]);
      state = this.requireEntry(execution.runId).state;
      if (
        !isWorkflowTerminal(state.status) &&
        execution.cancelReason === undefined
      ) {
        this.failTask(execution.runId, taskId, errorText(error));
      }
      return;
    }
    if (!observation) {
      execution.pendingChildIds.delete(childId);
      await this.queueChildCancellation(execution, [childId]);
      state = this.requireEntry(execution.runId).state;
      if (
        !isWorkflowTerminal(state.status) &&
        execution.cancelReason === undefined
      ) {
        this.failTask(
          execution.runId,
          taskId,
          "Workflow child was not available for owner-safe observation.",
        );
      }
      return;
    }

    if (
      execution.cancelReason !== undefined ||
      isWorkflowTerminal(this.requireEntry(execution.runId).state.status)
    ) {
      await this.queueChildCancellation(execution, [childId]);
      execution.pendingChildIds.delete(childId);
      this.releaseObservation(execution, observation);
      return;
    }

    execution.pendingChildIds.delete(childId);
    const active = this.registerChild(execution, taskId, childId, observation);
    if (
      execution.cancelReason !== undefined ||
      isWorkflowTerminal(this.requireEntry(execution.runId).state.status)
    ) {
      await this.queueChildCancellation(execution, [childId]);
      this.detachChild(execution, active);
    }
  }

  private async observeChild(
    execution: WorkflowExecution,
    child: SubagentSnapshot,
    expected: WorkflowOwnership,
  ): Promise<WorkflowChildObservation | undefined> {
    const executor = execution.options.executor;
    if (!this.ownedSnapshot(child, expected)) {
      throw new WorkflowExecutionError(
        `Child "${child.id}" is not owned by workflow "${expected.runId}/${expected.taskId}".`,
      );
    }
    if (executor.observeWorkflow) {
      const observation = await executor.observeWorkflow(child.id, expected);
      if (
        observation?.snapshot !== undefined &&
        !this.ownedSnapshot(observation.snapshot, expected, child.id)
      ) {
        throw new WorkflowExecutionError(
          `Owner observation for child "${child.id}" did not match its workflow task.`,
        );
      }
      return observation;
    }
    if (executor.claimWorkflow) {
      const observation = await executor.claimWorkflow(child.id, expected);
      if (
        observation?.snapshot !== undefined &&
        !this.ownedSnapshot(observation.snapshot, expected, child.id)
      ) {
        throw new WorkflowExecutionError(
          `Owner observation for child "${child.id}" did not match its workflow task.`,
        );
      }
      return observation;
    }

    // Keep the narrow executor seam backwards-compatible for tests/embedders,
    // while manager-backed runs always take the owner-safe branch above.
    return {
      admission: Promise.resolve(child),
      settlement: Promise.resolve().then(() =>
        executor.awaitSettlement(child.id, expected),
      ),
      release: async () => {},
    };
  }

  private registerChild(
    execution: WorkflowExecution,
    taskId: string,
    childId: string,
    observation: WorkflowChildObservation,
  ): ActiveChild {
    const admission = Promise.resolve(observation.admission).then(
      (snapshot) => ({ snapshot: projectChildSnapshot(snapshot) }),
      (error: unknown) => ({ error }),
    );
    const settlement = Promise.resolve(observation.settlement).then(
      (snapshot) => ({ snapshot: projectChildSnapshot(snapshot) }),
      (error: unknown) => ({ error }),
    );
    const active: ActiveChild = {
      taskId,
      childId,
      admission,
      settlement,
      release: observation.release,
      admissionHandled: false,
      settlementHandled: false,
      released: false,
    };
    execution.active.set(taskId, active);
    return active;
  }

  private async awaitOneSignal(execution: WorkflowExecution): Promise<void> {
    const signals: Array<Promise<ChildSignal>> = [];
    for (const child of execution.active.values()) {
      if (!child.admissionHandled) {
        signals.push(
          child.admission.then(
            (result): ChildSignal => ({
              kind: "admission",
              child,
              result,
            }),
            (error: unknown): ChildSignal => ({
              kind: "admission",
              child,
              result: { error },
            }),
          ),
        );
      }
      if (!child.settlementHandled) {
        signals.push(
          child.settlement.then(
            (result): ChildSignal => ({
              kind: "settlement",
              child,
              result,
            }),
            (error: unknown): ChildSignal => ({
              kind: "settlement",
              child,
              result: { error },
            }),
          ),
        );
      }
    }
    signals.push(
      execution.cancelSignal.then((): ChildSignal => ({ kind: "cancel" })),
    );
    const signal = await Promise.race(signals);
    if (signal.kind === "cancel") return;
    if (execution.active.get(signal.child.taskId) !== signal.child) return;

    if (signal.kind === "admission") {
      signal.child.admissionHandled = true;
      await this.reconcileAdmission(execution, signal.child, signal.result);
      return;
    }

    signal.child.settlementHandled = true;
    this.detachChild(execution, signal.child);
    await this.reconcileSettlement(execution, signal.child, signal.result);
  }

  private async reconcileAdmission(
    execution: WorkflowExecution,
    child: ActiveChild,
    admission: ChildSettlement,
  ): Promise<void> {
    const state = this.requireEntry(execution.runId).state;
    if (
      isWorkflowTerminal(state.status) ||
      execution.cancelReason !== undefined
    ) {
      return;
    }
    if (admission.error !== undefined) {
      const task = state.tasks[child.taskId];
      if (task && !isWorkflowTaskTerminal(task.status)) {
        this.failTask(
          execution.runId,
          child.taskId,
          errorText(admission.error),
        );
      }
      await this.queueChildCancellation(execution, [child.childId]);
      this.detachChild(execution, child);
      return;
    }
    const snapshot = admission.snapshot;
    if (snapshot === undefined) return;
    const expected = { runId: execution.runId, taskId: child.taskId };
    if (!this.ownedSnapshot(snapshot, expected, child.childId)) {
      this.failTask(
        execution.runId,
        child.taskId,
        "Child admission snapshot did not match its workflow owner.",
      );
      await this.queueChildCancellation(execution, [child.childId]);
      this.detachChild(execution, child);
      return;
    }
    if (
      snapshot.status !== "running" &&
      snapshot.startedAt === undefined &&
      snapshot.status !== "done"
    ) {
      return;
    }
    const task = this.requireEntry(execution.runId).state.tasks[child.taskId];
    if (task?.status === "queued") {
      this.startTask(execution.runId, child.taskId);
    }
  }

  private async reconcileSettlement(
    execution: WorkflowExecution,
    child: ActiveChild,
    settlement: ChildSettlement,
  ): Promise<void> {
    const state = this.requireEntry(execution.runId).state;
    if (
      isWorkflowTerminal(state.status) ||
      execution.cancelReason !== undefined
    ) {
      return;
    }
    if (settlement.error !== undefined) {
      const task = state.tasks[child.taskId];
      if (task && !isWorkflowTaskTerminal(task.status)) {
        this.failTask(
          execution.runId,
          child.taskId,
          errorText(settlement.error),
        );
      }
      await this.queueChildCancellation(execution, [child.childId]);
      return;
    }

    const snapshot = settlement.snapshot;
    if (!snapshot || !isSubagentTerminal(snapshot.status)) {
      this.failTask(
        execution.runId,
        child.taskId,
        "Child executor returned without a stable terminal settlement.",
      );
      return;
    }
    const expected = { runId: execution.runId, taskId: child.taskId };
    if (!this.ownedSnapshot(snapshot, expected, child.childId)) {
      this.failTask(
        execution.runId,
        child.taskId,
        "Child settlement snapshot did not match its workflow owner.",
      );
      return;
    }

    const task = this.requireEntry(execution.runId).state.tasks[child.taskId];
    if (!task || isWorkflowTaskTerminal(task.status)) return;
    if (snapshot.status === "error") {
      const error = snapshot.errorText ?? "Child task failed.";
      this.failTask(execution.runId, child.taskId, error);
      return;
    }

    // A very fast backend may settle between spawn and admission recording.
    if (task.status === "queued") this.startTask(execution.runId, child.taskId);
    const afterStart = this.requireEntry(execution.runId).state.tasks[
      child.taskId
    ];
    if (!afterStart || afterStart.status !== "running") return;

    const finalText = truncateUtf8(
      snapshot.finalText,
      MAX_WORKFLOW_EVENT_TEXT_BYTES,
    );
    // Store only bounded explicit output and an opaque manager id. The child
    // snapshot/transcript remains solely owned by SubagentManager.
    execution.results.set(child.taskId, {
      status: "completed",
      output: finalText,
      label: task.definition.label,
      sessionRef: `session:${snapshot.id}`,
    });
    this.completeTask(execution.runId, child.taskId, finalText);
  }

  private ownedSnapshot(
    snapshot: Pick<SubagentSnapshot, "id" | "workflow">,
    expected: WorkflowOwnership,
    expectedId?: string,
  ): boolean {
    return (
      (expectedId === undefined || snapshot.id === expectedId) &&
      snapshot.workflow?.runId === expected.runId &&
      snapshot.workflow.taskId === expected.taskId
    );
  }

  private releaseObservation(
    execution: WorkflowExecution,
    observation: Pick<WorkflowChildObservation, "release">,
  ): void {
    let release: Promise<void>;
    try {
      release = Promise.resolve(observation.release());
    } catch {
      return;
    }
    this.trackCleanup(execution, release);
  }

  private detachChild(execution: WorkflowExecution, child: ActiveChild): void {
    if (execution.active.get(child.taskId) === child) {
      execution.active.delete(child.taskId);
    }
    if (child.released) return;
    child.released = true;
    this.releaseObservation(execution, { release: child.release });
  }

  private trackCleanup(
    execution: WorkflowExecution,
    cleanup: Promise<void>,
  ): void {
    const safe = cleanup.catch(() => undefined);
    execution.cleanups.add(safe);
    void safe.then(
      () => execution.cleanups.delete(safe),
      () => execution.cleanups.delete(safe),
    );
  }

  private queueChildCancellation(
    execution: WorkflowExecution,
    ids: ReadonlyArray<string>,
  ): Promise<void> {
    const unique = [...new Set(ids)].filter(
      (id) => !execution.cancellationIds.has(id),
    );
    if (unique.length === 0) return execution.cancellation;
    for (const id of unique) execution.cancellationIds.add(id);
    execution.cancellation = execution.cancellation
      .then(() => this.cancelChildren(execution, unique))
      .catch(() => undefined);
    return execution.cancellation;
  }

  private async cancelChildren(
    execution: WorkflowExecution,
    ids: ReadonlyArray<string>,
  ): Promise<void> {
    if (ids.length === 0) return;
    try {
      await execution.options.executor.cancel([...new Set(ids)]);
    } catch {
      // The workflow is already sealed; backend cancellation is best effort.
    }
  }

  private async waitForCancellation(
    execution: WorkflowExecution,
  ): Promise<void> {
    if (execution.cancelReason === undefined) return;
    while (true) {
      const admissions = [...execution.inFlightAdmissions];
      const cancellation = execution.cancellation;
      await Promise.all(
        admissions.map((admission) => admission.catch(() => undefined)),
      );
      await cancellation;
      const cleanups = [...execution.cleanups];
      await Promise.all(cleanups);
      if (
        execution.inFlightAdmissions.size === 0 &&
        execution.cleanups.size === 0 &&
        execution.cancellation === cancellation
      ) {
        return;
      }
    }
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(runId: string) {
    super(`Workflow "${runId}" is not tracked.`);
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowJournalLimitError extends Error {
  constructor(runId: string, maxEvents: number) {
    super(`Workflow "${runId}" reached the ${maxEvents}-event journal limit.`);
    this.name = "WorkflowJournalLimitError";
  }
}
