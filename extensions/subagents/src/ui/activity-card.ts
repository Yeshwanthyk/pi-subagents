import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { LiveToolState, SubagentSnapshot } from "../domain.ts";
import { formatContextUtilization } from "../format.ts";

const ARGUMENT_MAX_LENGTH = 140;

function singleLine(text: string) {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bounded(text: string, maxLength = ARGUMENT_MAX_LENGTH) {
  const value = singleLine(text);
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

export function formatActivityDuration(startedAt: number, now = Date.now()) {
  const totalSeconds = Math.max(0, Math.round((now - startedAt) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

export function formatActivityAge(timestamp: number, now = Date.now()) {
  return `${formatActivityDuration(timestamp, now)} ago`;
}

function toolLine(tool: LiveToolState, theme: Theme, now: number) {
  const operation = bounded(
    `${tool.name}${tool.argsPreview ? ` ${tool.argsPreview}` : ""}`,
  );
  const marker = tool.isError
    ? theme.fg("error", "✕")
    : tool.done
      ? theme.fg("success", "✓")
      : theme.fg("warning", "■");
  return `  ${marker} ${theme.fg("toolTitle", operation)} ${theme.fg(
    "dim",
    formatActivityDuration(tool.startedAt, now),
  )}`;
}

function statusPresentation(
  snapshot: SubagentSnapshot,
  theme: Theme,
  now: number,
) {
  if (snapshot.status === "done") {
    return {
      square: theme.fg("success", "■"),
      word: theme.fg("success", "DONE"),
    };
  }
  if (snapshot.status === "error") {
    return {
      square: theme.fg("error", "■"),
      word: theme.fg("error", "FAILED"),
    };
  }
  const quiet = now - snapshot.lastActivityAt >= 30_000;
  return {
    square: theme.fg("warning", "■"),
    word: theme.fg(quiet ? "muted" : "warning", quiet ? "QUIET" : "RUNNING"),
  };
}

export function renderSubagentActivity(
  snapshot: SubagentSnapshot,
  theme: Theme,
  options: { expanded?: boolean; now?: number } = {},
) {
  const now = options.now ?? Date.now();
  const status = statusPresentation(snapshot, theme, now);
  const end = snapshot.settledAt ?? now;
  let text =
    `${status.square} ${theme.fg("accent", theme.bold(snapshot.id))}` +
    theme.fg("muted", ` · ${bounded(snapshot.title, 100)} `) +
    `${status.word}${theme.fg("dim", ` · ${formatActivityDuration(snapshot.createdAt, end)}`)}`;

  if (snapshot.liveTools.length > 0) {
    for (const tool of snapshot.liveTools.slice(0, options.expanded ? 4 : 1)) {
      text += `\n${toolLine(tool, theme, now)}`;
    }
    if (snapshot.liveTools.length > (options.expanded ? 4 : 1)) {
      text += `\n  ${theme.fg("dim", `+${snapshot.liveTools.length - (options.expanded ? 4 : 1)} more tools`)}`;
    }
  } else if (snapshot.status === "running") {
    const label = snapshot.liveAssistant ? "model responding" : "model working";
    text += `\n  ${theme.fg("muted", label)}${theme.fg(
      "dim",
      ` · activity ${formatActivityAge(snapshot.lastActivityAt, now)}`,
    )}`;
  }

  const operationCount = `${snapshot.completedOperations} operation${snapshot.completedOperations === 1 ? "" : "s"} complete`;
  text += `\n  ${theme.fg("dim", operationCount)}`;

  if (snapshot.errorText) {
    text += `\n  ${theme.fg("error", bounded(snapshot.errorText, 220))}`;
  }

  if (options.expanded) {
    const context = formatContextUtilization(snapshot.usage);
    text += `\n  ${theme.fg(
      "dim",
      [
        snapshot.backend,
        snapshot.meta.modelLabel,
        context,
        snapshot.meta.reasoningEffort
          ? `think:${snapshot.meta.reasoningEffort}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    )}`;
    text += `\n  ${theme.fg("dim", snapshot.cwd)}`;
    if (snapshot.lastCompletedOperation) {
      const operation = snapshot.lastCompletedOperation;
      text += `\n  ${theme.fg(
        operation.isError ? "error" : "muted",
        `last: ${operation.name}${operation.isError ? " failed" : " completed"} ${formatActivityAge(operation.finishedAt, now)}`,
      )}`;
    }
    text += `\n  ${theme.fg("muted", "/subagents for transcript and takeover")}`;
  } else {
    text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "for details")})`)}`;
  }
  return text;
}

export function renderSubagentWaitSummary(
  snapshots: ReadonlyArray<SubagentSnapshot>,
  now = Date.now(),
) {
  const pending = snapshots.filter((snapshot) => snapshot.status === "running");
  const complete = snapshots.length - pending.length;
  const lines = [
    `Waiting for ${pending.length} subagent${pending.length === 1 ? "" : "s"}${complete ? ` · ${complete} complete` : ""}`,
  ];
  for (const snapshot of pending.slice(0, 6)) {
    const current = snapshot.liveTools[0];
    const operation = current
      ? bounded(
          `${current.name}${current.argsPreview ? ` ${current.argsPreview}` : ""}`,
          120,
        )
      : now - snapshot.lastActivityAt >= 30_000
        ? "quiet · no recent events"
        : "model working";
    lines.push(
      `${snapshot.id} · ${operation} · activity ${formatActivityAge(snapshot.lastActivityAt, now)}`,
    );
  }
  if (pending.length > 6) lines.push(`+${pending.length - 6} more`);
  return lines.join("\n");
}
