#!/usr/bin/env node
// Drive pi-subagents through a real `pi -p --mode json` parent and time every event.
// Usage: node drive.mjs [scenario...]   (default: pass reject ungated)
// Env: PARENT_MODEL, CHILD_MODEL, VERIFY_OUT, PI_BIN
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EXT = path.join(REPO, "extensions/subagents/index.ts");
const PI = process.env.PI_BIN ?? "pi";
const PARENT = process.env.PARENT_MODEL ?? "openai-codex/gpt-6-luna";
const CHILD = process.env.CHILD_MODEL ?? "openai-codex/gpt-6-luna";
const OUT = path.join(
  process.env.VERIFY_OUT ?? path.join(os.tmpdir(), "verify-pi-subagents"),
  new Date().toISOString().replace(/[:.]/g, "-"),
);

const gate = (question) => ({
  evaluator: "jev",
  questions: { verdict: { type: "choice", question, options: ["pass", "reject"] } },
  predicate: { type: "choice_equals", question_id: "verdict", value: "pass" },
  timeout_ms: 10000,
});
const GATE_Q =
  "Does the report state what the add function in math.js returns, based on actually reading the file?";

const SCENARIOS = {
  pass: {
    expect: "pass",
    spawn: {
      name: "gate-pass",
      prompt: "Read math.js in the current directory. Reply with one sentence stating what the add function returns. Do not edit files.",
      gate: gate(GATE_Q),
    },
  },
  reject: {
    expect: "reject",
    spawn: {
      name: "gate-reject",
      prompt: "Do not read or edit any files. Reply with exactly the word: maybe",
      gate: gate(GATE_Q),
    },
  },
  // Same gated task, but spawn blocks and returns the result: one parent tool turn instead of three.
  wait: {
    expect: "pass",
    oneCall: true,
    spawn: {
      name: "gate-wait",
      prompt: "Read math.js in the current directory. Reply with one sentence stating what the add function returns. Do not edit files.",
      gate: gate(GATE_Q),
      wait: true,
    },
  },
  ungated: {
    expect: undefined,
    spawn: {
      name: "ungated",
      prompt: "Read math.js in the current directory. Reply with one sentence stating what the add function returns. Do not edit files.",
    },
  },
};

function makeProject(dir) {
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
  // Trusted-project overlay: routing off so a -p parent can spawn without an approval turn.
  fs.writeFileSync(
    path.join(dir, ".pi/subagents.json"),
    JSON.stringify({ version: 1, routing: { enabled: false } }),
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

function runScenario(name, index) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`unknown scenario ${name}`);
  const dir = path.join(OUT, `${index}-${name}`);
  const proj = path.join(dir, "proj");
  makeProject(proj);
  const args = { ...sc.spawn, harness: "pi", model: CHILD, reasoning_effort: "low" };
  const prompt =
    `Call subagent_spawn exactly once with these arguments (JSON):\n${JSON.stringify(args)}\n` +
    (sc.oneCall
      ? "Do not call any other tool. Then reply with one line: the child's status and acceptance status."
      : "Then call subagent_wait for that child. Then call subagent_inspect for that child. Then reply with one line: the child's status and acceptance status.");
  const t0 = performance.now();
  const child = spawn(
    PI,
    ["-p", "--mode", "json", "--no-session", "-a", "-ne", "-e", EXT, "--model", PARENT, "--thinking", "low", prompt],
    { cwd: proj, stdio: ["ignore", "pipe", "pipe"] },
  );
  const events = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        events.push({ t: Math.round(performance.now() - t0), e: JSON.parse(line) });
      } catch {
        events.push({ t: Math.round(performance.now() - t0), raw: line });
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      const wall = Math.round(performance.now() - t0);
      fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((x) => JSON.stringify(x)).join("\n") + "\n");
      fs.writeFileSync(path.join(dir, "stderr.txt"), stderr);
      const at = (type, tool) =>
        events.find((x) => x.e?.type === type && (!tool || x.e.toolName === tool));
      const spawnStart = at("tool_execution_start", "subagent_spawn");
      const spawnEnd = at("tool_execution_end", "subagent_spawn");
      const waitStart = sc.oneCall ? spawnStart : at("tool_execution_start", "subagent_wait");
      // With spawn wait, the spawn call itself carries the wait result.
      const waitEnd = sc.oneCall ? spawnEnd : at("tool_execution_end", "subagent_wait");
      const waitDetails = sc.oneCall ? waitEnd?.e.result?.details?.wait : waitEnd?.e.result?.details;
      const result = waitDetails?.results?.[0];
      const inspectEnd = at("tool_execution_end", "subagent_inspect");
      const usage = events
        .filter((x) => x.e?.type === "message_end" && x.e.message?.role === "assistant")
        .reduce(
          (a, x) => ({
            input: a.input + (x.e.message.usage?.input ?? 0),
            output: a.output + (x.e.message.usage?.output ?? 0),
            turns: a.turns + 1,
          }),
          { input: 0, output: 0, turns: 0 },
        );
      const acceptance = result?.acceptance?.status;
      const summary = {
        scenario: name,
        exit: code,
        wallMs: wall,
        toSpawnCallMs: spawnStart?.t,
        spawnToolMs: spawnEnd && spawnStart ? spawnEnd.t - spawnStart.t : undefined,
        spawnToWaitEndMs: waitEnd && spawnEnd ? waitEnd.t - spawnEnd.t : undefined,
        waitToolMs: waitEnd && waitStart ? waitEnd.t - waitStart.t : undefined,
        afterWaitMs: waitEnd ? wall - waitEnd.t : undefined,
        // Gate latency is not exposed by snapshots; compare spawnToWaitEnd of gated vs ungated runs and use jev-probe.ts.
        childStatus: result?.status,
        acceptance,
        waitText: waitEnd?.e.result?.content?.[0]?.text,
        childReport: inspectEnd?.e.result?.content?.[0]?.text?.slice(0, 2000),
        parentUsage: usage,
        expected: sc.expect ?? "(no gate)",
        ok:
          code === 0 &&
          result?.status === "done" &&
          (sc.expect === undefined ? acceptance === undefined : acceptance === sc.expect),
      };
      fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));
      resolve(summary);
    });
  });
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ["pass", "reject", "ungated"];
fs.mkdirSync(OUT, { recursive: true });
// Scenarios run concurrently: each has its own project dir and pi process, and no session file.
const summaries = await Promise.all(names.map((n, i) => runScenario(n, i)));
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summaries, null, 2));
for (const s of summaries) {
  console.log(
    `${s.ok ? "PASS" : "FAIL"} ${s.scenario.padEnd(8)} acceptance=${s.acceptance ?? "-"} (expected ${s.expected}) ` +
      `wall=${s.wallMs}ms toSpawn=${s.toSpawnCallMs}ms spawnToWaitEnd=${s.spawnToWaitEndMs}ms after=${s.afterWaitMs}ms ` +
      `parentTokens=${s.parentUsage.input}/${s.parentUsage.output}`,
  );
}
console.log(`evidence: ${OUT}`);
process.exit(summaries.every((s) => s.ok) ? 0 : 1);
