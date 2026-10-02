# pi-subagents

Unified Pi package for direct subagents and declarative workflows. One `SubagentManager` owns Pi/Codex child execution, queueing, lifecycle, transcripts, cancellation, and result delivery. `WorkflowManager` owns approved task graphs and schedules workflow children through that same queue.

## Install locally

```sh
pi install /Users/yesh/code/personal/pi-subagents
```

Reload an existing Pi session with `/reload`.

## Direct subagents

Tools:

- `subagent_spawn` — one task, or a `tasks` array of 1–16 independent tasks admitted together with per-task ids and failures; with `tasks`, top-level `harness`/`model`/`reasoning_effort`/`working_dir`/`classification` are shared defaults (a task's own value wins); pass `wait: true` (with optional `wait_mode`) to return results in the same call
- `subagent_route` and `subagent_approve` — prepare and approve exact preference-routed batches
- `subagent_wait` — `mode: "all"` (default) waits for every id; `mode: "any"` returns once at least one child has a new result (or asks a question), with that result and the still-running ids. `any` never returns a result already delivered by an earlier wait or automatic delivery
- `subagent_cancel`
- `subagent_send`
- `subagent_inspect` (`subagent_check` remains a compatibility alias)
- `subagent_list`

Commands:

- `/subagents` — compact fleet view, transcript inspection, and takeover for parent-owned subagents
- `/subagents-settings` — inspect effective routing settings
- `/subagents-settings global edit` or `project edit` — validate and atomically save one explicit settings scope

`Ctrl+Shift+A` toggles the fleet view. Workflow children are inspectable there but remain read-only; workflow lifecycle changes go through `workflow_control`.

`subagent_send({ id, message, mode?, requestId? })` sends another instruction. `mode` is `auto`, `steer`, `follow_up`, or `reply`; reply requires the exact `requestId` from a pending Pi child `ask_parent` question. `steer` cancels that question, while `follow_up` queues later work and is never an answer. Explicit steering fails on a harness that does not support it, while `auto` selects the effective supported mode. Queued children remain unavailable for sending.

`subagent_inspect({ id })` returns a bounded, read-only snapshot of current tools, pending `ask_parent` question/request ID/deadline, last activity, queued instruction previews, completed operations, latest output, and harness capabilities. It never waits for or consumes completion.

At most `maxRunning` children run at once across all harnesses (`subagents.json`, integer 1–32, default 6; a trusted project file may only lower the global value). Excess work queues FIFO per owner, and owners — the parent session and each workflow run — take turns for free slots, so one large workflow cannot starve direct spawns. A changed cap applies to new sessions. With routing enabled, a batch whose every task uses its saved route unchanged under `approval: "auto"` starts immediately; otherwise the batch returns one proposal for `subagent_approve`.

Preference routing remains disabled until `routing.enabled` is set. Routing uses explicit assignment classifications and prepares bound proposals before preference-derived runtimes can start. Simple validation has its own configurable route; documented alternatives are `opencode-go/deepseek-v4-flash` and `openai-codex/gpt-5.6-luna`, but the package selects or installs neither. The package does not write personal settings unless `/subagents-settings … edit` is explicitly used.

## Workflows

Tools:

- `workflow` — prepare an immutable draft or execute its exact ID after a later user approval
- `workflow_list` — list current and recovered runs
- `workflow_check` — inspect and consume one terminal aggregate; `wait: true` (optional `timeout_s`) blocks until the run is terminal instead of polling
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
