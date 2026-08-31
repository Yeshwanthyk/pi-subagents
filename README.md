# pi-subagents

Unified Pi package for direct subagents and declarative workflows. One `SubagentManager` owns Pi/Codex child execution, queueing, lifecycle, transcripts, cancellation, and result delivery. `WorkflowManager` owns approved task graphs and schedules workflow children through that same queue.

## Install locally

```sh
pi install /Users/yesh/code/personal/pi-subagents
```

Reload an existing Pi session with `/reload`.

## Direct subagents

Tools:

- `subagent_spawn`
- `subagent_wait`
- `subagent_cancel`
- `subagent_check`
- `subagent_list`

Command:

- `/subagents` — compact fleet view, transcript inspection, and takeover for parent-owned subagents

`Ctrl+Shift+A` toggles the fleet view. Workflow children are inspectable there but remain read-only; workflow lifecycle changes go through `workflow_control`.

## Workflows

Tools:

- `workflow` — prepare an immutable draft or execute its exact ID after a later user approval
- `workflow_list` — list current and recovered runs
- `workflow_check` — inspect and consume one terminal aggregate
- `workflow_control` — pause, resume, cancel, retry, or skip through workflow authority

Interactive TUI:

- `/workflows` opens the workflow inspector; `/workflows <runId>` focuses a run.
- `Ctrl+Shift+Z` toggles the same inspector from anywhere in the TUI.
- Select a run, inspect its task graph, and press `Enter` on a live child for a read-only transcript view.

A workflow is a declarative `flow({ tasks })` graph. Tasks declare dependencies and either `readOnly: true` or explicit owned paths. The scheduler derives safe parallelism; `SubagentManager` alone owns global execution capacity.

Workflow guarantees:

- preparation never executes;
- approval requires the exact immutable draft on a later response in the same session and project;
- dependency handoffs are explicit, bounded, and transcript-free;
- background completion uses the existing bounded parent mailbox;
- pause blocks new admissions while running children continue;
- retry is attempt-identified and bounded by declared provider/backend failure policy;
- run journals are atomic, bounded, project-isolated, and contain no child transcript copies;
- after a process restart, nonterminal journals are reported as orphaned/interrupted and are never falsely resumed.

Saved definitions are discovered, in precedence order, from:

1. `<project>/.pi/workflows/*.js`
2. `<project>/.agents/workflows/*.js`
3. `~/.pi/agent/workflows/*.js`

These are the same discovery locations used by `pi-workflows`, but the definition format changed. Legacy imperative scripts using `agent()`, `phase()`, `parallel()`, or `pipeline()` must be rewritten as one declarative `flow({ tasks })` graph. Definitions are snapshotted into immutable drafts before approval.

## Migration from `pi-workflows`

Only this package should be active after cutover; loading both packages creates duplicate workflow tool names.

1. Install or update `pi-subagents`.
2. Disable/remove `git:github.com/Yeshwanthyk/pi-workflows` in Pi package settings.
3. Restart or reload Pi.
4. Confirm direct subagent and workflow canaries.

Active runs are intentionally not migrated because native child sessions cannot be resumed safely across extension ownership or process restart. A legacy artifact that still says `running` is frozen historical state, not a resumable or currently running workflow.

Historical `pi-workflows` runs remain frozen and readable at:

```text
~/.pi/agent/workflows/<runId>/
```

The legacy `workflow.json`, `result.json`, `script.js`, and transcript artifacts are not rewritten or deleted. New project-isolated journals live under the separate `~/.pi/agent/workflows/runs/` namespace.

The unified package keeps `/workflows` as the interactive TUI inspector (and `/workflow-draft` / `/workflow-saved` for local inspection). The agent-facing API is `workflow_list`, `workflow_check`, and `workflow_control`; legacy `workflow_cancel` is replaced by `workflow_control`.

Rollback requires restoring a pre-workflow `pi-subagents` revision for direct subagents and re-enabling `pi-workflows`, then restarting Pi. Do not load a unified `pi-subagents` revision and `pi-workflows` simultaneously.

## Extension client API

Extensions can launch client-owned managed subagents through the versioned `subagents:client:*` event protocol. Channels are `ping`, `spawn`, `cancel`, `list`, `ready`, and `settled`. Client-owned jobs retain API dedupe/list/cancel access and settlement events, but are omitted from parent tools and `/subagents` rather than delivered into the parent conversation.

## Development

```sh
npm install
npm run check
npm test
npm run format:check
```

Live Codex tests are separate because they use an authenticated external harness:

```sh
npm run test:live
```

## Provenance and licensing

See [`NOTICE.md`](NOTICE.md). The upstream repository did not declare a license at the extracted revision. This repository is licensed under MIT; see [`LICENSE`](LICENSE).
