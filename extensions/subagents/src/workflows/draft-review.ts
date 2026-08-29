import {
  highlightCode,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";
import type { WorkflowDraft } from "./drafts.ts";

const MIN_SPLIT_WIDTH = 96;
const MIN_PANEL_HEIGHT = 8;

type Focus = "review" | "definition";
type ReviewAction = "close" | "approve";

function shortenHome(value: string): string {
  const home = process.env.HOME;
  return home && (value === home || value.startsWith(`${home}/`))
    ? `~${value.slice(home.length)}`
    : value;
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function panel(
  title: string,
  rows: string[],
  width: number,
  height: number,
  focused: boolean,
  theme: Theme,
): string[] {
  const panelWidth = Math.max(4, width);
  const innerWidth = panelWidth - 2;
  const bodyHeight = Math.max(1, height - 2);
  const border = focused ? "borderAccent" : "borderMuted";
  const heading = ` ${title} `;
  const ruleLength = Math.max(0, innerWidth - visibleWidth(heading) - 1);
  const lines = [theme.fg(border, `╭─${heading}${"─".repeat(ruleLength)}╮`)];
  for (let index = 0; index < bodyHeight; index++) {
    lines.push(
      `${theme.fg(border, "│")}${padToWidth(rows[index] ?? "", innerWidth)}${theme.fg(border, "│")}`,
    );
  }
  lines.push(theme.fg(border, `╰${"─".repeat(innerWidth)}╯`));
  return lines;
}

function addWrapped(
  rows: string[],
  text: string,
  width: number,
  color: "text" | "muted" | "dim",
  theme: Theme,
): void {
  for (const line of wrapTextWithAnsi(theme.fg(color, text), width)) {
    rows.push(line);
  }
}

function taskScope(draft: WorkflowDraft, taskIndex: number): string {
  const task = draft.definition.tasks[taskIndex];
  if (!task) return "";
  if (task.readOnly) return "read only";
  return `owns ${(task.owns ?? []).join(", ")}`;
}

function reviewRows(
  draft: WorkflowDraft,
  artifactPath: string,
  width: number,
  theme: Theme,
): string[] {
  const rows: string[] = [];
  rows.push(theme.fg("dim", "OUTCOME"));
  addWrapped(rows, draft.preview, width, "text", theme);
  rows.push("");
  rows.push(theme.fg("dim", `TASKS · ${draft.definition.tasks.length}`));
  for (const [index, task] of draft.definition.tasks.entries()) {
    rows.push(
      `${theme.fg("accent", String(index + 1).padStart(2, " "))}  ${theme.bold(task.label)} ${theme.fg("dim", `· ${task.id}`)}`,
    );
    const dependencies = task.needs?.length
      ? `after ${task.needs.join(", ")} · `
      : "";
    addWrapped(
      rows,
      `    ${dependencies}${taskScope(draft, index)}`,
      width,
      "muted",
      theme,
    );
    const runtime = [task.harness, task.model, task.effort]
      .filter((value) => value !== undefined)
      .join(" · ");
    if (runtime) addWrapped(rows, `    ${runtime}`, width, "dim", theme);
  }
  rows.push("");
  rows.push(theme.fg("dim", "REVIEW"));
  rows.push(`${theme.fg("success", "●")} immutable inputs`);
  rows.push(`${theme.fg("success", "●")} no agents started`);
  rows.push(
    `${theme.fg("success", "●")} ${draft.background ? "background execution" : "foreground execution"}`,
  );
  rows.push("");
  rows.push(theme.fg("dim", "DRAFT"));
  rows.push(theme.fg("text", draft.draftId));
  rows.push(theme.fg("dim", draft.executionSha256.slice(0, 16)));
  rows.push("");
  rows.push(theme.fg("dim", "ARTIFACT"));
  addWrapped(rows, shortenHome(artifactPath), width, "muted", theme);
  return rows;
}

interface ExactDefinition {
  readonly language: "javascript" | "json";
  readonly label: string;
  readonly text: string;
}

function exactDefinition(draft: WorkflowDraft): ExactDefinition {
  if (draft.source !== undefined) {
    return {
      language: "javascript",
      label: "Exact source",
      text: draft.source,
    };
  }
  return {
    language: "json",
    label: "Exact spec",
    text: JSON.stringify(draft.definition, null, 2),
  };
}

function definitionRows(draft: WorkflowDraft, theme: Theme): string[] {
  const definition = exactDefinition(draft);
  const highlighted = highlightCode(definition.text, definition.language);
  const numberWidth = String(Math.max(1, highlighted.length)).length;
  return highlighted.map(
    (line, index) =>
      `${theme.fg("dim", String(index + 1).padStart(numberWidth, " "))} ${theme.fg("borderMuted", "│")} ${line}`,
  );
}

/** Full-screen review of one authoritative pending draft. */
export class WorkflowDraftReview {
  private focus: Focus = "review";
  private reviewScroll = 0;
  private definitionScroll = 0;
  private reviewRowCount = 0;
  private definitionRowCount = 0;
  private viewportSize = 1;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly draft: WorkflowDraft;
  private readonly artifactPath: string;
  private readonly done: (action: ReviewAction) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    draft: WorkflowDraft,
    artifactPath: string,
    done: (action: ReviewAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.draft = draft;
    this.artifactPath = artifactPath;
    this.done = done;
  }

  handleInput(data: string): void {
    const cancel = this.keybindings.matches(data, "tui.select.cancel");
    const left =
      data === "h" || this.keybindings.matches(data, "tui.editor.cursorLeft");
    const right =
      data === "l" || this.keybindings.matches(data, "tui.editor.cursorRight");
    const up = data === "k" || this.keybindings.matches(data, "tui.select.up");
    const down =
      data === "j" || this.keybindings.matches(data, "tui.select.down");
    const pageUp =
      matchesKey(data, Key.ctrl("u")) ||
      this.keybindings.matches(data, "tui.select.pageUp");
    const pageDown =
      matchesKey(data, Key.ctrl("d")) ||
      this.keybindings.matches(data, "tui.select.pageDown");

    if (cancel) return this.done("close");
    if (data === "a") return this.done("approve");
    if (left) this.focus = "review";
    else if (right) this.focus = "definition";
    else if (data === "g") this.setScroll(0);
    else if (data === "G") this.setScroll(this.maxScroll());
    else if (up) this.setScroll(this.scroll() - 1);
    else if (down) this.setScroll(this.scroll() + 1);
    else if (pageUp) this.setScroll(this.scroll() - this.viewportSize + 2);
    else if (pageDown) this.setScroll(this.scroll() + this.viewportSize - 2);
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(MIN_PANEL_HEIGHT + 3, this.tui.terminal.rows - 1);
    const name = this.draft.definition.name ?? this.draft.draftId;
    const header = truncateToWidth(
      ` ${this.theme.fg("success", "●")} ${this.theme.bold("Draft review")} ${this.theme.fg("accent", name)} ${this.theme.fg("dim", "· immutable · not started")}`,
      width,
      "",
    );
    const footer = truncateToWidth(
      ` ${this.theme.fg("dim", "h/l focus · j/k scroll · ctrl-u/d page ·")} ${this.theme.fg("accent", "a")} approve · ${this.theme.fg("accent", "esc")} close`,
      width,
      "",
    );
    const panelHeight = Math.max(MIN_PANEL_HEIGHT, height - 2);
    this.viewportSize = Math.max(1, panelHeight - 2);
    const definition = exactDefinition(this.draft);
    const sourceRows = definitionRows(this.draft, this.theme);
    this.definitionRowCount = sourceRows.length;

    if (width < MIN_SPLIT_WIDTH) {
      const rows =
        this.focus === "review"
          ? reviewRows(this.draft, this.artifactPath, width - 4, this.theme)
          : sourceRows;
      if (this.focus === "review") this.reviewRowCount = rows.length;
      const offset = this.scroll();
      const label = this.focus === "review" ? "Review" : definition.label;
      return [
        header,
        ...panel(
          `${label} ${offset + 1}-${Math.min(rows.length, offset + this.viewportSize)}/${rows.length}`,
          rows.slice(offset, offset + this.viewportSize),
          width,
          panelHeight,
          true,
          this.theme,
        ),
        footer,
      ];
    }

    const summaryWidth = Math.max(38, Math.floor((width - 1) * 0.4));
    const definitionWidth = width - summaryWidth - 1;
    const summary = reviewRows(
      this.draft,
      this.artifactPath,
      summaryWidth - 4,
      this.theme,
    );
    this.reviewRowCount = summary.length;
    this.reviewScroll = Math.min(
      this.reviewScroll,
      Math.max(0, summary.length - this.viewportSize),
    );
    this.definitionScroll = Math.min(
      this.definitionScroll,
      Math.max(0, sourceRows.length - this.viewportSize),
    );
    const left = panel(
      "Review",
      summary.slice(this.reviewScroll, this.reviewScroll + this.viewportSize),
      summaryWidth,
      panelHeight,
      this.focus === "review",
      this.theme,
    );
    const right = panel(
      definition.label,
      sourceRows.slice(
        this.definitionScroll,
        this.definitionScroll + this.viewportSize,
      ),
      definitionWidth,
      panelHeight,
      this.focus === "definition",
      this.theme,
    );
    return [
      header,
      ...left.map((line, index) => `${line} ${right[index] ?? ""}`),
      footer,
    ].map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

  private scroll(): number {
    return this.focus === "review" ? this.reviewScroll : this.definitionScroll;
  }

  private setScroll(value: number): void {
    const next = Math.max(0, Math.min(this.maxScroll(), value));
    if (this.focus === "review") this.reviewScroll = next;
    else this.definitionScroll = next;
  }

  private maxScroll(): number {
    const rows =
      this.focus === "review" ? this.reviewRowCount : this.definitionRowCount;
    return Math.max(0, rows - this.viewportSize);
  }
}

export function workflowDraftReviewText(
  draft: WorkflowDraft,
  artifactPath: string,
): string {
  const definition = exactDefinition(draft);
  const tasks = draft.definition.tasks.flatMap((task, index) => {
    const dependencies = task.needs?.length
      ? ` after ${task.needs.join(", ")}`
      : "";
    const scope = task.readOnly
      ? "read only"
      : `owns ${(task.owns ?? []).join(", ")}`;
    return [
      `${index + 1}. ${task.label} (${task.id})`,
      `   ${scope}${dependencies}`,
    ];
  });
  return [
    `Workflow draft ${draft.definition.name ?? draft.draftId}`,
    `${draft.draftId} · ${draft.executionSha256.slice(0, 16)} · immutable · not started`,
    `Artifact: ${shortenHome(artifactPath)}`,
    "",
    "Outcome",
    draft.preview,
    "",
    `Tasks (${draft.definition.tasks.length})`,
    ...tasks,
    "",
    definition.label,
    definition.text,
  ].join("\n");
}

export async function showWorkflowDraftReview(
  ctx: ExtensionCommandContext,
  draft: WorkflowDraft,
  artifactPath: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    const review = workflowDraftReviewText(draft, artifactPath);
    if (!ctx.hasUI) return ctx.ui.notify(review, "info");
    await ctx.ui.editor(
      `Workflow draft · ${draft.definition.name ?? draft.draftId}`,
      review,
    );
    return;
  }
  const action = await ctx.ui.custom<ReviewAction>(
    (tui, theme, keybindings, done) =>
      new WorkflowDraftReview(
        tui,
        theme,
        keybindings,
        draft,
        artifactPath,
        done,
      ),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
  if (action !== "approve") return;
  ctx.ui.setEditorText(`Approve workflow draft ${draft.draftId}.`);
  ctx.ui.notify(
    "Approval loaded in the editor. Submit it to start the immutable draft.",
    "info",
  );
}
