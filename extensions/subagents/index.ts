/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Tool inputs are TypeBox-validated; conditional spreads preserve omission in immutable proposal bindings. */

/**
 * Subagents — spawn background subagents on Pi or Codex, unified behind a
 * single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn of one task or a `tasks` batch
 *   (prompt, name, harness, working_dir, model, reasoning_effort). At most
 *   `maxRunning` (settings, default 6) run at once across all backends.
 * - subagent_wait: block until all (or, with mode "any", one) of the listed
 *   parent-owned subagents settle, return results.
 * - subagent_cancel: stop one or more queued/running parent-owned subagents.
 * - subagent_send: send another instruction to one parent-owned subagent.
 * - subagent_inspect: peek at a parent-owned subagent's status and recent activity.
 * - subagent_check: compatibility alias for subagent_inspect.
 * - subagent_list: list all parent-owned subagents.
 *
 * Unawaited parent-owned subagents queue their result as a follow-up message
 * when they settle. `/subagents` opens a picker + full interactive takeover
 * view; client-owned jobs stay in the client API surface.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. Both backends are real: pi runs
 * in-process SDK sessions and codex speaks JSON-RPC to a scoped
 * `codex app-server` process.
 */

import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  BACKEND_NAMES,
  formatElapsed,
  isSubagentPending,
  MAX_RUNNING_LIMITS,
  REASONING_EFFORTS,
  type ParentQuestion,
  type ParentRef,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatContextUtilization,
} from "./src/format.ts";
import {
  operatorSubagentView,
  parentSubagentView,
  SubagentManager,
  type SubagentManagerApi,
  type SubagentReadModel,
} from "./src/manager.ts";
import {
  clientSettlement,
  registerSubagentClientApi,
} from "./src/client-api.ts";
import { SUBAGENT_CLIENT_CHANNELS } from "./src/client-protocol.ts";
import {
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  subagentSpawnToolDescription,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { registerSubagentParentTools } from "./src/parent-tools.ts";
import { createParentResultCoordinator } from "./src/parent-coordinator.ts";
import type { ParentResultEnvelope } from "./src/parent-mailbox.ts";
import {
  buildSubagentWaitResult,
  formatWaitRemainder,
  partitionWaitResult,
  type WaitMode,
} from "./src/result-delivery.ts";
import {
  buildParentQuestionBatchMessage,
  buildParentResultBatchMessage,
  PARENT_QUESTION_BATCH_OPTIONS,
  PARENT_RESULT_BATCH_OPTIONS,
  type ParentQuestionBatchDetails,
} from "./src/parent-message.ts";
import { captureParentRef, isSafeParentRef } from "./src/parent-ref.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import {
  WorkflowManager,
  type WorkflowExecutionOptions,
} from "./src/workflows/manager.ts";
import { WorkflowArtifactStore } from "./src/workflows/artifacts.ts";
import {
  isWorkflowTerminal,
  type WorkflowReadModel,
} from "./src/workflows/domain.ts";
import {
  applyWorkflowControl,
  staticWorkflowDefinitionPreparer,
  WorkflowToolLifecycle,
} from "./src/workflows/tools.ts";
import { WorkflowControls } from "./src/workflows/controls.ts";
import { showWorkflowDraftReview } from "./src/workflows/draft-review.ts";
import { openWorkflowDashboard } from "./src/ui/workflow-dashboard.ts";
import {
  loadWorkflowDraft,
  workflowDraftArtifactPath,
} from "./src/workflows/drafts.ts";
import {
  WORKFLOW_CHECK_TOOL_DESCRIPTION,
  WORKFLOW_CHECK_PARAMETER_DESCRIPTIONS,
  WORKFLOW_CONTROL_TOOL_DESCRIPTION,
  WORKFLOW_LIST_TOOL_DESCRIPTION,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./src/workflows/prompt.ts";
import { openSubagentPicker } from "./src/ui/takeover.ts";
import { loadSubagentSettings } from "./src/routing/settings.ts";
import { registerSubagentsSettingsCommand } from "./src/integration/settings-command.ts";
import {
  admitBatch,
  batchOutcomes,
  formatBatchSpawnResult,
  MAX_SPAWN_BATCH,
  normalizeSpawnRequest,
  resolveWorkingDir,
  SPAWN_BATCH_TASK_PARAMETERS,
  taskLabel,
  type BatchSpawnOutcome,
  type SpawnedTask,
} from "./src/integration/spawn-batch.ts";
import {
  parseWorkflowControlRequest,
  parseWorkflowToolRequest,
  WORKFLOW_CONTROL_TOOL_PARAMS,
  WORKFLOW_TOOL_PARAMS,
  type WorkflowControlToolParams,
  type WorkflowToolParams,
} from "./src/integration/workflow-params.ts";
import {
  ROUTING_CLASSIFICATION_PARAMETERS,
  ROUTED_SPAWN_TASK_PARAMETERS,
  StandaloneRoutingController,
  type BoundRoutedSpawnTask,
  type RoutedSpawnTaskParams,
} from "./src/integration/routing.ts";
import type {
  ConcreteRuntimeSelection,
  ModelLookup,
} from "./src/routing/domain.ts";
import { createWorkflowRoutingPreparer } from "./src/integration/workflow-routing.ts";
import {
  formatWorkflowList,
  formatWorkflowProjection,
  formatWorkflowRecoveryFailures,
  formatWorkflowRecoveryOmissions,
  projectWorkflowList,
  projectWorkflowRun,
  projectWorkflowRecoveryFailures,
  projectWorkflowRecoveryOmissions,
  workflowActiveWorkItem,
  workflowActiveWorkRemoval,
  workflowResultEnvelope,
} from "./src/workflows/projection.ts";
import {
  ACTIVE_WORK_CHANNELS,
  subagentActiveWorkItem,
  subagentActiveWorkRemoval,
  type ActiveWorkItem,
} from "./src/activity-protocol.ts";
import {
  BROWSER_ACTIVITY_WIDGET_KEY,
  encodeBrowserActivityWidget,
  nextBrowserActivityRevision,
  projectBrowserActivity,
} from "./src/browser-protocol.ts";
import {
  renderSubagentActivity,
  renderSubagentWaitSummary,
} from "./src/ui/activity-card.ts";

const WAIT_MODES = ["all", "any"] as const;
const HEADLESS_LABEL_MAX_LENGTH = 80;
const HEADLESS_OUTPUT_MAX_LENGTH = 2_000;
const HEADLESS_NOTIFY_MAX_LENGTH = 300;
const CLOSE_CHOICE = "Close";
const STEER_CHOICE = "Steer…";
const ABORT_CHOICE = "Abort";
const SHOW_OUTPUT_CHOICE = "Show output";
const BACK_CHOICE = "Back";

/**
 * Fallback theme for rendering wait summaries when no UI session is active
 * (headless runs): plain passthrough, so the ribbon text stays readable even
 * when there is nothing to color.
 */
// SAFETY: Headless rendering uses only the passthrough fg and bold methods.
const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

export interface HeadlessSubagentsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  editor?(title: string, prefill?: string): Promise<string | undefined>;
}

type HeadlessSubagentView = Pick<
  SubagentReadModel,
  "list" | "get" | "requestSend" | "requestAbort"
>;

/** Structured details attached to subagent-result messages. */
export interface SubagentResultDetails {
  kind?: "workflow";
  id?: string;
  title?: string;
  status?: string;
}

export interface SubagentResultBatchDetails {
  results?: ReadonlyArray<SubagentResultDetails>;
}

function singleLine(text: string) {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateCharacters(text: string, maxLength: number) {
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  if (maxLength <= 1) return characters.slice(0, maxLength).join("");
  return `${characters.slice(0, maxLength - 1).join("")}…`;
}

function headlessSnapshotLabel(snap: SubagentSnapshot) {
  const prefix = `${singleLine(snap.id)} [${snap.status}] `;
  const suffix = ` (${snap.backend})`;
  const titleLength = Math.max(
    1,
    HEADLESS_LABEL_MAX_LENGTH -
      Array.from(prefix).length -
      Array.from(suffix).length,
  );
  return truncateCharacters(
    `${prefix}${truncateCharacters(singleLine(snap.title), titleLength)}${suffix}`,
    HEADLESS_LABEL_MAX_LENGTH,
  );
}

function transcriptTail(snap: SubagentSnapshot) {
  return snap.transcript
    .map((item) => {
      switch (item.kind) {
        case "user":
          return `User: ${item.text}`;
        case "assistant":
          return item.parts
            .map((part) => {
              switch (part.type) {
                case "text":
                  return part.text;
                case "thinking":
                  return part.text;
                case "toolCall":
                  return `[Tool: ${part.name}${part.argsPreview ? ` ${part.argsPreview}` : ""}]`;
              }
            })
            .join("\n");
        case "toolResult":
          return `[${item.isError ? "Tool error" : "Tool result"}: ${item.name}${item.outputPreview ? ` ${item.outputPreview}` : ""}]`;
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

function headlessOutput(snap: SubagentSnapshot) {
  const preferred = isSubagentPending(snap.status)
    ? snap.liveAssistant?.text.trim()
    : snap.finalText.trim();
  const output = preferred || transcriptTail(snap).trim() || "(no output yet)";
  return output.slice(-HEADLESS_OUTPUT_MAX_LENGTH);
}

/** Standard-dialog fallback for RPC/web clients where custom TUI views are unavailable. */
export async function runHeadlessSubagentsDialog(
  ui: HeadlessSubagentsUI,
  view: HeadlessSubagentView,
): Promise<void> {
  while (true) {
    const snapshots = view.list();
    if (snapshots.length === 0) {
      ui.notify(
        "No subagents yet. The agent spawns them with subagent_spawn.",
        "info",
      );
      return;
    }

    const choices = snapshots.map(headlessSnapshotLabel);
    const selected = await ui.select("Subagents", [...choices, CLOSE_CHOICE]);
    if (selected === undefined || selected === CLOSE_CHOICE) return;

    const selectedIndex = choices.indexOf(selected);
    const selectedSnapshot = snapshots[selectedIndex];
    if (selectedSnapshot === undefined) continue;
    const id = selectedSnapshot.id;

    while (true) {
      const snap = view.get(id);
      if (snap === undefined) break;
      const actions = [
        ...(snap.status === "running" ? [STEER_CHOICE] : []),
        ...(isSubagentPending(snap.status) ? [ABORT_CHOICE] : []),
        SHOW_OUTPUT_CHOICE,
        BACK_CHOICE,
      ];
      const action = await ui.select(
        `${snap.id} — ${singleLine(snap.title)}`,
        actions,
      );
      if (action === undefined || action === BACK_CHOICE) break;

      if (action === STEER_CHOICE && snap.status === "running") {
        const text = await ui.input(
          `Steer ${snap.id}`,
          "Message to the subagent",
        );
        if (text !== undefined && text.trim().length > 0) {
          view.requestSend(id, text);
          ui.notify(`Sent to ${id}`, "info");
        }
        continue;
      }

      if (action === ABORT_CHOICE && isSubagentPending(snap.status)) {
        if (await ui.confirm(`Abort ${snap.id}?`, snap.title)) {
          view.requestAbort(id);
          ui.notify(`Abort requested for ${id}`, "info");
        }
        continue;
      }

      if (action === SHOW_OUTPUT_CHOICE) {
        const output = headlessOutput(snap);
        if (ui.editor !== undefined) {
          await ui.editor(`${snap.id} output`, output);
        } else {
          ui.notify(output.slice(-HEADLESS_NOTIFY_MAX_LENGTH), "info");
        }
      }
    }
  }
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let runtime: SubagentRuntime | undefined;
  let managerInitialization:
    | {
        readonly epoch: number;
        readonly cwd: string;
        readonly promise: Promise<SubagentManagerApi>;
      }
    | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  let disposeClientApi: (() => void) | undefined;
  let observabilityTimer: ReturnType<typeof setTimeout> | undefined;
  let renderView: SubagentReadModel | undefined;
  const publishedActivity = new Map<ActiveWorkItem["key"], ActiveWorkItem>();
  let browserUI: ExtensionUIContext | undefined;
  let browserRevision = 0;
  let publishedStatus: string | undefined;
  let sessionEpoch = 0;
  let sessionClosed = false;
  let userInputRevision = 0;
  let workflowManager: WorkflowManager | undefined;
  let workflowControls: WorkflowControls | undefined;
  let workflowLifecycle: WorkflowToolLifecycle | undefined;
  const standaloneRouting = new StandaloneRoutingController();
  const workflowParentRefs = new Map<string, ParentRef>();
  let publishWorkflowResult:
    ((run: WorkflowReadModel, parentRef: ParentRef) => void) | undefined;

  /** Cap advertised by the registered subagent_spawn description. */
  let registeredSpawnCap: number = MAX_RUNNING_LIMITS.default;
  /** Cap read for the current session; a runtime keeps the cap it was created with. */
  let sessionMaxRunning: number | undefined;
  let runtimeMaxRunning: number | undefined;

  /** Effective maxRunning from settings; invalid settings fall back to the default with a warning. */
  const readMaxRunning = (ctx: ExtensionContext | undefined): number => {
    try {
      return loadSubagentSettings({
        cwd: ctx?.cwd ?? process.cwd(),
        projectTrusted: ctx?.isProjectTrusted() ?? false,
      }).settings.maxRunning;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx?.hasUI) {
        ctx.ui.notify(
          `Subagent settings are invalid; using maxRunning ${MAX_RUNNING_LIMITS.default}: ${message.slice(0, 256)}`,
          "warning",
        );
      }
      return MAX_RUNNING_LIMITS.default;
    }
  };

  const getRuntime = () => {
    if (!runtime) {
      runtimeMaxRunning = sessionMaxRunning ?? readMaxRunning(sessionContext);
      runtime = createSubagentRuntime({ maxRunning: runtimeMaxRunning });
    }
    return runtime;
  };

  /** Resolve one manager per session epoch; stale completions cannot install hooks. */
  const getManager = () => {
    const epoch = sessionEpoch;
    const cwd = sessionContext?.cwd;
    if (cwd === undefined || sessionClosed) {
      return Promise.reject(
        new Error("Subagent manager requires an active session."),
      );
    }
    if (
      managerInitialization?.epoch === epoch &&
      managerInitialization.cwd === cwd
    ) {
      return managerInitialization.promise;
    }
    const promise = getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        if (
          sessionClosed ||
          sessionEpoch !== epoch ||
          sessionContext?.cwd !== cwd
        ) {
          throw new Error("Discarding stale subagent manager initialization.");
        }
        manager.view.setOnSettled(onSettled);
        manager.view.setOnQuestion?.((question) => {
          parentResults.onQuestion(question);
          if (sessionContext) parentResults.flush(sessionContext);
        });
        manager.view.setOnQuestionResolved?.((question) => {
          parentResults.consumeQuestions([question]);
        });
        renderView = parentSubagentView(manager.view);
        const workflowsDir = path.join(getAgentDir(), "workflows");
        const artifactStore = new WorkflowArtifactStore({
          workflowsDir,
          cwd,
        });
        workflowManager = new WorkflowManager({
          subagents: manager,
          artifacts: artifactStore,
        });
        workflowLifecycle = new WorkflowToolLifecycle({
          workflowsDir,
          agentDir: getAgentDir(),
          manager: workflowManager,
          preparer: createWorkflowRoutingPreparer(
            staticWorkflowDefinitionPreparer,
            () => {
              const ctx = sessionContext;
              if (!ctx) {
                throw new Error("Workflow routing requires an active session.");
              }
              const settings = loadSubagentSettings({
                cwd: ctx.cwd,
                projectTrusted: ctx.isProjectTrusted(),
              });
              return {
                settings,
                lookupModel: lookupRoutedModel(ctx),
              };
            },
          ),
        });
        workflowControls = new WorkflowControls(workflowManager);
        const schedule = () => scheduleObservability(manager);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(schedule);
        refreshObservability(manager);
        return manager;
      });
    managerInitialization = { epoch, cwd, promise };
    return promise;
  };

  const workflowExecutionFor = (
    ctx: ExtensionContext,
    manager: SubagentManagerApi,
  ): WorkflowExecutionOptions => {
    const parentRef = captureParentRef(sessionEpoch, ctx.sessionManager);
    return {
      subagents: manager,
      cwd: ctx.cwd,
      parentRef,
      onTerminal: (run) => {
        if (sessionClosed) return;
        workflowParentRefs.set(run.id, parentRef);
        publishWorkflowResult?.(run, parentRef);
        scheduleObservability(manager);
      },
      parent: {
        parentCwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        inheritedModel: ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : undefined,
        inheritedThinkingLevel: pi.getThinkingLevel(),
        modelRegistry: ctx.modelRegistry,
      },
    };
  };

  pi.on("input", (event) => {
    if (event.source !== "extension") userInputRevision += 1;
    return { action: "continue" };
  });
  const standardView = (manager: SubagentManagerApi) =>
    parentSubagentView(manager.view);
  const operatorView = (manager: SubagentManagerApi) =>
    operatorSubagentView(manager.view);
  const openWorkflowEntry = async (
    ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">,
    manager: SubagentManagerApi,
    selection: { runId?: string } = {},
  ): Promise<boolean> => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Workflow dashboard is only available in the TUI",
          "error",
        );
      }
      return false;
    }
    const workflows = workflowManager;
    if (!workflows || workflows.list().length === 0) {
      ctx.ui.notify(
        "No workflow runs yet. Prepare and approve a workflow first.",
        "info",
      );
      return false;
    }
    return openWorkflowDashboard(
      ctx,
      workflows,
      operatorView(manager),
      selection,
    );
  };
  const standardSnapshots = (manager: SubagentManagerApi) =>
    standardView(manager).list();
  const standardSnapshot = (manager: SubagentManagerApi, id: string) =>
    standardView(manager).get(id);
  const publishSubagentActivity = (manager: SubagentManagerApi) => {
    const active = new Set<ActiveWorkItem["key"]>();
    for (const snap of standardSnapshots(manager)) {
      const item = subagentActiveWorkItem(snap);
      const key = `subagent:${snap.id}` as const;
      if (item) {
        active.add(key);
        const previous = publishedActivity.get(key);
        publishedActivity.set(key, item);
        if (
          !previous ||
          previous.label !== item.label ||
          previous.status !== item.status ||
          previous.summary !== item.summary ||
          previous.currentOperation !== item.currentOperation ||
          previous.runningProcesses !== item.runningProcesses ||
          previous.modelLabel !== item.modelLabel ||
          previous.contextPercent !== item.contextPercent ||
          previous.completedOperations !== item.completedOperations
        ) {
          pi.events.emit(ACTIVE_WORK_CHANNELS.update, item);
        }
      } else if (publishedActivity.delete(key)) {
        // Settled (or dropped): carry the final status so the rail can show a
        // brief done/failed flash row.
        pi.events.emit(
          ACTIVE_WORK_CHANNELS.remove,
          subagentActiveWorkRemoval(snap),
        );
      }
    }
    for (const key of publishedActivity.keys()) {
      if (active.has(key) || key.startsWith("workflow:")) continue;
      publishedActivity.delete(key);
      pi.events.emit(ACTIVE_WORK_CHANNELS.remove, { version: 1, key });
    }
  };

  const publishWorkflowActivity = (manager: SubagentManagerApi) => {
    const workflowSnapshots = manager.view.list();
    const active = new Set<ActiveWorkItem["key"]>();
    for (const run of workflowManager?.list() ?? []) {
      const item = workflowActiveWorkItem(run, workflowSnapshots);
      if (item) {
        active.add(item.key);
        const previous = publishedActivity.get(item.key);
        publishedActivity.set(item.key, item);
        if (
          !previous ||
          previous.label !== item.label ||
          previous.status !== item.status ||
          previous.summary !== item.summary ||
          previous.currentOperation !== item.currentOperation ||
          previous.runningProcesses !== item.runningProcesses ||
          previous.completedOperations !== item.completedOperations
        ) {
          pi.events.emit(ACTIVE_WORK_CHANNELS.update, item);
        }
        continue;
      }

      const removal = workflowActiveWorkRemoval(run, workflowSnapshots);
      if (publishedActivity.delete(removal.key)) {
        pi.events.emit(ACTIVE_WORK_CHANNELS.remove, removal);
      }
    }
    for (const key of publishedActivity.keys()) {
      if (!key.startsWith("workflow:") || active.has(key)) continue;
      publishedActivity.delete(key);
      pi.events.emit(ACTIVE_WORK_CHANNELS.remove, { version: 1, key });
    }
  };
  const publishBrowserActivity = (
    snapshots: ReadonlyArray<SubagentSnapshot>,
    terminal?: SubagentSnapshot,
  ) => {
    if (!browserUI) return;
    const snapshot = projectBrowserActivity(
      snapshots,
      nextBrowserActivityRevision(browserRevision),
      terminal,
    );
    browserRevision = snapshot.revision;
    browserUI.setWidget(
      BROWSER_ACTIVITY_WIDGET_KEY,
      encodeBrowserActivityWidget(snapshot),
    );
  };

  const scheduleObservability = (manager: SubagentManagerApi) => {
    if (observabilityTimer) return;
    observabilityTimer = setTimeout(() => {
      observabilityTimer = undefined;
      refreshObservability(manager);
    }, 100);
    observabilityTimer.unref?.();
  };

  const refreshObservability = (manager: SubagentManagerApi) => {
    updateStatus(manager);
    publishSubagentActivity(manager);
    publishWorkflowActivity(manager);
    publishBrowserActivity(standardSnapshots(manager));
  };

  const updateStatus = (manager: SubagentManagerApi) => {
    if (!ui) return;
    const subs = standardSnapshots(manager);
    if (subs.length === 0) {
      if (publishedStatus !== undefined) {
        publishedStatus = undefined;
        ui.setStatus("subagents", undefined);
      }
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const queued = subs.filter((snap) => snap.status === "queued").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - queued - running - failed;
    const status = formatActivityStatus(ui.theme, {
      queued,
      running,
      done,
      failed,
    });
    if (status === publishedStatus) return;
    publishedStatus = status;
    ui.setStatus("subagents", status);
  };

  const sendParentResultBatch = (
    batch: ReadonlyArray<ParentResultEnvelope>,
  ) => {
    pi.sendMessage(
      buildParentResultBatchMessage(batch),
      PARENT_RESULT_BATCH_OPTIONS,
    );
  };

  const sendParentQuestionBatch = (batch: ReadonlyArray<ParentQuestion>) => {
    pi.sendMessage(
      buildParentQuestionBatchMessage(batch),
      PARENT_QUESTION_BATCH_OPTIONS,
    );
  };

  const parentResults = createParentResultCoordinator({
    sendBatch: sendParentResultBatch,
    sendQuestionBatch: sendParentQuestionBatch,
  });
  publishWorkflowResult = (run, parentRef) => {
    const envelope = workflowResultEnvelope(run, parentRef);
    if (!envelope) return;
    parentResults.onWorkflowSettled(envelope, false);
    if (sessionContext) parentResults.flush(sessionContext);
  };

  const inspectWorkflow = (manager: SubagentManagerApi, runId: string) => {
    const run = workflowManager?.get(runId);
    if (!run) {
      const failure = workflowManager?.recoveryFailures.find(
        (item) => item.runId === runId,
      );
      if (failure) {
        throw new Error(
          `Workflow run id "${runId}" could not be recovered: ${failure.message}`,
        );
      }
      throw new Error(`Unknown workflow run id "${runId}".`);
    }
    const projection = projectWorkflowRun(run, manager.view.list());
    if (isWorkflowTerminal(run.status)) {
      const parentRef = workflowParentRefs.get(run.id);
      if (parentRef) parentResults.consumeWorkflow(run.id, parentRef);
    }
    return {
      projection,
      text: formatWorkflowProjection(projection),
    };
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    if (sessionClosed) return;
    // Workflow children are observed by WorkflowManager through their stable
    // settlement handles. They must never enter parent messages or client
    // channels, even though the shared manager has one global settle hook.
    if (snap.resultDelivery === "workflow") return;
    const parentVisible =
      snap.client === undefined && snap.resultDelivery === "parent";
    publishBrowserActivity(
      renderView?.list() ?? [],
      parentVisible ? snap : undefined,
    );
    if (!parentVisible) {
      const event = clientSettlement(snap);
      if (event) pi.events.emit(SUBAGENT_CLIENT_CHANNELS.settled, event);
      return;
    }
    parentResults.onSettled(snap, consumed);
    if (sessionContext) parentResults.flush(sessionContext);
  };

  pi.on("session_start", (_event, ctx) => {
    sessionEpoch += 1;
    workflowParentRefs.clear();
    standaloneRouting.clear();
    sessionClosed = false;
    parentResults.startSession(ctx, sessionEpoch);
    browserUI?.setWidget(BROWSER_ACTIVITY_WIDGET_KEY, undefined);
    sessionContext = ctx;
    ui = ctx.hasUI ? ctx.ui : undefined;
    sessionMaxRunning = readMaxRunning(ctx);
    // Tool descriptions are static per registration; re-register so the model
    // sees the cap this session's runtime enforces.
    const effectiveCap = runtime
      ? (runtimeMaxRunning ?? sessionMaxRunning)
      : sessionMaxRunning;
    if (effectiveCap !== registeredSpawnCap) {
      registeredSpawnCap = effectiveCap;
      registerSpawnTool(effectiveCap);
    }
    browserUI = ctx.mode === "rpc" && ctx.hasUI ? ctx.ui : undefined;
    browserRevision = 0;
    const startEpoch = sessionEpoch;
    void getManager()
      .then((manager) => {
        if (sessionClosed || sessionEpoch !== startEpoch) return;
        if (browserUI) refreshObservability(manager);
        const recoveryFailures = workflowManager?.recoveryFailures ?? [];
        if (recoveryFailures.length > 0 && ui) {
          ui.notify(
            `Workflow recovery found ${recoveryFailures.length} artifact issue(s); workflow_list reports bounded details.`,
            "warning",
          );
        }
      })
      .catch((error) => {
        if (sessionClosed || sessionEpoch !== startEpoch) return;
        const message = error instanceof Error ? error.message : String(error);
        ui?.notify(
          `Workflow recovery unavailable: ${message.slice(0, 256)}`,
          "warning",
        );
      });
  });

  pi.on("agent_settled", (_event, ctx) => {
    parentResults.flush(ctx);
  });

  disposeClientApi = registerSubagentClientApi({
    pi,
    getManager,
    getRuntime,
    getSessionContext: () => sessionContext,
    getParentEpoch: () => sessionEpoch,
    resolveChildProjectTrust,
  });

  pi.on("session_shutdown", async () => {
    sessionClosed = true;
    parentResults.close();
    disposeClientApi?.();
    disposeClientApi = undefined;
    sessionContext = undefined;
    unsubStatus?.();
    unsubStatus = undefined;
    if (observabilityTimer) clearTimeout(observabilityTimer);
    observabilityTimer = undefined;
    renderView = undefined;
    browserUI?.setWidget(BROWSER_ACTIVITY_WIDGET_KEY, undefined);
    browserUI = undefined;
    browserRevision = 0;
    for (const key of publishedActivity.keys()) {
      pi.events.emit(ACTIVE_WORK_CHANNELS.remove, { version: 1, key });
    }
    publishedActivity.clear();
    publishedStatus = undefined;
    ui?.setStatus("subagents", undefined);
    const closingWorkflow = workflowManager;
    workflowManager = undefined;
    workflowLifecycle = undefined;
    workflowControls = undefined;
    workflowParentRefs.clear();
    standaloneRouting.clear();
    const closing = runtime;
    runtime = undefined;
    runtimeMaxRunning = undefined;
    sessionMaxRunning = undefined;
    managerInitialization = undefined;
    // Seal workflow state and propagate cancellation while the shared
    // SubagentManager runtime is still alive, then dispose child scopes.
    try {
      await closingWorkflow?.shutdown("Session is shutting down");
    } finally {
      await closing?.dispose();
    }
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: [...WORKFLOW_PROMPT_GUIDELINES],
    parameters: WORKFLOW_TOOL_PARAMS,
    async execute(
      _toolCallId,
      params: WorkflowToolParams,
      _signal,
      _onUpdate,
      ctx,
    ) {
      const manager = await getManager();
      const lifecycle = workflowLifecycle;
      if (!lifecycle) throw new Error("Workflow lifecycle is not initialized.");
      const context = {
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        userInput: userInputRevision,
      };
      const parsed = parseWorkflowToolRequest(params);
      if (parsed.kind === "approve") {
        const execution = workflowExecutionFor(ctx, manager);
        const approved = lifecycle.approve(parsed.draftId, context, execution);
        if (execution.parentRef) {
          workflowParentRefs.set(approved.run.id, execution.parentRef);
        }
        scheduleObservability(manager);
        return {
          content: [{ type: "text", text: approved.message }],
          details: {
            kind: approved.kind,
            draftId: approved.draftId,
            runId: approved.run.id,
            status: approved.run.status,
          },
        };
      }

      const { kind: _kind, ...request } = parsed;
      const prepared = lifecycle.prepare(request, context);
      return {
        content: [{ type: "text", text: prepared.message }],
        details: {
          kind: prepared.kind,
          draftId: prepared.draft.draftId,
          artifactPath: prepared.artifactPath,
          executionSha256: prepared.draft.executionSha256,
          preview: prepared.draft.preview,
          tasks: prepared.draft.definition.tasks.map((task) => ({
            id: task.id,
            label: task.label,
            needs: task.needs ?? [],
            readOnly: task.readOnly === true,
            owns: task.owns ?? [],
          })),
          reviewCommand: `/workflow-draft ${prepared.draft.draftId}`,
        },
      };
    },
  });

  pi.registerTool({
    name: "workflow_list",
    label: "List Workflows",
    description: WORKFLOW_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      await getManager();
      const runs = workflowManager?.list() ?? [];
      const recoveryFailures = workflowManager?.recoveryFailures ?? [];
      const recoveryOmissions =
        workflowManager?.getRecoveryReport().omissions ?? [];
      const recoveryText =
        recoveryFailures.length === 0 && recoveryOmissions.length === 0
          ? ""
          : `\n\n${recoveryFailures.length > 0 ? formatWorkflowRecoveryFailures(recoveryFailures) : ""}${recoveryOmissions.length > 0 ? `\n\n${formatWorkflowRecoveryOmissions(recoveryOmissions)}` : ""}`;
      return {
        content: [
          { type: "text", text: `${formatWorkflowList(runs)}${recoveryText}` },
        ],
        details: {
          workflows: projectWorkflowList(runs),
          recoveryFailures: projectWorkflowRecoveryFailures(recoveryFailures),
          recoveryOmissions:
            projectWorkflowRecoveryOmissions(recoveryOmissions),
        },
      };
    },
  });

  pi.registerTool({
    name: "workflow_check",
    label: "Check Workflow",
    description: WORKFLOW_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      runId: Type.String({
        description: WORKFLOW_CHECK_PARAMETER_DESCRIPTIONS.runId,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const inspected = inspectWorkflow(manager, params.runId);
      return {
        content: [{ type: "text", text: inspected.text }],
        details: inspected.projection,
      };
    },
  });
  pi.registerTool({
    name: "workflow_control",
    label: "Control Workflow",
    description: WORKFLOW_CONTROL_TOOL_DESCRIPTION,
    parameters: WORKFLOW_CONTROL_TOOL_PARAMS,
    async execute(_toolCallId, params: WorkflowControlToolParams) {
      const manager = await getManager();
      const controls = workflowControls;
      if (!controls) throw new Error("Workflow controls are not initialized.");
      const request = parseWorkflowControlRequest(params);
      const state = await applyWorkflowControl(controls, request);
      scheduleObservability(manager);
      const projection = projectWorkflowRun(state, manager.view.list());
      const taskId = "taskId" in request ? request.taskId : undefined;
      const taskSuffix = taskId === undefined ? "" : ` task ${taskId}`;
      const details = {
        action: request.action,
        runId: state.id,
        taskId,
        status: state.status,
        version: state.version,
        projection,
      };
      return {
        content: [
          {
            type: "text",
            text: `Workflow ${state.id} ${params.action}${taskSuffix} applied · [${state.status}] · v${state.version}\n${formatWorkflowProjection(projection)}`,
          },
        ],
        details,
      };
    },
  });

  pi.registerCommand("workflow-draft", {
    description: "Review a workflow draft and its exact source/spec",
    getArgumentCompletions: (prefix) => {
      const matches = (workflowLifecycle?.listPending() ?? [])
        .filter((draft) => draft.draftId.startsWith(prefix))
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((draft) => ({
          value: draft.draftId,
          label: draft.draftId,
          description: draft.definition.name ?? draft.preview.split("\n", 1)[0],
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (rawArgs, ctx) => {
      await getManager();
      const lifecycle = workflowLifecycle;
      if (!lifecycle) {
        ctx.ui.notify("Workflow lifecycle is not initialized.", "error");
        return;
      }
      const query = rawArgs.trim();
      const available = [
        ...lifecycle.listPending({
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
        }),
      ].sort((left, right) => right.createdAt - left.createdAt);
      const matches = query
        ? available.filter(
            (draft) => draft.draftId === query || draft.draftId.endsWith(query),
          )
        : available.slice(0, 1);
      if (matches.length > 1) {
        ctx.ui.notify(
          `Multiple pending workflow drafts match "${query}".`,
          "warning",
        );
        return;
      }
      const workflowsDir = path.join(getAgentDir(), "workflows");
      let draft = matches[0];
      let approvable = true;
      if (!draft) {
        if (!query) {
          ctx.ui.notify(
            "No pending workflow drafts in this session.",
            "warning",
          );
          return;
        }
        try {
          const persisted = loadWorkflowDraft(workflowsDir, query);
          if (
            persisted.sessionId !== ctx.sessionManager.getSessionId() ||
            persisted.cwd !== path.resolve(ctx.cwd)
          ) {
            ctx.ui.notify(
              "That workflow draft belongs to another session or project.",
              "warning",
            );
            return;
          }
          draft = persisted;
          approvable = false;
        } catch {
          ctx.ui.notify(`No workflow draft matching "${query}".`, "warning");
          return;
        }
      }
      await showWorkflowDraftReview(
        ctx,
        draft,
        workflowDraftArtifactPath(workflowsDir, draft.draftId),
        approvable,
      );
    },
  });

  pi.registerCommand("workflows", {
    description:
      "Open the workflow inspector (`/workflows <runId>` focuses a run)",
    handler: async (rawArgs, ctx) => {
      const manager = await getManager();
      const workflows = workflowManager;
      const runs = workflows?.list() ?? [];
      if (!workflows || runs.length === 0) {
        ctx.ui.notify(
          "No workflow runs yet. Prepare and approve a workflow first.",
          "info",
        );
        return;
      }
      const query = rawArgs.trim();
      if (query) {
        const matches = runs.filter(
          (run) => run.id === query || run.id.endsWith(query),
        );
        const run = matches.length === 1 ? matches[0] : undefined;
        if (!run) {
          ctx.ui.notify(
            `No unique workflow run matching "${query}".`,
            "warning",
          );
          return;
        }
        if (ctx.mode === "tui" && ctx.hasUI) {
          await openWorkflowEntry(ctx, manager, { runId: run.id });
          return;
        }
        ctx.ui.notify(inspectWorkflow(manager, run.id).text, "info");
        return;
      }
      if (ctx.mode === "tui" && ctx.hasUI) {
        await openWorkflowEntry(ctx, manager);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(formatWorkflowList(runs), "info");
        return;
      }
      const labels = runs.map((run) => {
        const completed = Object.values(run.tasks).filter(
          (task) => task.status === "completed",
        ).length;
        return `${run.id}  ${run.status}  ${run.definition.name ?? "workflow"}  ${completed}/${run.definition.tasks.length}`;
      });
      const selected = await ctx.ui.select("Workflow runs", labels);
      if (!selected) return;
      const run = runs[labels.indexOf(selected)];
      if (run) ctx.ui.notify(inspectWorkflow(manager, run.id).text, "info");
    },
  });

  pi.registerCommand("workflow-saved", {
    description: "List validated saved workflow definitions",
    getArgumentCompletions: (prefix) => {
      try {
        const cwd = sessionContext?.cwd ?? process.cwd();
        const matches = (workflowLifecycle?.discoverSaved({ cwd }) ?? [])
          .filter((workflow) => workflow.name.startsWith(prefix))
          .map((workflow) => ({
            value: workflow.name,
            label: workflow.name,
            description: workflow.path,
          }));
        return matches.length > 0 ? matches : null;
      } catch {
        return null;
      }
    },
    handler: async (rawArgs, ctx) => {
      await getManager();
      const lifecycle = workflowLifecycle;
      if (!lifecycle) {
        ctx.ui.notify("Workflow lifecycle is not initialized.", "error");
        return;
      }
      let saved;
      try {
        saved = lifecycle.discoverSaved({ cwd: ctx.cwd });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Saved workflow discovery failed: ${message}`, "error");
        return;
      }
      const query = rawArgs.trim();
      const matches = query
        ? saved.filter(
            (workflow) =>
              workflow.name === query || workflow.name.startsWith(query),
          )
        : saved;
      if (matches.length === 0) {
        ctx.ui.notify(
          query
            ? `No saved workflow matching "${query}".`
            : "No saved workflows found.",
          "warning",
        );
        return;
      }
      ctx.ui.notify(
        matches
          .map(
            (workflow) =>
              `${workflow.name} [${workflow.scope}]\n  ${workflow.path}`,
          )
          .join("\n"),
        "info",
      );
    },
  });

  /**
   * Build one model lookup per prepare/batch call. The registry listing is
   * read at most once per lookup instance, not once per routed task.
   */
  const lookupRoutedModel = (ctx: ExtensionContext): ModelLookup => {
    let allModels: ReturnType<typeof ctx.modelRegistry.getAll> | undefined;
    return (requested) => {
      if (requested.harness === "codex") {
        return { available: true, effective: requested };
      }
      const slash = requested.model.indexOf("/");
      if (slash > 0) {
        const provider = requested.model.slice(0, slash);
        const id = requested.model.slice(slash + 1);
        return ctx.modelRegistry.find(provider, id)
          ? { available: true, effective: requested }
          : {
              available: false,
              reason: `Unknown pi model "${requested.model}"`,
            };
      }
      allModels ??= ctx.modelRegistry.getAll();
      const matches = allModels.filter((model) => model.id === requested.model);
      if (matches.length !== 1) {
        return {
          available: false,
          reason:
            matches.length === 0
              ? `Unknown pi model "${requested.model}"`
              : `Pi model "${requested.model}" is ambiguous; use provider/model`,
        };
      }
      return {
        available: true,
        effective: {
          ...requested,
          model: `${matches[0]!.provider}/${matches[0]!.id}`,
        },
      };
    };
  };

  const admitStandalone = async (
    task: Omit<BoundRoutedSpawnTask, "classification"> & {
      readonly classification?: BoundRoutedSpawnTask["classification"];
    },
    runtimeSelection: {
      readonly harness: (typeof BACKEND_NAMES)[number];
      readonly model?: string;
      readonly effort?: (typeof REASONING_EFFORTS)[number];
    },
    ctx: ExtensionContext,
  ) => {
    const manager = await getManager();
    // Callers validate working_dir once (resolveWorkingDir) before admission.
    const cwd = path.resolve(task.cwd);
    const parentRef = captureParentRef(sessionEpoch, ctx.sessionManager);
    const title = task.name.trim().slice(0, 160) || "subagent";
    const snap = await runTool(
      getRuntime(),
      manager.spawn(runtimeSelection.harness, {
        prompt: task.prompt,
        title,
        cwd,
        model: runtimeSelection.model,
        reasoningEffort: runtimeSelection.effort,
        parentRef,
        parent: {
          parentCwd: ctx.cwd,
          projectTrusted: resolveChildProjectTrust({
            parentCwd: ctx.cwd,
            childCwd: cwd,
            parentTrusted: ctx.isProjectTrusted(),
          }),
          inheritedModel: ctx.model
            ? { provider: ctx.model.provider, id: ctx.model.id }
            : undefined,
          inheritedThinkingLevel: pi.getThinkingLevel(),
          modelRegistry: ctx.modelRegistry,
        },
      }),
    );
    return { snap, cwd, title };
  };

  // --- Tools -------------------------------------------------------------

  interface WaitProgressDetails {
    readonly pending: ReadonlyArray<string>;
    readonly activity: ReadonlyArray<{
      readonly id: string;
      readonly status: SubagentSnapshot["status"];
      readonly lastActivityAt: number;
      readonly currentTool?: string;
    }>;
  }

  /** Block until listed parent-owned children settle or ask; shared by subagent_wait and spawn wait. */
  const collectChildren = async (
    requestedIds: ReadonlyArray<string>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    mode: WaitMode = "all",
  ) => {
    const manager = await getManager();
    const ids = [...new Set(requestedIds)];
    if (ids.length === 0) throw new Error("Provide at least one subagent id.");
    const known = standardSnapshots(manager).map((snap) => snap.id);
    const unknown = ids.filter((id) => !standardSnapshot(manager, id));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
      );
    }

    const waitOwners = ids
      .map((id) => standardSnapshot(manager, id))
      .filter((snapshot): snapshot is SubagentSnapshot => !!snapshot);
    const delivered = (id: string) => {
      const parentRef = waitOwners.find((owner) => owner.id === id)?.parentRef;
      return (
        parentRef !== undefined && parentResults.wasDelivered(id, parentRef)
      );
    };
    let lastWaitUpdate = 0;
    const waitResult = await runTool(
      getRuntime(),
      manager.waitForParent!(
        ids,
        (pending) => {
          const now = Date.now();
          if (now - lastWaitUpdate < 100) return;
          lastWaitUpdate = now;
          const snapshots = ids
            .map((id) => standardSnapshot(manager, id))
            .filter((snapshot): snapshot is SubagentSnapshot => !!snapshot);
          onUpdate?.({
            content: [
              {
                type: "text",
                text: renderSubagentWaitSummary(
                  snapshots,
                  ui?.theme ?? PLAIN_THEME,
                ),
              },
            ],
            details: {
              pending,
              activity: snapshots.map((snapshot) => ({
                id: snapshot.id,
                status: snapshot.status,
                lastActivityAt: snapshot.lastActivityAt,
                currentTool: snapshot.liveTools[0]?.name,
              })),
            } satisfies WaitProgressDetails,
          });
        },
        { mode, alreadyDelivered: delivered },
      ),
      { signal, interruptMessage: "Wait aborted. Subagents keep running." },
    );

    // Partition synchronously after the wait returns: the parent is busy in
    // this tool call, so automatic delivery cannot interleave before consume.
    const partition = partitionWaitResult({
      mode,
      requestedIds: ids,
      settledIds: waitResult.settledIds,
      delivered,
    });
    // A question returns while its child remains running. Consume exactly the
    // terminal results this call returns, and always return what it consumes.
    parentResults.consume(
      waitOwners.filter((owner) => partition.returned.includes(owner.id)),
    );
    const delivery =
      partition.returned.length === 0
        ? undefined
        : buildSubagentWaitResult(
            partition.returned.map((id) => ({
              id,
              snapshot: standardSnapshot(manager, id),
            })),
          );
    const remainder =
      mode === "any" || waitResult.questions.length > 0
        ? formatWaitRemainder(partition)
        : "";
    const waitDetails = {
      mode,
      pending: partition.pending,
      ...(partition.alreadyDelivered.length === 0
        ? {}
        : { alreadyDelivered: partition.alreadyDelivered }),
    };

    if (waitResult.questions.length > 0) {
      parentResults.consumeQuestions(waitResult.questions);
      const questions = waitResult.questions.map(
        ({ childId, requestId, question, context, deadlineAt }) =>
          context === undefined
            ? { childId, requestId, question, deadlineAt }
            : { childId, requestId, question, context, deadlineAt },
      );
      const text = questions
        .map((question) => {
          const context = question.context
            ? `\nContext: ${question.context}`
            : "";
          return `Subagent ${question.childId} asks (requestId ${question.requestId}, deadline ${new Date(question.deadlineAt).toISOString()}):\n${question.question}${context}`;
        })
        .join("\n\n");
      return {
        content: [
          {
            type: "text" as const,
            text: [text, delivery?.text, remainder]
              .filter((part) => part !== undefined && part.length > 0)
              .join("\n\n---\n\n"),
          },
        ],
        details: {
          questions,
          ...(delivery ? delivery.details : {}),
          ...waitDetails,
        },
      };
    }

    const text =
      delivery === undefined
        ? "No new results: every listed subagent result was already delivered."
        : delivery.text;
    return {
      content: [
        {
          type: "text" as const,
          text: remainder ? `${text}\n\n${remainder}` : text,
        },
      ],
      details: { results: delivery?.details.results ?? [], ...waitDetails },
    };
  };

  pi.registerTool({
    name: "subagent_route",
    label: "Route Subagents",
    description:
      "Prepare a bound, batchable preference-routed spawn proposal without starting children. Every task requires explicit assignment classification. Preference-derived runtimes require a newer user approval through subagent_approve.",
    parameters: Type.Object({
      tasks: Type.Array(ROUTED_SPAWN_TASK_PARAMETERS, {
        minItems: 1,
        maxItems: 64,
      }),
    }),
    async execute(
      _toolCallId,
      params: { tasks: RoutedSpawnTaskParams[] },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const settings = loadSubagentSettings({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      if (!settings.settings.routing.enabled) {
        throw new Error(
          "Preference routing is disabled; use explicit subagent_spawn runtimes.",
        );
      }
      const tasks: BoundRoutedSpawnTask[] = params.tasks.map((task) => {
        const cwd = resolveWorkingDir(ctx.cwd, task.working_dir);
        return {
          prompt: task.prompt,
          name: task.name,
          cwd,
          classification: task.classification,
          ...(task.harness === undefined ? {} : { harness: task.harness }),
          ...(task.model === undefined ? {} : { model: task.model }),
          ...(task.reasoning_effort === undefined
            ? {}
            : { reasoningEffort: task.reasoning_effort }),
        };
      });
      const proposal = standaloneRouting.prepare(tasks, {
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        userInputRevision,
        settings,
        lookupModel: lookupRoutedModel(ctx),
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Prepared ${proposal.items.length} routed spawn(s) as ${proposal.id} with binding digest ${proposal.bindingDigest}; no child started. ` +
              "A newer user response must approve this exact binding before admission.\n" +
              proposal.items
                .map(
                  (item) =>
                    `Saved preference: ${JSON.stringify(item.runtime.preference)}; requested: ${JSON.stringify(item.runtime.requested)}; effective: ${JSON.stringify(item.runtime.effective)}`,
                )
                .join("\n"),
          },
        ],
        details: {
          kind: "routing_proposal",
          proposalId: proposal.id,
          bindingDigest: proposal.bindingDigest,
          status: proposal.status,
          items: proposal.items.map((item) => ({ runtime: item.runtime })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_approve",
    label: "Approve Routed Subagents",
    description:
      "Approve and admit one exact routed spawn batch. Preference-derived proposals require a user message newer than proposal creation. The id and binding digest must match the reviewed proposal.",
    parameters: Type.Object({
      proposal_id: Type.String(),
      binding_digest: Type.String(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const settings = loadSubagentSettings({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      const results = await standaloneRouting.approveAndAdmit(
        {
          proposalId: params.proposal_id,
          bindingDigest: params.binding_digest,
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          userInputRevision,
          settings,
          lookupModel: lookupRoutedModel(ctx),
        },
        async (task, runtime: ConcreteRuntimeSelection) => {
          const admitted = await admitStandalone(task, runtime, ctx);
          return {
            id: admitted.snap.id,
            title: admitted.snap.title,
            cwd: admitted.cwd,
            harness: runtime.harness,
            model: admitted.snap.meta.modelLabel,
          };
        },
      );
      return {
        content: [
          {
            type: "text",
            text: results
              .map((result) =>
                buildSubagentSpawnResult({
                  id: result.id,
                  title: result.title,
                  harness: result.harness,
                  modelLabel: result.model ?? "?",
                  cwd: result.cwd,
                }),
              )
              .join("\n\n"),
          },
        ],
        details: { proposalId: params.proposal_id, results },
      };
    },
  });

  /** subagent_spawn admission output before any requested wait. */
  interface SpawnToolResult {
    readonly content: [{ type: "text"; text: string }];
    readonly details:
      | SpawnedTask
      | {
          readonly kind: "batch_spawn";
          readonly ids: ReadonlyArray<string>;
          readonly results: ReadonlyArray<BatchSpawnOutcome>;
        };
  }

  /** Register subagent_spawn with the session's effective running cap in its description. */
  const registerSpawnTool = (maxRunning: number) =>
    pi.registerTool({
      name: "subagent_spawn",
      label: "Spawn Subagent",
      description: subagentSpawnToolDescription(maxRunning),
      promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
      promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
      parameters: Type.Object({
        prompt: Type.Optional(
          Type.String({
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
          }),
        ),
        name: Type.Optional(
          Type.String({
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
          }),
        ),
        classification: Type.Optional(ROUTING_CLASSIFICATION_PARAMETERS),
        wait: Type.Optional(
          Type.Boolean({
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.wait,
          }),
        ),
        wait_mode: Type.Optional(
          StringEnum(WAIT_MODES, {
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.waitMode,
          }),
        ),
        harness: Type.Optional(
          StringEnum(BACKEND_NAMES, {
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
          }),
        ),
        working_dir: Type.Optional(
          Type.String({
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
          }),
        ),
        reasoning_effort: Type.Optional(
          StringEnum(REASONING_EFFORTS, {
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
          }),
        ),
        tasks: Type.Optional(
          Type.Array(SPAWN_BATCH_TASK_PARAMETERS, {
            minItems: 1,
            maxItems: MAX_SPAWN_BATCH,
            description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.tasks,
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const { batch, tasks } = normalizeSpawnRequest(params);
        if (params.wait_mode !== undefined && params.wait !== true) {
          throw new Error(
            "wait_mode applies only with wait: true. No child started.",
          );
        }
        const waitMode: WaitMode = params.wait_mode ?? "all";
        // Validate every task before admitting any, so input mistakes start nothing.
        const inputErrors: string[] = [];
        const cwds = tasks.map((task, index) => {
          try {
            return resolveWorkingDir(ctx.cwd, task.working_dir);
          } catch (error) {
            inputErrors.push(
              `${taskLabel(task, index, batch)}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return "";
          }
        });
        const noChildStarted = () =>
          new Error(`${inputErrors.join("\n")}\nNo child started.`);
        if (inputErrors.length > 0) throw noChildStarted();
        const settings = loadSubagentSettings({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        });
        const routed = settings.settings.routing.enabled;
        tasks.forEach((task, index) => {
          if (routed && !task.classification) {
            inputErrors.push(
              `${taskLabel(task, index, batch)}: classification is required while routing is enabled, including when runtime overrides are supplied`,
            );
          }
          if (!routed && !task.harness) {
            inputErrors.push(
              `${taskLabel(task, index, batch)}: harness is required while routing is disabled`,
            );
          }
        });
        if (inputErrors.length > 0) throw noChildStarted();

        let settled: ReadonlyArray<PromiseSettledResult<SpawnedTask>>;
        if (routed) {
          const bound: BoundRoutedSpawnTask[] = tasks.map((task, index) => ({
            prompt: task.prompt,
            name: task.name,
            cwd: cwds[index]!,
            // Checked above: routing requires a classification for every task.
            classification: task.classification!,
            ...(task.harness === undefined ? {} : { harness: task.harness }),
            ...(task.model === undefined ? {} : { model: task.model }),
            ...(task.reasoning_effort === undefined
              ? {}
              : { reasoningEffort: task.reasoning_effort }),
          }));
          // One registry snapshot serves both preparation and admission checks.
          const lookupModel = lookupRoutedModel(ctx);
          const routingContext = {
            sessionId: ctx.sessionManager.getSessionId(),
            cwd: ctx.cwd,
            userInputRevision,
            settings,
            lookupModel,
          };
          const proposal = standaloneRouting.prepare(bound, routingContext);
          if (proposal.status === "pending") {
            const describe = (item: (typeof proposal.items)[number]) => {
              const { effective } = item.runtime;
              return (
                `Saved preference: ${JSON.stringify(item.runtime.preference)}; requested: ${JSON.stringify(item.runtime.requested)}. ` +
                `Review ${effective.harness}/${effective.model}${effective.effort ? `:${effective.effort}` : ""}`
              );
            };
            const header = batch
              ? `Prepared routed batch spawn ${proposal.id} (${proposal.items.length} task(s)) with binding digest ${proposal.bindingDigest}; no child started.`
              : `Prepared routed spawn ${proposal.id} with binding digest ${proposal.bindingDigest}; no child started.`;
            const body = batch
              ? proposal.items
                  .map(
                    (item, index) =>
                      `- tasks[${index}] "${tasks[index]!.name}": ${describe(item)}`,
                  )
                  .join("\n")
              : `${describe(proposal.items[0]!)}.`;
            return {
              content: [
                {
                  type: "text",
                  text: `${header}\n${body}\nAfter a newer user approval, call subagent_approve with this id and binding digest.`,
                },
              ],
              details: {
                kind: "routing_proposal",
                proposalId: proposal.id,
                bindingDigest: proposal.bindingDigest,
                status: proposal.status,
                ...(batch
                  ? {
                      items: proposal.items.map((item) => ({
                        runtime: item.runtime,
                      })),
                    }
                  : { runtime: proposal.items[0]!.runtime }),
              },
            };
          }
          settled = await standaloneRouting.approveAndAdmitSettled(
            {
              ...routingContext,
              proposalId: proposal.id,
              bindingDigest: proposal.bindingDigest,
            },
            async (approvedTask, runtime) => {
              const result = await admitStandalone(approvedTask, runtime, ctx);
              return {
                id: result.snap.id,
                title: result.snap.title,
                cwd: result.cwd,
                harness: runtime.harness,
                model: result.snap.meta.modelLabel,
              };
            },
          );
        } else {
          settled = await admitBatch(tasks, async (task, index) => {
            // Checked above: direct spawning requires a harness for every task.
            const harness = task.harness!;
            const admitted = await admitStandalone(
              { prompt: task.prompt, name: task.name, cwd: cwds[index]! },
              {
                harness,
                ...(task.model === undefined ? {} : { model: task.model }),
                ...(task.reasoning_effort === undefined
                  ? {}
                  : { effort: task.reasoning_effort }),
              },
              ctx,
            );
            return {
              id: admitted.snap.id,
              title: admitted.snap.title,
              cwd: admitted.cwd,
              harness,
              model: admitted.snap.meta.modelLabel,
            };
          });
        }

        const outcomes = batchOutcomes(tasks, settled);
        const started = outcomes.flatMap((outcome) =>
          outcome.ok ? [outcome] : [],
        );
        let spawned: SpawnToolResult;
        if (!batch) {
          const [only] = outcomes;
          if (!only?.ok) {
            throw new Error(
              only?.error ?? "Spawn admission returned no result",
            );
          }
          spawned = {
            content: [
              {
                type: "text",
                text: buildSubagentSpawnResult({
                  id: only.id,
                  title: only.title,
                  harness: only.harness,
                  modelLabel: only.model ?? "?",
                  cwd: only.cwd,
                }),
              },
            ],
            details: {
              id: only.id,
              title: only.title,
              cwd: only.cwd,
              harness: only.harness,
              model: only.model,
            },
          };
        } else {
          spawned = {
            content: [{ type: "text", text: formatBatchSpawnResult(outcomes) }],
            details: {
              kind: "batch_spawn",
              ids: started.map((outcome) => outcome.id),
              results: outcomes,
            },
          };
        }
        // Spawn and collect in one tool call, saving a parent turn when the next step needs the result.
        if (!params.wait || started.length === 0) return spawned;
        const waited = await collectChildren(
          started.map((outcome) => outcome.id),
          signal,
          onUpdate,
          waitMode,
        );
        const label = batch
          ? `Spawned ${started.length} subagent(s) and waited (${waitMode}).`
          : `Spawned subagent ${started[0]!.id} and waited for it.`;
        return {
          content: [
            {
              type: "text" as const,
              text: `${label}\n\n${batch ? `${spawned.content[0].text}\n\n` : ""}${waited.content[0].text}`,
            },
          ],
          details: { ...spawned.details, wait: waited.details },
        };
      },
      renderCall(args, theme, context) {
        // SAFETY: this renderer only returns Text components for this tool row,
        // so a previously rendered component, when present, is a Text.
        const component =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const label = args.tasks
          ? `${args.tasks.length} task(s)`
          : args.name?.trim() || "starting…";
        component.setText(
          `${theme.fg("warning", "■")} ${theme.fg("toolTitle", theme.bold("subagent "))}` +
            theme.fg("accent", label) +
            theme.fg(
              "dim",
              ` · ${args.tasks ? "batch" : (args.harness ?? "pi")}`,
            ),
        );
        return component;
      },
      renderResult(result, { expanded }, theme, context) {
        // SAFETY: execute always attaches id/title/cwd/harness/model details,
        // and the renderer must tolerate restored renders without them.
        const details = result.details as
          | {
              id?: string;
              title?: string;
              harness?: string;
              cwd?: string;
              proposalId?: string;
            }
          | undefined;
        const id = details?.id;
        if (!id && details?.proposalId) {
          return new Text(
            `${theme.fg("warning", "■")} ${theme.fg("accent", "routing proposal")} ${theme.fg("muted", details.proposalId)}\n  ${theme.fg("dim", "No child started; exact runtime awaits approval.")}`,
            0,
            0,
          );
        }
        const snapshot = id ? renderView?.get(id) : undefined;

        // Keep the in-transcript card live while the agent runs: subscribe for
        // this id (throttled — pi backends can emit an event per token) and drop
        // the subscription once the agent settles. Mirrors the bash tool's
        // state.interval + context.invalidate() pattern.
        // SAFETY: this renderer owns the per-tool-row state it persists in
        // context.state (unsubActivity handle and lastActivityRefresh timestamp).
        const state = context.state as
          | { unsubActivity?: () => void; lastActivityRefresh?: number }
          | undefined;
        const settled = !snapshot || !isSubagentPending(snapshot.status);
        if (state) {
          if (settled && state.unsubActivity) {
            state.unsubActivity();
            state.unsubActivity = undefined;
          } else if (!settled && !state.unsubActivity && renderView) {
            state.unsubActivity = renderView.subscribeTo(id!, () => {
              const now = Date.now();
              if (now - (state.lastActivityRefresh ?? 0) >= 100) {
                state.lastActivityRefresh = now;
                context.invalidate();
              }
            });
          }
        }

        // SAFETY: this renderer only returns Text components for this tool row,
        // so a previously rendered component, when present, is a Text.
        const component =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        if (snapshot) {
          component.setText(
            renderSubagentActivity(snapshot, theme, { expanded }),
          );
          return component;
        }
        const first = result.content[0];
        const fallback =
          first?.type === "text" ? first.text : "Subagent launch recorded.";
        component.setText(
          `${theme.fg("success", "■")} ${theme.fg("accent", id ?? "subagent")}${theme.fg(
            "muted",
            ` · ${details?.title ?? "historical launch"}`,
          )}\n  ${theme.fg("dim", fallback.split("\n", 1)[0] ?? "")}`,
        );
        return component;
      },
    });
  registerSpawnTool(registeredSpawnCap);

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
      mode: Type.Optional(
        StringEnum(WAIT_MODES, {
          description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.mode,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      return collectChildren(params.ids, signal, onUpdate, params.mode);
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = standardSnapshots(manager).map((snap) => snap.id);
      const unknown = ids.filter((id) => !standardSnapshot(manager, id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const cancelOwners = ids
        .map((id) => standardSnapshot(manager, id))
        .filter((snapshot): snapshot is SubagentSnapshot => !!snapshot);
      const report = await runTool(getRuntime(), manager.cancel(ids));
      // Cancellation consumes automatic delivery even when the target had
      // already settled before this tool call began.
      parentResults.consumeQuestions(
        cancelOwners.flatMap((owner) =>
          owner.pendingQuestion === undefined ? [] : [owner.pendingQuestion],
        ),
      );
      parentResults.consume(cancelOwners);

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  registerSubagentParentTools(pi, {
    getManager,
    runEffect: (effect) => runTool(getRuntime(), effect),
    getParentRef: () =>
      sessionContext === undefined
        ? undefined
        : captureParentRef(sessionEpoch, sessionContext.sessionManager),
    isParentRefSafe: (parentRef) =>
      sessionContext !== undefined &&
      isSafeParentRef(parentRef, sessionContext, sessionEpoch),
    onQuestionResolved: (requestId, parentRef) =>
      parentResults.consumeQuestion(requestId, parentRef),
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = standardSnapshots(manager);
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer<SubagentResultDetails>(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details: SubagentResultDetails = message.details ?? {};
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content = Array.isArray(message.content) ? "" : message.content;
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerMessageRenderer<SubagentResultBatchDetails>(
    "subagent-result-batch",
    (message, { expanded }, theme) => {
      const details: SubagentResultBatchDetails = message.details ?? {};
      const results = details.results ?? [];
      const content = Array.isArray(message.content) ? "" : message.content;
      const cards = content.split("\n\n---\n\n");
      const summaryLabel =
        results.length === 1 && results[0]?.kind === "workflow"
          ? "workflow result"
          : `subagent result${results.length === 1 ? "" : "s"}`;
      const summary = theme.fg(
        "accent",
        theme.bold(`${results.length} ${summaryLabel}`),
      );

      if (expanded) {
        const md = new Markdown(content, 0, 0, getMarkdownTheme());
        const container = new Text(summary, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      let text = summary;
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result === undefined) continue;
        const failed = result.status === "error";
        const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
        const subject = result.kind === "workflow" ? "workflow" : "subagent";
        const header =
          `${icon} ` +
          theme.fg("accent", theme.bold(`${subject} ${result.id ?? "?"}`)) +
          theme.fg(
            "muted",
            ` · ${result.title ?? ""} · ${failed ? "failed" : "finished"}`,
          );
        text += `\n${header}`;
        const body = (cards[index] ?? "").split("\n").slice(1).join("\n");
        for (const line of body.split("\n").slice(0, 4)) {
          if (line.trim()) text += `\n  ${theme.fg("toolOutput", line)}`;
        }
        if (body.split("\n").length > 4)
          text += `\n  ${theme.fg("dim", "... (ctrl+o to expand)")}`;
      }
      return new Text(text, 0, 0);
    },
  );

  pi.registerMessageRenderer<ParentQuestionBatchDetails>(
    "subagent-question-batch",
    (message, { expanded }, theme) => {
      const details: ParentQuestionBatchDetails = message.details ?? {
        questions: [],
      };
      const content = Array.isArray(message.content) ? "" : message.content;
      const header = theme.fg(
        "accent",
        theme.bold(
          `${details.questions.length} subagent question${details.questions.length === 1 ? "" : "s"}`,
        ),
      );
      if (expanded) {
        const md = new Markdown(content, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }
      return new Text(`${header}\n${content}`, 0, 0);
    },
  );

  // --- Command ------------------------------------------------------------
  // --- Command ------------------------------------------------------------

  registerSubagentsSettingsCommand(pi);

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over parent-owned subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const dialogUI = ctx.ui;
        if (!ctx.hasUI || !dialogUI.select || !dialogUI.input) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "Subagent takeover is only available in the TUI",
              "error",
            );
          return;
        }
        const manager = await getManager();
        await runHeadlessSubagentsDialog(dialogUI, standardView(manager));
        return;
      }
      const manager = await getManager();
      if (standardView(manager).size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, standardView(manager));
    },
  });

  pi.registerShortcut("ctrl+shift+a", {
    description: "Toggle the direct subagents dashboard",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagents dashboard is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (standardView(manager).size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, standardView(manager));
    },
  });

  pi.registerShortcut("ctrl+shift+z", {
    description: "Toggle the workflow inspector (also opened by /workflows)",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Workflow dashboard is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      await openWorkflowEntry(ctx, manager);
    },
  });
}
