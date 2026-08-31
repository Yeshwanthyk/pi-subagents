import type {
  ExtensionAPI,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  ACTIVE_WORK_CHANNELS,
  type ActiveWorkItem,
  type ActivityProtocolBoundary,
  parseActiveWorkItem,
  parseActiveWorkRemoval,
} from "../subagents/src/activity-protocol.ts";

const FLASH_TTL_MS = 20_000;
const COALESCE_MS = 100;
type EventPayload = Parameters<Parameters<ExtensionAPI["events"]["on"]>[1]>[0];

interface SettleFlash {
  status: "done" | "error";
  title: string;
  ops?: number;
  settledAt: number;
}

function compactStatus(
  status: "running" | "quiet" | "done" | "error",
  theme: Theme,
) {
  switch (status) {
    case "done":
      return theme.fg("success", "[DONE]");
    case "error":
      return theme.fg("error", "[FAIL]");
    case "quiet":
      return theme.fg("muted", "[QUIET]");
    default:
      return theme.fg("warning", "[RUN]");
  }
}

function compactRailLine(
  items: ReadonlyArray<ActiveWorkItem>,
  flashes: ReadonlyArray<SettleFlash>,
  theme: Theme,
  now: number,
  width: number,
) {
  const firstItem = items[0];
  const firstFlash = flashes[0];
  if (!firstItem && !firstFlash) {
    const empty = width < 40 ? "0a · ^⇧A" : "0 active · ctrl+shift+a";
    return truncateToWidth(theme.fg("dim", empty), width, "…");
  }
  const quiet =
    firstItem !== undefined &&
    (firstItem.status === "quiet" || now - firstItem.lastActivityAt >= 30_000);
  const label = firstItem?.label ?? firstFlash?.title ?? "activity";
  const status = firstItem
    ? compactStatus(quiet ? "quiet" : "running", theme)
    : compactStatus(firstFlash?.status ?? "done", theme);
  const overflow = Math.max(
    0,
    items.length +
      flashes.length -
      (firstItem !== undefined || firstFlash !== undefined ? 1 : 0),
  );
  const extraNarrow = width < 40;
  // Below 40 columns, conventional key/state symbols preserve every useful
  // field instead of allowing truncation to hide the shortcut or identity.
  const workflow = firstItem?.kind === "workflow";
  const shortcut = extraNarrow
    ? workflow
      ? "^⇧Z"
      : "^⇧A"
    : workflow
      ? "ctrl+shift+z"
      : "ctrl+shift+a";
  const prefix = theme.fg(
    items.length > 0 ? "warning" : "muted",
    extraNarrow ? `${items.length}a · ` : `${items.length} active · `,
  );
  const shortState = theme.fg(
    firstItem
      ? quiet
        ? "muted"
        : "warning"
      : firstFlash?.status === "error"
        ? "error"
        : "success",
    firstItem
      ? quiet
        ? "Q"
        : "R"
      : firstFlash?.status === "error"
        ? "!"
        : "D",
  );
  const suffix = extraNarrow
    ? `${theme.fg("dim", " · ")}${shortState}${
        overflow > 0 ? theme.fg("dim", ` · +${overflow}`) : ""
      }${theme.fg("dim", ` · ${shortcut}`)}`
    : `${theme.fg("dim", " · ")}${status}${
        overflow > 0 ? theme.fg("dim", ` · +${overflow}`) : ""
      }${theme.fg("dim", ` · ${shortcut}`)}`;
  const labelWidth = Math.max(
    1,
    width - visibleWidth(prefix) - visibleWidth(suffix),
  );
  const compactLabel = theme.fg(
    firstItem ? "accent" : "muted",
    truncateToWidth(label.replace(/\s+/g, " ").trim(), labelWidth, "…"),
  );
  return truncateToWidth(`${prefix}${compactLabel}${suffix}`, width, "…");
}

export function renderActiveWorkRail(
  items: ReadonlyArray<ActiveWorkItem>,
  theme: Theme,
  now = Date.now(),
  flashes: ReadonlyArray<SettleFlash> = [],
  maxWidth = 120,
) {
  const width = Math.max(1, maxWidth);
  return [compactRailLine(items, flashes, theme, now, width)];
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
    const itemSnapshot = [...items.values()];
    const flashSnapshot = [...flashes.values()];
    ui.setWidget(
      "active-work",
      (_tui, theme) => ({
        render: (width: number) =>
          renderActiveWorkRail(itemSnapshot, theme, now, flashSnapshot, width),
        invalidate() {},
      }),
      { placement: "aboveEditor" },
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
    (value: EventPayload) => {
      // SAFETY: the parser validates the event payload against the public protocol schema.
      const item = parseActiveWorkItem(value as ActivityProtocolBoundary);
      if (!ui || !item) return;
      items.set(item.key, item);
      schedule();
    },
  );
  const unsubscribeRemove = pi.events.on(
    ACTIVE_WORK_CHANNELS.remove,
    (value: EventPayload) => {
      // SAFETY: the parser validates the event payload against the public protocol schema.
      const removal = parseActiveWorkRemoval(value as ActivityProtocolBoundary);
      if (!ui || !removal) return;
      if (removal.status === "done" || removal.status === "error") {
        flashes.set(removal.key, {
          status: removal.status,
          title: removal.title ?? removal.key,
          ops: removal.ops,
          settledAt: removal.settledAt ?? Date.now(),
        });
      } else {
        flashes.delete(removal.key);
      }
      items.delete(removal.key);
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
