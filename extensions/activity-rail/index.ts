import type {
  ExtensionAPI,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  ACTIVE_WORK_CHANNELS,
  type ActiveWorkItem,
  type ActiveWorkRemoval,
} from "../subagents/src/activity-protocol.ts";

const MAX_VISIBLE = 4;
const MAX_FLASH = 2;
const FLASH_TTL_MS = 20_000;
const SPINNER_MS = 150;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COALESCE_MS = 100;

interface SettleFlash {
  status: "done" | "error";
  title: string;
  ops?: number;
  settledAt: number;
}

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

function bounded(text: string, maxLength: number) {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function compactAge(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  return seconds < 2 ? "active now" : `active ${age(timestamp, now)} ago`;
}

function spinnerAt(now: number) {
  return SPINNER_FRAMES[Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length];
}

function statusChip(
  status: "running" | "quiet" | "done" | "error",
  theme: Theme,
) {
  switch (status) {
    case "done":
      return theme.fg("success", "[DONE]");
    case "error":
      return theme.fg("error", "[FAILED]");
    case "quiet":
      return theme.fg("muted", "[QUIET]");
    default:
      return theme.fg("warning", "[RUNNING]");
  }
}

/** Render one item as compact metadata plus a fully wrapped operation. */
function cardLines(
  item: ActiveWorkItem,
  theme: Theme,
  now: number,
  width: number,
) {
  const quiet = item.status === "quiet" || now - item.lastActivityAt >= 30_000;
  const glyph = quiet
    ? theme.fg("muted", "■")
    : theme.fg("warning", spinnerAt(now));
  const title = theme.fg("accent", bounded(item.label, 32));
  const meta = [
    compactAge(item.lastActivityAt, now),
    item.completedOperations && item.completedOperations > 0
      ? `${item.completedOperations} ops`
      : undefined,
    typeof item.contextPercent === "number"
      ? `ctx ${item.contextPercent}%`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  // Live spinner already signals activity; the chip is reserved for quiet rows.
  const line1 = quiet
    ? `${glyph} ${title} ${statusChip("quiet", theme)}` +
      (meta ? theme.fg("dim", ` · ${meta}`) : "")
    : `${glyph} ${title}` + (meta ? theme.fg("dim", ` · ${meta}`) : "");

  const operation =
    item.currentOperation ??
    (quiet ? "quiet · no recent events" : "model working");
  const operationLines = wrapTextWithAnsi(operation, Math.max(10, width - 5));
  return [
    truncateToWidth(line1, width, "…"),
    ...operationLines.map((line, index) =>
      truncateToWidth(
        `${index === 0 ? "  → " : "     "}${theme.fg(
          quiet ? "muted" : "toolTitle",
          line,
        )}`,
        width,
      ),
    ),
  ];
}

function flashLine(
  flash: SettleFlash,
  theme: Theme,
  now: number,
  width: number,
) {
  const ok = flash.status === "done";
  const glyph = theme.fg(ok ? "success" : "error", ok ? "✓" : "✕");
  const meta = [
    typeof flash.ops === "number" ? `${flash.ops} ops` : undefined,
    age(flash.settledAt, now),
  ]
    .filter(Boolean)
    .join(" · ");
  const line =
    `${glyph} ${theme.fg("muted", bounded(flash.title, 28))} ` +
    `${statusChip(flash.status, theme)}` +
    (meta ? theme.fg("dim", ` · ${meta}`) : "");
  return truncateToWidth(line, width, "…");
}

export function renderActiveWorkRail(
  items: ReadonlyArray<ActiveWorkItem>,
  theme: Theme,
  now = Date.now(),
  flashes: ReadonlyArray<SettleFlash> = [],
  maxWidth = 100,
) {
  const lines = [theme.fg("muted", theme.bold("ACTIVE WORK"))];
  const visible = items.slice(0, MAX_VISIBLE);
  for (const item of visible)
    lines.push(...cardLines(item, theme, now, maxWidth));
  for (const flash of flashes.slice(0, MAX_FLASH))
    lines.push(flashLine(flash, theme, now, maxWidth));
  const overflow =
    Math.max(0, items.length - MAX_VISIBLE) +
    Math.max(0, flashes.length - MAX_FLASH);
  lines.push(
    overflow > 0
      ? theme.fg("dim", `+${overflow} more active items · ctrl+shift+a`)
      : theme.fg("dim", "ctrl+shift+a · subagents"),
  );
  return lines;
}

export default function activityRail(pi: ExtensionAPI) {
  const items = new Map<ActiveWorkItem["key"], ActiveWorkItem>();
  const flashes = new Map<ActiveWorkItem["key"], SettleFlash>();
  let ui: ExtensionUIContext | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let spinnerTicker: ReturnType<typeof setInterval> | undefined;

  const render = (now = Date.now()) => {
    if (!ui) return;
    if (items.size === 0 && flashes.size === 0) {
      ui.setWidget("active-work", undefined);
      return;
    }
    ui.setWidget(
      "active-work",
      renderActiveWorkRail([...items.values()], ui.theme, now, [
        ...flashes.values(),
      ]),
      { placement: "belowEditor" },
    );
  };

  const reconcileTicker = (now = Date.now()) => {
    const animating = [...items.values()].some(
      (item) => item.status === "running" && now - item.lastActivityAt < 30_000,
    );
    if (animating && !spinnerTicker) {
      spinnerTicker = setInterval(() => render(), SPINNER_MS);
      spinnerTicker.unref?.();
    } else if (!animating && spinnerTicker) {
      clearInterval(spinnerTicker);
      spinnerTicker = undefined;
    }
  };

  const flush = (now = Date.now()) => {
    flushTimer = undefined;
    // Drop flashes older than the TTL so settled rows fade out on their own.
    for (const [key, flash] of flashes) {
      if (now - flash.settledAt >= FLASH_TTL_MS) flashes.delete(key);
    }
    reconcileTicker(now);
    render(now);
  };

  const schedule = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => flush(), COALESCE_MS);
    flushTimer.unref?.();
  };

  const unsubscribeUpdate = pi.events.on(
    ACTIVE_WORK_CHANNELS.update,
    (value: unknown) => {
      if (!ui || !validItem(value)) return;
      items.set(value.key, value);
      schedule();
    },
  );
  const unsubscribeRemove = pi.events.on(
    ACTIVE_WORK_CHANNELS.remove,
    (value: unknown) => {
      if (!ui || !validRemoval(value)) return;
      if (value.status === "done" || value.status === "error") {
        flashes.set(value.key, {
          status: value.status,
          title: value.title ?? value.key,
          ops: value.ops,
          settledAt: value.settledAt ?? Date.now(),
        });
      } else {
        flashes.delete(value.key);
      }
      items.delete(value.key);
      schedule();
    },
  );

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ui?.setWidget("active-work", undefined);
      ui = undefined;
      items.clear();
      flashes.clear();
      return;
    }
    ui = ctx.ui;
    items.clear();
    flashes.clear();
    flush();
  });

  pi.on("session_shutdown", () => {
    unsubscribeUpdate();
    unsubscribeRemove();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (spinnerTicker) clearInterval(spinnerTicker);
    spinnerTicker = undefined;
    items.clear();
    flashes.clear();
    ui?.setWidget("active-work", undefined);
    ui = undefined;
  });
}
