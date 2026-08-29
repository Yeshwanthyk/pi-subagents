/**
 * Subagents — spawn background subagents on Pi or Codex, unified behind a
 * single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, agent, working_dir,
 *   model, reasoning_effort). Max 4 running at once across all backends.
 * - subagent_wait: block until the listed parent-owned subagents settle, return results.
 * - subagent_cancel: stop one or more queued/running parent-owned subagents.
 * - subagent_check: peek at a parent-owned subagent's status and recent activity.
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

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  BACKEND_NAMES,
  formatElapsed,
  isSubagentPending,
  latestText,
  REASONING_EFFORTS,
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
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createParentResultCoordinator } from "./src/parent-coordinator.ts";
import type { ParentResultEnvelope } from "./src/parent-mailbox.ts";
import {
  buildParentResultBatchMessage,
  PARENT_RESULT_BATCH_OPTIONS,
} from "./src/parent-message.ts";
import { captureParentRef } from "./src/parent-ref.ts";
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
  type WorkflowControlRequest,
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
  WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS,
  WORKFLOW_CONTROL_TOOL_DESCRIPTION,
  WORKFLOW_LIST_TOOL_DESCRIPTION,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./src/workflows/prompt.ts";
import { openSubagentPicker } from "./src/ui/takeover.ts";
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

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;
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

const WORKFLOW_TOOL_PARAMS = Type.Union([
  Type.Object({
    preview: Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.preview,
    }),
    source: Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.source,
    }),
    args: Type.Optional(
      Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.args }),
    ),
    background: Type.Optional(
      Type.Boolean({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.background }),
    ),
  }),
  Type.Object({
    preview: Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.preview,
    }),
    spec: Type.Any({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.spec }),
    args: Type.Optional(
      Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.args }),
    ),
    background: Type.Optional(
      Type.Boolean({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.background }),
    ),
  }),
  Type.Object({
    preview: Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.preview,
    }),
    savedWorkflow: Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.savedWorkflow,
    }),
    args: Type.Optional(
      Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.args }),
    ),
    background: Type.Optional(
      Type.Boolean({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.background }),
    ),
  }),
  Type.Object({
    draftId: Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.draftId,
    }),
  }),
]);
type WorkflowToolParams = Static<typeof WORKFLOW_TOOL_PARAMS>;
const WORKFLOW_CONTROL_TOOL_PARAMS = Type.Union([
  Type.Object({
    action: Type.Union(
      [Type.Literal("pause"), Type.Literal("resume"), Type.Literal("cancel")],
      {
        description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.action,
      },
    ),
    runId: Type.String({
      description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.runId,
    }),
    reason: Type.Optional(
      Type.String({
        description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.reason,
      }),
    ),
  }),
  Type.Object({
    action: Type.Union([Type.Literal("retry"), Type.Literal("skip")], {
      description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.action,
    }),
    runId: Type.String({
      description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.runId,
    }),
    taskId: Type.String({
      description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.taskId,
    }),
    reason: Type.Optional(
      Type.String({
        description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.reason,
      }),
    ),
  }),
]);
type WorkflowControlToolParams = Static<typeof WORKFLOW_CONTROL_TOOL_PARAMS>;

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

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
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
  const workflowParentRefs = new Map<string, ParentRef>();
  let publishWorkflowResult:
    ((run: WorkflowReadModel, parentRef: ParentRef) => void) | undefined;

  const getRuntime = () => (runtime ??= createSubagentRuntime());

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
          preparer: staticWorkflowDefinitionPreparer,
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

  const parentResults = createParentResultCoordinator({
    sendBatch: sendParentResultBatch,
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
    sessionClosed = false;
    parentResults.startSession(ctx, sessionEpoch);
    browserUI?.setWidget(BROWSER_ACTIVITY_WIDGET_KEY, undefined);
    sessionContext = ctx;
    ui = ctx.hasUI ? ctx.ui : undefined;
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
    const closing = runtime;
    runtime = undefined;
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
      if ("draftId" in params) {
        const execution = workflowExecutionFor(ctx, manager);
        const approved = lifecycle.approve(params.draftId, context, execution);
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

      const request =
        "source" in params
          ? {
              preview: params.preview,
              source: params.source,
              args: params.args,
              background: params.background,
            }
          : "savedWorkflow" in params
            ? {
                preview: params.preview,
                savedWorkflow: params.savedWorkflow,
                args: params.args,
                background: params.background,
              }
            : {
                preview: params.preview,
                spec: params.spec,
                args: params.args,
                background: params.background,
              };
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
      // SAFETY: TypeBox validates the discriminated control union before the
      // handler runs; this restores the corresponding domain request type.
      const state = await applyWorkflowControl(
        controls,
        params as WorkflowControlRequest,
      );
      scheduleObservability(manager);
      const projection = projectWorkflowRun(state, manager.view.list());
      const taskSuffix = "taskId" in params ? ` task ${params.taskId}` : "";
      const details = {
        action: params.action,
        runId: state.id,
        taskId: "taskId" in params ? params.taskId : undefined,
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
    description: "List workflow runs (`/workflows <runId>` for detail)",
    handler: async (rawArgs, ctx) => {
      const manager = await getManager();
      const runs = workflowManager?.list() ?? [];
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs yet.", "info");
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
        ctx.ui.notify(inspectWorkflow(manager, run.id).text, "info");
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

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      harness: StringEnum(BACKEND_NAMES, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
      }),
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager();
      const harness = params.harness;

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const parentRef = captureParentRef(sessionEpoch, ctx.sessionManager);
      const title = params.name.trim().slice(0, 160) || "subagent";
      const snap = await runTool(
        getRuntime(),
        manager.spawn(harness, {
          prompt: params.prompt,
          title,
          cwd,
          model: params.model,
          reasoningEffort: params.reasoning_effort,
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

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              harness,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd,
          harness,
          model: snap.meta.modelLabel,
        },
      };
    },
    renderCall(args, theme, context) {
      // SAFETY: this renderer only returns Text components for this tool row,
      // so a previously rendered component, when present, is a Text.
      const component =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      component.setText(
        `${theme.fg("warning", "■")} ${theme.fg("toolTitle", theme.bold("subagent "))}` +
          theme.fg("accent", args.name?.trim() || "starting…") +
          theme.fg("dim", ` · ${args.harness ?? "pi"}`),
      );
      return component;
    },
    renderResult(result, { expanded }, theme, context) {
      // SAFETY: execute always attaches id/title/cwd/harness/model details,
      // and the renderer must tolerate restored renders without them.
      const details = result.details as
        | { id?: string; title?: string; harness?: string; cwd?: string }
        | undefined;
      const id = details?.id;
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

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
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

      const waitOwners = ids
        .map((id) => standardSnapshot(manager, id))
        .filter((snapshot): snapshot is SubagentSnapshot => !!snapshot);
      let lastWaitUpdate = 0;
      await runTool(
        getRuntime(),
        manager.waitFor(ids, (pending) => {
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
            },
          });
        }),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      // Settlement may have happened before this wait began. Remove any
      // automatic delivery now that the tool is returning the result.
      parentResults.consume(waitOwners);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = standardSnapshot(manager, id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = standardSnapshot(manager, id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
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

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = standardSnapshot(manager, params.id);
      if (!snap) {
        const known = standardSnapshots(manager).map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "queued") {
        text += "\n\n(waiting for an execution slot)";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
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

  // --- Command ------------------------------------------------------------

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
    description: "Toggle the workflow dashboard",
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
      const workflows = workflowManager;
      if (!workflows || workflows.list().length === 0) {
        ctx.ui.notify(
          "No workflow runs yet. Prepare and approve a workflow first.",
          "info",
        );
        return;
      }
      await openWorkflowDashboard(ctx, workflows, operatorView(manager));
    },
  });
}
