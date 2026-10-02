#!/usr/bin/env node
// Compare two drive.mjs evidence trees: node compare.mjs <baselineDir> <afterDir>
// Each dir may be one drive run (has summary.json) or a VERIFY_OUT dir holding several
// timestamped runs. Per parent model + scenario it uses passing records when any exist
// (otherwise all), and reports the median across runs.
import * as fs from "node:fs";
import * as path from "node:path";

function load(dir) {
  const files = [];
  if (fs.existsSync(path.join(dir, "summary.json"))) files.push(path.join(dir, "summary.json"));
  for (const sub of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const f = path.join(dir, sub, "summary.json");
    if (fs.existsSync(f) && Array.isArray(JSON.parse(fs.readFileSync(f, "utf8")))) files.push(f);
  }
  if (!files.length) throw new Error(`no summary.json under ${dir}`);
  const groups = new Map();
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const r of Array.isArray(data) ? data : []) {
      const key = `${r.parentModel}${r.hideTools ? ` [hide ${r.hideTools}]` : ""}\t${r.scenario}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
  }
  return groups;
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return undefined;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const METRICS = [
  ["wall_s", (r) => r.wallMs, 1000],
  ["turns", (r) => r.parentTurns, 1],
  ["tools", (r) => r.toolCallsTotal, 1],
  ["tok_k", (r) => (r.parentTokens ? r.parentTokens.input + r.parentTokens.cacheRead + r.parentTokens.output : undefined), 1000],
  ["first_s", (r) => r.firstResultMs, 1000],
  ["last_s", (r) => r.lastResultMs, 1000],
  ["sleepLast_s", (r) => r.lastSleepDoneMs, 1000],
  ["wfRun_s", (r) => r.workflow?.runWallMs, 1000],
  ["wfCstart_s", (r) => r.workflow?.tasks?.C?.startMs, 1000],
  ["wfCdone_s", (r) => r.workflow?.tasks?.C?.finishMs, 1000],
];

function stats(records) {
  const pass = records.filter((r) => r.ok);
  const use = pass.length ? pass : records;
  const out = { ok: `${pass.length}/${records.length}` };
  for (const [name, get, scale] of METRICS) {
    const m = median(use.map(get));
    out[name] = m === undefined ? undefined : m / scale;
  }
  return out;
}

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error("usage: node compare.mjs <baselineDir> <afterDir>");
  process.exit(2);
}
const before = load(beforeDir);
const after = load(afterDir);
const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
const fmt = (x) => (x === undefined ? "-" : Number.isInteger(x) ? String(x) : x.toFixed(1));
console.log(`before: ${beforeDir}\nafter:  ${afterDir}\n`);
console.log("model / scenario                              metric       before    after    delta     %");
for (const key of keys) {
  const [model, scenario] = key.split("\t");
  const b = before.has(key) ? stats(before.get(key)) : undefined;
  const a = after.has(key) ? stats(after.get(key)) : undefined;
  console.log(`${model} / ${scenario}`);
  console.log(`${"".padEnd(45)} ${"ok".padEnd(11)} ${(b?.ok ?? "-").padStart(7)} ${(a?.ok ?? "-").padStart(8)}`);
  for (const [name] of METRICS) {
    const bv = b?.[name];
    const av = a?.[name];
    if (bv === undefined && av === undefined) continue;
    const d = bv !== undefined && av !== undefined ? av - bv : undefined;
    const pct = d !== undefined && bv ? `${d >= 0 ? "+" : ""}${Math.round((d / bv) * 100)}%` : "-";
    console.log(
      `${"".padEnd(45)} ${name.padEnd(11)} ${fmt(bv).padStart(7)} ${fmt(av).padStart(8)} ${(d === undefined ? "-" : (d >= 0 ? "+" : "") + fmt(d)).padStart(8)} ${pct.padStart(5)}`,
    );
  }
}
