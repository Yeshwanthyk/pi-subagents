import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_JEV_PROMPT_GUIDELINES,
  ASK_JEV_TOOL_DESCRIPTION,
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

test("routing and Jev guidance preserve authority and disclosure boundaries", () => {
  const spawnGuidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join(" ");
  const jevGuidance = ASK_JEV_PROMPT_GUIDELINES.join(" ");

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
  assert.match(
    ASK_JEV_TOOL_DESCRIPTION,
    /sends the state and questions to a remote service/,
  );
  assert.match(ASK_JEV_TOOL_DESCRIPTION, /not an agent or proof/);
  assert.match(jevGuidance, /never as permission/);
  assert.match(jevGuidance, /minimum explicitly selected evidence/);
  assert.match(jevGuidance, /never reads files or uploads context on its own/);
});

test("Jev guidance makes bounded judgment deliberate and economical", () => {
  const guidance = ASK_JEV_PROMPT_GUIDELINES.join(" ");

  assert.match(guidance, /On each request/);
  assert.match(guidance, /planning or delegating/);
  assert.match(guidance, /replace a larger model call/);
  assert.match(guidance, /avoid reading a long report/);
  assert.match(
    guidance,
    /bounded classification, scoring, and report judgments/,
  );
  assert.match(guidance, /rather than automatically/);
  assert.match(guidance, /Batch related questions/);
});

test("Jev guidance plans gates without replacing code proof", () => {
  const jevGuidance = ASK_JEV_PROMPT_GUIDELINES.join(" ");
  const spawnGuidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join(" ");

  assert.match(jevGuidance, /continuation depends on judging a child's result/);
  assert.match(jevGuidance, /Show planned gates before any required approval/);
  assert.match(jevGuidance, /exact code checks and tests/);
  assert.match(jevGuidance, /never as permission.*proof.*authority/);
  assert.match(spawnGuidance, /compact acceptance by default/);
  assert.match(spawnGuidance, /request the full report explicitly/);
  assert.match(spawnGuidance, /retain its content/);
  assert.match(spawnGuidance, /never strip dependency evidence/);
});
