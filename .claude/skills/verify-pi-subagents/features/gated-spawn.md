# Gated spawn

A child's result is delivered only after a Jev gate judges it, and the parent sees a compact `passed`/`rejected` verdict.

## Behaviors

- **GS-1 pass:** a child that reads `math.js` and answers correctly gets `acceptance.status = "pass"`.
- **GS-2 reject:** a child that answers `maybe` without reading gets `acceptance.status = "reject"`, with the reason "Jev gate predicate was not satisfied."
- **GS-3 compact delivery:** the `subagent_wait` text carries only the verdict plus "Full report retained; retrieve it with subagent_inspect", with no report body.
- **GS-4 evidence carries operations:** the gate question "…based on actually reading the file?" passes only because the envelope includes the child's `read` operation.

## User entry points

- A `subagent_spawn` call with a `gate` object. This recipe drives it.
- A `subagent_route` task with a `gate`. Not driven here; see the README's uncovered list.

## Drive

```bash
node .claude/skills/verify-pi-subagents/scripts/drive.mjs pass reject
```

Observable results: the `PASS pass … acceptance=pass` and `PASS reject … acceptance=reject` lines, and exit code 0.

## Proof

In `summary.json`:

- For each scenario, `acceptance` matches `expected`.
- `waitText` starts with `## sa-1 "gate-…" passed acceptance` or `rejected acceptance`.
- `childReport` shows `Acceptance: …` and `Last completed: read (ok)` for the pass case.

In `events.jsonl`, the `tool_execution_start` for `subagent_spawn` has the `gate` args. That is the initiating action.

## Gotchas

- If the parent's routing is on (the global default here), spawn returns a proposal and never runs. The scratch overlay plus `-a` prevents that.
- A gate question about process ("did it run/read …") depends on GS-4. If a regression drops `operations` from the envelope, GS-1 flips to reject while GS-2 still passes. Always run both.
- Jev errors (`timeout`, `unauthorized`) surface as `acceptance=error`. Run the doctor probe before blaming the product.
