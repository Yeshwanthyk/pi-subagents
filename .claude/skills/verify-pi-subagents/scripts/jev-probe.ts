// Live Jev probe through the repo's real JevClient. Read-only; sends only synthetic state.
// Usage: node --experimental-strip-types jev-probe.ts [rounds=3] [timeoutMs=<settings or 10000>]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJevClient } from "../../../../extensions/subagents/src/jev/client.ts";

interface JevSettings {
  readonly timeoutMs?: number;
  readonly model?: string;
}
let configured: JevSettings = {};
try {
  configured = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/subagents.json"), "utf8")).jev ?? {};
} catch {
  // No global settings: client defaults apply.
}
const rounds = Number(process.argv[2] ?? 3);
const timeoutMs = Number(process.argv[3] ?? configured.timeoutMs ?? 10_000);
const client = createJevClient({ timeoutMs, model: configured.model });
const questions = {
  verdict: {
    type: "choice",
    question: "Does the report provide sufficient evidence the change works?",
    options: ["pass", "reject"],
  },
} as const;
const cases = {
  good: { expect: "pass", report: "Changed src/parser.ts line 42 from < to <=. Ran `npm test`: 31 passed, 0 failed. Added regression test parser.test.ts#boundary which failed before and passes after." },
  bad: { expect: "reject", report: "I think it's probably fixed now. Didn't run anything." },
} as const;

console.log(`jev timeoutMs=${timeoutMs} model=${configured.model ?? "default"}`);
let failures = 0;
const latencies: number[] = [];
for (let r = 0; r < rounds; r++) {
  for (const [name, c] of Object.entries(cases)) {
    const state = JSON.stringify({ taskGoal: "Fix parser off-by-one", report: c.report, process: { status: "completed" } });
    const t = performance.now();
    const res = await client.evaluate({ state, questions });
    const ms = Math.round(performance.now() - t);
    latencies.push(ms);
    if (!res.ok) {
      failures++;
      console.log(`FAIL ${name} ${ms}ms ${res.error.code}: ${res.error.message}`);
      continue;
    }
    const v = res.answers.verdict;
    const ok = v.type === "choice" && v.value === c.expect;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ms}ms verdict=${v.type === "choice" ? v.value : "?"} confidence=${v.confidence ?? "?"} tokens=${res.metadata.usage?.inputTokens ?? "?"}/${res.metadata.usage?.outputTokens ?? "?"}`);
  }
}
latencies.sort((a, b) => a - b);
console.log(`latency p50=${latencies[Math.floor(latencies.length / 2)]}ms max=${latencies.at(-1)}ms headroom=${timeoutMs - (latencies.at(-1) ?? 0)}ms`);
process.exit(failures ? 1 : 0);
