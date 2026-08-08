import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderActiveWorkRail } from "../activity-rail/index.ts";
import type { ActiveWorkItem } from "./src/activity-protocol.ts";
import type { SubagentSnapshot } from "./src/domain.ts";
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
  assert.match(text, /3 operations complete · activity 2s ago/);
  assert.match(text, /pi · openai\/test · 10%\/100k/);
  assert.match(text, /\/subagents for transcript and takeover/);
});

test("wait summary reports each pending subagent's current operation", () => {
  const text = renderSubagentWaitSummary(
    [snapshot(), snapshot({ id: "sa-4", status: "done", liveTools: [] })],
    6_000,
  );
  assert.match(text, /Waiting for 1 subagent · 1 complete/);
  assert.match(text, /sa-3 · bash npm test · activity 2s ago/);
  assert.doesNotMatch(text, /sa-4 ·/);
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
});
