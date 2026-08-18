/**
 * Subagents — spawn background subagents on one of three backends
 * (pi, Claude Code, Codex) unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, agent, working_dir,
 *   model, reasoning_effort). Max 4 running at once across all backends.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. All three backends are real: pi runs
 * in-process SDK sessions, claude drives the Claude Agent SDK, codex speaks
 * JSON-RPC to a scoped `codex app-server` process.
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
import { Type } from "typebox";
import {
  BACKEND_NAMES,
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  type SpawnTask,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatContextUtilization,
} from "./src/format.ts";
import {
  standardSubagentView,
  SubagentManager,
  type SubagentManagerShape,
  type SubagentReadModel,
} from "./src/manager.ts";
import {
  clientSettlement,
  registerSubagentClientApi,
} from "./src/client-api.ts";
import { SUBAGENT_CLIENT_CHANNELS } from "./src/client-protocol.ts";
import {
  buildSubagentResultMessage,
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
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { registerBtw } from "./src/btw.ts";
import { openSubagentPicker } from "./src/ui/takeover.ts";
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
const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

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
  const preferred =
    snap.status === "running"
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
        ...(snap.status === "running" ? [STEER_CHOICE, ABORT_CHOICE] : []),
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

      if (action === ABORT_CHOICE && snap.status === "running") {
        if (await ui.confirm(`Abort ${snap.id}?`, snap.title)) {
          view.requestAbort(id);
          ui.notify(`Abort requested for ${id}`, "info");
        }
        continue;
      }

      if (action === SHOW_OUTPUT_CHOICE) {
        const output = headlessOutput(snap);
        if (typeof ui.editor === "function") {
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
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  let disposeClientApi: (() => void) | undefined;
  let observabilityTimer: ReturnType<typeof setTimeout> | undefined;
  let renderView: SubagentReadModel | undefined;
  const publishedActivity = new Map<`subagent:${string}`, ActiveWorkItem>();
  let browserUI: ExtensionUIContext | undefined;
  let browserRevision = 0;
  let publishedStatus: string | undefined;
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();

  const getRuntime = () => (runtime ??= createSubagentRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        renderView = standardSubagentView(manager.view);
        const schedule = () => scheduleObservability(manager);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(schedule);
        refreshObservability(manager);
        return manager;
      });
    return managerPromise;
  };

  const standardView = (manager: SubagentManagerShape) =>
    standardSubagentView(manager.view);
  const standardSnapshots = (manager: SubagentManagerShape) =>
    standardView(manager).list();
  const standardSnapshot = (manager: SubagentManagerShape, id: string) =>
    standardView(manager).get(id);

  const publishSubagentActivity = (manager: SubagentManagerShape) => {
    const active = new Set<`subagent:${string}`>();
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
    for (const key of [...publishedActivity.keys()]) {
      if (active.has(key)) continue;
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

  const scheduleObservability = (manager: SubagentManagerShape) => {
    if (observabilityTimer) return;
    observabilityTimer = setTimeout(() => {
      observabilityTimer = undefined;
      refreshObservability(manager);
    }, 100);
    observabilityTimer.unref?.();
  };

  const refreshObservability = (manager: SubagentManagerShape) => {
    updateStatus(manager);
    publishBrowserActivity(manager.view.list());
  };

  const updateStatus = (manager: SubagentManagerShape) => {
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
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    const status = formatActivityStatus(ui.theme, { running, done, failed });
    if (status === publishedStatus) return;
    publishedStatus = status;
    ui.setStatus("subagents", status);
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          output: truncatedOutput(snap),
        }),
        display: true,
        details: { id: snap.id, title: snap.title, status: snap.status },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    publishBrowserActivity(renderView?.list() ?? [], snap);
    if (snap.resultDelivery === "client") {
      const event = clientSettlement(snap);
      if (event) pi.events.emit(SUBAGENT_CLIENT_CHANNELS.settled, event);
      return;
    }
    if (snap.resultDelivery === "none") return;
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    // The activity rail is no longer part of the package UI. Clear a stale
    // widget when a session is opened after upgrading from an older version.
    ctx.ui?.setWidget("active-work", undefined);
    browserUI?.setWidget(BROWSER_ACTIVITY_WIDGET_KEY, undefined);
    sessionContext = ctx;
    ui = ctx.hasUI ? ctx.ui : undefined;
    browserUI = ctx.mode === "rpc" && ctx.hasUI ? ctx.ui : undefined;
    browserRevision = 0;
    if (browserUI) {
      const existingManager = managerPromise;
      if (existingManager) {
        void existingManager
          .then((manager) => {
            if (browserUI) refreshObservability(manager);
          })
          .catch(() => undefined);
      } else {
        void getManager().catch(() => undefined);
      }
    }
  });

  pi.on("agent_settled", flushResults);

  disposeClientApi = registerSubagentClientApi({
    pi,
    getManager,
    getRuntime,
    getSessionContext: () => sessionContext,
    resolveChildProjectTrust,
  });

  registerBtw({
    pi,
    getManager,
    getRuntime,
    getSessionContext: () => sessionContext,
    resolveChildProjectTrust,
  });

  pi.on("session_shutdown", async () => {
    disposeClientApi?.();
    disposeClientApi = undefined;
    sessionContext = undefined;
    resultDelivery.clear();
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
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
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

      const title = params.name.trim().slice(0, 160) || "subagent";
      const snap = await runTool(
        getRuntime(),
        manager.spawn(harness, {
          prompt: params.prompt,
          title,
          cwd,
          model: params.model,
          reasoningEffort: params.reasoning_effort,
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
      const details = result.details as
        | { id?: string; title?: string; harness?: string; cwd?: string }
        | undefined;
      const id = details?.id;
      const snapshot = id ? renderView?.get(id) : undefined;

      // Keep the in-transcript card live while the agent runs: subscribe for
      // this id (throttled — pi backends can emit an event per token) and drop
      // the subscription once the agent settles. Mirrors the bash tool's
      // state.interval + context.invalidate() pattern.
      const state = context.state as
        | { unsubActivity?: () => void; lastActivityRefresh?: number }
        | undefined;
      const settled = !snapshot || snapshot.status !== "running";
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
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);

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

      const report = await runTool(getRuntime(), manager.cancel(ids));

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

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
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

  // --- Command ------------------------------------------------------------

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (
          !ctx.hasUI ||
          typeof ctx.ui.select !== "function" ||
          typeof ctx.ui.input !== "function"
        ) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "Subagent takeover is only available in the TUI",
              "error",
            );
          return;
        }
        const manager = await getManager();
        await runHeadlessSubagentsDialog(ctx.ui, standardView(manager));
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
    description: "Open the subagents dashboard",
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
}
