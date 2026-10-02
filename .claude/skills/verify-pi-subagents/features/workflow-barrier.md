# Workflow scheduling (level barrier)

A fixed 3-task `flow()` graph: A (`sleep 2`), B (`sleep 25`), C needs A (`sleep 10`). All tasks are `readOnly: true`, `harness: "pi"`, pinned to `CHILD_MODEL`, and `effort: "low"`. Message 1 prepares the draft. Message 2 approves it and polls `workflow_check`.

## Behaviors

- **WF-1:** the draft is prepared in message 1, and approval succeeds in message 2 (approval requires a newer user input). The run completes with A, B, and C completed.
- **WF-2 (barrier):** with a level barrier, C starts only after B finishes: `cStartAfterBFinishMs ≈ 0`, `C.startMs ≈ 28 s`, `runWallMs ≈ 42 s`. Without the barrier, C starts right after A (`cStartAfterAFinishMs ≈ 0`, `C.startMs ≈ 5 s`), and `runWallMs` is bounded by B (about 29 s).

## Drive

```bash
node .claude/skills/verify-pi-subagents/scripts/drive.mjs workflow
```

## Proof

`summary.json` → `workflow.tasks.{A,B,C}`, `runWallMs`, `cStartAfterAFinishMs`, `cStartAfterBFinishMs`, and `journal` (the path of the raw run journal).

## Gotchas

- The parent's `wallMs` mostly reflects how long it sleeps between checks. Judge scheduling by the journal offsets.
- Providers that reject top-level `anyOf` tool schemas (opencode-go/deepseek) cannot use the `workflow` tool at all, and every request 400s while it is registered.
