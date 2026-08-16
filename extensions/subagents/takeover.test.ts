import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./src/domain.ts";
import {
  reconcileDashboardSelection,
  renderDetailHeader,
  renderListPaneRow,
  takeoverOverlayOptions,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "pi",
    owner: "subagents",
    visibility: "standard",
    resultDelivery: "parent",
    title: "Fix login flow",
    prompt: "fix",
    cwd: "/repo",
    status: "running",
    createdAt: Date.now() - 10_000,
    lastActivityAt: Date.now() - 5_000,
    meta: { backend: "pi", modelLabel: "deepseek-v4-flash" },
    usage: { tokens: 10_000, contextWindow: 100_000 },
    transcript: [],
    liveTools: [],
    completedOperations: 12,
    processTelemetry: "unavailable",
    queued: [],
    finalText: "",
    turns: 1,
    ...overrides,
  };
}

test("standard subagents keep their original full-width presentation", () => {
  assert.deepEqual(takeoverOverlayOptions(), {
    anchor: "center",
    width: "100%",
    maxHeight: "100%",
  });
  assert.deepEqual(takeoverOverlayOptions(true), {
    anchor: "right-center",
    width: "78%",
    minWidth: 72,
    maxHeight: "100%",
    margin: 1,
  });
});

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("list pane row shows title, id, status word and dim meta, bounded to width", () => {
  const [line1, line2] = renderListPaneRow(snapshot(), 40, true, theme);
  assert.match(line1, /Fix login flow/);
  assert.match(line1, /sa-1/);
  assert.match(line1, /running/);
  assert.match(line2, /deepseek-v4-flash/);
  assert.match(line2, /10%\/100k/);
  assert.match(line2, /\d+s\s*$/);
  assert.ok(visibleWidth(line1) <= 40 && visibleWidth(line2) <= 40);
});

test("detail header shows id, title, status and live meta", () => {
  const settledAt = Date.now();
  const [line1, line2] = renderDetailHeader(
    snapshot({ status: "done", completedOperations: 5, settledAt }),
    60,
    theme,
  );
  assert.match(line1, /sa-1 · Fix login flow done/);
  assert.match(line2, /pi: deepseek-v4-flash/);
  assert.match(line2, /10%\/100k/);
  assert.match(line2, /5 ops/);
  assert.ok(visibleWidth(line1) <= 60 && visibleWidth(line2) <= 60);
});

test("settled list rows render done/failed status words", () => {
  const [doneLine] = renderListPaneRow(
    snapshot({ status: "done", liveTools: [], completedOperations: 24 }),
    30,
    false,
    theme,
  );
  assert.match(doneLine, /done/);
  const [failedLine] = renderListPaneRow(
    snapshot({
      status: "error",
      liveTools: [],
      errorText: "boom",
      completedOperations: 3,
    }),
    30,
    false,
    theme,
  );
  assert.match(failedLine, /failed/);
});
