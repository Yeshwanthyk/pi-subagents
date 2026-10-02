# pi-subagents feature map (CLI slice)

**Baseline.** Follow `../SKILL.md` for Launch and Doctor: a scratch project with routing disabled via a trusted `.pi/subagents.json`, `-a`, `--no-session`, and the extension at `$EXT` loaded with `-ne -e`.

**Driving.** `scripts/drive.mjs <scenario…>` drives a real parent model, serially by default. Parent compliance is probabilistic. If `toolCalls` shows the parent never called the expected tool, that is a model miss and not a product failure, so re-run it. `scripts/compare.mjs <before> <after>` compares two evidence trees.

**Evidence and cleanup.** See `../SKILL.md`. Evidence dirs are kept, and workflow journals land under `~/.pi/agent/workflows/runs/`.

| Feature | Covers | Recipe |
| --- | --- | --- |
| Spawn and wait | one child → report delivered; fewest-calls variant (`single`, `wait`) | [spawn-and-wait.md](spawn-and-wait.md) |
| Parallel spawn | 4/6 concurrent children, cap/queueing, first vs last result (`parallel4`, `parallel6`) | [parallel-spawn.md](parallel-spawn.md) |
| Workflow scheduling | prepare → approve in a later message → run; level-barrier timing (`workflow`) | [workflow-barrier.md](workflow-barrier.md) |

## Not covered (no recipe yet)

- Routed spawn with approval (`subagent_route` / `subagent_approve`). This needs an interactive user turn, so use a TUI/PTY drive.
- Workflow controls (pause/resume/retry/skip/cancel) and workflow `consumes` handoffs.
- `/subagents-settings`, `/subagents` TUI, the activity rail, child→parent questions, and takeover.
