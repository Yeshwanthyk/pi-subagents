import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubagentSpawnResult,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
  subagentSpawnToolDescription,
} from "./src/prompt.ts";

test("spawn metadata describes scoped delegation and coordination", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join(" ");

  assert.match(SUBAGENT_SPAWN_PROMPT_SNIPPET, /clearly scoped/);
  assert.match(guidance, /clear scope, purpose, and expected output/);
  assert.match(guidance, /Parallel delegation/);
  assert.match(guidance, /outside its delegated scope/);
  assert.match(guidance, /next parent step requires a child's result/);
  assert.doesNotMatch(guidance, /\bfreely\b/);
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
  assert.match(result, /subagent_inspect/);
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

test("routing guidance preserves authority and disclosure boundaries", () => {
  const spawnGuidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join(" ");

  assert.match(
    SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    /Classification describes the actual deliverable/,
  );
  assert.match(spawnGuidance, /actual deliverable/);
  assert.match(spawnGuidance, /validation with simple complexity/);
  assert.match(spawnGuidance, /selects simple_validation/);
  assert.match(spawnGuidance, /every spawn requires classification/);
  assert.match(spawnGuidance, /agent-supplied fields are not authorization/);
  assert.match(
    spawnGuidance,
    /saved preference, requested overrides, and effective runtime/,
  );
  assert.match(spawnGuidance, /newer user approval/);
});

test("spawn description reports the effective running cap and batch form", () => {
  assert.match(subagentSpawnToolDescription(3), /Max 3 subagents run at once/);
  assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /Max 6 subagents run at once/);
  assert.doesNotMatch(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /Max 4/);
  assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /"tasks" array of 1 to 16/);
  assert.match(SUBAGENT_WAIT_TOOL_DESCRIPTION, /mode "any"/);
});
