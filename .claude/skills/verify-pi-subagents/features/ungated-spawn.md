# Ungated spawn

A child spawned without a gate delivers its report directly through `subagent_wait`.

## Behaviors

- **US-1:** `subagent_wait` returns `status=done` with no `acceptance` field, and the text contains the child's answer.
- **US-2 timing control:** its `spawnToWaitEndMs` is the baseline for estimating gate overhead in gated runs.

## User entry points

- `subagent_spawn` with an explicit `harness` while routing is disabled.

## Drive

```bash
node .claude/skills/verify-pi-subagents/scripts/drive.mjs ungated
```

## Proof

In `summary.json` for `ungated`:

- `ok: true` and `acceptance` absent.
- `waitText` includes "sum" or equivalent.
- `events.jsonl` has the spawn call, then the wait result.

## Gotchas

- Run it in the same batch as the gated scenarios when you compare timing. Model latency drifts a lot between batches.
