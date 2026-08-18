/**
 * Takeover UI for subagents (ported from v1, rendering from the synchronous
 * SubagentReadModel instead of live pi sessions):
 * - SubagentDashboard: full popup (overlay) listing all subagents.
 * - TakeoverView: full interactive view of one subagent with an input line
 *   to steer/continue it.
 */

import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed, type SubagentSnapshot } from "../domain.ts";
import { formatContextUtilization } from "../format.ts";
import type { SubagentReadModel } from "../manager.ts";
import { buildTranscriptLines, sanitizeText } from "./transcript.ts";

/** Pad a line to `width` and apply a background fn across the full width
 * (inline copy of pi-tui's unreachable applyBackgroundToLine). */
function backgroundLine(
  line: string,
  width: number,
  bgFn: (text: string) => string,
) {
  const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
  return bgFn(line + padding);
}

/** Below this terminal width the dashboard falls back to a single list. */
const TWO_PANE_MIN_WIDTH = 88;
const TRANSCRIPT_SCROLL_STEP = 6;

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "error":
      return theme.fg("error", "■");
  }
}

export function subagentThinkingLabel(snap: SubagentSnapshot) {
  return snap.meta.reasoningEffort
    ? `think:${snap.meta.reasoningEffort}`
    : undefined;
}

export function dashboardMetaLabels(snap: SubagentSnapshot) {
  return [
    snap.backend,
    snap.meta.modelLabel ?? "?",
    subagentThinkingLabel(snap),
  ].filter((label): label is string => label !== undefined);
}

export function takeoverMetaLabels(snap: SubagentSnapshot) {
  return [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    subagentThinkingLabel(snap),
  ].filter((label): label is string => label !== undefined);
}

function statusWord(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "error":
      return theme.fg("error", "failed");
  }
}

export function renderDashboardRow(
  snap: SubagentSnapshot,
  width: number,
  isSelected: boolean,
  theme: Theme,
) {
  const marker = isSelected ? theme.fg("accent", "❯") : " ";
  const title = isSelected
    ? theme.fg("accent", snap.title)
    : theme.fg("text", snap.title);
  const left = ` ${marker} ${statusGlyph(snap, theme)} ${title} ${theme.fg("dim", snap.id)}`;

  const utilization = formatContextUtilization(snap.usage);
  const dot = theme.fg("dim", " · ");
  const rightParts = [
    ...dashboardMetaLabels(snap).map((label) => theme.fg("muted", label)),
    ...(utilization ? [theme.fg("muted", utilization)] : []),
    theme.fg("muted", formatElapsed(snap)),
    statusWord(snap, theme),
  ];
  const right = `${rightParts.join(dot)} `;
  const rightWidth = visibleWidth(right);
  const leftMax = Math.max(0, width - rightWidth - 2);
  const leftTruncated = truncateToWidth(left, leftMax);
  const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
  return truncateToWidth(leftTruncated + " ".repeat(gap) + right, width);
}

export function renderTakeoverHeader(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
) {
  const utilization = formatContextUtilization(snap.usage);
  const header =
    `${statusGlyph(snap, theme)} ` +
    theme.fg("accent", theme.bold(`${snap.id} · ${snap.title}`)) +
    ` · ${statusWord(snap, theme)} · ` +
    theme.fg("dim", formatElapsed(snap)) +
    theme.fg("dim", ` · ${takeoverMetaLabels(snap).slice(0, 2).join(" · ")}`) +
    (utilization ? theme.fg("dim", ` · ${utilization}`) : "");
  return truncateToWidth(header, width, "…");
}

/** Two-line row for the left-hand agent list of the two-pane dashboard. */
export function renderListPaneRow(
  snap: SubagentSnapshot,
  width: number,
  isSelected: boolean,
  theme: Theme,
): string[] {
  const marker = isSelected ? theme.fg("accent", "❯") : " ";
  const title = isSelected
    ? theme.fg("accent", snap.title)
    : theme.fg("text", snap.title);
  // Right-align the status word so every row's right edge is clean.
  const status = statusWord(snap, theme);
  const rightWidth = visibleWidth(status) + 1;
  const left = `${marker} ${statusGlyph(snap, theme)} ${title} ${theme.fg("dim", snap.id)}`;
  const leftTruncated = truncateToWidth(
    left,
    Math.max(0, width - rightWidth),
    "…",
  );
  const gap = Math.max(1, width - visibleWidth(leftTruncated) - rightWidth);
  const line1 = leftTruncated + " ".repeat(gap) + status;

  // Meta aligns under the title column (marker + space + glyph + space).
  const meta = [
    snap.meta.modelLabel ?? snap.backend,
    formatContextUtilization(snap.usage) || undefined,
    formatElapsed(snap),
  ]
    .filter((label): label is string => label !== undefined)
    .join(" · ");
  const line2 = `    ${truncateToWidth(theme.fg("dim", meta), Math.max(0, width - 4), "…")}`;

  if (!isSelected) {
    return [truncateToWidth(line1, width, "…"), line2];
  }
  // Full-row highlight: the selection is the row you stare at while steering.
  return [
    backgroundLine(line1, width, (text) => theme.bg("selectedBg", text)),
    backgroundLine(line2, width, (text) => theme.bg("selectedBg", text)),
  ];
}

/** Two header lines for the right-hand detail pane of the two-pane dashboard. */
export function renderDetailHeader(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
): string[] {
  const line1 =
    `${statusGlyph(snap, theme)} ` +
    theme.fg("accent", theme.bold(snap.id)) +
    ` · ${theme.fg("accent", snap.title)} ${statusWord(snap, theme)}`;
  const meta = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage) || undefined,
    formatElapsed(snap),
    snap.completedOperations > 0
      ? `${snap.completedOperations} ops`
      : undefined,
    subagentThinkingLabel(snap),
  ]
    .filter((label): label is string => label !== undefined)
    .join(" · ");
  return [
    truncateToWidth(line1, width),
    truncateToWidth(theme.fg("dim", meta || " "), width),
  ];
}

// --- Entry point ---------------------------------------------------------------

type TakeoverContext = Pick<ExtensionContext, "mode" | "ui">;

export interface TakeoverOptions {
  title?: string;
  /** Use the narrower right-side overlay reserved for extension-owned sessions. */
  floating?: boolean;
  onPopOut?: (id: string) => Promise<boolean>;
  onCloseSession?: (id: string) => Promise<void>;
}

export function takeoverOverlayOptions(floating = false) {
  return floating
    ? {
        anchor: "right-center" as const,
        width: "78%" as const,
        minWidth: 72,
        maxHeight: "100%" as const,
        margin: 1,
      }
    : {
        anchor: "center" as const,
        width: "100%" as const,
        maxHeight: "100%" as const,
      };
}

export async function openSubagent(
  ctx: TakeoverContext,
  view: SubagentReadModel,
  id: string,
  options: TakeoverOptions = {},
): Promise<void> {
  if (!view.get(id)) return;
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new TakeoverView(tui, theme, keybindings, id, view, done, options),
    {
      overlay: true,
      overlayOptions: takeoverOverlayOptions(options.floating),
    },
  );
}

export async function openSubagentPicker(
  ctx: TakeoverContext,
  view: SubagentReadModel,
  options: TakeoverOptions = {},
) {
  const selection: DashboardSelection = { index: 0 };

  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No subagents", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new SubagentDashboard(
          tui,
          theme,
          keybindings,
          view,
          selection,
          done,
          options,
        ),
      {
        overlay: true,
        overlayOptions: takeoverOverlayOptions(options.floating),
      },
    );

    if (!picked) return;
    if (!view.get(picked)) continue;

    await openSubagent(ctx, view, picked, options);
    // After leaving the takeover view, fall back to the dashboard.
  }
}

// --- Dashboard (fullscreen overlay) ----------------------------------------------

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  subs: ReadonlyArray<Pick<SubagentSnapshot, "id">>,
) {
  const stableIndex = selection.id
    ? subs.findIndex((snap) => snap.id === selection.id)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, subs.length - 1));
  selection.id = subs[selection.index]?.id;
}

/**
 * Dashboard ordering (Cursor-style subagents panel): running first, then
 * error, then done, then anything else ("unknown" / future statuses); most
 * recently active first within each group (lastActivityAt, then createdAt,
 * descending). Returns a new array; the input is never mutated.
 */
function dashboardStatusRank(status: SubagentSnapshot["status"]): number {
  switch (status) {
    case "running":
      return 0;
    case "error":
      return 1;
    case "done":
      return 2;
    default:
      return 3;
  }
}

export function orderDashboardSnapshots(
  subs: ReadonlyArray<SubagentSnapshot>,
): ReadonlyArray<SubagentSnapshot> {
  return [...subs].sort(
    (a, b) =>
      dashboardStatusRank(a.status) - dashboardStatusRank(b.status) ||
      b.lastActivityAt - a.lastActivityAt ||
      b.createdAt - a.createdAt,
  );
}

class SubagentDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: SubagentReadModel;
  private selection: DashboardSelection;
  private done: (value: string | null) => void;
  private options: TakeoverOptions;

  private closed = false;
  private ticker: ReturnType<typeof setInterval>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private unsubChange: () => void;
  private input = new Input();
  private focusPane: "list" | "detail" = "list";
  private detailScrollOffset = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: SubagentReadModel,
    selection: DashboardSelection,
    done: (value: string | null) => void,
    options: TakeoverOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    this.options = options;
    // Elapsed times, token counts, and statuses tick along at 1Hz.
    this.ticker = setInterval(() => this.scheduleRender(), 1000);
    // Snapshot updates can arrive once per streamed token. Coalesce them so
    // the dashboard does not repaint the list pane for every child event.
    this.unsubChange = view.subscribe(() => this.scheduleRender());
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      if (!text) return;
      const snap = this.subs()[this.selection.index];
      if (snap) this.view.requestSend(snap.id, text);
      this.input.setValue("");
      this.detailScrollOffset = 0;
      this.scheduleRender();
    };
  }

  private narrow(): boolean {
    return (this.tui.terminal.columns || 100) < TWO_PANE_MIN_WIDTH;
  }

  private focusDetail() {
    this.focusPane = "detail";
    this.input.focused = true;
    this.detailScrollOffset = 0;
    this.scheduleRender();
  }

  private focusList() {
    this.focusPane = "list";
    this.input.focused = false;
    this.scheduleRender();
  }

  private subs(): ReadonlyArray<SubagentSnapshot> {
    return orderDashboardSnapshots(this.view.list());
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.unsubChange();
    return true;
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private close(result: string | null) {
    this.input.focused = false;
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.focusPane === "detail") {
        this.focusList();
        return;
      }
      this.close(null);
      return;
    }
    if (data === "\t") {
      if (this.focusPane === "list") this.focusDetail();
      else this.focusList();
      return;
    }

    if (this.focusPane === "detail") {
      if (this.keybindings.matches(data, "app.clear")) {
        const snap = subs[this.selection.index];
        if (snap?.status === "running") this.view.requestAbort(snap.id);
        return;
      }
      if (data === "o" && this.options.onPopOut) {
        const snap = subs[this.selection.index];
        if (snap) void this.options.onPopOut(snap.id);
        return;
      }
      if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
        this.detailScrollOffset += TRANSCRIPT_SCROLL_STEP;
        this.scheduleRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
        this.detailScrollOffset = Math.max(
          0,
          this.detailScrollOffset - TRANSCRIPT_SCROLL_STEP,
        );
        this.scheduleRender();
        return;
      }
      this.input.handleInput(data);
      this.scheduleRender();
      return;
    }

    // List focus.
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (!this.narrow()) this.focusDetail();
      else {
        const snap = subs[this.selection.index];
        if (snap) this.close(snap.id);
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (subs.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + subs.length) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.detailScrollOffset = 0;
        this.scheduleRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (subs.length > 0) {
        this.selection.index = (this.selection.index + 1) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.detailScrollOffset = 0;
        this.scheduleRender();
      }
      return;
    }
    if (data === "o" && this.options.onPopOut) {
      const snap = subs[this.selection.index];
      if (snap) void this.options.onPopOut(snap.id);
      return;
    }
    if (data === "x") {
      const snap = subs[this.selection.index];
      if (!snap) return;
      if (this.options.onCloseSession)
        void this.options.onCloseSession(snap.id);
      else if (snap.status === "running") this.view.requestAbort(snap.id);
      return;
    }
  }

  private pad(text: string, width: number): string {
    // Callers truncate first; pad only (no ellipsis, no double-cut).
    const padded = truncateToWidth(text, width, "", true);
    return padded;
  }

  private borderSegment(width: number, title: string): string {
    const theme = this.theme;
    const label = title
      ? ` ${truncateToWidth(title, Math.max(0, width - 3))} `
      : "";
    const labelWidth = visibleWidth(label);
    return (
      theme.fg("border", "─") +
      (label ? theme.fg("text", label) : "") +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
    );
  }

  render(width: number): string[] {
    const theme = this.theme;
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    const rows = this.tui.terminal.rows || 30;
    // Render exactly terminal rows - 1 so the overlay covers the header,
    // chat, editor, and extra footer lines while leaving pi's final footer
    // row visible.
    const bodyHeight = Math.max(6, rows - 5);
    const innerWidth = width - 2;

    const lines: string[] = [];

    // Header: title left, count right
    const headerLeft = theme.fg(
      "accent",
      theme.bold(this.options.title ?? "Subagents"),
    );
    const running = subs.filter((s) => s.status === "running").length;
    const headerRight = theme.fg(
      running > 0 ? "warning" : "muted",
      `● ${running} running`,
    );
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(
        `  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
        width,
      ),
    );

    // Top border with panel title.
    const settled = subs.filter((s) => s.status !== "running").length;
    const borderLabel = `agents · ${settled}/${subs.length}`;

    if (this.narrow()) {
      // Single-column list (narrow terminals).
      lines.push(
        theme.fg("border", "╭") +
          this.borderSegment(innerWidth, borderLabel) +
          theme.fg("border", "╮"),
      );
      const divider = theme.fg("border", "│");
      const rowLines = this.renderRows(subs, innerWidth, bodyHeight);
      for (let i = 0; i < bodyHeight; i++) {
        lines.push(divider + this.pad(rowLines[i] ?? "", innerWidth) + divider);
      }
      lines.push(
        theme.fg("border", "╰") +
          theme.fg("border", "─".repeat(innerWidth)) +
          theme.fg("border", "╯"),
      );
    } else {
      // Two panes: agent list on the left, live detail on the right.
      const listWidth = Math.max(
        26,
        Math.min(42, Math.floor(innerWidth * 0.38)),
      );
      const detailWidth = innerWidth - listWidth - 1;
      lines.push(
        theme.fg("border", "╭") +
          this.borderSegment(listWidth, borderLabel) +
          theme.fg("border", "┬") +
          theme.fg("border", "─".repeat(detailWidth)) +
          theme.fg("border", "╮"),
      );
      const left = this.renderListPane(subs, listWidth, bodyHeight);
      const right = this.renderDetailPane(
        subs[this.selection.index],
        detailWidth,
        bodyHeight,
      );
      // The divider's color is the focus affordance: accent = detail pane
      // active, muted = list pane active (the selected row highlights there).
      const divider = theme.fg(
        this.focusPane === "detail" ? "borderAccent" : "borderMuted",
        "│",
      );
      for (let i = 0; i < bodyHeight; i++) {
        lines.push(
          theme.fg("border", "│") +
            this.pad(left[i] ?? "", listWidth) +
            divider +
            this.pad(right[i] ?? "", detailWidth) +
            theme.fg("border", "│"),
        );
      }
      lines.push(
        theme.fg("border", "╰") +
          theme.fg("border", "─".repeat(listWidth)) +
          theme.fg("border", "┴") +
          theme.fg("border", "─".repeat(detailWidth)) +
          theme.fg("border", "╯"),
      );
    }

    // Hints
    lines.push(truncateToWidth(theme.fg("dim", this.helpLine()), width));

    return lines;
  }

  private helpLine(): string {
    const keys = this.keybindings;
    if (this.narrow() || this.options.floating) {
      return this.options.floating
        ? `  ${configuredKeys(keys, "tui.select.up")}/${configuredKeys(keys, "tui.select.down")}/jk select · ${configuredKeys(keys, "tui.select.confirm")} open${this.options.onPopOut ? " · o shell" : ""} · x ${this.options.onCloseSession ? "close" : "abort"} · ${configuredKeys(keys, "tui.select.cancel")} back`
        : `  ${configuredKeys(keys, "tui.select.up")}/${configuredKeys(keys, "tui.select.down")}/jk select · ${configuredKeys(keys, "tui.select.confirm")} take over · x abort · ${configuredKeys(keys, "tui.select.cancel")} close`;
    }
    return this.focusPane === "detail"
      ? `  tab list · ⏎ send steer · ${configuredKeys(keys, "tui.editor.cursorUp")}/${configuredKeys(keys, "tui.editor.cursorDown")} scroll · ${configuredKeys(keys, "app.clear")} abort run${this.options.onPopOut ? " · o shell" : ""} · ${configuredKeys(keys, "tui.select.cancel")} back to list`
      : `  ${configuredKeys(keys, "tui.select.up")}/${configuredKeys(keys, "tui.select.down")}/jk select · tab detail · x abort${this.options.onPopOut ? " · o shell" : ""} · ${configuredKeys(keys, "tui.select.cancel")} close`;
  }

  /** Left pane: compact 2-line rows with a scroll window around the selection. */
  private renderListPane(
    subs: ReadonlyArray<SubagentSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];
    const maxVisible = Math.max(1, Math.floor(height / 2));
    let start = 0;
    if (subs.length > maxVisible) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor((maxVisible - 1) / 2)),
        subs.length - maxVisible,
      );
    }
    const visible = subs.slice(start, start + maxVisible);
    for (let i = 0; i < visible.length; i++) {
      const index = start + i;
      out.push(
        ...renderListPaneRow(
          visible[i]!,
          width,
          index === this.selection.index,
          theme,
        ),
      );
    }
    // Scroll markers occupy a full 2-line slot so no orphaned meta line
    // dangles under a marker.
    if (start > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `  +${start} more`), width);
      out[1] = "";
    }
    if (start + maxVisible < subs.length) {
      const remaining = subs.length - start - maxVisible;
      out[out.length - 2] = "";
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `  +${remaining} more`),
        width,
      );
    }
    return out;
  }

  /** Right pane: detail header + live transcript viewport + steer input. */
  private renderDetailPane(
    snap: SubagentSnapshot | undefined,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    if (!snap) return [theme.fg("dim", "  select an agent")];
    const chrome = 3; // header(2) + input(1)
    const transcriptCapacity = Math.max(1, height - chrome);
    const full = buildTranscriptLines(snap, width, theme);
    const maxOffset = Math.max(0, full.length - transcriptCapacity);
    if (this.detailScrollOffset > maxOffset)
      this.detailScrollOffset = maxOffset;
    const end = full.length - this.detailScrollOffset;
    const visible = full.slice(Math.max(0, end - transcriptCapacity), end);

    const lines = [...renderDetailHeader(snap, width, theme)];
    if (visible.length === 0) lines.push(theme.fg("dim", "(no output yet)"));
    else lines.push(...visible);
    if (this.detailScrollOffset > 0) {
      lines.push(
        truncateToWidth(
          theme.fg(
            "dim",
            `... ${this.detailScrollOffset} lines below · ↑/pgup`,
          ),
          width,
        ),
      );
    }
    while (lines.length < height - 1) lines.push("");
    lines.push(...this.input.render(width));
    return lines;
  }

  private renderRows(
    subs: ReadonlyArray<SubagentSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window around selection
    let start = 0;
    if (subs.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        subs.length - height,
      );
    }
    const visible = subs.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const snap = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;

      out.push(renderDashboardRow(snap, width, isSelected, theme));
    }

    if (start > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} more`), width);
    }
    if (start + height < subs.length) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   ... ${subs.length - start - height} more`),
        width,
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Takeover view ------------------------------------------------------------

class TakeoverView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private view: SubagentReadModel;
  private done: (value: null) => void;
  private options: TakeoverOptions;

  private input = new Input();
  private poppingOut = false;
  /** Scroll offset in lines from the bottom of the transcript. 0 = pinned to bottom. */
  private scrollOffset = 0;
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker: ReturnType<typeof setInterval>;
  private closed = false;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: SubagentReadModel,
    done: (value: null) => void,
    options: TakeoverOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.options = options;
    this.unsubscribe = view.subscribeTo(id, () => this.scheduleRender());
    // Elapsed time in the header ticks along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.view.requestSend(this.id, text);
      this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  private snap(): SubagentSnapshot | undefined {
    return this.view.get(this.id);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // Streaming can emit an event per token. Limit terminal repaints so this
    // view cannot starve input handling or make the child look frozen.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (data === "o" && this.options.onPopOut && !this.poppingOut) {
      this.poppingOut = true;
      this.tui.requestRender();
      void this.options.onPopOut(this.id).then((opened) => {
        if (opened) this.close();
        else {
          this.poppingOut = false;
          this.scheduleRender();
        }
      });
      return;
    }
    if (this.keybindings.matches(data, "app.clear")) {
      const snap = this.snap();
      if (snap?.status === "running") this.view.requestAbort(this.id);
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
      this.scheduleRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
      this.scheduleRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(),
      );
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal.rows || 30;
    // The complete view renders viewport + 7 chrome rows. Using rows - 8
    // makes the overlay exactly terminal rows - 1.
    return Math.max(6, rows - 8);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
    const lines: string[] = [];
    const snap = this.snap();

    if (!snap) {
      lines.push(border);
      lines.push(theme.fg("dim", `${this.id} is no longer tracked`));
      lines.push(border);
      return lines;
    }

    lines.push(border);
    lines.push(renderTakeoverHeader(snap, width, theme));
    lines.push(border);

    // Fixed-height transcript viewport. Error and scroll status consume rows
    // inside the viewport so streaming/scrolling never changes overlay height.
    const transcript = buildTranscriptLines(snap, width, theme);
    const viewport = this.viewportHeight();
    const errorRows = snap.errorText ? 1 : 0;
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const transcriptCapacity = Math.max(1, viewport - errorRows - scrollRows);
    const maxOffset = Math.max(0, transcript.length - transcriptCapacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const body: string[] = [];
    if (snap.errorText) {
      body.push(
        truncateToWidth(
          theme.fg(
            "error",
            `error: ${sanitizeText(snap.errorText).replace(/\s+/g, " ").trim()}`,
          ),
          width,
          "…",
        ),
      );
    }

    const capacity = Math.max(
      1,
      viewport - body.length - (this.scrollOffset > 0 ? 1 : 0),
    );
    const end = transcript.length - this.scrollOffset;
    const visible = transcript.slice(Math.max(0, end - capacity), end);
    if (visible.length === 0) body.push(theme.fg("dim", "(no output yet)"));
    else body.push(...visible);

    if (this.scrollOffset > 0) {
      body.push(
        truncateToWidth(
          theme.fg("dim", `... ${this.scrollOffset} lines below · ↓/pgdn`),
          width,
        ),
      );
    }
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport));

    lines.push(border);
    lines.push(...this.input.render(width));
    const help = this.options.floating
      ? `${configuredKeys(this.keybindings, "tui.input.submit")} send · ${configuredKeys(this.keybindings, "app.interrupt")} back${this.options.onPopOut ? ` · o ${this.poppingOut ? "opening…" : "shell"}` : ""} · ${configuredKeys(this.keybindings, "app.clear")} abort run · ${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")} scroll`
      : `${configuredKeys(this.keybindings, "tui.input.submit")} send · ${configuredKeys(this.keybindings, "app.interrupt")} back · ${configuredKeys(this.keybindings, "app.clear")} abort run · ${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")} scroll · ${configuredKeys(this.keybindings, "tui.editor.pageUp")}/${configuredKeys(this.keybindings, "tui.editor.pageDown")} page`;
    lines.push(truncateToWidth(theme.fg("dim", help), width));
    lines.push(border);
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
