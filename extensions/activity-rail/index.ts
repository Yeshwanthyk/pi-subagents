import type {
  ExtensionAPI,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  ACTIVE_WORK_CHANNELS,
  type ActiveWorkItem,
  type ActiveWorkRemoval,
} from "../subagents/src/activity-protocol.ts";

const MAX_VISIBLE = 3;
const MAX_FLASH = 1;
const FLASH_TTL_MS = 20_000;
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

/** Render one active item on a single bounded line. */
function itemLine(
  item: ActiveWorkItem,
  theme: Theme,
  now: number,
  width: number,
) {
  const quiet = item.status === "quiet" || now - item.lastActivityAt >= 30_000;
  const glyph = quiet ? theme.fg("muted", "■") : theme.fg("warning", "●");
  const title = theme.fg("accent", bounded(item.label, 30));
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
  const operation =
    item.currentOperation ??
    (quiet ? "quiet · no recent events" : "model working");
  const chip = quiet ? ` ${statusChip("quiet", theme)}` : "";
  return truncateToWidth(
    `${glyph} ${title}${chip}${theme.fg("dim", " — ")}${theme.fg(
      quiet ? "muted" : "toolTitle",
      operation,
    )}${meta ? theme.fg("dim", ` · ${meta}`) : ""}`,
    width,
    "…",
  );
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
  const count = items.length;
  const lines = [
    `${theme.fg("warning", "●")} ${theme.fg(
      "muted",
      theme.bold(`${count} active ${count === 1 ? "item" : "items"}`),
    )}${theme.fg("dim", " · ctrl+shift+a")}`,
  ];
  const visible = items.slice(0, MAX_VISIBLE);
  for (const item of visible) lines.push(itemLine(item, theme, now, maxWidth));
  for (const flash of flashes.slice(0, MAX_FLASH))
    lines.push(flashLine(flash, theme, now, maxWidth));
  const overflow =
    Math.max(0, items.length - MAX_VISIBLE) +
    Math.max(0, flashes.length - MAX_FLASH);
  if (overflow > 0) lines.push(theme.fg("dim", `+${overflow} more`));
  return lines;
}

export default function activityRail(pi: ExtensionAPI) {
  const items = new Map<ActiveWorkItem["key"], ActiveWorkItem>();
  const flashes = new Map<ActiveWorkItem["key"], SettleFlash>();
  let ui: ExtensionUIContext | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flashExpiryTimer: ReturnType<typeof setTimeout> | undefined;

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

  const flush = (now = Date.now()) => {
    flushTimer = undefined;
    // Drop flashes older than the TTL so settled rows fade out on their own.
    for (const [key, flash] of flashes) {
      if (now - flash.settledAt >= FLASH_TTL_MS) flashes.delete(key);
    }
    render(now);
    if (flashExpiryTimer) clearTimeout(flashExpiryTimer);
    flashExpiryTimer = undefined;
    const nextExpiry = Math.min(
      ...[...flashes.values()].map(
        (flash) => flash.settledAt + FLASH_TTL_MS - now,
      ),
    );
    if (Number.isFinite(nextExpiry)) {
      flashExpiryTimer = setTimeout(
        () => {
          flashExpiryTimer = undefined;
          flush();
        },
        Math.max(1, nextExpiry),
      );
      flashExpiryTimer.unref?.();
    }
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
    if (flashExpiryTimer) clearTimeout(flashExpiryTimer);
    flashExpiryTimer = undefined;
    items.clear();
    flashes.clear();
    ui?.setWidget("active-work", undefined);
    ui = undefined;
  });
}
