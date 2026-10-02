#!/usr/bin/env node
// Drive pi-subagents through a real `pi -p --mode json` parent and time every event.
// Usage: node drive.mjs [scenario...]   (default: single wait parallel4 parallel6 workflow)
// Env: EXT (extension index.ts; default this repo), PARENT_MODEL, CHILD_MODEL, VERIFY_OUT,
//      RUNS (repeats, default 1), CONCURRENCY (scenarios at once, default 1 = serial),
//      THINKING (parent, default low), TIMEOUT_MS (per scenario, default 600000), PI_BIN, PI_AGENT_DIR,
//      HIDE_TOOLS (comma list; loads EXT through tool-filter.ts without those tools)
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EXT = path.resolve(process.env.EXT ?? path.join(REPO, "extensions/subagents/index.ts"));
const PI = process.env.PI_BIN ?? "pi";
const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";
const PARENT = process.env.PARENT_MODEL ?? DEFAULT_MODEL;
const CHILD = process.env.CHILD_MODEL ?? DEFAULT_MODEL;
const THINKING = process.env.THINKING ?? "low";
const RUNS = Math.max(1, Number(process.env.RUNS ?? 1));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 1));
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 600_000);
const AGENT_DIR = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
const HIDE_TOOLS = process.env.HIDE_TOOLS ?? "";
const LOAD_EXT = HIDE_TOOLS ? path.join(path.dirname(fileURLToPath(import.meta.url)), "tool-filter.ts") : EXT;
const OUT = path.join(
  process.env.VERIFY_OUT ?? path.join(os.tmpdir(), "verify-pi-subagents"),
  new Date().toISOString().replace(/[:.]/g, "-"),
);

const runtime = `harness "pi", model "${CHILD}", reasoning_effort "low"`;
const MATH_TASK =
  "Read math.js in the current directory and reply with one sentence stating what the add function returns. Do not edit files.";

// Prompts state goals, not tool parameters beyond those every version has, so the
// parent uses whatever the loaded extension offers (batch spawn, wait modes, ...).
const single = (extra) =>
  `Use a child subagent for this. Spawn one child (${runtime}) with this task: "${MATH_TASK}" ` +
  `Wait for the child to finish, then reply with one line stating what add returns according to the child.${extra}`;

const parallel = (n) =>
  `Start ${n} independent child subagents at the same time (${runtime} for each); do not wait for one child before starting the next. ` +
  `Child number i (i = 1..${n}) gets this task, with i replaced by its number: ` +
  `"Run exactly this bash command: sleep 8 && touch .marks/child-i  Then reply with only the number i." ` +
  `Then collect the results of all ${n} children and reply with one line listing the numbers they returned.`;

const workflowTask = (id, label, seconds, needs) => {
  const needsPart = needs ? `, needs: [${needs.map((n) => JSON.stringify(n)).join(", ")}]` : "";
  return (
    `    { id: "${id}", label: "${label}", kind: "scout", prompt: "Run exactly this bash command and nothing else: sleep ${seconds}  Then reply with exactly: done", ` +
    `readOnly: true, harness: "pi", model: ${JSON.stringify(CHILD)}, effort: "low"${needsPart} }`
  );
};
const WORKFLOW_SOURCE = [
  "flow({",
  '  name: "barrier-probe",',
  "  tasks: [",
  [workflowTask("A", "Sleep 2", 2), workflowTask("B", "Sleep 25", 25), workflowTask("C", "Sleep 10 after A", 10, ["A"])].join(",\n"),
  "  ],",
  "})",
].join("\n");

const SCENARIOS = {
  single: { messages: [single("")] },
  wait: { messages: [single(" Do this in as few tool calls as possible.")] },
  parallel4: { parallel: 4, messages: [parallel(4)] },
  parallel6: { parallel: 6, messages: [parallel(6)] },
  workflow: {
    workflow: true,
    messages: [
      `Prepare a workflow draft with the workflow tool. Use the preview "Barrier probe: A and B are independent; C needs A only." and exactly this source:\n\n${WORKFLOW_SOURCE}\n\nDo not approve it in this response.`,
      "Approve the workflow draft you just prepared, then wait for the run to finish (poll with workflow_check) and report the final task states.",
    ],
  },
};

function makeProject(dir) {
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".marks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
  // Trusted-project overlay: routing off so a -p parent can spawn without an approval turn.
  fs.writeFileSync(
    path.join(dir, ".pi/subagents.json"),
    JSON.stringify({ version: 1, routing: { enabled: false } }),
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

const TERMINAL_CHILD = new Set(["done", "error", "cancelled", "failed"]);
const TIME_KEYS = ["createdAt", "startedAt", "settledAt", "finishedAt"];

// Find child records ({id, status, ...}) anywhere in tool/message details.
function walkChildren(value, visit, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) return value.forEach((v) => walkChildren(v, visit, depth + 1));
  if (typeof value.id === "string" && typeof value.status === "string") visit(value);
  for (const v of Object.values(value)) walkChildren(v, visit, depth + 1);
}

function readJournal(runId) {
  if (!runId) return undefined;
  const runsDir = path.join(AGENT_DIR, "workflows/runs");
  let dirs = [];
  try {
    dirs = fs.readdirSync(runsDir).map((p) => path.join(runsDir, p, runId)).filter((d) => fs.existsSync(d));
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).sort()) {
      if (!/journal/.test(file)) continue;
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      let events;
      try {
        const parsed = JSON.parse(text);
        events = Array.isArray(parsed) ? parsed : (parsed.events ?? []);
      } catch {
        events = text.split("\n").filter((l) => l.trim()).flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        });
      }
      return { path: path.join(dir, file), events };
    }
  }
  return undefined;
}

function workflowTimings(journal, approveEpoch) {
  if (!journal) return undefined;
  const tag = (e) => e._tag ?? e.type ?? e.kind;
  const started = journal.events.find((e) => tag(e) === "WorkflowStarted")?.at;
  const terminal = journal.events.find((e) => /^Workflow(Completed|Failed|Cancelled)$/.test(tag(e)));
  const base = started ?? approveEpoch;
  const tasks = {};
  for (const e of journal.events) {
    if (!e.taskId || typeof e.at !== "number") continue;
    const t = (tasks[e.taskId] ??= {});
    const off = e.at - base;
    const name = tag(e).replace(/^Task/, "");
    if (name === "Queued") t.queuedMs ??= off;
    else if (name === "Started") t.startMs ??= off;
    else if (/Completed|Failed|Cancelled|Skipped/.test(name)) {
      t.finishMs = off;
      t.status = name.toLowerCase();
    }
  }
  return {
    journal: journal.path,
    runStatus: terminal ? tag(terminal).replace(/^Workflow/, "").toLowerCase() : "unsettled",
    runWallMs: terminal && started ? terminal.at - started : undefined,
    approveToTerminalMs: terminal && approveEpoch ? terminal.at - approveEpoch : undefined,
    tasks,
    cStartAfterAFinishMs:
      tasks.C?.startMs !== undefined && tasks.A?.finishMs !== undefined ? tasks.C.startMs - tasks.A.finishMs : undefined,
    cStartAfterBFinishMs:
      tasks.C?.startMs !== undefined && tasks.B?.finishMs !== undefined ? tasks.C.startMs - tasks.B.finishMs : undefined,
  };
}

function summarize(name, sc, run, code, signal, wall, t0Epoch, events, proj, stderr) {
  const assistant = events.filter((x) => x.e?.type === "message_end" && x.e.message?.role === "assistant");
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const x of assistant) {
    const u = x.e.message.usage ?? {};
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) tokens[k] += u[k] ?? 0;
    tokens.cost += u.cost?.total ?? 0;
  }
  tokens.cost = Math.round(tokens.cost * 1e5) / 1e5;
  const toolCalls = {};
  for (const x of events) {
    if (x.e?.type === "tool_execution_start") toolCalls[x.e.toolName] = (toolCalls[x.e.toolName] ?? 0) + 1;
  }
  const lastText = assistant
    .map((x) => (x.e.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""))
    .filter(Boolean)
    .at(-1);
  const errors = assistant.map((x) => x.e.message.errorMessage).filter(Boolean);

  // Parent-observed child results: first time each child id is seen terminal in a
  // subagent_* tool result or in a pushed parent message.
  const settled = new Map();
  const childTimes = {};
  const spawnStarts = events.filter((x) => x.e?.type === "tool_execution_start" && x.e.toolName === "subagent_spawn");
  for (const x of events) {
    let details;
    if (x.e?.type === "tool_execution_end" && String(x.e.toolName).startsWith("subagent_")) details = x.e.result?.details;
    else if (x.e?.type === "message_end" && x.e.message?.role !== "assistant") details = x.e.message?.details;
    walkChildren(details, (c) => {
      if (!/^sa-/.test(c.id)) return;
      for (const k of TIME_KEYS) {
        if (typeof c[k] === "number" && c[k] > 1e12) (childTimes[c.id] ??= {})[k + "Ms"] = c[k] - t0Epoch;
      }
      if (TERMINAL_CHILD.has(c.status) && !settled.has(c.id)) settled.set(c.id, { t: x.t, status: c.status });
    });
  }
  const results = [...settled.values()];
  const resultTimes = results.map((r) => r.t).sort((a, b) => a - b);
  const done = results.filter((r) => r.status === "done").length;

  const marks = fs.existsSync(path.join(proj, ".marks"))
    ? fs
        .readdirSync(path.join(proj, ".marks"))
        .map((f) => ({ f, t: Math.round(fs.statSync(path.join(proj, ".marks", f)).mtimeMs - t0Epoch) }))
        .sort((a, b) => a.t - b.t)
    : [];

  const summary = {
    scenario: name,
    run,
    parentModel: PARENT,
    childModel: CHILD,
    ext: EXT,
    hideTools: HIDE_TOOLS || undefined,
    exit: code,
    signal,
    wallMs: wall,
    parentTurns: assistant.length,
    toolCalls,
    toolCallsTotal: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    parentTokens: tokens,
    firstSpawnCallMs: spawnStarts[0]?.t,
    childrenSettled: results.length,
    childrenDone: done,
    firstResultMs: resultTimes[0],
    lastResultMs: resultTimes.at(-1),
    childTimes: Object.keys(childTimes).length ? childTimes : undefined,
    finalText: lastText?.slice(0, 600),
    errors: errors.length ? errors : undefined,
    stderrTail: stderr.trim() ? stderr.trim().slice(-600) : undefined,
  };

  if (sc.parallel) {
    summary.sleepDoneMs = marks.map((m) => m.t);
    summary.firstSleepDoneMs = marks[0]?.t;
    summary.lastSleepDoneMs = marks.at(-1)?.t;
    summary.ok = code === 0 && done >= sc.parallel && marks.length >= sc.parallel;
  } else if (sc.workflow) {
    const tag = (n) => events.filter((x) => x.e?.type === "tool_execution_end" && x.e.toolName === n);
    const wfEnds = tag("workflow");
    const prepared = wfEnds.find((x) => x.e.result?.details?.kind === "draft");
    const approved = wfEnds.find((x) => x.e.result?.details?.runId);
    const runId = approved?.e.result?.details?.runId;
    const approveEpoch = approved ? t0Epoch + approved.t : undefined;
    const wf = workflowTimings(readJournal(runId), approveEpoch);
    const checks = tag("workflow_check");
    const lastCheck = checks.at(-1)?.e.result?.details;
    summary.workflow = {
      draftId: prepared?.e.result?.details?.draftId,
      preparedMs: prepared?.t,
      approvedMs: approved?.t,
      approveError: approved ? undefined : wfEnds.map((x) => x.e.result?.content?.[0]?.text?.slice(0, 300)).filter(Boolean),
      runId,
      checkCalls: checks.length,
      lastCheckStatus: lastCheck?.status,
      lastCheckTasks: lastCheck?.tasks?.map((t) => ({
        id: t.id,
        status: t.status,
        attempts: t.attempts?.map((a) => ({
          status: a.status,
          startMs: approveEpoch && a.startedAt ? a.startedAt - approveEpoch : undefined,
          finishMs: approveEpoch && a.finishedAt ? a.finishedAt - approveEpoch : undefined,
        })),
      })),
      ...wf,
    };
    summary.ok =
      code === 0 &&
      wf?.runStatus === "completed" &&
      ["A", "B", "C"].every((id) => wf.tasks[id]?.status === "completed");
  } else {
    summary.ok = code === 0 && done >= 1 && /a \+ b|sum/i.test(lastText ?? "");
  }
  return summary;
}

function runScenario(name, run) {
  const sc = SCENARIOS[name];
  const dir = path.join(OUT, `${run}-${name}`);
  const proj = path.join(dir, "proj");
  makeProject(proj);
  const argv = ["-p", "--mode", "json", "--no-session", "-a", "-ne", "-e", LOAD_EXT, "--model", PARENT, "--thinking", THINKING, ...sc.messages];
  const env = HIDE_TOOLS ? { ...process.env, FILTER_EXT: EXT, HIDE_TOOLS } : process.env;
  fs.writeFileSync(path.join(dir, "command.json"), JSON.stringify({ pi: PI, argv, cwd: proj, hideTools: HIDE_TOOLS || undefined }, null, 2));
  const t0Epoch = Date.now();
  const t0 = performance.now();
  const child = spawn(PI, argv, { cwd: proj, env, stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const t = Math.round(performance.now() - t0);
      try {
        events.push({ t, e: JSON.parse(line) });
      } catch {
        events.push({ t, raw: line });
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  process.stderr.write(`[${new Date().toISOString()}] start ${run}-${name}\n`);
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(kill);
      const wall = Math.round(performance.now() - t0);
      fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((x) => JSON.stringify(x)).join("\n") + "\n");
      fs.writeFileSync(path.join(dir, "stderr.txt"), stderr);
      let summary;
      try {
        summary = summarize(name, sc, run, code, signal, wall, t0Epoch, events, proj, stderr);
      } catch (err) {
        summary = { scenario: name, run, parentModel: PARENT, childModel: CHILD, ext: EXT, exit: code, wallMs: wall, ok: false, harnessError: String(err?.stack ?? err) };
      }
      fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));
      process.stderr.write(`[${new Date().toISOString()}] ${summary.ok ? "PASS" : "FAIL"} ${run}-${name} ${wall}ms\n`);
      resolve(summary);
    });
  });
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
for (const n of names) if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n}; known: ${Object.keys(SCENARIOS).join(" ")}`);
if (!fs.existsSync(EXT)) throw new Error(`EXT not found: ${EXT}`);
fs.mkdirSync(OUT, { recursive: true });
const jobs = [];
for (let run = 1; run <= RUNS; run++) for (const n of names) jobs.push([n, run]);
const summaries = [];
// Serial by default (CONCURRENCY=1) so scenarios do not distort each other's timings.
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (jobs.length) {
      const [n, run] = jobs.shift();
      summaries.push(await runScenario(n, run));
    }
  }),
);
summaries.sort((a, b) => a.run - b.run || names.indexOf(a.scenario) - names.indexOf(b.scenario));
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summaries, null, 2));

const s = (ms) => (ms === undefined ? "-" : (ms / 1000).toFixed(1));
console.log(`parent=${PARENT} child=${CHILD} ext=${EXT}${HIDE_TOOLS ? ` hide=${HIDE_TOOLS}` : ""}`);
console.log("ok   scenario   run  wall_s turns tools tok_in/out    first_s last_s  extra");
for (const r of summaries) {
  let extra = "";
  if (r.sleepDoneMs) extra = `sleepDone=${s(r.firstSleepDoneMs)}..${s(r.lastSleepDoneMs)}s spawns=${r.toolCalls?.subagent_spawn ?? 0}`;
  if (r.workflow) {
    const t = r.workflow.tasks ?? {};
    const span = (id) => `${id}:${s(t[id]?.startMs)}-${s(t[id]?.finishMs)}`;
    extra = `run=${s(r.workflow.runWallMs)}s ${span("A")} ${span("B")} ${span("C")} checks=${r.workflow.checkCalls}`;
  }
  if (r.harnessError) extra = `harnessError`;
  const tok = r.parentTokens ? `${r.parentTokens.input + r.parentTokens.cacheRead}/${r.parentTokens.output}` : "-";
  console.log(
    `${r.ok ? "PASS" : "FAIL"} ${r.scenario.padEnd(10)} ${String(r.run).padEnd(4)} ${s(r.wallMs).padStart(6)} ${String(r.parentTurns ?? "-").padStart(5)} ${String(r.toolCallsTotal ?? "-").padStart(5)} ${tok.padEnd(13)} ${s(r.firstResultMs).padStart(7)} ${s(r.lastResultMs).padStart(6)}  ${extra}`,
  );
}
console.log(`evidence: ${OUT}`);
process.exit(summaries.every((r) => r.ok) ? 0 : 1);
