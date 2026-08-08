import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { claudeThinkingConfig } from "./src/backends/claude.ts";
import {
  applyCodexMetadataNotification,
  negotiateCodexReasoningEffort,
} from "./src/backends/codex.ts";
import { piRuntimeMeta, resolvePiReasoningEffort } from "./src/backends/pi.ts";
import type { SubagentMeta, SubagentSnapshot } from "./src/domain.ts";
import {
  dashboardMetaLabels,
  renderDashboardRow,
  renderTakeoverHeader,
  takeoverMetaLabels,
} from "./src/ui/takeover.ts";

test("pi resolves explicit and inherited reasoning effort", () => {
  assert.equal(resolvePiReasoningEffort("high", "low"), "high");
  assert.equal(resolvePiReasoningEffort(undefined, "medium"), "medium");
  assert.equal(resolvePiReasoningEffort(undefined, "invalid"), undefined);
});

test("Codex reports negotiated model-supported effort", () => {
  const modelList = {
    data: [
      {
        id: "gpt-test",
        supportedReasoningEfforts: [
          { reasoningEffort: "none" },
          { reasoningEffort: "low" },
        ],
      },
    ],
  };

  assert.deepEqual(
    negotiateCodexReasoningEffort("high", "gpt-test", modelList),
    { nativeEffort: "low", reasoningEffort: "low" },
  );
  assert.deepEqual(
    negotiateCodexReasoningEffort("off", "gpt-test", modelList),
    { nativeEffort: "none", reasoningEffort: "off" },
  );
  assert.deepEqual(
    negotiateCodexReasoningEffort("high", "unknown", undefined),
    { nativeEffort: "high", reasoningEffort: undefined },
  );
});

test("Claude reports the effective adaptive-thinking effort", () => {
  assert.deepEqual(claudeThinkingConfig(undefined), {});
  assert.deepEqual(claudeThinkingConfig("off"), {
    reasoningEffort: "off",
    thinking: { type: "disabled" },
  });
  assert.deepEqual(claudeThinkingConfig("minimal"), {
    reasoningEffort: "low",
    thinking: { type: "adaptive" },
    effort: "low",
  });
  assert.deepEqual(claudeThinkingConfig("max"), {
    reasoningEffort: "max",
    thinking: { type: "adaptive" },
    effort: "max",
  });
});

test("Codex settings and reroutes replace stale effort metadata", () => {
  const modelList = {
    data: [
      {
        id: "known",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      },
    ],
  };
  const initial: SubagentMeta = {
    backend: "codex",
    modelLabel: "known",
    reasoningEffort: "high",
  };
  const rerouted = applyCodexMetadataNotification(
    initial,
    "high",
    "model/rerouted",
    { toModel: "uncatalogued" },
    "high",
    modelList,
  );
  assert.ok(rerouted);
  assert.deepEqual(rerouted.patch, {
    modelLabel: "uncatalogued",
    reasoningEffort: undefined,
  });
  assert.equal(rerouted.meta.reasoningEffort, undefined);

  const authoritative = applyCodexMetadataNotification(
    rerouted.meta,
    rerouted.effort,
    "thread/settings/updated",
    { threadSettings: { model: "uncatalogued", effort: "low" } },
    "high",
    modelList,
  );
  assert.ok(authoritative);
  assert.equal(authoritative.meta.reasoningEffort, "low");
  assert.equal(authoritative.effort, "low");
});

test("Pi metadata reads the runtime session thinking level on each update", () => {
  const runtime = { thinkingLevel: "low", sessionFile: "/tmp/pi.jsonl" };
  const session = runtime as unknown as Pick<
    AgentSession,
    "thinkingLevel" | "sessionFile"
  >;
  assert.equal(piRuntimeMeta(session, undefined).reasoningEffort, "low");

  runtime.thinkingLevel = "xhigh";
  assert.equal(piRuntimeMeta(session, undefined).reasoningEffort, "xhigh");
});

test("dashboard and takeover metadata render the exact thinking label", () => {
  const snap: SubagentSnapshot = {
    id: "sa-1",
    backend: "pi",
    owner: "subagents",
    visibility: "standard",
    resultDelivery: "parent",
    title: "fixture",
    prompt: "test",
    cwd: process.cwd(),
    status: "running",
    createdAt: 0,
    lastActivityAt: 0,
    meta: {
      backend: "pi",
      modelLabel: "openai/gpt-test",
      reasoningEffort: "xhigh",
    },
    usage: {},
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    finalText: "",
    turns: 0,
  };

  assert.deepEqual(dashboardMetaLabels(snap), [
    "pi",
    "openai/gpt-test",
    "think:xhigh",
  ]);
  assert.deepEqual(takeoverMetaLabels(snap), [
    "pi: openai/gpt-test",
    "think:xhigh",
  ]);

  const withoutEffort: SubagentSnapshot = {
    ...snap,
    meta: { backend: "pi", modelLabel: "openai/gpt-test" },
  };
  assert.equal(
    dashboardMetaLabels(withoutEffort).includes("think:xhigh"),
    false,
  );
  assert.equal(
    takeoverMetaLabels(withoutEffort).includes("think:xhigh"),
    false,
  );
});

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("dashboard rows and takeover headers stay within constrained widths", () => {
  const snap: SubagentSnapshot = {
    id: "sa-long-id",
    backend: "codex",
    owner: "subagents",
    visibility: "standard",
    resultDelivery: "parent",
    title: "A deliberately long subagent title",
    prompt: "test",
    cwd: process.cwd(),
    status: "running",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    meta: {
      backend: "codex",
      modelLabel: "a-very-long-model-name",
      reasoningEffort: "xhigh",
    },
    usage: { tokens: 42_000, contextWindow: 100_000 },
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    finalText: "",
    turns: 0,
  };

  for (const width of [24, 40, 64]) {
    assert.ok(
      visibleWidth(renderDashboardRow(snap, width, true, plainTheme)) <= width,
    );
    assert.ok(
      visibleWidth(renderTakeoverHeader(snap, width, plainTheme)) <= width,
    );
  }
  assert.match(renderDashboardRow(snap, 120, true, plainTheme), /think:xhigh/);
  assert.match(renderTakeoverHeader(snap, 120, plainTheme), /think:xhigh/);
});
