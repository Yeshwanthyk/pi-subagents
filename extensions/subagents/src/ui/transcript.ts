/**
 * Transcript rendering for the takeover view: turns a SubagentSnapshot's
 * normalized transcript + live state into plain wrapped lines. Ported from
 * v1, with the session-poking replaced by snapshot reads.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SubagentSnapshot, TranscriptItem } from "../domain.ts";

const ANSI_PATTERN = new RegExp(
  String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);

/**
 * Strip raw ANSI codes, expand tabs, and drop control chars. Terminal-expanded
 * tabs (and stray escapes) make lines wider than the width we declare to the
 * TUI, which desyncs the renderer and smears the overlay.
 */
export function sanitizeText(text: string): string {
  return Array.from(text.replace(ANSI_PATTERN, "").replaceAll("\t", "  "))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(code <= 0x08 || (code >= 0x0b && code <= 0x1f) || code === 0x7f);
    })
    .join("");
}

function renderUserText(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
) {
  const clean = sanitizeText(text).trim();
  if (!clean) return;
  const wrapped = wrapTextWithAnsi(clean, Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    const prefix = i === 0 ? theme.fg("accent", "> ") : "  ";
    out.push(
      truncateToWidth(prefix + theme.fg("userMessageText", wrapped[i]), width),
    );
  }
}

function renderThinking(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
) {
  const reasoning = sanitizeText(text).trim();
  if (!reasoning) return;
  const prefix = theme.fg("dim", "~ ");
  const wrapped = wrapTextWithAnsi(reasoning, Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    out.push(
      truncateToWidth(
        (i === 0 ? prefix : "  ") +
          theme.fg("thinkingText", theme.italic(wrapped[i])),
        width,
      ),
    );
  }
}

function renderAssistantText(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
) {
  let inCodeBlock = false;
  for (const rawLine of sanitizeText(text).split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      out.push(truncateToWidth(theme.fg("dim", `  ${trimmed}`), width));
      continue;
    }

    if (inCodeBlock) {
      const wrapped = wrapTextWithAnsi(line, Math.max(10, width - 4));
      for (const part of wrapped) {
        out.push(
          truncateToWidth(
            theme.fg("borderMuted", "  | ") + theme.fg("toolOutput", part),
            width,
          ),
        );
      }
      continue;
    }

    const heading = trimmed.match(/^(?:#{1,6}\s+|\*\*(.+)\*\*\s*$)/);
    if (heading) {
      const content = heading[1] ?? trimmed.replace(/^#{1,6}\s+/, "");
      out.push(
        truncateToWidth(theme.fg("accent", theme.bold(`  ${content}`)), width),
      );
      continue;
    }

    const bullet = line.match(/^(\s*)([-*+] |\d+\. )(.*)$/);
    const prefix = bullet ? `${bullet[1]}${theme.fg("accent", bullet[2])}` : "";
    const body = bullet ? bullet[3] : line;
    const wrapped = wrapTextWithAnsi(
      body,
      Math.max(10, width - visibleWidth(prefix)),
    );
    for (let index = 0; index < wrapped.length; index++) {
      out.push(
        truncateToWidth(
          (index === 0 ? prefix : " ".repeat(visibleWidth(prefix))) +
            theme.fg("text", wrapped[index]),
          width,
        ),
      );
    }
  }
}

function renderAssistantItem(
  theme: Theme,
  item: Extract<TranscriptItem, { kind: "assistant" }>,
  width: number,
  out: string[],
) {
  for (const part of item.parts) {
    if (part.type === "text") {
      if (!sanitizeText(part.text).trim()) continue;
      renderAssistantText(theme, part.text, width, out);
    } else if (part.type === "thinking") {
      renderThinking(
        theme,
        part.redacted ? "[redacted reasoning]" : part.text,
        width,
        out,
      );
    } else if (part.type === "toolCall") {
      const preview = part.argsPreview ? sanitizeText(part.argsPreview) : "";
      const line =
        theme.fg("warning", "→ ") +
        theme.fg("toolTitle", theme.bold(part.name)) +
        (preview && preview !== "{}" ? theme.fg("dim", ` ${preview}`) : "");
      out.push(truncateToWidth(line, width));
    }
  }
}

function renderToolResultItem(
  theme: Theme,
  item: Extract<TranscriptItem, { kind: "toolResult" }>,
  width: number,
  out: string[],
) {
  const output = sanitizeText(item.outputPreview ?? "").trim() || "(no output)";
  const label = item.isError
    ? theme.fg("error", "  x error: ")
    : theme.fg("success", "  ✓ output: ");
  const wrapped = wrapTextWithAnsi(
    output,
    Math.max(10, width - visibleWidth(label)),
  );
  for (let index = 0; index < wrapped.length; index++) {
    out.push(
      truncateToWidth(
        (index === 0 ? label : " ".repeat(visibleWidth(label))) +
          theme.fg(item.isError ? "error" : "toolOutput", wrapped[index]),
        width,
      ),
    );
  }
}

/** Render a subagent's conversation as plain lines, wrapped to `width`. */
export function buildTranscriptLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
): string[] {
  const out: string[] = [];

  for (const item of snap.transcript) {
    const before = out.length;
    if (item.kind === "user") {
      renderUserText(theme, item.text, width, out);
    } else if (item.kind === "assistant") {
      renderAssistantItem(theme, item, width, out);
    } else {
      renderToolResultItem(theme, item, width, out);
    }
    if (out.length > before) out.push("");
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  // Live streaming assistant buffers (cleared when the finalized message lands).
  if (snap.liveAssistant) {
    const { thinking, text } = snap.liveAssistant;
    const before = out.length;
    if (out.length > 0) out.push("");
    if (thinking.trim()) renderThinking(theme, thinking, width, out);
    if (text.trim())
      out.push(...wrapTextWithAnsi(sanitizeText(text).trim(), width));
    if (out.length === before + 1) out.pop();
  }

  // Live tool executions (present until the ToolEnd lands in the transcript).
  for (const tool of snap.liveTools) {
    if (out.length > 0) out.push("");
    const marker = tool.done
      ? tool.isError
        ? theme.fg("error", "x error")
        : theme.fg("success", "✓ done")
      : theme.fg("warning", "■ running");
    let line = `${theme.fg("warning", "→ ")}${theme.fg(
      "toolTitle",
      theme.bold(tool.name),
    )} · ${marker}`;
    const preview = tool.outputPreview && sanitizeText(tool.outputPreview);
    if (preview) line += theme.fg("dim", ` · ${preview}`);
    const wrapped = wrapTextWithAnsi(line, width);
    out.push(...wrapped.map((part) => truncateToWidth(part, width)));
  }

  // Queued steering/follow-up messages: show them immediately so Enter
  // visibly acknowledges the user's input instead of appearing to do nothing.
  for (const message of snap.queued) {
    if (out.length > 0) out.push("");
    // Queued = pending, not in-flight; keep it out of the "hot" warning color.
    const prefix = theme.fg("muted", `> [queued ${message.kind}] `);
    const wrapped = wrapTextWithAnsi(
      sanitizeText(message.text),
      Math.max(10, width - visibleWidth(prefix)),
    );
    for (let i = 0; i < wrapped.length; i++) {
      out.push(
        truncateToWidth(
          (i === 0 ? prefix : " ".repeat(visibleWidth(prefix))) +
            theme.fg("muted", wrapped[i]),
          width,
        ),
      );
    }
  }

  return out;
}
