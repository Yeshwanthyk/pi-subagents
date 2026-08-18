import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./src/domain.ts";
import {
  cycleSubagentId,
  orderDashboardSnapshots,
  reconcileDashboardSelection,
  renderDetailHeader,
  renderListPaneRow,
  renderTakeoverHeaderLines,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

// SAFETY: This fixture implements only the Theme methods exercised by takeover rendering.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "pi",
    owner: "subagents",
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

test("agent cycling wraps and handles a missing current id", () => {
  const ids = ["sa-1", "sa-2", "sa-3"];
  assert.equal(cycleSubagentId(ids, "sa-1", 1), "sa-2");
  assert.equal(cycleSubagentId(ids, "sa-1", -1), "sa-3");
  assert.equal(cycleSubagentId(ids, "sa-3", 1), "sa-1");
  assert.equal(cycleSubagentId(ids, "sa-2", -1), "sa-1");
  assert.equal(cycleSubagentId(ids, "missing", 1), "sa-1");
  assert.equal(cycleSubagentId(ids, "missing", -1), "sa-3");
  assert.equal(cycleSubagentId([], "sa-1", 1), undefined);
});

test("takeover header keeps identity and metadata visible at responsive widths", () => {
  const snap = snapshot({
    title: "executor-env-scout",
    completedOperations: 8,
    meta: {
      backend: "pi",
      modelLabel: "deepseek-v4-flash",
      reasoningEffort: "medium",
    },
  });

  const wide = renderTakeoverHeaderLines(snap, 100, theme, {
    index: 2,
    total: 6,
  });
  assert.equal(wide.length, 2);
  assert.match(wide[0]!, /sa-1 · executor-env-scout/);
  assert.match(wide[0]!, /3\/6/);
  assert.match(wide[1]!, /pi: deepseek-v4-flash/);
  assert.match(wide[1]!, /ctx 10%\/100k/);
  assert.match(wide[1]!, /8 ops/);
  assert.match(wide[1]!, /think:medium/);

  const compact = renderTakeoverHeaderLines(snap, 40, theme, {
    index: 2,
    total: 6,
  });
  assert.equal(compact.length, 3);
  assert.match(compact[0]!, /3\/6/);
  assert.match(compact[1]!, /deepseek-v4-flash/);
  for (const line of compact) assert.ok(visibleWidth(line) <= 40);
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
  const header = renderDetailHeader(
    snapshot({ status: "done", completedOperations: 5, settledAt }),
    60,
    theme,
  );
  assert.equal(header.length, 4);
  assert.match(header[0]!, /DONE  Fix login flow/);
  assert.match(header[1]!, /sa-1 · pi/);
  assert.match(header[1]!, /5 ops/);
  assert.match(header[2]!, /model: deepseek-v4-flash/);
  assert.match(header[3]!, /think: default · ctx: 10%\/100k/);
  assert.ok(header.every((line) => visibleWidth(line) <= 60));
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
test("dashboard snapshots preserve manager insertion order", () => {
  const now = Date.now();
  const running = snapshot({
    id: "run",
    status: "running",
    createdAt: now - 40_000,
    lastActivityAt: now - 10_000,
  });
  const failed = snapshot({
    id: "fail",
    status: "error",
    createdAt: now - 30_000,
    lastActivityAt: now - 20_000,
  });
  const done = snapshot({
    id: "done",
    status: "done",
    createdAt: now - 20_000,
    lastActivityAt: now - 30_000,
  });
  // "unknown" is not part of SubagentStatus yet, but it must not reorder the
  // stable list if a future status is introduced.
  // SAFETY: The test intentionally injects a future status to verify stable ordering.
  const unknown = {
    ...snapshot({
      id: "unk",
      createdAt: now - 10_000,
      lastActivityAt: now - 1_000,
    }),
    // SAFETY: This fixture deliberately models an unknown future status for ordering behavior.
    status: "unknown" as SubagentSnapshot["status"],
  } as SubagentSnapshot;

  assert.deepEqual(
    orderDashboardSnapshots([done, unknown, running, failed]).map((s) => s.id),
    ["done", "unk", "run", "fail"],
  );
});

test("activity updates do not reorder rows", () => {
  const now = Date.now();
  const idle = snapshot({
    id: "idle",
    status: "error",
    createdAt: now - 60_000,
    lastActivityAt: now - 50_000,
  });
  const busy = snapshot({
    id: "busy",
    status: "error",
    createdAt: now - 20_000,
    lastActivityAt: now - 10_000,
  });
  assert.deepEqual(
    orderDashboardSnapshots([idle, busy]).map((s) => s.id),
    ["idle", "busy"],
  );

  // Equal or different timestamps do not affect the visible order.
  const createdEarly = snapshot({
    id: "early",
    status: "done",
    createdAt: now - 40_000,
    lastActivityAt: now - 5_000,
  });
  const createdLate = snapshot({
    id: "late",
    status: "done",
    createdAt: now - 10_000,
    lastActivityAt: now - 5_000,
  });
  assert.deepEqual(
    orderDashboardSnapshots([createdEarly, createdLate]).map((s) => s.id),
    ["early", "late"],
  );
});

test("empty input stays empty and the input array is not mutated", () => {
  assert.deepEqual(orderDashboardSnapshots([]), []);

  const subs = [
    snapshot({ id: "b", status: "done", createdAt: 100, lastActivityAt: 50 }),
    snapshot({
      id: "a",
      status: "running",
      createdAt: 200,
      lastActivityAt: 150,
    }),
  ];
  const idsBefore = subs.map((s) => s.id);
  orderDashboardSnapshots(subs);
  assert.deepEqual(
    subs.map((s) => s.id),
    idsBefore,
  );
});
