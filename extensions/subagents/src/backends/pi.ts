/**
 * pi backend — real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts + shared/child-session.ts):
 * - real session files visible in /resume, child resources loaded per-cwd
 *   with trust gating, and the child tool denylist;
 * - `session.subscribe()` events translated to normalized SubagentEvents;
 * - send() uses Pi's native steer/follow-up queues while streaming and starts
 *   a fresh prompt() when idle;
 * - interrupt clears the queue and aborts; closing the session scope emits
 *   the child session_shutdown hook and disposes the session.
 */

import type {
  AssistantMessage,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentToolResult,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createAgentSession,
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  ReasoningEffort,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentFailureProvenance,
  ParentQuestionRequest,
  SubagentMeta,
  TranscriptPart,
  EffectiveSubagentSendMode,
} from "../domain.ts";
import {
  PARENT_QUESTION_LIMITS,
  failureKindFromProvenance,
  isReasoningEffort,
  SendError,
  SpawnError,
} from "../domain.ts";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const CHILD_TOOL_CALL_TIMEOUT_MS = 3 * 60 * 1_000;
const CHILD_TOOL_TIMEOUT_EXEMPTIONS = new Set(["ask_parent"]);

/** Tools that headless children must not receive. Everything else stays enabled. */
const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_send",
  "subagent_inspect",
  "subagent_check",
  "subagent_list",
  "subagent_route",
  "subagent_approve",
  "workflow",
  "workflow_control",
  "ask_user",
] as const;
export function createAskParentTool(
  askParent: NonNullable<SpawnTask["askParent"]>,
) {
  return {
    name: "ask_parent",
    label: "Ask Parent",
    description:
      "Ask the owning parent one bounded question and wait for its answer. Use only when a decision or missing fact blocks progress; the parent may answer, steer, cancel, or let the finite deadline expire.",
    parameters: Type.Object({
      question: Type.String({
        maxLength: PARENT_QUESTION_LIMITS.maxQuestionLength,
        description: "The specific question that blocks progress",
      }),
      context: Type.Optional(
        Type.String({
          maxLength: PARENT_QUESTION_LIMITS.maxContextLength,
          description: "Minimal bounded context needed to answer",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: PARENT_QUESTION_LIMITS.minTimeoutSeconds,
          maximum: PARENT_QUESTION_LIMITS.maxTimeoutSeconds,
          description: "Finite wait deadline in seconds; default 300",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: ParentQuestionRequest,
      signal?: AbortSignal,
    ) {
      const answer = await askParent(params, signal);
      return {
        content: [{ type: "text" as const, text: answer }],
        details: { answered: true },
      };
    },
  };
}

// --- Model + effort resolution -----------------------------------------------

type ThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

export function resolvePiReasoningEffort(
  requested: ReasoningEffort | undefined,
  inherited: string | undefined,
): ReasoningEffort | undefined {
  return requested ?? (isReasoningEffort(inherited) ? inherited : undefined);
}

export function piRuntimeMeta(
  session: Pick<AgentSession, "thinkingLevel" | "sessionFile">,
  model: Pick<Model<any>, "provider" | "id" | "contextWindow"> | undefined,
): SubagentMeta {
  return {
    backend: "pi",
    modelLabel: model ? `${model.provider}/${model.id}` : undefined,
    reasoningEffort: session.thinkingLevel,
    contextWindow: model?.contextWindow,
    sessionFilePath: session.sessionFile,
  };
}

/**
 * Resolve the generic model hint against the parent registry (v1 semantics):
 * "provider/model-id" is exact; a bare id prefers the inherited provider,
 * then must be unambiguous across providers. No hint inherits the parent
 * model; with nothing to inherit, the SDK default applies.
 */
function resolvePiModel(
  registry: ModelRegistry,
  hint: string | undefined,
  inherited: { provider: string; id: string } | undefined,
): Model<any> | undefined {
  if (!hint) {
    if (!inherited) return undefined;
    return registry.find(inherited.provider, inherited.id) ?? undefined;
  }
  const slash = hint.indexOf("/");
  if (slash > 0) {
    const provider = hint.slice(0, slash);
    const id = hint.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    throw new Error(`Unknown model "${hint}".`);
  }
  if (inherited) {
    const found = registry.find(inherited.provider, hint);
    if (found) return found;
  }
  const matches = registry.getAll().filter((m) => m.id === hint);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${hint}" exists in multiple providers (${matches.map((m) => m.provider).join(", ")}). Use "provider/${hint}".`,
    );
  }
  throw new Error(`Unknown model "${hint}".`);
}

// --- Session resources -------------------------------------------------------

//
// What is shared vs per child (verified against the pi SDK resource loader):
// - Extension instances are NOT shareable. Their factories capture an
//   ExtensionAPI wired to the loader's `runtime`, which each AgentSession's
//   ExtensionRunner mutates via bindCore() and invalidates on dispose. Every
//   child therefore loads its own extension set (pi itself caches the module
//   imports, so this re-runs only the cheap factories).
// - SettingsManager is mutable (setters, reload, trust) and is created per
//   child; it is cheap (two small JSON reads).
// - Package resolution and the loaded skills, prompt templates, themes, and
//   context files are plain data derived from (agentDir, cwd, trust,
//   settings). They are loaded once per key into a snapshot and handed to
//   each child loader through the SDK's override hooks.

type ResolvedPackagePaths = Awaited<
  ReturnType<InstanceType<typeof DefaultPackageManager>["resolve"]>
>;
interface PiChildResourceSnapshot {
  readonly resolvedPaths: ResolvedPackagePaths;
  readonly skills: ReturnType<DefaultResourceLoader["getSkills"]>;
  readonly prompts: ReturnType<DefaultResourceLoader["getPrompts"]>;
  readonly themes: ReturnType<DefaultResourceLoader["getThemes"]>;
  readonly agentsFiles: ReturnType<DefaultResourceLoader["getAgentsFiles"]>;
}

/** Resource snapshots older than this are reloaded on the next spawn. */
export const PI_CHILD_RESOURCE_TTL_MS = 30_000;

/**
 * Keyed promise cache with a time-to-live and a cheap validity fingerprint.
 * Concurrent first requests for one key share a single in-flight load; a
 * rejected load is evicted so the next request retries.
 */
export class TimedLoadCache<V> {
  private readonly entries = new Map<
    string,
    { value: Promise<V>; loadedAt: number; fingerprint: string }
  >();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string, fingerprint: string, load: () => Promise<V>): Promise<V> {
    const time = this.now();
    const cached = this.entries.get(key);
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      time - cached.loadedAt < this.ttlMs
    ) {
      return cached.value;
    }
    for (const [entryKey, entry] of this.entries) {
      if (time - entry.loadedAt >= this.ttlMs) this.entries.delete(entryKey);
    }
    const entry = { value: load(), loadedAt: time, fingerprint };
    this.entries.set(key, entry);
    entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

const childResourceCache = new TimedLoadCache<PiChildResourceSnapshot>(
  PI_CHILD_RESOURCE_TTL_MS,
);

/** Drop all cached child resource snapshots (tests, /reload). */
export function clearPiChildResourceCache() {
  childResourceCache.clear();
}

function mtimeOf(path: string) {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "-";
  }
}

/** Settings files decide package/resource resolution; an edit invalidates. */
function resourceFingerprint(cwd: string, agentDir: string) {
  return [
    mtimeOf(join(agentDir, "settings.json")),
    mtimeOf(join(cwd, CONFIG_DIR_NAME, "settings.json")),
  ].join("|");
}

/**
 * Serve a precomputed package resolution to a loader. DefaultResourceLoader
 * owns its package manager privately; when the SDK shape is not what we
 * expect, the loader keeps resolving on its own (correct, just slower).
 */
function useResolvedPackagePaths(
  loader: DefaultResourceLoader,
  resolvedPaths: ResolvedPackagePaths,
) {
  const packageManager: unknown = loader["packageManager"];
  if (packageManager instanceof DefaultPackageManager) {
    packageManager.resolve = async () => structuredClone(resolvedPaths);
  }
}

async function loadChildResourceSnapshot(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): Promise<PiChildResourceSnapshot> {
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });
  const resolvedPaths = await new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  }).resolve();
  // Extensions are deliberately skipped: they are loaded per child.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
  });
  useResolvedPackagePaths(loader, resolvedPaths);
  await loader.reload();
  return {
    resolvedPaths,
    skills: loader.getSkills(),
    prompts: loader.getPrompts(),
    themes: loader.getThemes(),
    agentsFiles: loader.getAgentsFiles(),
  };
}

/** Snapshot entries first, then extension-discovered ones not shadowed by name. */
function mergeByName<T>(
  cached: readonly T[],
  discovered: readonly T[],
  name: (item: T) => string | undefined,
) {
  const seen = new Set(cached.map(name));
  return [...cached, ...discovered.filter((item) => !seen.has(name(item)))];
}

/**
 * Load normal global/package resources and trust-gated project resources.
 * Package resolution, skills, prompts, themes, and context files come from
 * a shared snapshot; settings and extensions are fresh for every child.
 */
export async function createPiChildResources(
  cwd: string,
  projectTrusted: boolean,
  agentDir: string = getAgentDir(),
) {
  const resolvedCwd = resolvePath(cwd);
  const resolvedAgentDir = resolvePath(agentDir);
  const snapshot = await childResourceCache.get(
    JSON.stringify([resolvedAgentDir, resolvedCwd, projectTrusted]),
    resourceFingerprint(resolvedCwd, resolvedAgentDir),
    () =>
      loadChildResourceSnapshot(resolvedCwd, resolvedAgentDir, projectTrusted),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });
  // The no* flags skip disk loads; the overrides then serve the snapshot.
  // Overrides also run for extendResources(), where `base` holds only the
  // extension-discovered resources, so those are merged after the snapshot.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: (base) => ({
      skills: mergeByName(snapshot.skills.skills, base.skills, (s) => s.name),
      diagnostics: [...snapshot.skills.diagnostics, ...base.diagnostics],
    }),
    promptsOverride: (base) => ({
      prompts: mergeByName(
        snapshot.prompts.prompts,
        base.prompts,
        (p) => p.name,
      ),
      diagnostics: [...snapshot.prompts.diagnostics, ...base.diagnostics],
    }),
    themesOverride: (base) => ({
      themes: mergeByName(snapshot.themes.themes, base.themes, (t) => t.name),
      diagnostics: [...snapshot.themes.diagnostics, ...base.diagnostics],
    }),
    agentsFilesOverride: () => ({
      agentsFiles: [...snapshot.agentsFiles.agentsFiles],
    }),
  });
  useResolvedPackagePaths(loader, snapshot.resolvedPaths);
  await loader.reload();
  return { loader, settingsManager };
}

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/** Emit child session_shutdown (bounded), then dispose. Never throws. */
/**
 * Resolve once the session's active run has stopped: on its agent_settled
 * event, or after a bounded fallback in case that event never arrives.
 * Handlers registered earlier (the event translator) run first, so the
 * run's own RunSettled lands before the caller resumes.
 */
export function waitForRunToStop(
  session: Pick<AgentSession, "isStreaming" | "subscribe">,
  timeoutMs = CHILD_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (!session.isStreaming) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_settled") finish();
    });
    if (done) unsubscribe();
    timer = setTimeout(finish, timeoutMs);
    // The run may have stopped between the first check and subscribing.
    if (!session.isStreaming) finish();
  });
}

async function shutdownAndDisposeChildSession(session: AgentSession) {
  try {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await waitBounded(
        session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        }),
        CHILD_SHUTDOWN_TIMEOUT_MS,
      );
    }
  } catch {
    // Extension runner inspection/emission is best-effort during teardown.
  } finally {
    try {
      session.dispose();
    } catch {
      // Disposal is terminal and must remain idempotent for callers.
    }
  }
}

// --- Tool-call timeout guard (ported from v1 shared/tool-call-timeout.ts) -----

/**
 * Wrap every registered child tool with an independent execution timeout so a
 * hung tool cannot wedge a headless child forever. apply() is idempotent and
 * re-applied on agent_start to pick up tools registered between runs.
 */
export function createToolCallTimeoutGuard(timeoutMs = CHILD_TOOL_CALL_TIMEOUT_MS) {
  const wrapped = new WeakSet<ToolDefinition>();

  const wrap = (definition: ToolDefinition) => {
    // ask_parent owns its own finite 30s-900s deadline. The generic 180s
    // guard must not turn its valid 300s/900s waits into early failures.
    if (CHILD_TOOL_TIMEOUT_EXEMPTIONS.has(definition.name)) return;
    if (wrapped.has(definition)) return;
    wrapped.add(definition);
    const execute = definition.execute;
    definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      const timeoutController = new AbortController();
      const executionSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `Tool call "${definition.name}" timed out after ${Math.round(timeoutMs / 60_000)} minutes.`,
          );
          reject(error);
          timeoutController.abort(error);
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          execute.call(
            definition,
            toolCallId,
            params,
            executionSignal,
            onUpdate,
            ctx,
          ),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
  };

  return {
    apply(session: AgentSession) {
      for (const { name } of session.getAllTools()) {
        const definition = session.getToolDefinition(name);
        if (definition) wrap(definition);
      }
    },
  };
}

// --- Event translation ----------------------------------------------------------

/**
 * Decoded preview JSON. Tool-call arguments are model-emitted JSON trees, so
 * preview rendering reads a named JsonValue contract instead of ad-hoc typeof
 * parsing over the SDK's `any`/`Record<string, any>` values.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

function lastAssistantMessage(
  session: AgentSession,
): AssistantMessage | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") return msg;
  }
  return undefined;
}

/** Final assistant text output (last assistant message with text), v1 semantics. */
function finalOutput(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: JsonValue): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * First non-empty line of a text content part (v1 liveToolPreview). The SDK's
 * tool events deliver `AgentToolResult` payloads, so the contract is the
 * owner-typed shape rather than an unparsed value.
 */
function toolPreview(result: AgentToolResult<unknown>): string | undefined {
  for (const part of result.content) {
    if (part.type !== "text") continue;
    const firstLine = part.text.split("\n").find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

function assistantParts(msg: AssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: part.redacted ? "" : part.thinking,
        redacted: part.redacted,
      });
    } else if (part.type === "toolCall") {
      // SAFETY: pi parses tool-call arguments from model-emitted JSON, so the
      // whole tree satisfies the JsonValue contract by construction.
      const argsPreview = safeJson(part.arguments as JsonValue);
      parts.push({
        type: "toolCall",
        toolId: part.id,
        name: part.name,
        argsPreview,
      });
    }
  }
  return parts;
}

function userText(message: UserMessage): string {
  const content = message.content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return content;
}

// --- The session ------------------------------------------------------------------

function boundedError(error: Error | string) {
  const text = error instanceof Error ? error.message : error;
  return text.slice(0, 4096);
}

function failure(
  provenance: SubagentFailureProvenance,
  errorText: string,
): Extract<RunOutcome, { readonly _tag: "Failed" }> {
  return {
    _tag: "Failed",
    errorText,
    failureKind: failureKindFromProvenance(provenance),
    failureProvenance: provenance,
  };
}

const makePiSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = task.parent.modelRegistry;
    if (!registry) {
      return yield* new SpawnError({
        message: "pi backend requires the parent session's model registry.",
      });
    }

    const model = yield* Effect.try({
      try: () =>
        resolvePiModel(registry, task.model, task.parent.inheritedModel),
      catch: (error) =>
        new SpawnError({
          message: boundedError(error instanceof Error ? error : String(error)),
        }),
    });
    // pi's thinking levels ARE the shared reasoning-effort scale.
    const thinkingLevel: ThinkingLevel | undefined = resolvePiReasoningEffort(
      task.reasoningEffort,
      task.parent.inheritedThinkingLevel,
    );

    const session = yield* Effect.tryPromise({
      try: async () => {
        const { loader, settingsManager } = await createPiChildResources(
          task.cwd,
          task.parent.projectTrusted,
        );
        const { session } = await createAgentSession({
          cwd: task.cwd,
          sessionManager: SessionManager.create(task.cwd),
          settingsManager,
          resourceLoader: loader,
          modelRegistry: registry,
          model,
          thinkingLevel,
          excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES],
          customTools: task.askParent
            ? [createAskParentTool(task.askParent)]
            : undefined,
        });
        // Start child extension session hooks/resources in headless mode.
        // A rejection here would otherwise leak the freshly created session:
        // the scope finalizer that owns cleanup is only registered later.
        try {
          await session.bindExtensions({ mode: "print" });
        } catch (error) {
          await shutdownAndDisposeChildSession(session);
          throw error;
        }
        return session;
      },
      catch: (error) =>
        new SpawnError({
          message: boundedError(error instanceof Error ? error : String(error)),
        }),
    });

    // SAFETY: the initial run-error marker is the undefined member of
    // `string | undefined`; prompt() rejections assign bounded strings to it.
    const state = {
      closed: false,
      /** prompt() rejection for the active run; folded into RunSettled. */
      runError: undefined as string | undefined,
      /** One terminal event per run: lifecycle, prompt-rejection, and abort
       * fallbacks can all race to settle; the first wins. */
      settled: false,
    };

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const toolTimeout = createToolCallTimeoutGuard();
    toolTimeout.apply(session);

    const activeModel = (): Model<any> | undefined => {
      const sessionModel = session.model;
      const last = lastAssistantMessage(session);
      if (!last) return sessionModel;
      if (
        sessionModel &&
        (last.provider !== sessionModel.provider ||
          last.model !== sessionModel.id)
      ) {
        // The session changed models after this assistant response.
        return sessionModel;
      }
      return (
        registry.find(last.provider, last.responseModel ?? last.model) ??
        sessionModel
      );
    };

    const currentMeta = (): SubagentMeta =>
      piRuntimeMeta(session, activeModel());

    const emitUsage = () => {
      const usage = session.getContextUsage();
      emit({
        _tag: "UsageChanged",
        tokens: usage?.tokens ?? undefined,
        contextWindow: activeModel()?.contextWindow ?? usage?.contextWindow,
      });
    };

    const settle = () => {
      if (state.settled) return;
      state.settled = true;
      const last = lastAssistantMessage(session);
      const partialText = finalOutput(session) || undefined;
      if (last?.stopReason === "aborted") {
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Interrupted", partialText },
        });
        return;
      }
      const errorText =
        state.runError ??
        (last?.stopReason === "error"
          ? (last.errorMessage ?? "Run failed")
          : undefined);
      if (errorText !== undefined) {
        emit({
          _tag: "RunSettled",
          outcome: {
            ...failure({ _tag: "unknown" }, boundedError(errorText)),
            partialText,
          },
        });
        return;
      }
      emit({
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: finalOutput(session) },
      });
    };

    const handleEvent = (event: AgentSessionEvent) => {
      if (state.closed) return;
      switch (event.type) {
        case "agent_start":
          // Extensions may register tools between runs; guard new ones too.
          toolTimeout.apply(session);
          state.settled = false;
          emit({ _tag: "RunStarted" });
          break;
        case "thinking_level_changed":
          emit({ _tag: "MetaChanged", meta: currentMeta() });
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent.type === "text_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "text",
              delta: streamEvent.delta,
            });
          } else if (streamEvent.type === "thinking_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "thinking",
              delta: streamEvent.delta,
            });
          }
          break;
        }
        case "message_end": {
          const message = event.message;
          if (message.role === "user") {
            const text = userText(message);
            if (text.trim()) emit({ _tag: "UserMessage", text });
          } else if (message.role === "assistant") {
            emit({
              _tag: "AssistantMessage",
              parts: assistantParts(message),
            });
            emitUsage();
            emit({ _tag: "MetaChanged", meta: currentMeta() });
          }
          // toolResult messages are covered by tool_execution_end.
          break;
        }
        case "tool_execution_start":
          // SAFETY: tool-call arguments are model-emitted JSON, so the whole
          // tree satisfies the JsonValue contract by construction.
          emit({
            _tag: "ToolStart",
            toolId: event.toolCallId,
            name: event.toolName,
            argsPreview: safeJson(event.args as JsonValue),
          });
          break;
        case "tool_execution_update":
          emit({
            _tag: "ToolUpdate",
            toolId: event.toolCallId,
            outputPreview: toolPreview(event.partialResult),
          });
          break;
        case "tool_execution_end":
          emit({
            _tag: "ToolEnd",
            toolId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            outputPreview: toolPreview(event.result),
          });
          break;
        case "queue_update":
          emit({
            _tag: "QueueChanged",
            queued: [
              ...event.steering.map((text) => ({
                text,
                kind: "steer" as const,
              })),
              ...event.followUp.map((text) => ({
                text,
                kind: "follow-up" as const,
              })),
            ],
          });
          break;
        case "agent_settled":
          settle();
          break;
      }
    };
    const unsubscribe = session.subscribe(handleEvent);

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true;
        unsubscribe();
        try {
          session.clearQueue();
        } catch {
          // Continue with abort/dispose.
        }
        await waitBounded(session.abort(), CHILD_SHUTDOWN_TIMEOUT_MS);
        await shutdownAndDisposeChildSession(session);
        Queue.endUnsafe(events);
      }),
    );

    /** Start a fresh run (v1 manager.run): fire-and-forget, errors -> events. */
    const startRun = (text: string) => {
      state.runError = undefined;
      state.settled = false;
      emit({ _tag: "RunStarted" });
      void session.prompt(text).catch((error) => {
        state.runError = boundedError(
          error instanceof Error ? error : String(error),
        );
        // Preflight failures may never start the agent lifecycle, so no
        // agent_settled will arrive for them.
        if (!session.isStreaming) settle();
      });
    };

    // Session naming is best-effort.
    yield* Effect.try(() =>
      session.sessionManager.appendSessionInfo(
        `${task.owner ?? "subagents"}: ${task.title}`,
      ),
    ).pipe(Effect.ignore);

    emit({ _tag: "MetaChanged", meta: currentMeta() });
    startRun(task.prompt);

    return {
      meta: Effect.sync(currentMeta),
      events: Stream.fromQueue(events),
      send: (text, mode: EffectiveSubagentSendMode) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          if (session.isStreaming) {
            // Use the selected native queue; queue_update events render it,
            // and message_end(user) lands it in the transcript. A rejected
            // delivery is a real send failure, not a diagnostic.
            return Effect.tryPromise({
              try: () =>
                mode === "steer" ? session.steer(text) : session.followUp(text),
              catch: (error) =>
                new SendError({
                  message: boundedError(
                    error instanceof Error ? error : String(error),
                  ),
                }),
            }).pipe(Effect.asVoid);
          }
          return Effect.sync(() => startRun(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed) return;
        try {
          session.clearQueue();
        } catch {
          // Abort regardless.
        }
        await session.abort().catch(() => undefined);
        // Only resolve once streaming has actually stopped: reporting the
        // interrupt as complete while the run keeps working would let the
        // manager settle a run that is still mutating the workspace. The
        // manager bounds this effect at 5s and force-disposes on timeout.
        if (!state.closed) await waitForRunToStop(session);
        // No streaming run means no agent_settled will arrive; emit the
        // terminal event (once) so the run cannot look running forever.
        if (!state.closed && !state.settled) {
          state.settled = true;
          emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
        }
      }),
    } satisfies SubagentSession;
  });

export const piBackend: SubagentBackend = {
  name: "pi",
  capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
  // In-process SDK: always available.
  available: Effect.succeed(true),
  spawn: makePiSession,
};
