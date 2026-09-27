# pi-subagents feature map (CLI slice)

**Baseline.** Follow `../SKILL.md` for Launch and Doctor: a scratch project with routing disabled via a trusted `.pi/subagents.json`, `-a`, `--no-session`, and the repo extension loaded with `-ne -e`. The Jev credential comes from `TYPESAFE_API_KEY` or `~/.pi/agent/jev-credentials.json`.

**Driving.** `scripts/drive.mjs <scenario…>` drives a real parent model. Parent compliance is probabilistic. If `toSpawnCallMs` is missing, the parent never called the tool, which is a harness or model miss and not a product failure. Re-run it.

**Evidence and cleanup.** See `../SKILL.md`. Evidence dirs are kept, and nothing else persists.

| Feature | Covers | Recipe |
| --- | --- | --- |
| Gated spawn | spawn → child run → Jev gate → compact pass/reject delivery → inspect | [gated-spawn.md](gated-spawn.md) |
| Spawn wait | `subagent_spawn` with `wait: true` → gated result in the same call, 2 parent turns (`drive.mjs wait`) | [gated-spawn.md](gated-spawn.md) |
| Ungated spawn | spawn → wait returns report directly | [ungated-spawn.md](ungated-spawn.md) |
| Jev service | live Jev reachability, verdict quality, latency vs timeout | [jev-service.md](jev-service.md) |

## Not covered (no recipe yet)

- Routed spawn with approval (`subagent_route` / `subagent_approve`). This needs an interactive user turn, so use a TUI/PTY drive. Routed `approval: "auto"` is unit-tested only: a project overlay may not loosen the global policy, so a scratch project can't enable it while the global setting is `ask`.
- The `ask_jev` parent tool as called by a model. `jev-probe.ts` exercises the same client but not the tool wrapper.
- Workflow `flow()` evaluation tasks and workflow gates.
- `/subagents-settings`, `/subagents` TUI, the activity rail, child→parent questions, and takeover.
