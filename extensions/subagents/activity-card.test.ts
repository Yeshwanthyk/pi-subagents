import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderActiveWorkRail } from "../activity-rail/index.ts";
import type { ActiveWorkItem } from "./src/activity-protocol.ts";
import type { SubagentSnapshot } from "./src/domain.ts";
import { formatActivityCounts, formatActivityStatus } from "./src/format.ts";
import {
  renderSubagentActivity,
  renderSubagentWaitSummary,
} from "./src/ui/activity-card.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-3",
    backend: "pi",
    owner: "subagents",
    visibility: "standard",
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

test("active-work rail is bounded and shows overflow", () => {
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
  assert.equal(lines.length, 10);
  assert.equal(lines.filter((line) => /sa-\d/.test(line)).length, 4);
  assert.match(lines.at(-1) ?? "", /\+2 more active items/);
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
  assert.match(lines.join("\n"), /quiet · no recent events/);
  assert.match(lines.join("\n"), /\[QUIET\]/);
});

test("active-work rail renders compact running rows with spinner, ops and ctx", () => {
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
  assert.match(text, /⠋/);
  assert.doesNotMatch(text, /\[RUNNING\]/);
  assert.match(text, /Fix login flow/);
  assert.match(text, /12 ops/);
  assert.match(text, /ctx 4%/);
  assert.match(text, /→ bash npm test/);
});

test("active-work rail wraps the full operation instead of truncating it", () => {
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
  assert.match(
    text.replace(/\s+/g, ""),
    /vendor\/alchemy\/packages\/alchemy\/src\/Cloudflare\/Workers\/Source\.ts/,
  );
  assert.doesNotMatch(text, /…/);
});

test("active-work rail spinner advances with time and is deterministic per now", () => {
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
  assert.notEqual(first, second);
  assert.match(first, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test("active-work rail shows settle flashes bounded to MAX_FLASH", () => {
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
  assert.match(lines.join("\n"), /✓ Lint pass \[DONE\] · 24 ops · 3s/);
  assert.match(lines.join("\n"), /✕ Migrate config \[FAILED\] · 3 ops/);
  assert.doesNotMatch(lines.join("\n"), /Overflow flash/);
  assert.match(lines.at(-1) ?? "", /\+1 more active items/);
});

test("active-work rail footer shows the dashboard shortcut when not overflowing", () => {
  const lines = renderActiveWorkRail([], theme, 1_000);
  assert.match(lines.at(-1) ?? "", /ctrl\+shift\+a · subagents/);
});
