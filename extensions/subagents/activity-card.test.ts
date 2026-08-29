import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderActiveWorkRail } from "../activity-rail/index.ts";
import type { ActiveWorkItem } from "./src/activity-protocol.ts";
import type { SubagentSnapshot } from "./src/domain.ts";
import { formatActivityCounts, formatActivityStatus } from "./src/format.ts";
import {
  renderSubagentActivity,
  renderSubagentWaitSummary,
} from "./src/ui/activity-card.ts";

// SAFETY: This fixture implements only the Theme methods exercised by the activity-card renderer.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-3",
    backend: "pi",
    owner: "subagents",
    resultDelivery: "parent",
    title: "final-verify",
    prompt: "verify",
    cwd: "/repo",
    status: "running",
    createdAt: 1_000,
    lastActivityAt: 4_000,
    meta: { backend: "pi", modelLabel: "openai/test" },
    usage: { tokens: 10_000, contextWindow: 100_000 },
    transcript: [],
    liveTools: [
      {
        toolId: "tool-1",
        name: "bash",
        argsPreview: "npm test",
        startedAt: 2_000,
        updatedAt: 4_000,
      },
    ],
    completedOperations: 3,
    processTelemetry: "unavailable",
    queued: [],
    finalText: "",
    turns: 1,
    ...overrides,
  };
}

test("subagent activity card shows current work and bounded activity metadata", () => {
  const text = renderSubagentActivity(snapshot(), theme, {
    now: 6_000,
    expanded: true,
  });
  assert.match(text, /sa-3 · final-verify RUNNING · 5s/);
  assert.match(text, /bash npm test 4s/);
  assert.match(text, /3 operations complete/);
  assert.match(text, /pi · openai\/test · 10%\/100k/);
  assert.match(text, /\/subagents for transcript and takeover/);
});

test("wait summary reports each pending subagent's current operation", () => {
  const text = renderSubagentWaitSummary(
    [snapshot(), snapshot({ id: "sa-4", status: "done", liveTools: [] })],
    theme,
    6_000,
  );
  assert.match(text, /Waiting for 1 subagent · 1 complete/);
  assert.match(text, /sa-3 · bash npm test · activity 2s ago/);
  assert.doesNotMatch(text, /sa-4 ·/);
});

test("wait summary ribbons the full status mix once any agent settles", () => {
  const text = renderSubagentWaitSummary(
    [
      snapshot(),
      snapshot({ id: "sa-2" }),
      snapshot({ id: "sa-4", status: "done", liveTools: [] }),
      snapshot({ id: "sa-5", status: "error", liveTools: [] }),
    ],
    theme,
    6_000,
  );
  const lines = text.split("\n");
  assert.match(lines[0], /Waiting for 2 subagents · 2 complete/);
  assert.equal(lines[1], "■ 2 running · ■ 1 done · ■ 1 failed");
});

test("wait summary omits the counts ribbon while nothing has settled", () => {
  const text = renderSubagentWaitSummary(
    [snapshot(), snapshot({ id: "sa-2" })],
    theme,
    6_000,
  );
  assert.match(text.split("\n")[0], /Waiting for 2 subagents$/);
  assert.doesNotMatch(text, /■/);
});

test("formatActivityCounts renders only nonzero groups", () => {
  assert.equal(
    formatActivityCounts(theme, { running: 2, done: 1, failed: 1 }),
    "■ 2 running · ■ 1 done · ■ 1 failed",
  );
  assert.equal(
    formatActivityCounts(theme, { running: 1, done: 0, failed: 0 }),
    "■ 1 running",
  );
  assert.equal(
    formatActivityCounts(theme, { running: 0, done: 0, failed: 0 }),
    "",
  );
});

test("formatActivityStatus keeps its established string for a given mix", () => {
  assert.equal(
    formatActivityStatus(theme, { running: 2, done: 1, failed: 1 }),
    "subagents: ■ 2 running · ■ 1 done · ■ 1 failed · /subagents to view",
  );
});

test("active-work rail stays one line and shows overflow at normal widths", () => {
  const items: ActiveWorkItem[] = Array.from({ length: 6 }, (_, index) => ({
    version: 1,
    key: `subagent:sa-${index}`,
    kind: "subagent",
    label: `sa-${index} · task`,
    status: "running",
    summary: `bash test-${index}`,
    currentOperation: `bash test-${index}`,
    runningProcesses: 0,
    startedAt: 1_000 + index,
    lastActivityAt: 2_000 + index,
  }));
  const lines = renderActiveWorkRail(items, theme, 7_000);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /6 active/);
  assert.match(lines[0] ?? "", /sa-0/);
  assert.match(lines[0] ?? "", /\+5/);
});

test("active-work rail collapses to one useful row at phone widths", () => {
  const items: ActiveWorkItem[] = Array.from({ length: 6 }, (_, index) => ({
    version: 1,
    key: `subagent:sa-${index}`,
    kind: "subagent",
    label: `sa-${index} · task`,
    status: "running",
    summary: `bash test-${index}`,
    currentOperation: `bash test-${index}`,
    runningProcesses: 0,
    startedAt: 1_000 + index,
    lastActivityAt: 2_000 + index,
  }));
  const lines = renderActiveWorkRail(items, theme, 7_000, [], 48);
  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0] ?? "") <= 48);
  assert.match(lines[0] ?? "", /6 active/);
  assert.match(lines[0] ?? "", /sa-0/);
  assert.match(lines[0] ?? "", /\[RUN\]/);
  assert.match(lines[0] ?? "", /\+5/);
  assert.match(lines[0] ?? "", /ctrl\+shift\+a/);
});

test("workflow activity rail advertises the workflow dashboard shortcut", () => {
  const item: ActiveWorkItem = {
    version: 1,
    key: "workflow:wf-1",
    kind: "workflow",
    label: "wf-1 · verify",
    status: "running",
    summary: "1 running",
    runningProcesses: 1,
    startedAt: 1_000,
    lastActivityAt: 2_000,
  };
  assert.match(
    renderActiveWorkRail([item], theme, 3_000, [], 48)[0] ?? "",
    /ctrl\+shift\+z/,
  );
  assert.match(
    renderActiveWorkRail([item], theme, 3_000, [], 32)[0] ?? "",
    /\^⇧Z$/,
  );
});

test("active-work rail retains essentials below 40 columns", () => {
  const items: ActiveWorkItem[] = [
    {
      version: 1,
      key: "subagent:sa-0",
      kind: "subagent",
      label: "sa-0 · task",
      status: "running",
      summary: "working",
      runningProcesses: 0,
      startedAt: 1_000,
      lastActivityAt: 2_000,
    },
    {
      version: 1,
      key: "subagent:sa-1",
      kind: "subagent",
      label: "sa-1 · task",
      status: "running",
      summary: "working",
      runningProcesses: 0,
      startedAt: 1_000,
      lastActivityAt: 2_000,
    },
  ];
  const line = renderActiveWorkRail(items, theme, 3_000, [], 32)[0] ?? "";
  assert.ok(visibleWidth(line) <= 32);
  assert.match(line, /^2a · sa-0/);
  assert.match(line, / · R · \+1 · \^⇧A$/);
});

test("active-work rail remains one compact row on wide terminals", () => {
  const item: ActiveWorkItem = {
    version: 1,
    key: "subagent:sa-wide",
    kind: "subagent",
    label: "sa-wide · verify",
    status: "running",
    summary: "bash npm test",
    currentOperation: "bash npm test",
    runningProcesses: 0,
    startedAt: 1_000,
    lastActivityAt: 2_000,
  };
  const lines = renderActiveWorkRail([item], theme, 3_000, [], 101);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /1 active/);
  assert.match(lines[0] ?? "", /sa-wide/);
  assert.match(lines[0] ?? "", /\[RUN\]/);
});

test("active-work rail derives quiet state as activity ages", () => {
  const item: ActiveWorkItem = {
    version: 1,
    key: "subagent:sa-quiet",
    kind: "subagent",
    label: "sa-quiet · waiting",
    status: "running",
    summary: "model working",
    runningProcesses: 0,
    startedAt: 1_000,
    lastActivityAt: 2_000,
  };
  const lines = renderActiveWorkRail([item], theme, 40_000);
  assert.match(lines.join("\n"), /\[QUIET\]/);
});

test("active-work rail keeps the primary identity and state instead of verbose metadata", () => {
  const item: ActiveWorkItem = {
    version: 1,
    key: "subagent:sa-1",
    kind: "subagent",
    label: "Fix login flow",
    status: "running",
    summary: "bash npm test",
    currentOperation: "bash npm test",
    runningProcesses: 0,
    startedAt: 1_000,
    lastActivityAt: 2_000,
    modelLabel: "deepseek-v4-flash",
    contextPercent: 4,
    completedOperations: 12,
  };
  const text = renderActiveWorkRail([item], theme, 3_000).join("\n");
  assert.equal(text.split("\n").length, 1);
  assert.match(text, /Fix login flow/);
  assert.match(text, /\[RUN\]/);
  assert.doesNotMatch(text, /12 ops|ctx 4%|bash npm test/);
});

test("active-work rail replaces long operations with a bounded phone summary", () => {
  const item: ActiveWorkItem = {
    version: 1,
    key: "subagent:sa-long",
    kind: "subagent",
    label: "p0-implementer",
    status: "running",
    summary: "read source",
    currentOperation:
      "read vendor/alchemy/packages/alchemy/src/Cloudflare/Workers/Source.ts",
    runningProcesses: 0,
    startedAt: 1_000,
    lastActivityAt: 2_000,
  };
  const text = renderActiveWorkRail([item], theme, 3_000, [], 42).join("\n");
  assert.equal(text.split("\n").length, 1);
  assert.ok(text.split("\n").every((line) => visibleWidth(line) <= 42));
  assert.match(text, /p0-/);
  assert.match(text, /\[RUN\]/);
  assert.match(text, /ctrl\+shift\+a/);
});

test("active-work rail uses a stable marker to avoid idle repaint churn", () => {
  const item: ActiveWorkItem = {
    version: 1,
    key: "subagent:sa-spin",
    kind: "subagent",
    label: "spinner",
    status: "running",
    summary: "working",
    runningProcesses: 0,
    startedAt: 1_000,
    lastActivityAt: 2_000,
  };
  const first = renderActiveWorkRail([item], theme, 0).join("\n");
  const second = renderActiveWorkRail([item], theme, 150).join("\n");
  assert.equal(first, second);
  assert.match(first, /\[RUN\]/);
});

test("active-work rail summarizes the first settle flash and overflow", () => {
  const flashes = [
    {
      status: "done" as const,
      title: "Lint pass",
      ops: 24,
      settledAt: 5_000,
    },
    {
      status: "error" as const,
      title: "Migrate config",
      ops: 3,
      settledAt: 6_000,
    },
    {
      status: "done" as const,
      title: "Overflow flash",
      ops: 1,
      settledAt: 7_000,
    },
  ];
  const lines = renderActiveWorkRail([], theme, 8_000, flashes);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /Lint pass · \[DONE\]/);
  assert.doesNotMatch(lines.join("\n"), /Migrate config/);
  assert.doesNotMatch(lines.join("\n"), /Overflow flash/);
  assert.match(lines[0] ?? "", /\+2/);
});

test("active-work rail header shows the dashboard shortcut", () => {
  const lines = renderActiveWorkRail([], theme, 1_000);
  assert.match(lines[0] ?? "", /0 active · ctrl\+shift\+a/);
});
