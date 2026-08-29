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

type Pane = "runs" | "tasks";
type NarrowLevel = "runs" | "tasks";
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
    `${projection.counts.terminal}/${projection.counts.total} · ${projection.status} · ${elapsed(projection, now)}`,
  );
  const room = Math.max(1, safeWidth - visibleWidth(right) - 2);
  const clipped = truncateToWidth(left, room, "…");
  return truncateToWidth(
    `${clipped}${" ".repeat(Math.max(1, safeWidth - visibleWidth(clipped) - visibleWidth(right)))}${right}`,
    safeWidth,
    "",
  );
}

function scopeLabel(task: WorkflowTaskProjection): string {
  if (task.readOnly) return "read only";
  if (task.owns.length === 0) return "owned scope";
  return `owns ${task.owns.join(",")}`;
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
    const state = theme.fg("dim", task.status);
    rows.push(
      truncateToWidth(
        ` ${marker} ${theme.fg("dim", branch)} ${glyph} ${label} ${state}`,
        safeWidth,
        "…",
      ),
    );
    const needs =
      task.dependencies.length > 0
        ? `needs:${task.dependencies.join(",")} · `
        : "";
    const runtime = [task.backend, task.model, task.effort]
      .filter((value) => value !== undefined)
      .join("/");
    const activity = task.currentTool ? ` · ${task.currentTool}` : "";
    const attempts =
      task.attemptNumber > 1 ? ` · try ${task.attemptNumber}` : "";
    rows.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `     ${needs}${scopeLabel(task)} · ${runtime}${attempts}${activity}`,
        ),
        safeWidth,
        "…",
      ),
    );
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

function runSummary(projection: WorkflowProjection, theme: Theme): string[] {
  const counts = projection.counts;
  const rows = [
    `${theme.fg(statusColor(projection.status), runGlyph(projection.status))} ${theme.bold(
      projection.name ?? projection.id,
    )}`,
    theme.fg(
      "dim",
      `${projection.status} · ${counts.terminal}/${counts.total} terminal · v${projection.version}`,
    ),
  ];
  const live = [
    counts.running ? `${counts.running} running` : undefined,
    counts.queued ? `${counts.queued} queued` : undefined,
    counts.ready ? `${counts.ready} ready` : undefined,
    counts.blocked ? `${counts.blocked} blocked` : undefined,
    counts.skipped ? `${counts.skipped} skipped` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (live.length > 0) rows.push(theme.fg("muted", live.join(" · ")));
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

function projections(source: WorkflowDashboardSource): WorkflowProjection[] {
  const children = source.children();
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
  private pane: Pane = "runs";
  private narrowLevel: NarrowLevel = "runs";
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
    const items = projections(this.source);
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
    const cancel =
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel");
    const narrow = this.narrow();
    if (cancel) {
      if (narrow && this.narrowLevel === "tasks") {
        this.narrowLevel = "runs";
        this.pane = "runs";
        this.tui.requestRender();
      } else {
        this.close({ kind: "close" });
      }
      return;
    }
    const left =
      data === "h" || this.keybindings.matches(data, "tui.editor.cursorLeft");
    const right =
      data === "l" || this.keybindings.matches(data, "tui.editor.cursorRight");
    const up = data === "k" || this.keybindings.matches(data, "tui.select.up");
    const down =
      data === "j" || this.keybindings.matches(data, "tui.select.down");
    const enter = this.keybindings.matches(data, "tui.select.confirm");

    if (!narrow && left) this.pane = "runs";
    else if (!narrow && right) this.pane = "tasks";
    else if (up) this.move(-1);
    else if (down) this.move(1);
    else if (enter || (narrow && right)) this.activate(narrow);
    else return;
    this.tui.requestRender();
  }

  private move(direction: -1 | 1): void {
    const items = this.snapshot();
    if (this.pane === "runs") {
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

  private activate(narrow: boolean): void {
    const items = this.snapshot();
    const run = items[this.runIndex];
    if (!run) return;
    if (this.pane === "runs") {
      this.pane = "tasks";
      if (narrow) this.narrowLevel = "tasks";
      return;
    }
    const childId = run.tasks[this.taskIndex]?.childId;
    if (childId) this.close({ kind: "child", childId });
  }

  private footer(width: number): string {
    const narrow = this.narrow();
    const state = narrow
      ? `narrow ${this.narrowLevel} pane`
      : `wide ${this.pane} pane`;
    const back =
      narrow && this.narrowLevel === "tasks" ? "esc back" : "esc close";
    const essential = ` ${back} · Ctrl+Shift+Z close`;
    if (visibleWidth(essential) >= width) {
      return truncateToWidth(` esc · Ctrl+Shift+Z`, width, "");
    }
    const actions = narrow
      ? this.narrowLevel === "tasks"
        ? "j/k move · enter child"
        : "j/k move · enter tasks"
      : "j/k move · h/l pane · enter child";
    return truncateToWidth(
      this.theme.fg("dim", `${essential} · ${state} · ${actions}`),
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
    const lineBudget = Math.max(0, (this.tui.terminal.rows || 30) - 1);
    if (lineBudget === 0) return [];
    const header = truncateToWidth(
      ` ${this.theme.fg("accent", "◆")} ${this.theme.bold("Workflows")} ${this.theme.fg(
        "dim",
        `· ${items.length} run${items.length === 1 ? "" : "s"} · Ctrl+Shift+Z`,
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
        this.theme.fg("muted", " No workflow runs yet."),
        footer(),
      ];
    }
    const current = items[this.runIndex] ?? items[0]!;
    if (width >= TWO_PANE_MIN_WIDTH) this.narrowLevel = this.pane;
    else if (this.pane === "tasks") this.narrowLevel = "tasks";
    if (lineBudget < 5) {
      if (lineBudget === 1) return [footer()];
      return [header, footer()];
    }
    const bodyHeight = lineBudget - 2;

    if (width < TWO_PANE_MIN_WIDTH) {
      if (this.narrowLevel === "runs") {
        const available = Math.max(1, bodyHeight - 2);
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
          ...panel("Runs", rows, width, bodyHeight, true, this.theme),
          footer(),
        ];
      }
      const summary = runSummary(current, this.theme)
        .slice(0, Math.max(1, lineBudget - 5))
        .map((line) => truncateToWidth(` ${line}`, width, "…"));
      const allRows = renderWorkflowTaskRows(
        current,
        width - 2,
        this.selection.taskId,
        this.theme,
      );
      const selectedRow = this.taskIndex * 2;
      const panelHeight = lineBudget - 2 - summary.length;
      if (panelHeight < 3) return [header, footer()];
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
        ...summary,
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
    const bodyCapacity = bodyHeight - 2;
    const summary = runSummary(current, this.theme).slice(
      0,
      Math.max(1, bodyCapacity - 2),
    );
    const allTaskRows = renderWorkflowTaskRows(
      current,
      rightWidth - 2,
      this.selection.taskId,
      this.theme,
    );
    const taskCapacity = Math.max(1, bodyCapacity - summary.length - 1);
    const selectedTaskRow = this.taskIndex * 2;
    this.taskOffset = this.selectedOffset(
      selectedTaskRow,
      allTaskRows.length,
      this.taskOffset,
      taskCapacity,
    );
    const details = [
      ...summary,
      "",
      ...allTaskRows.slice(this.taskOffset, this.taskOffset + taskCapacity),
    ];
    const left = panel(
      "Runs",
      runRows,
      leftWidth,
      bodyHeight,
      this.pane === "runs",
      this.theme,
    );
    const right = panel(
      "Run · tasks",
      details,
      rightWidth,
      bodyHeight,
      this.pane === "tasks",
      this.theme,
    );
    return [
      header,
      ...left.map((line, index) => `${line} ${right[index] ?? ""}`),
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
      ctx.ui.notify("No workflow runs yet.", "info");
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
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    if (result.kind === "toggle") return true;
    if (result.kind !== "child") return false;
    const toggled = await openSubagent(ctx, childView, result.childId, {
      title: "Workflow child",
      readOnly: true,
      toggleShortcut: "ctrl+shift+z",
    });
    if (toggled) return true;
  }
}
