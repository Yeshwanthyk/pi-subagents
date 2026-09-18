# Jev and preference-based routing implementation plan

Status: planning only. Proposed APIs below are not implemented. Research: `research/jev-upstream.md`, `research/jev-integration.md`, and `research/model-routing.md`.

## Outcome

Provide one optional Jev question/answer capability, exposed as `ask_jev` and reusable inside workflows and post-run gates. Independently, provide low-ceremony assignment classification and preference-based runtime proposals for standalone subagents and workflows. No registered agent definitions are required.

The principal tradeoff: explicit labels and deterministic preferences are cheap and explainable; Jev helps classify ambiguous text but introduces remote data transmission, latency, cost, and probabilistic errors. Gate lifecycle changes are substantially more consequential than adding a tool.

## Settled contracts

- Classify assignments, not agent names. Writing research notes remains scouting. Permissions/scope are separate from classification.
- Explicit runtime fields take precedence over preferences. Never silently replace an explicitly requested model.
- Routing recommends, then asks. Existing workflow draft approval covers all task runtimes; no per-task approval ceremony.
- Dynamically composing the graph before review is supported. Runtime graph mutation, silent runtime changes, and autonomous escalation are excluded.
- Jev is optional. No Jev configuration means normal subagents, workflows, and labeled preference routing still work without network requests.
- `ask_jev` returns answers, not execution authority. Routing policy, workflow scheduling, completion, cancellation, and retries retain their existing owners.
- A requested Jev gate or evaluation step cannot be silently skipped if Jev is unavailable.
- Tests/lint establish deterministic facts. Jev may classify reports/evidence, but a generated report is not proof of correctness.
- No arbitrary shell script runner, inline executable workflow source, agent registry, model marketplace, automatic repair loops, or broad profile/rule language in v1.

## Proposed configuration and user surface

Use one extension-owned config file: `~/.pi/agent/subagents.json`; optional trusted-project override: `.pi/subagents.json`. These are NEW proposed paths, not existing files. Do not modify Pi's core settings schema.

```json
{
  "version": 1,
  "routing": {
    "enabled": true,
    "approval": "ask",
    "ambiguous": "ask",
    "unavailable": "ask",
    "routes": {
      "scout": { "harness": "pi", "model": "openai-codex/gpt-5.6-luna", "effort": "high" },
      "small_slice": { "harness": "pi", "model": "openai-codex/gpt-5.6-luna", "effort": "max" },
      "lint": { "harness": "pi", "model": "openai-codex/gpt-5.6-luna", "effort": "max" }
    }
  },
  "jev": {
    "enabled": false,
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "model": "jev-1.13.0",
    "timeoutMs": 10000,
    "maxConcurrent": 2
  }
}
```

This example is intentionally incomplete until providers for Sol and Astra are confirmed. Add implementation -> Sol/medium, validation -> Astra/medium, hard work -> Astra/high after provider resolution. `hard` wins over the ordinary intent route, but never over explicit runtime fields. Confirm Luna/max for small slices/lints before shipping this user's defaults.

Configuration rules:

- Explicit request fields > trusted project route > global route > existing inherited defaults when routing is disabled.
- Merge route entries by key, replace each runtime entry atomically, reject unknown fields and invalid combinations. Do not deep-merge partial runtime objects into surprising provider/model combinations.
- An enabled routing policy with no applicable route produces an unresolved proposal, not a hidden fallback.
- Project configuration may restrict but not silently enable remote Jev use. Global/session consent governs remote evaluation; a project cannot change the credential environment-variable name or API endpoint.
- Use a fixed first-party endpoint in v1. Never serialize credentials into drafts, journals, prompts, or debug output.
- New `/subagents-settings` command: routing enabled, route rows, approval behavior, ambiguous-task handling, Jev model/timeout, credential presence only. Global/project scope is explicit. Save atomically after validation; untrusted project config is ignored with an explanation.
- No settings file means legacy behavior. Merely installing the extension must not activate routing or Jev.

## Shared data and authority

### Classification and routing

```ts
// Proposed types; existing workflow `kind` remains a distinct field.
classification?: {
  intent?: "scout" | "small_slice" | "lint" | "implementation" | "validation";
  complexity?: "normal" | "hard";
}
```

The orchestrator normally supplies these labels. Safe workflow kind defaults: scout -> scout, writer -> implementation, proof/review -> validation; repair is ambiguous without more metadata. Do not infer permissions, implementation size, or hardness from a task name alone. Mixed assignments use the hardest required deliverable or become separate tasks when useful.

The shared resolver is pure: validated classification + explicit fields + snapshotted preferences + model catalog -> concrete runtime proposal or unresolved reason. It never invokes Jev itself. An optional pre-resolution classification stage can call Jev when configured; a failed classifier returns to ask/unresolved, not a guessed route. A Jev-derived label cannot loosen scope/privacy constraints.

The proposal records requested and effective/negotiated runtime, classification source, matched preference, config digest, and unresolved issues. Preflight availability is not proof that a provider will accept a request. Keep requested versus observed effective model/effort distinct, including Codex `max` mapping.

Standalone route proposals should be batchable: one review can cover several pending spawns. Add a proposal/approval boundary at the parent tool layer, not an opaque policy in the backend. Approval binds the exact task content, scope/cwd, runtime, and policy snapshot; reusing approval for a changed task is invalid. A user's explicit instruction to start a specified runtime already supplies runtime authorization; do not ask the same question again. Preference-derived proposals require a newer approval before admission. Proposal storage can remain session-local: restart invalidates unexecuted standalone proposals rather than resuming them.

### `ask_jev`

```ts
// Proposed public tool input. No arbitrary file paths or transcript access.
ask_jev({
  state: "bounded task description or explicitly selected evidence",
  questions: {
    intent: {
      type: "choice",
      question: "What is the main required deliverable?",
      options: ["scout", "small_slice", "implementation", "validation"]
    }
  }
})
```

Support `choice` and `score` first. Normalize the SDK/service-specific response to our own versioned answer union. Choice answers must be members of the supplied choices; numeric values must be finite and satisfy the requested scale. Preserve only probability fields actually returned by the service; never invent confidence or interpret it as calibrated certainty.

The shared client owns authentication, request serialization, total deadline, cancellation, bounded response parsing, and service errors. Return bounded answers and metadata (requested/actual service model, duration, usage if available, input digest). Distinguish not_configured, invalid_input, unauthorized, rate_limited, timeout, cancelled, transport_error, invalid_response. No error is a semantic answer.

Proposed initial safety budgets: 32 KiB input, 16 questions, 16 choices per question, 16 KiB response, two concurrent Jev requests, bounded pending queue of 32 with explicit overload errors, and a 10-second total deadline covering admission and any request attempts. Validate these against the current API in slice 1. No transparent retries in v1; workflow/operator retry remains explicit. These are application limits, not claims about Jev service limits.

Only explicitly selected `state` goes to Jev. No automatic transcript upload, source crawling, API keys, or raw native session objects. Logs contain bounded metadata, not request bodies. Availability of the API key is not itself consent to transmit data.

Expose `ask_jev` initially to the parent and explicit workflow evaluator path; do not automatically expose it to every coding child. Child use can be added later under the same budgets/consent if needed.

### Typed workflow evaluations

Add an execution discriminator distinct from semantic `kind`: existing agent tasks remain the default executor; new evaluation tasks declare a Jev evaluation payload. No fake `SubagentManager` child and no coding-agent slot for an HTTP evaluation.

Evaluation tasks are read-only, declare `needs` and explicit `consumes`, and specify bounded inline questions. Build state only from declared inputs. A validated answer is data for downstream tasks; it cannot add tasks, change routes, or release unrelated dependencies.

Persist bounded structured result data and its schema version in workflow artifacts. Existing text previews remain available. A task whose typed input was truncated must fail or explicitly describe that input as partial; never present a partial report as complete evidence.

### Post-run gate

A gate references the same evaluator contract and a deterministic acceptance predicate over its typed answer. Inline questions avoid mandatory check registration. Initial predicates should be small and closed (choice equality and numeric threshold), not executable expressions.

Keep process outcome and acceptance outcome distinct:

```text
child process succeeds -> gate pending -> pass -> publish accepted result -> complete task
                                      -> reject -> task fails with gate_rejected
                                      -> error  -> task fails with evaluator error category
child process fails --------------------------------> existing process failure path
```

No result becomes consumable and no dependant becomes ready before gate pass. Retain workflow writer ownership until acceptance is terminal even if the coding child has released its execution slot. Gate rejection is not backend_failure and must not enter existing automatic backend retries.

For standalone children, preserve process status and add acceptance state; hold the parent's final completion notification and `subagent_wait` result until acceptance settles. Inspection may show `process done / gate pending`. Cancellation must cover pending evaluation, and publication must remain exactly once. Do not make all low-level process observers wait for the gate.

Gate input is a bounded evidence envelope with task goal, explicit report/check evidence, and completeness flags. It is not an implicit independent code review. Missing required evidence or truncation yields an error/insufficient-evidence outcome rather than pass.

## Implementation slices

### 1. Optional `ask_jev`, usable end to end

Depends on: no other slice.

Existing seams: `extensions/subagents/index.ts` tool registration; `extensions/subagents/src/backends/pi.ts` child tool exclusions; `package.json` dependency/test scripts. Introduce clearly new modules under `extensions/subagents/src/jev/` for domain, validation, client, and service admission, plus an extension-owned settings module. Keep logic outside the registration file.

Work: verify current TypeSafe choice/score wire contract; implement validated settings read, shared client, bounded admission/cancellation, normalized result, and direct tool. Invocation or a declared gate/evaluation step is the opt-in; environment credential presence alone never initiates a request. Prefer minimal HTTP integration unless the SDK materially reduces contract risk; choose once after the wire-contract check and avoid two transports.

Risk: remote data leakage, oversized/malformed API output, hidden SDK retries, request continuing after cancellation.

Proof: local fake HTTP service or injected transport exercises the public tool handler for valid choice/score, wrong choice, NaN/range errors, missing answers, unknown fields, large response, 401/429/5xx, total deadline, queue overload, cancellation, and missing credentials. Assert zero transport calls when credentials are missing and no body/credential logs. An explicitly invoked live smoke with synthetic non-sensitive text requires credentials; record the actual returned model and validated output. No real call is needed for the default test suite.

Handoff: working optional question/answer tool; normal behavior unchanged when disabled.

### 2. Preference routing and settings for standalone subagents

Depends on: settings contract from slice 1; routing itself has no Jev dependency.

Existing seams: `index.ts` subagent spawn handling; `src/domain.ts` SpawnTask; `src/parent-tools.ts`; `src/prompt.ts`; `src/backends/pi.ts` model resolution; `src/backends/codex.ts` effort negotiation. Introduce a new shared routing module and session-local proposal store, not a backend-specific routing engine.

Work: classification schema, deterministic resolver, route provenance, batchable proposal/approval tools, and `/subagents-settings`. Preserve legacy direct calls when routing is disabled. Add user labels and optional Jev-assisted classification before resolution. Snapshot task and route at proposal time and recheck executable availability without silently substituting. Show requested versus effective runtime in inspection.

Risk: accidental model override; duplicate approvals; settings change between proposal and execution; bypass through direct parent tool paths.

Proof: table tests for all preference mappings and precedence; ambiguous assignment; partial explicit overrides; unavailable/ambiguous provider; stale proposal/session; changed settings; repeated approval (no duplicate spawn); explicit runtime authorization; Jev disabled/outage. Drive settings UI once in a Pi session, save and reload, and inspect a real approved scout's runtime. Use synthetic/no-op tasks where possible.

Handoff: standalone routing works with no Jev key and no agent registration.

### 3. The same routing in dynamic workflow preparation

Depends on: slice 2.

Existing files/symbols: `src/workflows/domain.ts`, `graph.ts`, `sandbox.ts`, `tools.ts` WorkflowToolLifecycle.prepare, `drafts.ts`, `provenance.ts`, `draft-review.ts`, `prompt.ts`, and `manager.ts` workflow admission.

Work: accept classification metadata as static data; resolve concrete task runtimes before persisting the draft; record provenance and policy snapshot in immutable execution inputs. Extend current review rows rather than adding another approval screen. Missing routing information produces a actionable preparation error/proposal, not an executable unresolved draft. Approval executes snapshotted routes, never current settings. Retries retain them.

Dynamic composition means the parent may generate arbitrary valid tasks before preparation. After review, graph, scopes, consumes, evaluator definitions, and runtimes stay immutable.

Risk: ambient settings override a reviewed route; prepare starts a child; task labels accidentally become permissions.

Proof: `drafts.test.ts`, `draft-review.test.ts`, `graph.test.ts`, and `execution.test.ts`: generated mixed graph resolves expected runtimes, approval starts exactly those runtimes, settings changes do not mutate the approved execution, edited draft fails integrity checks, no children during prepare, explicit task runtime wins, only one workflow approval needed.

Handoff: one classification/resolution path for both surfaces.

### 4. Typed Jev workflow evaluation tasks

Depends on: slice 1 and slice 3's immutable metadata boundary.

Existing files: `src/workflows/{domain,graph,sandbox,manager,scheduler,events,reducer,artifacts,handoff,recovery,projection}.ts`, `src/ui/workflow-dashboard.ts`. These all currently assume agent-centric execution in some form; inspect every childId assumption before changes.

Work: add the execution union and evaluation dispatcher under WorkflowManager; track evaluator attempts without forged child IDs; share Jev admission limits rather than coding slots. Add validated structured results to events/artifacts/handoffs and bounded previews to UI. Needs/consumes, pause/cancel, retry attempt identity, persist-before-publish, and private workflow result ownership still apply.

Risk: fake child lifecycle, unbounded handoffs, recovery accidentally repeating a paid remote call, evaluation bypassing scheduler authority.

Proof: scout -> evaluation -> validator integration using stub agents and fake Jev; consumer receives only selected typed data; no coding child spawned for evaluation; dependencies release only after persisted success; malformed output blocks; cancel and stale result cannot publish; restart marks in-flight workflow orphaned without calling Jev; old journals still load; large/deep handoff is rejected or explicitly partial according to schema.

Handoff: a workflow can classify/score evidence without registered agents.

### 5. Typed post-run gates on standalone and workflow work

Depends on: slices 1 and 4's typed results/lifecycle support; slice 3 for reviewed policy.

Existing seams: `src/workflows/manager.ts` reconcileSettlement (currently stores finalText and calls completeTask immediately after process success), plus `events.ts`, `reducer.ts`, `controls.ts`, `artifacts.ts`, `projection.ts`; standalone `src/manager.ts`, `src/parent-tools.ts`, `index.ts` result delivery and corresponding tests.

Work: reusable gate evaluation function, separate pending/terminal acceptance state, gate policy in request/draft snapshot, attempt-fenced async evaluation, cancellation barriers and timeout cleanup. WorkflowManager owns workflow acceptance; parent-facing standalone acceptance is coordinated in the subagent lifecycle. Do not run the same gate twice on a workflow-owned child. Gate result is durable before workflow completion/publication. Preserve process inspection while holding accepted-result notification.

Risk: premature downstream execution, stale verdict completing a retry, ownership released while acceptance pending, duplicate completion notification, gate reject accidentally auto-retrying a coding agent.

Proof: process done + delayed gate leaves dependant blocked; pass releases exactly once; reject/error/timeout do not release; overlapping writer stays blocked; cancel during gate prevents late publication; retry gets new attempt and ignores old answer; journal write failure publishes nothing; shutdown drains/invalidates evaluations; direct subagent_wait settles only after acceptance; workflow children never leak parent notifications. Test deterministic check failure cannot be overridden by a Jev answer.

Handoff: gates deliver compact verdicts without hiding process outcomes or weakening workflow authority.

### 6. Integrated examples, hardening, rollout

Depends on: slices 1–5.

Existing docs: `README.md`, `extensions/subagents/docs/design-plan.md`; update tool descriptions in `src/prompt.ts` and `src/workflows/prompt.ts`. Any later skill documentation changes must follow the repository's agent-writing guidance. Add examples as explicitly new files, not modifications to users' global settings.

Show three examples: label-only routed workflow without Jev; direct ask_jev; scout -> typed evaluation -> implementation with post-run gate. Explain remote data disclosure, unavailable behavior, acceptance versus process state, and runtime immutability.

Feature rollout: default off; opt in routing independently of Jev; enable direct tool, then evaluations, then gates after their proof passes. No migration writes into personal configuration. Removing settings returns new requests to legacy routing behavior; existing approved snapshots do not change. Code rollback must not reinterpret new journals as old: unsupported versions fail closed with a readable diagnostic; drain active runs first.

## Verification and proof boundaries

- Existing fast suite: `npm test`; lint/typecheck: `npm run check`. The current test script enumerates test files, so every new test file must be added explicitly.
- Existing live suite `npm run test:live` is Codex-specific, not Jev validation. Add a separate explicitly invoked Jev smoke test if necessary; never make normal tests require credentials.
- Seeded generated routing cases: at least 1,000 combinations of explicit fields, classifications, settings precedence, catalog availability. Invariants: explicit values survive; disabled Jev makes no request; identical inputs resolve identically; unresolved input never spawns. Save failing seed/case as a deterministic regression fixture.
- Generated gate event sequences: at least 1,000 bounded sequences of settle/pass/reject/cancel/retry/late-result. Invariants: at most one accepted completion per attempt; no dependent starts before acceptance; no stale attempt writes current results. Replay failing sequences using existing stub manager harness.
- Malformed evaluator input/output corpus: unknown keys, deep/oversized values, missing answers, dangerous property names, non-finite scores, invalid choice members, encoding edge cases. Bound parser tests by bytes and depth; preserve every failure fixture. No claim of universal safety from a finite corpus.
- Performance: record zero remote calls and deterministic lookup count for label-only routing; verify concurrent evaluations never exceed configured limit, queued requests are bounded, and timeout covers queue time. Measure fake-service latency separately from real provider latency; do not promise Jev saves time until measured.
- Live acceptance: route and approve one tiny standalone task and one dynamically composed workflow; observe effective model/effort and exactly-once results. With consent/key, run one synthetic Jev evaluation and one gate. If unavailable, report that live integration was not verified.
- Baseline evidence from the research scout: 200 tests passed. This plan does not rerun tests or claim the new behavior exists.

## Ownership, persistence, recovery

- Config service owns validated global/project snapshots; files are persisted, secrets remain external environment values.
- Routing resolver owns no mutable state; its output/trace is derived. Standalone proposal store owns pending approvals; they expire with the session.
- Workflow draft owns immutable graph, effective routes, questions, gate predicates, schema versions, and non-secret policy snapshot. Settings changing later do not rewrite it.
- Jev service owns bounded in-flight requests and queue; it owns no workflow transitions. No answer cache in v1.
- WorkflowManager owns evaluation attempts, gate acceptance, completion, retry authority, and persisted structured results. SubagentManager retains coding process identity and capacity.
- Display models derive from those owners, never infer gate acceptance from process `done`.
- Nonterminal workflows remain orphaned after restart under the existing recovery rule. Never replay remote calls or restart coding children implicitly.

## Remaining confirmations and gates

1. Confirm exact provider IDs for Sol/Astra and Luna/max interpretation. Blocks installing this user's complete routing defaults, not resolver implementation.
2. Confirm proposed extension-owned settings location and settings command. This is the plan's recommended default, not an existing Pi setting.
3. Enable remote Jev only with user consent and credentials; confirm retention suitability for real project evidence. Blocks live/private-data use, not fake-transport implementation.
4. Confirm initial wire contract and model availability against current TypeSafe docs/API during slice 1. Pin a supported model rather than trusting a moving alias.
5. Review concrete public standalone proposal/approval tool schema before slice 2 coding. Keep it batchable and ensure it cannot bypass the newer-user-approval check; no additional workflow approval round.
6. Before slice 5, review the explicit acceptance-state transition tests against existing completion/publication semantics. Gates must not be added as an untracked callback after settlement.

No workflow has been prepared or started by this plan. No implementation or personal settings have been changed.
