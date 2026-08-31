import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "../domain.ts";
import type { SubagentReadModel } from "../manager.ts";
import type { WorkflowReadModel } from "../workflows/domain.ts";
import {
  projectWorkflowRun,
  type WorkflowProjection,
  type WorkflowTaskProjection,
} from "../workflows/projection.ts";
import type { WorkflowManager } from "../workflows/manager.ts";
import { openSubagent } from "./takeover.ts";

const TWO_PANE_MIN_WIDTH = 92;
const MAX_DASHBOARD_ROWS = 22;

type Mode = "overview" | "tasks";
type Focus = "list" | "inspector";
export type WorkflowDashboardResult =
  | { readonly kind: "close" }
  | { readonly kind: "toggle" }
  | { readonly kind: "child"; readonly childId: string };

export interface WorkflowDashboardSelection {
  runId?: string;
  taskId?: string;
}

export interface WorkflowDashboardSource {
  list(): ReadonlyArray<WorkflowReadModel>;
  subscribe(runId: string, listener: () => void): () => void;
  children(): ReadonlyArray<SubagentSnapshot>;
  subscribeChildren(listener: () => void): () => void;
}

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "…");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function panel(
  title: string,
  rows: ReadonlyArray<string>,
  width: number,
  height: number,
  focused: boolean,
  theme: Theme,
): string[] {
  const safeWidth = Math.max(1, width);
  const inner = Math.max(0, safeWidth - 2);
  const bodyHeight = Math.max(1, height - 2);
  const color = focused ? "borderAccent" : "borderMuted";
  const heading = ` ${truncateToWidth(title, Math.max(0, inner - 3), "")} `;
  const rule = Math.max(0, inner - visibleWidth(heading) - 1);
  const output = [
    truncateToWidth(
      theme.fg(color, `╭─${heading}${"─".repeat(rule)}╮`),
      safeWidth,
      "",
    ),
  ];
  for (let index = 0; index < bodyHeight; index++) {
    output.push(
      truncateToWidth(
        `${theme.fg(color, "│")}${pad(rows[index] ?? "", inner)}${theme.fg(color, "│")}`,
        safeWidth,
        "",
      ),
    );
  }
  output.push(
    truncateToWidth(theme.fg(color, `╰${"─".repeat(inner)}╯`), safeWidth, ""),
  );
  return output;
}

/** Fill a selected row so the focus cue remains visible without relying on color alone. */
function selectedLine(text: string, width: number, theme: Theme): string {
  const line = pad(text, width);
  return theme.bg?.("selectedBg", line) ?? line;
}

export function workflowStatusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "DONE";
    case "declared":
      return "BLOCKED";
    default:
      return status.replace(/_/gu, " ").toUpperCase();
  }
}

function statusColor(
  status: WorkflowReadModel["status"],
): Parameters<Theme["fg"]>[0] {
  switch (status) {
    case "running":
      return "warning";
    case "paused":
      return "accent";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "muted";
    case "pending_approval":
      return "dim";
  }
}

function runGlyph(status: WorkflowReadModel["status"]): string {
  switch (status) {
    case "running":
      return "◆";
    case "paused":
      return "◇";
    case "completed":
      return "✓";
    case "failed":
      return "×";
    case "cancelled":
      return "■";
    case "pending_approval":
      return "○";
  }
}

function taskGlyph(task: WorkflowTaskProjection): string {
  switch (task.status) {
    case "declared":
      return "○";
    case "completed":
      return "✓";
    case "failed":
      return "×";
    case "cancelled":
      return "■";
    case "skipped":
      return "↷";
    case "running":
      return "◆";
    case "queued":
      return "◈";
    case "ready":
      return "◇";
    case "blocked":
      return "○";
  }
}

function taskColor(task: WorkflowTaskProjection): Parameters<Theme["fg"]>[0] {
  switch (task.status) {
    case "declared":
      return "muted";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "running":
      return "warning";
    case "ready":
    case "queued":
      return "accent";
    case "cancelled":
    case "skipped":
    case "blocked":
      return "muted";
  }
}

function elapsed(
  run: Pick<WorkflowReadModel, "createdAt" | "startedAt" | "finishedAt">,
  now = Date.now(),
): string {
  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt ?? now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function renderWorkflowRunRow(
  projection: WorkflowProjection,
  width: number,
  selected: boolean,
  theme: Theme,
  now = Date.now(),
): string {
  const safeWidth = Math.max(1, width);
  const marker = selected ? theme.fg("accent", "❯") : " ";
  const glyph = theme.fg(
    statusColor(projection.status),
    runGlyph(projection.status),
  );
  const name = projection.name ?? projection.id;
  const identity = selected
    ? theme.fg("accent", theme.bold(name))
    : theme.fg("text", name);
  const left = ` ${marker} ${glyph} ${identity}`;
  const right = theme.fg(
    "dim",
    `${projection.counts.completed}/${projection.counts.total} done · ${projection.counts.running} running · ${projection.counts.blocked} blocked${safeWidth >= 70 ? ` · ${elapsed(projection, now)}` : ""}`,
  );
  const room = Math.max(1, safeWidth - visibleWidth(right) - 2);
  const clipped = truncateToWidth(left, room, "…");
  const line = truncateToWidth(
    `${clipped}${" ".repeat(Math.max(1, safeWidth - visibleWidth(clipped) - visibleWidth(right)))}${right}`,
    safeWidth,
    "",
  );
  return selected ? selectedLine(line, safeWidth, theme) : line;
}

function scopeLabel(task: WorkflowTaskProjection): string {
  if (task.readOnly) return "read only";
  if (task.owns.length === 0) return "owned scope";
  return `owns ${task.owns.join(",")}`;
}

function blockedReason(
  task: WorkflowTaskProjection,
  projection: WorkflowProjection,
): string {
  const waitingOn = task.dependencies.filter(
    (dependencyId) =>
      projection.tasks.find((dependency) => dependency.id === dependencyId)
        ?.status !== "completed",
  );
  return waitingOn.length > 0
    ? `BLOCKED <- ${waitingOn.join(", ")}`
    : "BLOCKED · waiting for admission";
}

export function renderWorkflowTaskRows(
  projection: WorkflowProjection,
  width: number,
  selectedTaskId: string | undefined,
  theme: Theme,
): string[] {
  const safeWidth = Math.max(1, width);
  const rows: string[] = [];
  projection.tasks.forEach((task, index) => {
    const selected = task.id === selectedTaskId;
    const branch = index === projection.tasks.length - 1 ? "╰─" : "├─";
    const marker = selected ? theme.fg("accent", "❯") : " ";
    const glyph = theme.fg(taskColor(task), taskGlyph(task));
    const label = selected
      ? theme.fg("accent", theme.bold(task.label))
      : theme.fg("text", task.label);
    const state = theme.fg(
      "dim",
      workflowStatusLabel(
        task.displayStatus === "blocked" ? "blocked" : task.status,
      ),
    );
    const primary = truncateToWidth(
      ` ${marker} ${theme.fg("dim", branch)} ${glyph} ${label} ${state}`,
      safeWidth,
      "…",
    );
    rows.push(selected ? selectedLine(primary, safeWidth, theme) : primary);
    const metadata = [
      task.dependencies.length > 0
        ? `needs:${task.dependencies.join(",")}`
        : undefined,
      scopeLabel(task),
      [task.backend, task.model, task.effort]
        .filter((value) => value !== undefined)
        .join("/"),
      task.attemptNumber > 1 ? `try ${task.attemptNumber}` : undefined,
      task.currentTool ? `tool:${task.currentTool}` : undefined,
      task.displayStatus === "blocked"
        ? blockedReason(task, projection)
        : undefined,
    ]
      .filter((value): value is string => value !== undefined && value !== "")
      .join(" · ");
    const secondary = truncateToWidth(
      theme.fg("dim", `     ${metadata}`),
      safeWidth,
      "…",
    );
    rows.push(selected ? selectedLine(secondary, safeWidth, theme) : secondary);
    if (selected && task.error) {
      rows.push(
        truncateToWidth(
          theme.fg("error", `     ${task.error}`),
          safeWidth,
          "…",
        ),
      );
    }
  });
  return rows;
}

function runSummary(
  projection: WorkflowProjection,
  currentTask: WorkflowTaskProjection | undefined,
  theme: Theme,
): string[] {
  const counts = projection.counts;
  const status = workflowStatusLabel(projection.status);
  const rows = [
    `${theme.fg(statusColor(projection.status), runGlyph(projection.status))} ${theme.bold(
      projection.name ?? projection.id,
    )} ${theme.fg(statusColor(projection.status), theme.bold(status))}`,
    theme.fg(
      "dim",
      `${projection.id} · ${counts.completed}/${counts.total} done · ${counts.running} running · ${counts.blocked} blocked · v${projection.version}`,
    ),
  ];
  if (projection.description) {
    rows.push(theme.fg("muted", `“${projection.description}”`));
  }
  const terminal = [
    counts.completed ? `${counts.completed} done` : undefined,
    counts.failed ? `${counts.failed} failed` : undefined,
    counts.cancelled ? `${counts.cancelled} cancelled` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (terminal.length > 0) rows.push(theme.fg("muted", terminal.join(" · ")));
  const other = [
    counts.queued ? `${counts.queued} queued` : undefined,
    counts.ready ? `${counts.ready} ready` : undefined,
    counts.skipped ? `${counts.skipped} skipped` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (other.length > 0) rows.push(theme.fg("accent", other.join(" · ")));
  if (currentTask) {
    rows.push(
      theme.fg(
        "accent",
        `current: ${currentTask.id} · ${currentTask.label} · ${workflowStatusLabel(currentTask.status)}`,
      ),
    );
  }
  if (projection.outcome?.recovery) {
    rows.push(theme.fg("warning", `recovery: ${projection.outcome.recovery}`));
  }
  if (projection.outcome?.message) {
    rows.push(
      theme.fg(
        projection.status === "failed" ? "error" : "muted",
        projection.outcome.message,
      ),
    );
  }
  return rows;
}

function taskDetail(
  task: WorkflowTaskProjection,
  projection: WorkflowProjection,
  theme: Theme,
): string[] {
  const runtime = [task.backend, task.model, task.effort]
    .filter((value) => value !== undefined)
    .join("/");
  const scope = scopeLabel(task);
  const attempt =
    task.attemptNumber > 0 ? `attempt ${task.attemptNumber}` : "not started";
  const lines = [
    `${theme.fg(taskColor(task), taskGlyph(task))} ${theme.bold(task.label)}`,
    theme.fg(
      "dim",
      `state: ${task.status} (${workflowStatusLabel(task.status)}) · ${attempt}`,
    ),
    theme.fg("muted", runtime ? `${runtime} · ${scope}` : scope),
  ];
  if (task.dependencies.length > 0) {
    lines.push(theme.fg("dim", `needs: ${task.dependencies.join(", ")}`));
  }
  if (task.displayStatus === "blocked") {
    lines.push(theme.fg("warning", blockedReason(task, projection)));
  }
  const history = task.attempts.map(
    (item) => `#${item.number} ${workflowStatusLabel(item.status)}`,
  );
  if (history.length > 0) {
    lines.push(theme.fg("dim", `history: ${history.join(" · ")}`));
  }
  const activity = [
    task.currentTool ? `tool: ${task.currentTool}` : undefined,
    task.completedOperations > 0
      ? `${task.completedOperations} ops`
      : undefined,
    task.turns > 0 ? `${task.turns} turns` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (activity.length > 0) lines.push(theme.fg("dim", activity.join(" · ")));
  if (task.error) lines.push(theme.fg("error", task.error));
  return lines;
}

function projections(
  source: WorkflowDashboardSource,
  children = source.children(),
): WorkflowProjection[] {
  return [...source.list()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((run) => projectWorkflowRun(run, children));
}

export class WorkflowDashboard implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly source: WorkflowDashboardSource;
  private readonly selection: WorkflowDashboardSelection;
  private readonly done: (result: WorkflowDashboardResult) => void;
  private mode: Mode = "overview";
  private focus: Focus = "list";
  private runIndex = 0;
  private taskIndex = 0;
  private runOffset = 0;
  private taskOffset = 0;
  private subscriptions = new Map<string, () => void>();
  private readonly unsubscribeChildren: () => void;
  private readonly ticker: ReturnType<typeof setInterval>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private lastWidth: number;
  private availableChildIds = new Set<string>();
  private selectedTaskChildId?: string;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    source: WorkflowDashboardSource,
    selection: WorkflowDashboardSelection,
    done: (result: WorkflowDashboardResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.source = source;
    this.selection = selection;
    this.done = done;
    this.lastWidth = tui.terminal.columns || 120;
    this.unsubscribeChildren = source.subscribeChildren(() =>
      this.scheduleRender(),
    );
    this.syncSubscriptions();
    this.ticker = setInterval(() => this.scheduleRender(), 1000);
  }

  private snapshot(): WorkflowProjection[] {
    const children = this.source.children();
    this.availableChildIds = new Set(children.map((child) => child.id));
    const items = projections(this.source, children);
    this.syncSubscriptions();
    if (items.length === 0) return items;
    const selectedRunIndex = this.selection.runId
      ? items.findIndex((run) => run.id === this.selection.runId)
      : -1;
    this.runIndex =
      selectedRunIndex >= 0
        ? selectedRunIndex
        : Math.max(0, Math.min(this.runIndex, items.length - 1));
    const tasks = items[this.runIndex]?.tasks ?? [];
    const selectedTaskIndex = this.selection.taskId
      ? tasks.findIndex((task) => task.id === this.selection.taskId)
      : -1;
    this.taskIndex =
      selectedTaskIndex >= 0
        ? selectedTaskIndex
        : Math.max(0, Math.min(this.taskIndex, Math.max(0, tasks.length - 1)));
    this.selectedTaskChildId = tasks[this.taskIndex]?.childId;
    this.selection.runId = items[this.runIndex]?.id;
    this.selection.taskId = tasks[this.taskIndex]?.id;
    return items;
  }

  private syncSubscriptions(): void {
    const ids = new Set(this.source.list().map((run) => run.id));
    for (const [id, unsubscribe] of this.subscriptions) {
      if (ids.has(id)) continue;
      unsubscribe();
      this.subscriptions.delete(id);
    }
    for (const id of ids) {
      if (this.subscriptions.has(id)) continue;
      this.subscriptions.set(
        id,
        this.source.subscribe(id, () => this.scheduleRender()),
      );
    }
  }

  private scheduleRender(): void {
    if (this.closed || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 80);
  }

  private narrow(): boolean {
    return this.lastWidth < TWO_PANE_MIN_WIDTH;
  }

  private selectedChildAvailable(run: WorkflowProjection): boolean {
    const task = run.tasks[this.taskIndex];
    return (
      task?.childId !== undefined && this.availableChildIds.has(task.childId)
    );
  }

  private get currentChildAvailable(): boolean {
    return (
      this.selectedTaskChildId !== undefined &&
      this.availableChildIds.has(this.selectedTaskChildId)
    );
  }

  private cleanup(): boolean {
    if (this.closed) return false;
    this.closed = true;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.unsubscribeChildren();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    return true;
  }

  dispose(): void {
    this.cleanup();
  }

  dismiss(): void {
    if (this.cleanup()) this.done({ kind: "close" });
  }

  private close(result: WorkflowDashboardResult): void {
    if (this.cleanup()) this.done(result);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+shift+z")) {
      this.close({ kind: "toggle" });
      return;
    }
    const left =
      data === "h" || this.keybindings.matches(data, "tui.editor.cursorLeft");
    const right =
      data === "l" || this.keybindings.matches(data, "tui.editor.cursorRight");
    const quit =
      data === "q" || this.keybindings.matches(data, "app.interrupt");
    const back = this.keybindings.matches(data, "tui.select.cancel");
    const narrow = this.narrow();
    if (quit) {
      this.close({ kind: "close" });
      return;
    }
    if (back) {
      if (this.mode === "tasks") {
        this.mode = "overview";
        this.focus = "list";
        this.tui.requestRender();
      } else {
        this.close({ kind: "close" });
      }
      return;
    }
    if (narrow && this.mode === "tasks" && left) {
      this.mode = "overview";
      this.focus = "list";
      this.tui.requestRender();
      return;
    }
    const up = data === "k" || this.keybindings.matches(data, "tui.select.up");
    const down =
      data === "j" || this.keybindings.matches(data, "tui.select.down");
    const enter = this.keybindings.matches(data, "tui.select.confirm");

    if (!narrow && left) this.focus = "list";
    else if (!narrow && right) this.focus = "inspector";
    else if (up) this.move(-1);
    else if (down) this.move(1);
    else if (enter || (narrow && right)) this.activate();
    else return;
    this.tui.requestRender();
  }

  private move(direction: -1 | 1): void {
    const items = this.snapshot();
    if (this.mode === "overview") {
      this.runIndex = Math.max(
        0,
        Math.min(items.length - 1, this.runIndex + direction),
      );
      this.taskIndex = 0;
      this.selection.runId = items[this.runIndex]?.id;
      this.selection.taskId = items[this.runIndex]?.tasks[0]?.id;
      return;
    }
    const tasks = items[this.runIndex]?.tasks ?? [];
    this.taskIndex = Math.max(
      0,
      Math.min(tasks.length - 1, this.taskIndex + direction),
    );
    this.selection.taskId = tasks[this.taskIndex]?.id;
  }

  private activate(): void {
    const items = this.snapshot();
    const run = items[this.runIndex];
    if (!run) return;
    if (this.mode === "overview") {
      this.mode = "tasks";
      this.focus = "list";
      return;
    }
    const childId = run.tasks[this.taskIndex]?.childId;
    if (childId && this.selectedChildAvailable(run))
      this.close({ kind: "child", childId });
  }

  private footer(width: number): string {
    const narrow = this.narrow();
    const state = narrow ? `narrow ${this.mode}` : `wide ${this.mode}`;
    const back = this.mode === "tasks" ? "esc back" : "esc close";
    const childHint =
      this.mode === "tasks" && this.currentChildAvailable
        ? " · enter child"
        : "";
    const actions = narrow
      ? this.mode === "tasks"
        ? `j/k${childHint} · ${back}`
        : "j/k · enter tasks"
      : this.mode === "overview"
        ? "j/k move · h/l focus · enter tasks"
        : `j/k move · h/l focus${childHint}`;
    const primary = ` ${state} · ${actions}`;
    const essential = ` · ${back} · q · Ctrl+Shift+Z`;
    if (visibleWidth(primary) + visibleWidth(essential) >= width) {
      return truncateToWidth(primary, width, "");
    }
    return truncateToWidth(
      this.theme.fg("dim", `${primary}${essential}`),
      width,
      "",
    );
  }

  private selectedOffset(
    selectedRow: number,
    rowCount: number,
    offset: number,
    capacity: number,
  ): number {
    const maxOffset = Math.max(0, rowCount - capacity);
    const next = Math.max(0, Math.min(offset, maxOffset));
    if (selectedRow < next) return selectedRow;
    if (selectedRow >= next + capacity)
      return Math.min(maxOffset, selectedRow - capacity + 1);
    return next;
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const items = this.snapshot();
    const lineBudget = Math.max(
      0,
      Math.min(MAX_DASHBOARD_ROWS, (this.tui.terminal.rows || 30) - 1),
    );
    if (lineBudget === 0) return [];
    const activeRuns = items.filter(
      (run) => run.status === "running" || run.status === "paused",
    ).length;
    const header = truncateToWidth(
      ` ${this.theme.fg("accent", "◆")} ${this.theme.bold("Workflows")} ${this.theme.fg(
        "dim",
        `· ${items.length} run${items.length === 1 ? "" : "s"}${activeRuns > 0 ? ` · ${activeRuns} active` : ""} · Ctrl+Shift+Z toggle`,
      )}`,
      width,
      "",
    );
    const footer = () => this.footer(width);
    if (items.length === 0) {
      if (lineBudget === 1) return [footer()];
      if (lineBudget === 2) return [header, footer()];
      return [
        header,
        truncateToWidth(
          this.theme.fg(
            "muted",
            " No workflow runs yet. Approve a workflow to see it here.",
          ),
          width,
          "…",
        ),
        footer(),
      ];
    }
    const current = items[this.runIndex] ?? items[0]!;
    const currentTask = current.tasks[this.taskIndex];
    if (lineBudget < 5) {
      if (lineBudget === 1) return [footer()];
      return [header, footer()];
    }
    const bodyHeight = lineBudget - 2;

    if (width < TWO_PANE_MIN_WIDTH) {
      if (this.mode === "overview") {
        const summary = [
          "Overview",
          ...runSummary(current, currentTask, this.theme),
        ].slice(0, Math.max(1, lineBudget - 6));
        const panelHeight = lineBudget - 2 - summary.length;
        if (panelHeight < 3) return [header, footer()];
        const available = Math.max(1, panelHeight - 2);
        this.runOffset = this.selectedOffset(
          this.runIndex,
          items.length,
          this.runOffset,
          available,
        );
        const rows = items
          .slice(this.runOffset, this.runOffset + available)
          .map((run) =>
            renderWorkflowRunRow(
              run,
              width - 2,
              run.id === current.id,
              this.theme,
            ),
          );
        return [
          header,
          ...summary.map((line) => truncateToWidth(` ${line}`, width, "…")),
          ...panel("Runs", rows, width, panelHeight, true, this.theme),
          footer(),
        ];
      }
      const detail = currentTask
        ? taskDetail(currentTask, current, this.theme).slice(
            0,
            Math.max(1, lineBudget - 6),
          )
        : ["No task selected"];
      const panelHeight = lineBudget - 2 - detail.length;
      if (panelHeight < 3) return [header, footer()];
      const allRows = renderWorkflowTaskRows(
        current,
        width - 2,
        this.selection.taskId,
        this.theme,
      );
      const selectedRow = this.taskIndex * 2;
      const room = Math.max(1, panelHeight - 2);
      this.taskOffset = this.selectedOffset(
        selectedRow,
        allRows.length,
        this.taskOffset,
        room,
      );
      const rows = allRows.slice(this.taskOffset, this.taskOffset + room);
      return [
        header,
        ...detail.map((line, index) =>
          truncateToWidth(
            `${index === 0 ? " Task · " : " "}${line}`,
            width,
            "…",
          ),
        ),
        ...panel("Tasks", rows, width, panelHeight, true, this.theme),
        footer(),
      ];
    }

    const gap = 1;
    const leftWidth = Math.max(34, Math.floor((width - gap) * 0.36));
    const rightWidth = width - leftWidth - gap;
    const allRunRows = items.map((run) =>
      renderWorkflowRunRow(
        run,
        leftWidth - 2,
        run.id === current.id,
        this.theme,
      ),
    );
    const runCapacity = Math.max(1, bodyHeight - 2);
    this.runOffset = this.selectedOffset(
      this.runIndex,
      allRunRows.length,
      this.runOffset,
      runCapacity,
    );
    const runRows = allRunRows.slice(
      this.runOffset,
      this.runOffset + runCapacity,
    );
    const left = panel(
      "Runs",
      runRows,
      leftWidth,
      bodyHeight,
      this.mode === "overview" && this.focus === "list",
      this.theme,
    );
    if (this.mode === "overview") {
      const overview = runSummary(current, currentTask, this.theme);
      const right = panel(
        "Overview",
        overview,
        rightWidth,
        bodyHeight,
        this.focus === "inspector",
        this.theme,
      );
      return [
        header,
        ...left.map((line, index) => `${line} ${right[index] ?? ""}`),
        footer(),
      ].map((line) => truncateToWidth(line, width, ""));
    }

    const allTaskRows = renderWorkflowTaskRows(
      current,
      leftWidth - 2,
      this.selection.taskId,
      this.theme,
    );
    const taskCapacity = Math.max(1, bodyHeight - 2);
    const selectedTaskRow = this.taskIndex * 2;
    this.taskOffset = this.selectedOffset(
      selectedTaskRow,
      allTaskRows.length,
      this.taskOffset,
      taskCapacity,
    );
    const taskRows = allTaskRows.slice(
      this.taskOffset,
      this.taskOffset + taskCapacity,
    );
    const task = currentTask
      ? taskDetail(currentTask, current, this.theme)
      : ["No task selected"];
    const taskPanel = panel(
      "Task",
      task,
      rightWidth,
      bodyHeight,
      this.focus === "inspector",
      this.theme,
    );
    const taskList = panel(
      "Tasks",
      taskRows,
      leftWidth,
      bodyHeight,
      this.focus === "list",
      this.theme,
    );
    return [
      header,
      ...taskList.map((line, index) => `${line} ${taskPanel[index] ?? ""}`),
      footer(),
    ].map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
}

export async function openWorkflowDashboard(
  ctx: Pick<ExtensionContext, "mode" | "ui">,
  manager: WorkflowManager,
  childView: SubagentReadModel,
  selection: WorkflowDashboardSelection = {},
): Promise<boolean> {
  while (true) {
    if (manager.list().length === 0) {
      ctx.ui.notify(
        "No workflow runs yet. Approve a workflow to see it here.",
        "info",
      );
      return false;
    }
    const source: WorkflowDashboardSource = {
      list: () => manager.list(),
      subscribe: (runId, listener) => manager.subscribe(runId, listener),
      children: () => childView.list(),
      subscribeChildren: (listener) => childView.subscribe(listener),
    };
    const result = await ctx.ui.custom<WorkflowDashboardResult>(
      (tui, theme, keybindings, done) =>
        new WorkflowDashboard(tui, theme, keybindings, source, selection, done),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "94%",
          maxHeight: MAX_DASHBOARD_ROWS,
          margin: 1,
        },
      },
    );
    if (result.kind === "toggle") return true;
    if (result.kind !== "child") return false;
    if (!childView.get(result.childId)) {
      ctx.ui.notify(
        "Workflow child is not available in this session.",
        "warning",
      );
      continue;
    }
    const toggled = await openSubagent(ctx, childView, result.childId, {
      title: "Workflow child",
      readOnly: true,
      toggleShortcut: "ctrl+shift+z",
    });
    if (toggled) return true;
  }
}
