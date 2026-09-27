# Jev service

The configured Jev credential reaches `api.typesafe.ai`, returns correct verdicts, and answers well within `jev.timeoutMs`.

## Behaviors

- **JV-1 reachable:** evaluation returns `ok: true` with `actualModel` equal to the configured model.
- **JV-2 discriminates:** a report with concrete test evidence gets `pass`, and "probably fixed, didn't run anything" gets `reject`.
- **JV-3 latency:** the max latency leaves positive headroom under the global `jev.timeoutMs`, currently 1000 ms.

## User entry points

- Indirectly through every gate. Directly through the `ask_jev` tool, which this recipe does not drive.

## Drive

```bash
node --experimental-strip-types .claude/skills/verify-pi-subagents/scripts/jev-probe.ts 3
```

## Proof

- Stdout shows `PASS good …` / `PASS bad …` lines and `latency p50=… max=… headroom=…`.
- Exit code 0.

## Gotchas

- This probe is a real network call billed to the credential. It sends only synthetic state.
- A second argument overrides the timeout (`… jev-probe.ts 3 250`) to test how tight `timeoutMs` can go.
