# Parallel spawn and the concurrency cap

N independent children are started "at once", and each runs `sleep 8 && touch .marks/child-i`. `parallel4` fits the baseline cap (`MAX_RUNNING = 4`). `parallel6` exceeds it, so on the baseline 2 children queue until a slot frees.

## Behaviors

- **PS-1:** all N children reach `done`, and N marker files exist.
- **PS-2 (cap):** `sleepDoneMs` forms one cluster when N ≤ cap. When N > cap, a second cluster lands about 8 s or more later. With a cap ≥ 6, `parallel6` should show one cluster.
- **PS-3 (delivery):** `firstResultMs` vs `lastResultMs` shows whether the parent sees results incrementally (wait-for-first) or all at once (wait-for-all, where first = last).
- **PS-4 (spawn cost):** `toolCalls.subagent_spawn` is N for one-per-call spawning and 1 for batch spawn.

## Drive

```bash
node .claude/skills/verify-pi-subagents/scripts/drive.mjs parallel4 parallel6
```

## Proof

In `summary.json`, check `ok`, `sleepDoneMs`, `firstResultMs`/`lastResultMs`, `toolCalls`, `parentTurns`, and `wallMs`.

## Gotchas

- Marker mtimes measure when each child's bash command finished. They do not include the child's final reply turn, so they are a lower bound on child completion.
- If the parent spawns sequentially with `wait: true`, the children run serially and `sleepDoneMs` is spaced about 8 s apart. That is a parent choice, not a product bug. Check `toolCalls`.
