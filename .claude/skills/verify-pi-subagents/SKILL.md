---
name: verify-pi-subagents
description: Verify the pi-subagents extension through the real `pi` CLI (print/JSON mode) — spawn, wait, inspect, and Jev post-run gates — with per-event timing. Use after changing extensions/subagents, the Jev client, gate evidence, or result delivery, or when asked whether gates/Jev actually work or how fast subagent runs are.
---

# Verify pi-subagents (CLI)

Drives a real `pi -p --mode json` parent with this repo's extension loaded (`-ne -e extensions/subagents/index.ts`), so the parent model calls the actual `subagent_spawn` / `subagent_wait` / `subagent_inspect` tools, which spawn a real Pi child and run a real Jev gate. Every JSONL event is timestamped by the driver.

## Launch

No server. Each scenario is one short-lived `pi` process in its own scratch project:

- `scripts/drive.mjs` creates `<evidence>/<i>-<scenario>/proj/` with `math.js`, `git init`, and `.pi/subagents.json` = `{"version":1,"routing":{"enabled":false}}`.
- `-a` trusts that project for the run, so the overlay disables routing. Otherwise your global `routing.enabled: true` turns every spawn into an approval proposal that print mode cannot answer.
- `--no-session` means no session file is written. The process exits after the parent's final reply. A 300 s kill timer is the teardown backstop.

Readiness: the process exits 0 and `events.jsonl` contains `agent_end`.

## Doctor (read-only, ~1 s)

Run from the repo root:

```bash
pi --version                                   # pi installed
test -n "$TYPESAFE_API_KEY" || test -f ~/.pi/agent/jev-credentials.json   # Jev credential present
node --experimental-strip-types .claude/skills/verify-pi-subagents/scripts/jev-probe.ts 1
```

`jev-probe.ts` uses the repo's real `JevClient` with the global `jev.timeoutMs`/`model` from `~/.pi/agent/subagents.json`. It sends two synthetic reports (good → `pass`, bad → `reject`) and prints latency and headroom against the timeout. It exits non-zero on any error or wrong verdict. If it fails, stop: the gate scenarios will fail for credential or network reasons, not product reasons.

Model availability: `pi --list-models luna` must list the parent/child models (default `openai-codex/gpt-6-luna` for both). Override with `PARENT_MODEL=… CHILD_MODEL=…`.

## Drive

```bash
node .claude/skills/verify-pi-subagents/scripts/drive.mjs                    # pass reject ungated
node .claude/skills/verify-pi-subagents/scripts/drive.mjs pass pass pass     # repeat for flakiness/latency spread
node .claude/skills/verify-pi-subagents/scripts/drive.mjs wait               # spawn with wait: true (one tool call)
```

Scenarios run concurrently (separate dirs and processes, no shared session). Each prompts the parent to call `subagent_spawn` with exact JSON, then `subagent_wait`, then `subagent_inspect`. The `wait` scenario instead passes `wait: true` and makes no other tool call, so its timings come from the spawn call. Exit code 0 means every scenario matched its expectation.

## Evidence

Evidence lives at `${VERIFY_OUT:-$TMPDIR/verify-pi-subagents}/<ISO-timestamp>/` and the path is printed as the last line. It holds:

- `summary.json`, with one record per scenario:
  - `ok`, `acceptance`, `childStatus`, `waitText`: the compact gated delivery.
  - `childReport`: the `subagent_inspect` text, which includes the child's tool operations and final output.
  - Timings: `toSpawnCallMs` (parent think before spawning), `spawnToWaitEndMs` (child run + gate), `afterWaitMs` (parent's closing turns), `wallMs`.
  - `parentUsage`: tokens.
- `<i>-<scenario>/events.jsonl`: the raw pi events with `t` (ms since launch). This is the initiating tool call and its result.
- `<i>-<scenario>/stderr.txt`

Gate latency is not exposed by snapshots. Estimate it from `jev-probe.ts` and from the gated-vs-ungated difference in `spawnToWaitEndMs`.

## Cleanup

Nothing long-lived is started. The scratch projects sit inside the evidence dir, so keep them as proof and delete the whole timestamped dir when you no longer need it. If a run was killed, check `pgrep -fl "extensions/subagents/index.ts"` and kill only PIDs whose cwd is under the evidence dir.

## Features

See [features/README.md](features/README.md).

## Findings log

- 2026-09-27 baseline, `openai-codex/gpt-6-luna` for both parent and child:
  - Jev p50 was 130 ms and max 168 ms, against the 1000 ms global `jev.timeoutMs`.
  - Wall time per scenario was 12–19 s. Parent LLM turns took about 4–9 s before the spawn and 4–7 s after the wait. The child plus gate took 3–8 s. The gate is under 3% of wall time, so speed work belongs in parent turn count and model latency, not Jev.
- 2026-09-27 defect found and fixed:
  - The standalone gate envelope sent only `{taskGoal, report}`. Jev therefore rejected correct reports on process questions like "based on actually reading the file", 4 of 4 times, and gave coin-flip confidence (~0.5) on loose questions.
  - `standalone-gate.ts` now adds up to 24 recent `operations` (tool, args, ok, output preview ≤400 chars; oldest dropped first to stay within 24 KiB).
  - After the fix: 3 of 3 pass, 1 of 1 reject.
- Workflow gates had the same gap. They now share `src/gate-evidence.ts` with standalone gates, and a unit test (`execution.test.ts`) covers them, but no live workflow drive exists yet.
- A `-ne` harness artifact adds about 1 s between the spawn tool result and the next parent turn: the first child compiles 20 global extensions and 54 skills (`DefaultResourceLoader.reload`), and later children take about 15 ms. This is not product latency in a normal session where the parent already loaded those modules.
- Per-turn breakdown (2026-09-27, luna):
  - Each parent LLM turn takes 1.5–8 s. The first turn carries about 9.5k uncached prompt tokens, and later turns hit the cache.
  - A child usually finishes while the parent is still composing its `subagent_wait` call, so wait returns in about 1 ms.
  - The main lever is the number of parent turns.
- 2026-09-27 speed changes:
  - `subagent_spawn` accepts `wait: true`. Live `wait` runs took 2 parent turns, against 4 for spawn→wait→inspect (wall time 15.8 s vs 16.3 s in one run, where the variance comes from the model's turns).
  - Routing supports `approval: "auto"`: a spawn whose effective runtime equals the saved route starts without a proposal. Overrides still propose. A project overlay may only restrict it.
  - Global routes: `lint` effort lowered to `low`, `small_slice` to `medium`.
  - Full drive (wait, pass, reject, ungated) all PASS.
