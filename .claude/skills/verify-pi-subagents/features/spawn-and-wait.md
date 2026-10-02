# Spawn and wait

One child is spawned and its report reaches the parent. The `single` scenario lets the parent choose the tool sequence. The `wait` scenario asks for as few tool calls as possible.

## Behaviors

- **SW-1:** the child reaches `done`, and the parent's final text states that `add` returns `a + b` (or the sum).
- **SW-2:** in `wait`, the parent uses a single blocking call (`subagent_spawn` with `wait: true` in both baseline and current code). `toolCallsTotal` is 1 and `parentTurns` is 2.

## Drive

```bash
node .claude/skills/verify-pi-subagents/scripts/drive.mjs single wait
```

## Proof

In `summary.json`, check `ok: true`, `childrenDone ≥ 1`, `toolCalls`, `parentTurns`, and `firstResultMs` (when the child's terminal result first reached the parent).

## Gotchas

- Models often pick `wait: true` even in `single`. That is allowed. Compare `toolCalls` before you compare wall time.
- Model latency drifts between batches. Compare runs from the same hour, or use `RUNS≥3` and medians.
