# Jev integration scout for `pi-subagents`

**Scope:** local repository only (`/Users/yesh/code/personal/pi-subagents`). Research only; no application files were changed. I found no existing `Jev`, structured-verdict, or scoring implementation in the repository.

## Executive finding

The safest first integration is an **opt-in, post-child workflow gate** owned by `WorkflowManager`, not a new backend and not executable workflow source. The precise lifecycle seam is after the owned child has a stable terminal `done` snapshot, but before `execution.results.set(...)` and `completeTask(...)` in `extensions/subagents/src/workflows/manager.ts:1508-1602` (especially `1576-1601`). A gate pass would be the condition that turns process success into workflow task completion. A reject, malformed result, script error, or timeout must not write a result or emit `TaskCompleted`; therefore it cannot unlock dependants.

A typed Jev/script task is a larger boundary. The current workflow source is deliberately a static AST-to-data decoder and explicitly cannot execute identifiers, imports, calls, filesystem/network/process/timer access, or imperative scheduling (`extensions/subagents/src/workflows/sandbox.ts:1-1,123-204`). The minimal safe shape is an allowlisted script/gate ID plus typed input/output policy, not inline executable Jev code. Any user-visible gate/script choice must be part of the reviewed immutable definition and execution digest.

## Actual lifecycle and ownership

1. **Preparation is not execution.** `WorkflowToolLifecycle.prepare` decodes source/spec, validates the graph, and persists a draft; it creates no run or child (`extensions/subagents/src/workflows/tools.ts:143-191`). The tool contract says the source is static data, preparation never starts a child, and approval is a later exact-draft action (`extensions/subagents/src/workflows/prompt.ts:81-105`).
2. **Approval is a provenance boundary.** Approval loads the persisted draft, requires exact equality with the process-memory draft, enforces same session/project and a newer user input, then creates/starts the run (`extensions/subagents/src/workflows/tools.ts:194-223`; `extensions/subagents/src/workflows/drafts.ts:351-383`). The draft hashes the complete definition/source/args/background (`extensions/subagents/src/workflows/provenance.ts:30-68`; `extensions/subagents/src/workflows/drafts.ts:220-256,287-308`).
3. **Graph validation owns dependencies and scopes.** `needs` must name transitive dependencies for `consumes`; overlapping writers require dependency order, and the validated graph is frozen/indexed (`extensions/subagents/src/workflows/graph.ts:607-730`). Tasks currently have only kinds `scout|writer|proof|review|repair` and exactly one read-only or owned-path scope (`extensions/subagents/src/workflows/domain.ts:7-17,24-44`).
4. **Scheduling is authoritative.** A dependency is eligible only when its task status is `completed`; queued/running tasks retain active ownership, including before shared-manager admission (`extensions/subagents/src/workflows/scheduler.ts:595-651`). This is the existing protection Jev must not bypass.
5. **Admission and child correlation are owner-checked.** The workflow executor is a narrow seam: spawn, admission/settlement observation, owner-safe observation, and cancel (`extensions/subagents/src/workflows/manager.ts:47-89`). The manager requires workflow delivery to carry `WorkflowOwnership` and places it on a private result lane (`extensions/subagents/src/manager.ts:731-804`).
6. **Fast-child race is already handled.** The manager publishes `TaskQueued` before owner observation so a fast settlement cannot skip the queue edge (`extensions/subagents/src/workflows/manager.ts:1219-1238`). Settlement validates terminal status, run/task/attempt ownership, and child error before normal completion (`extensions/subagents/src/workflows/manager.ts:1508-1573`).
7. **Current completion boundary.** For a child with `status === "done"`, the manager starts a very fast queued task if necessary, verifies `running`, truncates final text to 4 KiB, stores an in-memory completed result, then appends `TaskCompleted` (`extensions/subagents/src/workflows/manager.ts:1576-1601`). The reducer changes `running -> completed` and only then unlocks ready dependants (`extensions/subagents/src/workflows/reducer.ts:673-707`).
8. **Journal publication precedes runtime cleanup/publication.** `WorkflowManager.append` bounds/reduces the event, persists the candidate journal before mutating state/listeners, and only then resolves/wakes execution and begins terminal cleanup (`extensions/subagents/src/workflows/manager.ts:402-449`). On terminal workflow state, the extension creates one bounded parent-visible workflow envelope; workflow children are explicitly excluded from normal parent/client settlement channels (`extensions/subagents/index.ts:767-817`; `extensions/subagents/src/workflows/projection.ts:649-685`).
9. **Direct child settlement has its own exact-once semantics.** `SubagentManager` settles once, ignores late events, releases a slot, drains queued work, then calls its settlement hook (`extensions/subagents/src/manager.ts:457-510`). Workflow children remain in the workflow lane and are not duplicated into parent output (`extensions/subagents/index.ts:798-817`).

## Needs, consumes, approval, digest, and publication

- `needs` controls ordering/readiness. `consumes` is a separate explicit handoff allowlist; results are never inferred from arbitrary dependency transcripts (`extensions/subagents/src/workflows/prompt.ts:96-104`; `extensions/subagents/src/workflows/graph.ts:645-658`).
- `buildTaskHandoff` fails closed for missing/non-completed dependencies, sanitizes data, rejects unsafe object shapes, and bounds each entry and the aggregate (`extensions/subagents/src/workflows/handoff.ts:1-22,871-940`). However, `CompletedHandoffResult.output` and `.result` are currently `unknown` (`extensions/subagents/src/workflows/handoff.ts:53-72`), so this is bounded but not a typed Jev contract.
- The journal’s `TaskCompleted` payload is only a bounded string `resultPreview`; task failures carry only the current retry classifications (`extensions/subagents/src/workflows/events.ts:7-15,47-59,266-292`; `extensions/subagents/src/workflows/artifacts.ts:353-433`). A structured verdict would need a separate validated type and, if it must survive/replay, a bounded journal representation.
- Review approval is stronger than a normal config check: persisted and in-memory drafts must be byte-equivalent; source provenance, definition, args, and background are checked by digest; session, project, and newer user response are required (`extensions/subagents/src/workflows/drafts.ts:220-256,351-383`). Do not inject a user-selectable gate after approval through `WorkflowExecutionOptions`; that would execute something the reviewed digest did not cover.
- Approval starts detached scheduling and returns the run immediately (`extensions/subagents/src/workflows/tools.ts:209-223`; `extensions/subagents/src/workflows/prompt.ts:102-105`). The parent sees an aggregate only at workflow terminal state, not child results.

## Persistence, recovery, cancellation, and retry authority

- Workflow journals are private, bounded, strictly parsed, and atomically replaced: serialization bounds are checked, a private temp file is fsynced, renamed, and the directory is best-effort fsynced (`extensions/subagents/src/workflows/artifacts.ts:913-1010`). State publication follows persistence (`extensions/subagents/src/workflows/manager.ts:402-449`).
- Recovery never resumes children. A nonterminal journal receives one bounded `WorkflowFailed(recovery: "orphaned")`; the recovery code has no child executor and cannot resume/cancel native sessions (`extensions/subagents/src/workflows/recovery.ts:126-131,180-257`). Session shutdown seals/cancels workflows while the shared runtime still exists, then disposes it (`extensions/subagents/index.ts:865-899`).
- Cancellation is fail-closed and bounded: the manager interrupts children with a deadline, settles locally if acknowledgements do not arrive, ignores late events, and waits for admission/cancellation/cleanup barriers (`extensions/subagents/src/manager.ts:836-926`; `extensions/subagents/src/workflows/manager.ts:1618-1641,1713-1734`).
- **Important async-gate consequence:** settlement is detached and its observation released before `reconcileSettlement` runs (`extensions/subagents/src/workflows/manager.ts:1438-1446,1665-1672`). A gate that only consumes the projected bounded snapshot is safe. An async gate that needs live child ownership must either move before release or add explicit in-flight gate tracking to cancellation/cleanup; current `waitForCancellation` does not know about gates.
- Automatic retry is intentionally narrow: only configured `provider_stall` or `backend_failure` classifications can be automatic; explicit controls create a fresh attempt identity and remain the operator authority (`extensions/subagents/src/workflows/controls.ts:15-46`; `extensions/subagents/src/workflows/prompt.ts:113-115`; `extensions/subagents/src/workflows/manager.ts:1029-1099`). A Jev semantic reject must not be mislabeled `backend_failure`.

## Runtime and settings extension seams

- The workflow extension is constructed with one shared `SubagentManager`, a private `WorkflowArtifactStore`, `WorkflowManager`, static preparer, and controls (`extensions/subagents/index.ts:502-555`). Approval captures cwd, parent reference, project trust, inherited model/thinking level, and model registry (`extensions/subagents/index.ts:557-581`).
- The child Pi backend creates a real SDK child session using the task cwd and `SettingsManager.create(cwd, agentDir, { projectTrusted })`, reloads resources, and excludes subagent/workflow/control/user-interaction tools (`extensions/subagents/src/backends/pi.ts:134-145,391-411`). This is the concrete settings seam in this repository. There is no Jev setting, registry, script runner, or package dependency in `package.json:10-58`.
- Codex is separately headless/approval-denied and has bounded interrupt/kill-tree behavior (`extensions/subagents/src/backends/codex.ts:1019-1024,1148-1157,1227-1293`). A Jev gate should not inherit backend-specific approval assumptions accidentally.
- The narrowest testable insertion point is `WorkflowExecutionOptions` (`extensions/subagents/src/workflows/manager.ts:79-90`) with an optional gate registry/runner, then the post-terminal/pre-`results.set` block in `reconcileSettlement`. A script task that is not a child-agent task would need a new executor seam rather than pretending to be a backend; the current `WorkflowChildExecutor` contract is explicitly child-oriented (`extensions/subagents/src/workflows/manager.ts:47-69`).

## Safe minimal designs

### A. Post-child Jev gate (recommended first slice)

1. Add an opt-in, trusted/allowlisted `gateId` and typed policy to the immutable task/definition data, and include it in graph validation, draft preview, persisted draft, provenance, and `workflowExecutionSha256`. Do not use an approval-time-only closure or ambient setting for a user-selected gate.
2. Inject a `WorkflowGate` through the execution seam. Give it only the bounded `WorkflowChildSnapshot` (already projected to 4 KiB), validated task metadata, and attempt ID. Prefer a synchronous/pure local adapter first; it consumes no manager slot and avoids cancellation races.
3. Return a closed typed union, for example: `pass { verdict: JevVerdict }`, `reject { classification, reason }`, and `error { kind: gate_failure|gate_timeout, reason }`. Validate exact keys, finite bounded numbers, enumerated strings, maximum depth/nodes/bytes, and scrub secrets/native paths. Do not pass the raw child snapshot, transcript, session file, or arbitrary object to Jev.
4. On `pass`, store only the bounded typed result (plus the existing text preview if needed), then call `completeTask`. On reject/error/timeout, do not populate `execution.results` and do not call `completeTask`; record a separate gate failure/rejection outcome. This preserves the existing reducer boundary: no `TaskCompleted`, no `unlockReadyTasks`, and no downstream `consumes` handoff until the gate passes.
5. Keep retry authority in `WorkflowManager`/`WorkflowControls`. A semantic reject is not a provider/backend failure and should not auto-retry by default. If automatic retry is later supported, add explicit gate failure/timeout classifications and policy through the existing validated retry path; never let the script call retry or mutate the journal.
6. If the verdict is needed after restart or for later typed `consumes`, persist a bounded gate result/event and validate it in `events.ts`, `artifacts.ts`, and the reducer. Otherwise keep it runtime-only and accept the existing recovery rule that nonterminal work is orphaned rather than rerun. Do not persist full child output.

### B. Typed Jev/script workflow task

The least risky variant is an **allowlisted script ID + schema/policy metadata**, run by a dedicated bounded executor, not arbitrary inline source. A true new task kind would cross the current fixed kind union (`extensions/subagents/src/workflows/domain.ts:7-17`) and must also update graph validation, scheduler ownership, event/reducer transitions, artifact parsing, recovery, controls, and tests. If it has side effects, it needs a separate capacity/cancellation/persistence model rather than being hidden behind `WorkflowChildExecutor`.

The existing static source surface must remain declarative. Do not weaken the AST decoder or add a VM to `sandbox.ts`; that would reverse its explicit security contract (`extensions/subagents/src/workflows/sandbox.ts:180-204`). If inline script text is ever allowed, it needs a separately reviewed/signed registry or isolated process contract with a source digest, JSON-only IPC, strict CPU/wall-clock/output bounds, and explicit filesystem/network policy. The source, script ID/version, schemas, and policy must all be visible in the approval digest.

## Invariants Jev must preserve

- **Process success is not gate success.** Child `done` means the process completed; only gate `pass` means the workflow task completed.
- **No premature dependency release.** `TaskCompleted` is the sole release edge; no result map entry or downstream handoff before it.
- **Attempt authority.** Only the current run/task/attempt owner may gate or complete; stale settlements and late gate results are ignored.
- **Fail closed.** Missing, malformed, unknown-key, oversized, non-finite, secret-bearing, or timed-out output never becomes a pass.
- **Bound every boundary.** Gate input, output, reason, classification, score, journal event, handoff, and aggregate parent message need independent byte/depth/count limits.
- **Retry is manager-owned.** A gate cannot self-retry; explicit retry remains operator-controlled, and automatic retry requires an explicitly configured, typed classification and fresh attempt ID.
- **Preserve approval.** Any user-controlled gate/script config is in the immutable draft and execution digest; persisted and process-memory authorities must still match exactly.
- **Persist before publish.** If a gate result is journaled, journal persistence precedes state/listener/parent publication; cleanup follows the authoritative terminal event.
- **Recovery is not implicit rerun.** Restart must not silently rerun a child or Jev script. A new attempt requires explicit approved authority unless the recovery model is deliberately expanded.
- **Workflow result lanes remain separate.** Jev must not cause workflow children or intermediate verdicts to enter normal parent/client settlement channels.

## Efficiency opportunities grounded in current code

- Gate the already projected bounded child snapshot (`manager.ts:123-161`) instead of reading transcripts or starting a second child. This adds no SubagentManager slot or backend startup.
- Reuse `execution.results`, explicit `consumes`, and the existing handoff sanitizer/bounds (`handoff.ts:871-940`); carry a small typed verdict rather than full text.
- Keep the gate opt-in and evaluate/validate its static policy at preparation/approval. Existing scheduler wave selection and disjoint-writer parallelism remain unchanged for tasks without gates.
- Reuse attempt IDs, `append`, atomic artifact replacement, and terminal cleanup rather than creating a second lifecycle. If an async runner is unavoidable, add one in-flight gate set to the same cancellation barrier instead of a parallel lifecycle.
- Preserve one parent publication: the existing terminal workflow envelope is already bounded and emitted once (`index.ts:767-772`; `projection.ts:649-685`).

## Required proof/tests before implementation

1. **Ordering:** child process `done` + gate pass emits `TaskCompleted`; a dependant becomes ready only after that event. Gate reject/error/timeout emits no completion and no dependant readiness.
2. **Outcome separation:** child process success plus semantic reject is distinguishable from provider/backend failure; no accidental automatic retry.
3. **Schema/limits:** reject unknown keys, duplicate keys, non-finite/out-of-range scores, oversized/deep/node-heavy values, secrets, native paths, transcript/session fields, and malformed JSON; verify bounded output deterministically.
4. **Attempt races:** stale settlement/gate result cannot complete a retried attempt; a retry has a fresh attempt ID; late events remain no-ops.
5. **Timeout/cancel:** gate timeout fails closed; cancellation interrupts/invalidates gate work; shutdown waits for any async gate; no late gate can publish after terminal state.
6. **Persistence:** journal replacement failure prevents state/listener publication; if verdicts are persisted, parse/fold/recovery round trips preserve the bounded schema and never rerun Jev.
7. **Approval:** changing gate/script ID, version, source, schema, args, policy, or registry digest after preparation is rejected; same-session/project/new-response rules remain enforced.
8. **Scheduling/scope:** delayed gate completion retains writer ownership; overlapping writers remain blocked; `needs`/`consumes` cannot observe a process-success result before gate pass.
9. **Publication:** exactly one aggregate parent result is emitted at workflow terminal state; workflow children and intermediate verdicts never use the normal parent lane.
10. **Baseline:** current repository verification passes: `npm test` completed with **200 passing, 0 failing**. No Jev-specific implementation or test exists yet.

## Additional requirement: shared low-ceremony classification/routing

### What the current repo already exposes

- Standalone `subagent_spawn` already accepts per-call `harness`, optional model, and reasoning effort; it does not require a named agent registration (`extensions/subagents/index.ts:1265-1331`). The underlying `SpawnTask` is similarly per-call and carries prompt/title/cwd/owner/workflow/result-delivery/model/effort, with no named-agent registry field (`extensions/subagents/src/domain.ts:115-138`).
- Workflows already select `task.definition.harness` per task and otherwise use an execution default backend (`extensions/subagents/src/workflows/manager.ts:1139-1158`; default resolution at `838-864`). The backend registry is an internal map keyed by the fixed backend union (`extensions/subagents/src/backend.ts:64-73`; `extensions/subagents/src/domain.ts:13-14`), not a user-facing named-agent catalog.
- Therefore a shared classifier/router can be low ceremony if it resolves a bounded **classification/routing hint** into an effective backend/model/effort at the existing spawn boundary. It should be metadata on the request/task, not mandatory registration of a named agent.

### Preferred resolution point: before review when configuration is user-visible

For a workflow, resolve classification/routing metadata before the existing review boundary whenever it can affect execution. Put the normalized result (or an immutable classifier ID/version plus its deterministic resolved route) into the validated definition/draft preview and the execution digest. This makes the reviewed plan say which route will run and preserves the current exact approval checks (`extensions/subagents/src/workflows/tools.ts:143-223`; `extensions/subagents/src/workflows/drafts.ts:220-256,351-383`). A classifier that silently changes backend/model after approval would violate the current “exact immutable later approval” contract.

For a standalone subagent, resolve the same metadata at `subagent_spawn` request handling, before `manager.spawn` (`extensions/subagents/index.ts:1297-1331`). Return the effective route in the existing spawn result/metadata if useful, but do not require a named registration. The two paths should share the classification schema/resolver, while keeping workflow approval and standalone request validation separate.

The safe low-ceremony shape is:

```text
classification: bounded enum/labels + optional score/confidence
route: optional explicit harness/model/effort override
resolver: pure, versioned, allowlisted policy
effective route: concrete backend/model/effort captured on the execution request
```

The resolver must be deterministic for an approved workflow. Do not let arbitrary prompt text select an unbounded provider, model, filesystem, or script. Preserve explicit per-task `harness`, model, and effort as higher-authority inputs unless the reviewed policy explicitly says otherwise; current workflow runtime already surfaces these fields (`extensions/subagents/src/workflows/domain.ts:24-35`; `extensions/subagents/src/workflows/manager.ts:1139-1158`).

### Truly runtime-dynamic graphs are a different mode

The current workflow is not runtime-dynamic: the complete graph is validated/frozen before persistence (`extensions/subagents/src/workflows/graph.ts:688-730`), source is decoded as literals only (`extensions/subagents/src/workflows/sandbox.ts:123-204`), and readiness is derived from the approved graph (`extensions/subagents/src/workflows/scheduler.ts:612-651`). A classifier may choose a route for an existing approved task, but it must not add/remove tasks, alter `needs`/`consumes`, or change ownership after review.

If future Jev output can compose a new graph at runtime, treat it as a **new approval epoch**, not as an in-place mutation: produce a bounded candidate graph and provenance/digest, pause the current run, show the candidate, and require the same immutable approval protocol before admitting it. Do not call runtime graph composition “routing.” This keeps dependency release and writer ownership tied to the graph that was actually reviewed. A runtime-generated subtask may be represented only as an explicitly designed child workflow with its own bounded journal and approval/recovery semantics; it must not bypass `TaskQueued`/`TaskStarted`/`TaskCompleted` transitions.

### Shared classification without named-agent registration

The conceptual seam is a small shared `ClassificationResolver`/`RouteResolver` capability used by both standalone spawn handling and workflow admission:

1. Normalize bounded metadata before execution.
2. Resolve to a concrete effective route from an allowlisted set.
3. Capture the route/classifier version in workflow review/digest; for standalone work, attach it to the per-call request and snapshot metadata.
4. Pass only the concrete route to existing backend selection; keep backends unaware of workflow semantics.

This reuses the existing `SpawnTask` metadata and avoids a global named-agent registry. It also leaves routing-specific preferences/settings to the routing owner, as requested; this note only identifies the integration boundary and approval implications.

### Classification is not gate outcome

Keep three concepts separate:

- **classification/routing:** pre-admission metadata used to select execution;
- **process outcome:** the existing child terminal status (`done`/`error`);
- **Jev gate outcome:** post-process verdict that permits or rejects workflow completion.

Do not overload the existing backend failure classification for any of these. The current backend classification is explicitly supplied at the backend boundary and only has `provider_stall|backend_failure` (`extensions/subagents/src/domain.ts:41-76`). A classifier may influence route selection before review; it must not make a failed process look successful, and a gate reject must not look like a backend fault.

### Additional proof required

- Standalone and workflow requests with the same classification metadata resolve to the same bounded route, without a named registration.
- An explicit reviewed task route is not silently changed by the resolver after approval.
- Changing classifier ID/version, labels, thresholds, route allowlist, or effective model after workflow preparation invalidates the draft/digest or requires a new approval epoch.
- Runtime Jev output cannot mutate the approved graph or release a dependency; dynamic composition gets a separate approval and run identity.
- A process error, a route-resolution error, and a post-child gate rejection remain distinguishable in status, journal, and retry policy.
