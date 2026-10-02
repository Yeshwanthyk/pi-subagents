---
name: verify-pi-subagents
description: Verify and benchmark the pi-subagents extension through the real `pi` CLI (print/JSON mode). It covers single spawn, spawn-and-wait, 4- and 6-way parallel children, and a 3-task workflow, with per-event timing and a before/after comparison. Use after changing extensions/subagents (spawn, wait, scheduling, concurrency, workflows, result delivery), or when asked how fast subagent runs are or whether a change made them faster.
---

# Verify pi-subagents (CLI)

The driver runs a real `pi -p --mode json` parent with an extension loaded (`-ne -e $EXT`). The parent model calls the real `subagent_*` / `workflow*` tools, and those spawn real Pi children. The driver timestamps every JSONL event. `EXT` defaults to this repo's `extensions/subagents/index.ts`. Point it at another checkout, such as a baseline worktree, to measure the same scenarios against older code.

## Launch

No server. Each scenario is one short-lived `pi` process in its own scratch project:

- `scripts/drive.mjs` creates `<evidence>/<run>-<scenario>/proj/` with `math.js`, an empty `.marks/`, `git init`, and `.pi/subagents.json` = `{"version":1,"routing":{"enabled":false}}`.
- `-a` trusts that project for the run, so the overlay disables routing. Otherwise a global `routing.enabled: true` turns every spawn into an approval proposal that print mode cannot answer.
- `--no-session` means no session file is written. The process exits after the parent's final reply to the last message. A `TIMEOUT_MS` (default 600 s) kill timer is the teardown backstop.
- Multi-message print mode: `pi -p … "<msg1>" "<msg2>"` sends each message as a new user input in one session. The `workflow` scenario uses it because approval needs a newer user input than preparation.

Readiness: the process exits 0 and `events.jsonl` contains `agent_end`.

## Doctor (read-only, ~10 s)

```bash
pi --version
pi --list-models deepseek-v4.1-flash      # default model must be listed (opencode-go provider)
pi -p --no-session -ne -e extensions/subagents/index.ts --model opencode-go/deepseek-v4.1-flash --thinking low "say hi"
```

The last command must print a reply.

- If it prints `400 …`, the provider rejects one of the extension's tool schemas. Top-level `Type.Union` parameters (`workflow`, `workflow_control`) are rejected by OpenAI-compatible endpoints. Run the spawn scenarios with `HIDE_TOOLS=workflow,workflow_control`, which loads EXT through `scripts/tool-filter.ts`. Record that the workflow scenario is blocked.
- If it prints `Failed to load extension`, EXT does not load. Stop and fix the extension.

Do not default to `openai-codex/*` models; they are not available here.

## Drive

```bash
# all 5 scenarios, serial, default model for parent+child, this repo's extension
node .claude/skills/verify-pi-subagents/scripts/drive.mjs
# pick scenarios / repeat / target another checkout
RUNS=3 node .claude/skills/verify-pi-subagents/scripts/drive.mjs parallel4 parallel6
EXT=/tmp/pi-subagents-baseline/extensions/subagents/index.ts PARENT_MODEL=… CHILD_MODEL=… VERIFY_OUT=/tmp/verify-pi-subagents/baseline-<slug> node …/drive.mjs
```

Env: `EXT`, `PARENT_MODEL` / `CHILD_MODEL` (default `opencode-go/deepseek-v4.1-flash`), `VERIFY_OUT`, `RUNS` (default 1), `CONCURRENCY` (default 1; keep it at 1 for timing work), `THINKING` (parent, default `low`), `TIMEOUT_MS`, `HIDE_TOOLS`, `PI_BIN`, `PI_AGENT_DIR`.

The prompts are capability-neutral. They state the goal ("start 4 children at once, then collect all results") and only the spawn fields that every version has (`harness`, `model`, `reasoning_effort`). The parent then uses whatever the loaded tools offer, such as `wait: true`, batch spawn, or wait-for-first. So the same scenario measures both old and new code. Parent compliance is probabilistic: read `toolCalls` before blaming the product.

| Scenario | Goal given to the parent | ok when |
| --- | --- | --- |
| `single` | spawn one child that reads `math.js`, wait, report what `add` returns | exit 0, child done, answer mentions `a + b`/sum |
| `wait` | same, "in as few tool calls as possible" | same |
| `parallel4` / `parallel6` | start N children at once; each runs `sleep 8 && touch .marks/child-i` and replies with i; collect all | N children seen done and N marker files |
| `workflow` | msg1: prepare the fixed `flow({tasks:[A sleep 2, B sleep 25, C needs A sleep 10]})` draft (readOnly, pinned to `CHILD_MODEL`, effort low); msg2: approve, poll `workflow_check`, report | run journal says completed, all 3 tasks completed |

## Compare

```bash
node .claude/skills/verify-pi-subagents/scripts/compare.mjs <baselineDir> <afterDir>
```

Either argument can be a single drive output or a `VERIFY_OUT` dir that holds several timestamped drives. For each parent model and scenario, compare.mjs takes the median over passing records (or over all records if none passed) and prints before, after, the delta, and the % change. Records run with `HIDE_TOOLS` are grouped separately.

## Evidence

Evidence lives at `${VERIFY_OUT:-$TMPDIR/verify-pi-subagents}/<ISO-timestamp>/`, and the path is printed as the last line, after a compact table. It holds:

- `summary.json`, with one record per scenario run. All times are ms since the `pi` launch unless noted.
  - `ok`, `exit`, `wallMs`, `parentTurns` (assistant messages), `toolCalls` (by name), `toolCallsTotal`, `parentTokens` (input/output/cacheRead/cacheWrite/cost).
  - `firstSpawnCallMs`.
  - `firstResultMs` / `lastResultMs`: when the parent first saw each child terminal, from any `subagent_*` tool result or a pushed parent message. `childTimes` is filled when tool details expose epoch `startedAt`/`settledAt`/… .
  - Parallel: `sleepDoneMs[]`, `firstSleepDoneMs`, `lastSleepDoneMs`, taken from the `.marks/child-i` file mtimes. They show when each child actually finished its sleep, independent of what the parent observed. A queued child shows up as a later cluster.
  - Workflow: `workflow.{draftId, preparedMs, approvedMs, runId, checkCalls, runStatus}`. Also `runWallMs` (WorkflowStarted→terminal), `approveToTerminalMs`, `tasks.{A,B,C}.{queuedMs,startMs,finishMs}` (ms after WorkflowStarted), and `cStartAfterAFinishMs` / `cStartAfterBFinishMs`. These come from the run journal at `~/.pi/agent/workflows/runs/project-*/<runId>/journal*`, with the last `workflow_check` attempts as a cross-check. A level barrier shows up as `cStartAfterBFinishMs ≈ 0`.
- `<run>-<scenario>/events.jsonl`: raw pi events, each with `t`.
- `<run>-<scenario>/command.json`: the exact argv.
- `<run>-<scenario>/stderr.txt`.
- `<run>-<scenario>/proj/`.

The parent's `wallMs` in `workflow` includes however long the parent chooses to sleep between checks. Use `runWallMs` and the task offsets for scheduler speed.

## Cleanup

Nothing long-lived is started. Workflow runs leave journals under `~/.pi/agent/workflows/runs/project-<hash of scratch dir>/`. They are harmless; delete those dirs together with the evidence dir if you want. If a run was killed, check `pgrep -fl "extensions/subagents/index.ts"` and kill only PIDs whose cwd is under the evidence dir.

## Features

See [features/README.md](features/README.md).

## Findings log

- 2026-09-27 (historical: Jev gates, `jev-probe.ts`, and the gated scenarios were removed with the product's Jev/gate feature): Jev p50 was 130 ms, under 3% of wall time. The gate envelope bug (missing `operations`) was fixed before the removal.
- A `-ne` harness artifact adds about 1 s between the spawn tool result and the next parent turn: the first child compiles the global extensions and skills (`DefaultResourceLoader.reload`), and later children take about 15 ms.
- Per-turn breakdown (2026-09-27): each parent LLM turn takes 1.5–8 s. A child usually finishes while the parent is still composing its wait call. The main lever is the number of parent turns. `subagent_spawn` `wait: true` cuts spawn→wait→inspect from 4 turns to 2.
- 2026-10-01 baseline (`ef43a6f`):
  - With `opencode-go/deepseek-v4.1-flash` as the parent, every request returns `400` while the extension is loaded. The cause is the top-level `Type.Union` parameter schemas of `workflow` and `workflow_control`.
  - Opus once sent a mis-shaped first `workflow` call against the same union and recovered on retry.
  - The workflow level barrier is visible: C (needs A only) is queued within ~15 ms of B finishing, not A.
