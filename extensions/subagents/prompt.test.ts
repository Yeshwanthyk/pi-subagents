import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubagentSpawnResult,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

test("spawn metadata describes scoped delegation and coordination", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join(" ");

  assert.match(SUBAGENT_SPAWN_PROMPT_SNIPPET, /clearly scoped/);
  assert.match(guidance, /clear scope, purpose, and expected output/);
  assert.match(guidance, /Parallel delegation/);
  assert.match(guidance, /outside its delegated scope/);
  assert.match(guidance, /next parent step requires a child's result/);
  assert.doesNotMatch(guidance, /\bfreely\b|\bby default\b/);
  assert.doesNotMatch(
    SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    /background work is normal/,
  );
});

test("spawn result makes dependency-based waiting explicit", () => {
  const result = buildSubagentSpawnResult({
    id: "sa-1",
    title: "Inspect contracts",
    harness: "codex",
    modelLabel: "gpt-5.6-sol",
    cwd: "/tmp/project",
  });

  assert.match(result, /result will be delivered automatically/);
  assert.match(result, /next step requires that result/);
  assert.match(result, /continue outside its delegated scope/);
  assert.match(result, /subagent_cancel/);
  assert.match(result, /subagent_check/);
  assert.match(result, /subagent_list/);
});

test("wait description identifies dependent parent work", () => {
  assert.match(
    SUBAGENT_WAIT_TOOL_DESCRIPTION,
    /next parent step requires those outputs/,
  );
  assert.doesNotMatch(
    SUBAGENT_WAIT_TOOL_DESCRIPTION,
    /not to monitor progress/,
  );
});
