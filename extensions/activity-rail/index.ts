import type {
  ExtensionAPI,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  ACTIVE_WORK_CHANNELS,
  type ActiveWorkItem,
  type ActiveWorkRemoval,
} from "../subagents/src/activity-protocol.ts";

const MAX_VISIBLE = 4;
const COALESCE_MS = 100;

function validItem(value: unknown): value is ActiveWorkItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ActiveWorkItem>;
  return (
    item.version === 1 &&
    (item.kind === "subagent" || item.kind === "workflow") &&
    typeof item.key === "string" &&
    item.key.startsWith(`${item.kind}:`) &&
    typeof item.label === "string" &&
    (item.status === "running" || item.status === "quiet") &&
    typeof item.summary === "string" &&
    typeof item.runningProcesses === "number" &&
    Number.isFinite(item.runningProcesses) &&
    typeof item.startedAt === "number" &&
    Number.isFinite(item.startedAt) &&
    typeof item.lastActivityAt === "number" &&
    Number.isFinite(item.lastActivityAt)
  );
}

function validRemoval(value: unknown): value is ActiveWorkRemoval {
  if (!value || typeof value !== "object") return false;
  const removal = value as Partial<ActiveWorkRemoval>;
  return (
    removal.version === 1 &&
    typeof removal.key === "string" &&
    (removal.key.startsWith("subagent:") || removal.key.startsWith("workflow:"))
  );
}

function age(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

export function renderActiveWorkRail(
  items: ReadonlyArray<ActiveWorkItem>,
  theme: Theme,
  now = Date.now(),
) {
  const sorted = [...items].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt || a.startedAt - b.startedAt,
  );
  const visible = sorted.slice(0, MAX_VISIBLE);
  const lines = [theme.fg("muted", theme.bold("ACTIVE WORK"))];
  for (const item of visible) {
    const quiet =
      item.status === "quiet" || now - item.lastActivityAt >= 30_000;
    const square = theme.fg(quiet ? "muted" : "warning", "■");
    const kind = item.kind === "workflow" ? "workflow" : "agent";
    lines.push(
      `${square} ${theme.fg("accent", item.label)} ${theme.fg("dim", `· ${kind} · ${age(item.lastActivityAt, now)} ago`)}`,
    );
    const summary =
      quiet && item.summary === "model working"
        ? "quiet · no recent events"
        : item.summary;
    lines.push(`  ${theme.fg(quiet ? "muted" : "toolTitle", summary)}`);
  }
  if (sorted.length > MAX_VISIBLE) {
    lines.push(
      theme.fg("dim", `+${sorted.length - MAX_VISIBLE} more active items`),
    );
  }
  return lines;
}

export default function activityRail(pi: ExtensionAPI) {
  const items = new Map<ActiveWorkItem["key"], ActiveWorkItem>();
  let ui: ExtensionUIContext | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;

  const flush = () => {
    flushTimer = undefined;
    if (!ui) return;
    if (items.size === 0) {
      ui.setWidget("active-work", undefined);
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = undefined;
      return;
    }
    ui.setWidget(
      "active-work",
      renderActiveWorkRail([...items.values()], ui.theme),
      { placement: "belowEditor" },
    );
    if (!tickTimer) {
      tickTimer = setInterval(flush, 1_000);
      tickTimer.unref?.();
    }
  };

  const schedule = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, COALESCE_MS);
    flushTimer.unref?.();
  };

  const unsubscribeUpdate = pi.events.on(
    ACTIVE_WORK_CHANNELS.update,
    (value: unknown) => {
      if (!validItem(value)) return;
      items.set(value.key, value);
      schedule();
    },
  );
  const unsubscribeRemove = pi.events.on(
    ACTIVE_WORK_CHANNELS.remove,
    (value: unknown) => {
      if (!validRemoval(value)) return;
      items.delete(value.key);
      schedule();
    },
  );

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ui = ctx.ui;
    flush();
  });

  pi.on("session_shutdown", () => {
    unsubscribeUpdate();
    unsubscribeRemove();
    if (flushTimer) clearTimeout(flushTimer);
    if (tickTimer) clearInterval(tickTimer);
    flushTimer = undefined;
    tickTimer = undefined;
    items.clear();
    ui?.setWidget("active-work", undefined);
    ui = undefined;
  });
}
