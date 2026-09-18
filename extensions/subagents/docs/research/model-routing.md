# Model routing research for `pi-subagents`

**Scope:** research only. No application files were changed. This note separates confirmed facts from design proposals. Primary sources are the checked-out repository and the installed Pi documentation.

## Executive recommendation

Use a **shared lightweight classifier + named-profile + deterministic ordered-candidate resolver**. Do not build a heavyweight agent registry. Existing workflow task kinds and optional inline classification metadata should feed the same resolver used by standalone proposals and dynamically composed workflows; defer Jev-style scoring until the explicit policy and trace contract are stable.

1. A user selects a profile (`private`, `balanced`, or `quality`) globally, per project, or per workflow/task; task classification selects the profile without requiring role registration.
2. Each profile contains an ordered list of concrete `(harness, model, effort)` candidates plus hard privacy/capability constraints.
3. Resolution is deterministic: explicit task/invocation override > project profile/rule > global profile/rule > built-in default. Filter by hard constraints, then choose the first available candidate.
4. For reviewed workflows, dynamically compose/classify and resolve the complete graph during draft preparation, display every concrete runtime in one review, and pin them into immutable execution inputs. Do not silently re-route an approved workflow because settings changed later.
5. Emit a bounded, secret-free decision trace containing requested values, policy source, candidate rejection reasons, selected/effective values, and the policy/config digest.

This gives most of the latency/token/privacy benefit without adding a classifier call or making model choice opaque.

### User preference overlay (new, proposal-only authority)

The current preference is **quality first**, with these proposed task defaults:

| Task shape | Proposed runtime | Status |
|---|---|---|
| scout | `openai-codex/gpt-5.6-luna`, high | Concrete provider/model supplied |
| small slice | `gpt-5.6-luna`, max | Treat `max` as a likely Luna preference, but ask whether max is really wanted for small changes |
| lint | `gpt-5.6-luna`, max | Same ambiguity as small slices; do not silently downgrade |
| implementation | `gpt-5.6-sol`, medium | Provider intentionally unspecified; do not guess |
| validation | `gpt-6-astra`, medium | Provider intentionally unspecified; do not guess |
| really hard validation/reasoning | `gpt-6-astra`, high | Provider intentionally unspecified; do not guess |

These are **recommendations, not execution authorization**. The router should show the proposed harness/provider/model/effort and ask before starting a standalone subagent. An explicit user model override changes the proposal but still goes through this ask unless it is already covered by an approved workflow draft.

For workflows, the existing prepare/review/approve boundary is the approval surface: show the proposed runtime and uncertainty in the draft, then execute only after the exact draft ID is approved. Do not add a second prompt after workflow approval. If provider resolution is still uncertain, prepare a non-executable proposal or fail closed rather than inventing a provider.

The `max` ambiguity matters because the shared scale accepts `max`, but the current Codex mapping reduces `max` to native `xhigh`; Pi may use `max` directly. The proposal must display both requested and effective effort after backend negotiation.

## Lightweight workflow classification and dynamic composition (design idea)

Routing should be a **shared runtime resolver/proposal service**, not an agent-definition registry. There is no need to register a named agent for every role. The existing workflow task `kind` (`scout`, `writer`, `proof`, `review`, `repair`), prompt, scope, dependencies, and explicit runtime fields are enough for a first classifier.

Use a small, optional inline classification metadata object only when inference is ambiguous:

```ts
classification?: {
  intent?: "scout" | "small_slice" | "lint" | "implementation" | "validation";
  complexity?: "small" | "medium" | "hard";
  sensitivity?: "normal" | "private";
  requires?: ReadonlyArray<"reasoning" | "image" | "steering">;
}
```

The resolver consumes this metadata plus existing task fields. It returns one proposal per task: concrete runtime (or unresolved provider), rationale, rejected candidates, and a trace digest. A dynamic workflow composer can generate tasks and classifications just before preparation; the resolver then resolves the complete graph in one pass and the existing workflow review shows all runtime rows. This is low ceremony: no role registration, no imperative scheduler, and no second approval per task.

The approval boundary is important:

- **Dynamic composition before approval:** allowed. Compose the graph, classify every task, resolve every runtime, display the full proposal, hash the resolved runtimes/policy, then ask once through the existing workflow approval.
- **Graph or runtime change after approval:** not allowed under the immutable contract. A changed task, classification, profile, provider, effort, or fallback chain requires a new draft and approval. A retry keeps the pinned runtime; it does not reclassify silently.
- **Standalone subagent:** use the same resolver, but its proposal must be explicitly approved before `subagent_spawn` starts. The proposal can contain multiple standalone tasks, but approval should bind the exact set and route traces.

Jev, if added later, may populate classification metadata before resolution. It must not become an agent registry or final execution authority; explicit task overrides, hard capability/privacy constraints, deterministic candidate order, and the ask boundary remain authoritative.

## Confirmed existing facts


- `subagent_spawn` already accepts `harness` (`pi` or `codex`), `model`, and shared `reasoning_effort`; omission is documented as the harness default, with Pi inheriting the current model/thinking level. [`extensions/subagents/src/prompt.ts:25-37`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/prompt.ts:25)
- The domain contract says `model` is a generic backend-interpreted hint: Pi accepts `provider/model-id` or a bare ID; Codex accepts a model slug. [`extensions/subagents/src/domain.ts:115-137`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/domain.ts:115)
- The manager queues work behind one global `MAX_RUNNING = 4`, checks backend availability at admission, and fails with `BackendUnavailableError` when unavailable. [`extensions/subagents/src/manager.ts:617-648`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/manager.ts:617)
- The queued snapshot initially records requested model/effort, then replaces metadata with the backend session's effective metadata after admission. [`extensions/subagents/src/manager.ts:713-772`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/manager.ts:713)
- Backend capability metadata currently has only `steering`, `modelSelection`, and `reasoningEffort`; capability data is exposed by inspection/UI. [`extensions/subagents/src/domain.ts:46-50`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/domain.ts:46)

### Pi backend resolution

- Pi resolution is parent-registry based. An exact `provider/model-id` is required to exist; a bare ID first tries the inherited provider, then must be unique across providers. No model hint inherits the parent model; with no inherited model, the SDK chooses its default. [`extensions/subagents/src/backends/pi.ts:97-124`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/backends/pi.ts:97)
- Pi effort is direct: requested effort wins, otherwise a valid inherited thinking level is used. The child is created with the resolved model, thinking level, per-cwd settings/resource loader, and excluded orchestration tools. [`extensions/subagents/src/backends/pi.ts:77-94`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/backends/pi.ts:364)
- `piBackend.available` is always true because it is an in-process SDK backend. Actual model/resource/auth failures happen during session creation or the first provider request. [`extensions/subagents/src/backends/pi.ts:1300-1305`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/backends/pi.ts:1300)
- Parent context captures the parent model, thinking level, model registry, cwd, and project trust. [`extensions/subagents/src/domain.ts:104-113`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/domain.ts:104)

### Codex backend resolution

- The shared effort scale is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; Pi uses it directly and Codex maps it to native values. [`extensions/subagents/src/domain.ts:16-20`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/domain.ts:16)
- Codex native values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. The current mapping turns `off` and `minimal` into native `minimal`, and `xhigh`/`max` into `xhigh`; model-specific supported values are then clamped by nearest effort. [`extensions/subagents/src/backends/codex.ts:248-340`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/backends/codex.ts:248)
- A Codex effort request triggers a bounded `model/list` probe (5 seconds). If the probe fails, the unclamped preferred effort is used. Later `thread/settings/updated` or `model/rerouted` notifications are authoritative for effective metadata. [`extensions/subagents/src/backends/codex.ts:343-358`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/backends/codex.ts:343), [`extensions/subagents/src/backends/codex.ts:1186-1204`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/backends/codex.ts:1186)
- `codexBackend.available` currently checks only whether the Codex binary resolves on `PATH`; it does not preflight credentials or a requested model. [`extensions/subagents/src/backends/codex.ts:1299-1305`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/backends/codex.ts:1299)
- Codex `thread/start` passes the requested model when present, and the thread response supplies the actual model/effort/session metadata. [`extensions/subagents/src/backends/codex.ts:1148-1185`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/backends/codex.ts:1148)

### Workflows, settings, and UI

- Workflow tasks already have optional `harness`, `model`, `effort`, and retry policy fields. [`extensions/subagents/src/workflows/domain.ts:24-34`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/workflows/domain.ts:24)
- Draft review already renders a “Requested/configured runtime” row with harness, provider, model, and thinking. Omitted harness defaults to Pi; omitted model/effort are shown as selected backend/session defaults. [`extensions/subagents/src/workflows/prompt.ts:42-79`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/workflows/prompt.ts:96)
- Saved workflow discovery has project precedence: `<project>/.pi/workflows`, then `<project>/.agents/workflows`, then `~/.pi/agent/workflows`; the first same-name definition shadows later ones. [`extensions/subagents/src/workflows/saved-workflows.ts:43-56`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/workflows/saved-workflows.ts:89-107)
- Preparation snapshots and validates the full graph before persistence; approval requires the exact pending draft, persisted artifact match, newer user input, same session, and same project. [`extensions/subagents/src/workflows/tools.ts:134-180`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/workflows/tools.ts:134), [`extensions/subagents/src/workflows/drafts.ts:225-244`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/workflows/drafts.ts:225)
- The execution digest currently hashes the validated definition, source, args, and background flag. A future routing policy digest must be added to the immutable execution inputs if routing can change execution. [`extensions/subagents/src/workflows/provenance.ts:57-68`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/workflows/provenance.ts:57)
- Workflow children use a private workflow result lane; bounded explicit handoffs are retained, while child transcripts remain owned by `SubagentManager`. The prompt also says automatic retry is limited to classified `provider_stall`/`backend_failure`. [`extensions/subagents/src/workflows/prompt.ts:103-115`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/workflows/prompt.ts:103), [`extensions/subagents/src/workflows/manager.ts:80-90`](../Users/yesh/code/personal/pi-subagents/extensions/subagents/src/workflows/manager.ts:80)
- There is no current routing/profile/Jev configuration or routing UI in this repository. The workflow review is the existing relevant UI surface; subagent inspection shows backend/model/effort and capabilities.

### Installed Pi facts and local availability snapshot

Observed during this research:

- `pi --version`: `0.85.1`; `codex --version`: `codex-cli 0.154.0`; both binaries are present.
- Repository dev/peer dependencies are `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` `0.80.7` (`package.json:35-58`). The installed CLI/docs are newer than the repository's local SDK dependency. This is a compatibility risk for any new availability API; route through the existing `ModelRegistry` seam unless the dependency is deliberately upgraded.
- Global Pi settings currently select `openai-codex/gpt-6-astra` at `low` thinking. There is no project `.pi/settings.json` in this checkout.
- Global `models.json` defines:
  - `lmstudio` at `http://127.0.0.1:1234/v1` with `gemma-4-12b-coder-fable5-composer2.5-v1` (non-reasoning, 65,536 context) and `vibethinker-3b-mlx` (reasoning, 32,768 context).
  - `vibeproxy-anthropic` at `http://localhost:8317` with four configured Claude aliases.
- `pi --list-models` shows those configured models. The LM Studio endpoint was not listening when probed (`curl` connection refused); the VibeProxy `/v1/models` endpoint responded with OpenAI model IDs. A configured/authenticated catalog entry is not proof that a local server is healthy or that a proxy is privacy-local.

## Pi model/config facts relevant to routing

- Pi settings are global `~/.pi/agent/settings.json` plus project `.pi/settings.json`; project settings override global settings and nested objects merge. `/model` + Ctrl+S saves startup model, and `/thinking` + Ctrl+S saves startup thinking. [`pi-coding-agent/docs/settings.md:1-10`](../Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md:1)
- Project-local resources/settings are trust-gated. In noninteractive modes, `defaultProjectTrust` controls whether project resources are ignored, always trusted, or asked about. [`pi-coding-agent/docs/settings.md:12-22`](../Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md:12)
- Pi has startup model/thinking settings (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, and `modelThinkingLevels`) but no built-in subagent routing preference. [`pi-coding-agent/docs/settings.md:24-36`](../Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md:24)
- Custom local models and proxies are configured through `models.json`. Pi distinguishes registered models from available/authenticated models; `/model`/`--list-models` availability is based on configured auth presence, not a live endpoint health check. [`pi-coding-agent/docs/models.md:1-3`](../Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md:1), [`pi-coding-agent/docs/models.md:132-176`](../Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md:132)
- Model metadata includes reasoning support, input modality, context window, max output, cost, compatibility, and per-level `thinkingLevelMap`; unsupported thinking levels may be hidden/skipped/clamped. [`pi-coding-agent/docs/models.md:200-211`](../Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md:200), [`pi-coding-agent/docs/models.md:259-300`](../Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md:259)
- The SDK's model runtime can distinguish registered models from authenticated/available models, restores cached catalogs, optionally refreshes them with a timeout, and documents fallback order: resume-session model, settings default, then first available model. [`pi-coding-agent/docs/sdk.md:367-438`](../Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:367)
- The SDK's `DefaultResourceLoader` uses cwd for project resources and `agentDir` for global settings, models, auth, and sessions. [`pi-coding-agent/docs/sdk.md:330-365`](../Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:330)

## Candidate design shapes

| Shape | Explainability | Latency/token savings | Privacy | Override/fallback | Capability constraints | Workflow review/digest |
|---|---|---|---|---|---|---|
| **1. Explicit named runtime profiles** | High: user sees `private`, `balanced`, `quality` and concrete candidates | High when profiles put a small local model first; no classifier call | High if a profile can enforce `local-only`/`remote-allowed` | Strong: explicit task model wins; profile can say deny or try-next | Strong: filter candidates by context, input type, reasoning, steering, and harness | Strong if the resolved candidate and profile/config digest are snapshotted during draft preparation |
| **2. Deterministic preference rules** | High for simple ordered rules; can degrade with many overlapping rules | High; rules are cheap and predictable | High if privacy is a hard filter, not a score | Medium-to-high; ordered candidate chains are understandable, but rule precedence must be documented | Strong if rules are hard constraints before ranking | Strong if rules are evaluated at preparation and their result is materialized in the draft |
| **3. Optional Jev classification/scoring** | Medium/low: “why this score?” is harder than “first eligible candidate” | Potentially better quality/cost fit, but adds a classifier call, tokens, and queue latency | Depends on classifier/model; unsafe for private tasks if it sends prompt content remotely | Can honor explicit overrides, but probabilistic fallback is harder to reason about | Can score capabilities, but must still hard-filter them first | Weak unless classification, candidate scores, model availability, and policy digest are persisted; never re-score an approved workflow silently |

### Shape 1: profiles (recommended foundation)

A profile is a named policy, not a model alias. It should contain an ordered list of concrete candidates and hard constraints. Example intent:

- `private`: local candidates only; if unavailable, fail closed.
- `balanced`: local first, then an allowed proxy/cloud candidate.
- `quality`: a strong remote candidate, with a deterministic same-provider fallback if explicitly permitted.

Profiles make the UI and workflow review legible. They also let one user preference express both privacy and economics without teaching the parent model a long rule language.

### Shape 2: rules (use inside profiles)

Rules are useful for task kinds already present (`scout`, `writer`, `proof`, `review`, `repair`) and for hard requirements such as read-only, expected context, image input, or steering. Keep rules ordered and non-overlapping where possible. A rule should select a profile or add constraints; it should not directly perform arbitrary model scoring.

For dynamically composed workflows, classify each generated task in memory, resolve the complete graph during preparation, and present one review. There is no need to register an agent definition for every role.

### Shape 3: Jev (optional later)

No Jev implementation or term was found in this repository. If “Jev” means a classifier/scorer, use it only as an advisory classifier that chooses a profile or adds a bounded complexity label. Do not let it override explicit model choices or hard privacy/capability constraints. In `local-only` mode it must run locally or be disabled. A deterministic tie-breaker must remain in charge.

## Proposed small settings schema (design idea)

Prefer a separate routing file so Pi's own settings schema remains stable:

- Global: `~/.pi/agent/subagents-routing.json`
- Project: `.pi/subagents-routing.json`, loaded only when the project is trusted
- Precedence: explicit invocation/task > project routing file > global routing file > built-in defaults

Illustrative schema:

```json
{
  "version": 1,
  "defaultProfile": "quality",
  "profiles": {
    "quality": {
      "privacy": "remote-allowed",
      "candidates": [
        { "harness": "pi", "provider": "openai-codex", "model": "gpt-5.6-luna", "effort": "high", "for": ["scout"] },
        { "harness": "pi", "provider": null, "model": "gpt-5.6-sol", "effort": "medium", "for": ["writer"] },
        { "harness": "pi", "provider": null, "model": "gpt-6-astra", "effort": "medium", "for": ["proof", "review"] },
        { "harness": "pi", "provider": null, "model": "gpt-6-astra", "effort": "high", "for": ["repair"] }
      ],
      "fallback": "ask"
    },
    "private": {
      "privacy": "local-only",
      "candidates": [],
      "fallback": "deny"
    },
    "balanced": {
      "privacy": "remote-allowed",
      "candidates": [
        { "harness": "pi", "model": "lmstudio/vibethinker-3b-mlx", "effort": "low" },
        { "harness": "pi", "provider": null, "model": "gpt-6-astra", "effort": "medium" }
      ],
      "fallback": "next-available"
    }
  },
  "rules": [
    { "when": { "kind": ["scout", "writer", "proof", "review", "repair"] }, "profile": "quality" }
  ],
  "ui": { "showDecisionTrace": true }
}
```

Keep the first version intentionally small. Add model labels, cost budgets, endpoint health checks, and Jev weights only after the trace format is proven. Treat privacy tier as explicit user configuration: `localhost` or a proxy name is not proof that data stays local.

## Deterministic resolution contract (design idea)

1. **Normalize inputs:** direct spawn fields, workflow task fields, selected profile, rule match, parent/session defaults.
2. **Honor explicit values:** an explicit user model is exact. An explicit unknown/unavailable model should fail with a clear reason; do not silently replace it. An explicit harness with no model may use that harness's configured default. A bare `gpt-5.6-sol` or `gpt-6-astra` with no provider is intentionally unresolved when the provider is ambiguous; preserve it as `provider: unspecified` and ask rather than guessing.
3. **Select policy:** task/profile selector from project config, then global config, then built-in default.
4. **Classify only if enabled:** Jev may add `complexity`/`privacy` labels, but cannot loosen hard constraints or replace explicit fields.
5. **Filter candidates:** privacy tier, required harness capabilities, model existence, auth/catalog availability, context window, input modality, reasoning/effort support, and optional endpoint health.
6. **Choose first eligible candidate:** deterministic order, no hidden score ties.
7. **Materialize requested vs effective:** preserve requested effort and record backend-native/effective effort after negotiation. For Codex, model/list or settings notifications remain authoritative.
8. **Propose, then ask:** for standalone routing, return a proposal and wait for explicit approval or an override before spawning. For workflows, the draft review/approval is the ask; approval executes the pinned proposal.
9. **Record a bounded trace:** no API keys, prompts, or raw provider errors beyond bounded safe messages.

Standalone proposal shape (design idea):

```text
Routing proposal · scout
Harness: pi · Provider: openai-codex · Model: gpt-5.6-luna · Thinking: high
Why: quality-first scout preference; first eligible candidate
Approval: start this runtime, or reply with a model/provider/effort override
```

If the proposal contains `Provider: unspecified`, it is not executable. The user must resolve the provider first. A standalone approval should bind the exact proposal/trace digest so a later settings change cannot alter the child that starts.

Recommended fallback semantics:

- `fallback: deny`: no substitution, especially for private workflows.
- `fallback: next-available`: move only through the preconfigured candidate list, with each rejection recorded.
- Never fall back from an explicit `provider/model` to another provider unless the user explicitly selected a fallback profile/chain.

## Decision trace proposal

```json
{
  "version": 1,
  "source": "explicit | task | project-rule | global-rule | default",
  "profile": "quality",
  "classification": {
    "intent": "validation",
    "complexity": "medium",
    "sensitivity": "normal",
    "source": "task-kind | inline | Jev"
  },
  "requested": { "harness": "pi", "provider": null, "model": "gpt-6-astra", "effort": "medium" },
  "requirements": {
    "privacy": "remote-allowed",
    "minContextWindow": 65536,
    "input": ["text"],
    "reasoning": false,
    "steering": false
  },
  "candidates": [
    { "harness": "pi", "model": "lmstudio/vibethinker-3b-mlx", "status": "rejected", "reason": "endpoint_unhealthy" },
    { "harness": "pi", "provider": null, "model": "gpt-6-astra", "status": "blocked", "reason": "provider_unspecified" }
  ],
  "selected": {
    "harness": "pi",
    "provider": null,
    "model": "gpt-6-astra",
    "requestedEffort": "low",
    "effectiveEffort": "low"
  },
  "policyDigest": "sha256:...",
  "availabilityCheckedAt": 0,
  "approval": "pending"
}
```

For a direct subagent, show a compact trace in a proposal card before spawning; approval changes `approval` to `approved` and the exact trace digest is bound to the child. For a workflow, include the compact selected runtime and policy digest in the draft preview, and keep the full trace in the draft artifact or bounded run metadata. An unresolved provider leaves the proposal blocked.

## Workflow immutability implications

The current workflow system intentionally separates preparation from approval and hashes exact execution inputs. Routing must follow that boundary:

- Resolve profiles/rules and availability during **preparation**, not after approval.
- Render the concrete selected runtime, fallback policy, and any Jev classification in the existing draft review row.
- Add the routing policy/config digest and resolved runtime to the hashed execution inputs. The current digest does not include external config, so merely storing a profile name is insufficient.
- On approval, execute the pinned runtime from the draft; do not reread mutable routing settings.
- Keep retry attempts on the same pinned runtime. A cross-model/provider retry should be a new reviewed draft, or an explicitly pre-approved fallback chain whose candidate list was shown and hashed.
- Record availability changes as failures/diagnostics, not as silent changes to an already-approved plan. This is especially important for `private`/local-only policy.
- Preserve existing workflow result ownership: child transcripts remain with the manager, handoffs are bounded, and only the workflow owner consumes terminal results.

This preserves the current “review this exact graph” guarantee while making runtime routing reviewable rather than implicit.

## Privacy, latency, and token trade-offs

- **Local-first:** usually lowest data exposure and provider spend; may have higher wall-clock latency, smaller context/output limits, and lower quality. Health checks must distinguish “Pi catalog/auth says visible” from “local endpoint is responding.”
- **Proxy-first:** can be fast and convenient, but a localhost proxy may forward to a cloud provider. Require an explicit configured privacy tier.
- **Remote strong model:** best for complex repair/review work, but increases cost, network dependency, and data exposure. A `local-only` hard constraint must prevent this fallback.
- **Higher effort:** can improve difficult-task success but raises latency and output/reasoning tokens. Budget effort by task kind, not just model quality. Pi model metadata and `thinkingLevelMap` already expose the data needed for capability filtering.
- **Jev scorer:** adds at least one extra model call unless classification is local/deterministic. Its token cost and privacy impact can erase the savings from routing small tasks locally. Start with rule labels (`kind`, scope, context estimate, sensitivity) and measure before adding it.

## Current confirmed preference decisions

- Priority: **quality first**.
- Recommended assignments: Luna/high for scouts; Luna/max for small slices and lints, pending confirmation that `max` is intentional; Sol/medium for implementation; Astra/medium for validation; Astra/high for really hard tasks.
- Provider: preserve the uncertainty for Sol and Astra. The router must not infer `openai`, `openai-codex`, or another provider from a bare model ID.
- Authority: recommend, show the proposed runtime, then ask. Standalone subagents need a new explicit proposal approval; existing workflows use their current immutable draft approval as the execution approval.

## Open user-preference questions

1. Is **privacy** a hard requirement for some projects/tasks (`local-only`), or only a preference that may be traded for quality/latency?
2. Should a user-specified `provider/model` **always fail closed** when unavailable, or may it use a declared fallback chain?
3. Should `harness` be an independent preference, or may a profile switch between Pi and Codex for the same model family?
4. Should the quality-first mapping be one `quality` profile with task-kind rules, or separate named profiles for `scout`, `implementation`, and `validation`?
5. For local models, should the router perform a live health probe, and what timeout/staleness policy is acceptable?
6. Should workflows allow only pinned runtime choices, or may the user approve a displayed fallback chain for retries?
7. Which capability constraints matter first: minimum context, text/image input, reasoning level, steering, cost ceiling, or tool compatibility?
8. What does “Jev” mean operationally: a local classifier, a remote model scorer, or a deterministic feature extractor? Is sending task text to it acceptable?
9. Should routing preferences live in a dedicated `subagents-routing.json` (safer extension boundary) or be nested in Pi `settings.json` so `/settings` can edit them?
10. Should the route trace be visible in normal transcript output, only `/subagents`/workflow review, or both?

## Primary sources

- Repository: `README.md`; `package.json`; `extensions/subagents/src/domain.ts`; `extensions/subagents/src/backends/pi.ts`; `extensions/subagents/src/backends/codex.ts`; `extensions/subagents/src/manager.ts`; `extensions/subagents/src/workflows/{domain,prompt,tools,drafts,provenance,saved-workflows,manager}.ts`.
- Installed Pi 0.85.1 docs, read in full where used:
  - `/Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
  - `docs/settings.md`
  - `docs/models.md`
  - `docs/providers.md`
  - `docs/sdk.md`
- Local availability commands: `pi --version`, `codex --version`, `pi --list-models`, `curl --max-time 2 http://127.0.0.1:1234/v1/models`, and a redacted structural inspection of `~/.pi/agent/settings.json`/`models.json` (no credentials read).
