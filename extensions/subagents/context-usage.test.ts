import assert from "node:assert/strict";
import test from "node:test";
import { parseThreadTokenUsage, type JsonValue } from "./src/backends/codex.ts";

// --- Codex: last request's total, never the thread-cumulative total ----------

const codexParams = (tokenUsage: JsonValue) => ({
  threadId: "t",
  turnId: "u",
  tokenUsage,
});

test("Codex occupancy uses tokenUsage.last.totalTokens, not the cumulative total", () => {
  const { tokens, contextWindow } = parseThreadTokenUsage(
    codexParams({
      total: {
        totalTokens: 1_450_000,
        inputTokens: 1_400_000,
        cachedInputTokens: 1_300_000,
        outputTokens: 50_000,
        reasoningOutputTokens: 20_000,
      },
      last: {
        totalTokens: 61_000,
        inputTokens: 60_000,
        cachedInputTokens: 55_000,
        outputTokens: 1_000,
        reasoningOutputTokens: 400,
      },
      modelContextWindow: 272_000,
    }),
  );
  assert.equal(tokens, 61_000);
  assert.equal(contextWindow, 272_000);
});

test("Codex occupancy is unknown when last usage or window is absent", () => {
  assert.deepEqual(
    parseThreadTokenUsage(
      codexParams({ total: { totalTokens: 10 }, modelContextWindow: null }),
    ),
    { tokens: undefined, contextWindow: undefined },
  );
  assert.deepEqual(parseThreadTokenUsage({ threadId: "t" }), {
    tokens: undefined,
    contextWindow: undefined,
  });
});
