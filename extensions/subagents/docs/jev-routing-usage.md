# Jev and standalone routing usage

Jev and preference routing are optional. With no settings file, preference routing remains disabled. Jev becomes available when `TYPESAFE_API_KEY` or a saved global fallback is present, but only a direct `ask_jev` invocation or an explicitly declared gate/evaluation step can make a network request.

## Settings

Global settings live at:

```text
~/.pi/agent/subagents.json
```

A trusted project may override them at:

```text
.pi/subagents.json
```

Project settings are ignored when the project is untrusted. A project may restrict Jev limits, but it cannot change the credential environment variable or service endpoint.

Inspect effective settings and credential presence without printing the credential:

```text
/subagents-settings
```

Securely enter or replace the global saved credential using masked TUI input:

```text
/subagents-settings set-jev-key
```

The command writes `~/.pi/agent/jev-credentials.json` atomically with owner-only `0600` permissions and makes the new key available to existing Jev clients immediately. It never accepts the key in command arguments, does not prefill the input, and does not store credentials in project settings. The configured environment variable (by default `TYPESAFE_API_KEY`) always takes precedence over the saved fallback.

Open the interactive editor for one explicit scope:

```text
/subagents-settings global edit
/subagents-settings project edit
```

Edits are validated before an atomic write. Routing changes are read on the next operation. After a Jev client has been used, changing its cached Jev model or limits fails closed until Pi is reloaded or a new session starts; this prevents a session from silently switching remote policy or admission limits. The extension does not create or modify either settings file unless this edit command is used.

Example global file:

```json
{
  "version": 1,
  "routing": {
    "enabled": true,
    "approval": "ask",
    "ambiguous": "ask",
    "unavailable": "ask",
    "routes": {
      "scout": {
        "harness": "pi",
        "model": "provider/model-id",
        "effort": "high"
      },
      "implementation": {
        "harness": "codex",
        "model": "model-slug",
        "effort": "medium"
      },
      "validation": {
        "harness": "pi",
        "model": "provider/model-id",
        "effort": "medium"
      },
      "simple_validation": {
        "harness": "pi",
        "model": "provider/model-id",
        "effort": "medium"
      }
    }
  },
  "jev": {
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "model": "jev-1.13.0",
    "timeoutMs": 10000,
    "maxConcurrent": 2
  }
}
```

Route keys are `scout`, `small_slice`, `lint`, `implementation`, `validation`, `simple_validation`, and `hard`. Route selection is deterministic:

1. `complexity: "hard"` selects `hard`.
2. `intent: "validation"` with `complexity: "simple"` selects `simple_validation`.
3. Otherwise, an intent selects its same-named route.

If the selected key is absent, routing fails with `route_missing`; it does not fall through to another route or model. A route must specify `harness` and `model` together; `effort` is optional. Explicit runtime fields take precedence over route fields.

Do not copy the placeholder model IDs above unchanged. Use models available in the current Pi model registry or Codex harness.

For simple validation, the user-preferred alternatives are `opencode-go/deepseek-v4-flash` and `openai-codex/gpt-5.6-luna`. Choose and configure one explicitly; the package does not rank, select, or install either model. For example, either configuration is valid when the corresponding provider/model is available:

```json
"simple_validation": {
  "harness": "pi",
  "model": "opencode-go/deepseek-v4-flash"
}
```

```json
"simple_validation": {
  "harness": "pi",
  "model": "openai-codex/gpt-5.6-luna",
  "effort": "medium"
}
```

The ordinary `validation` and `hard` routes remain separately configurable. A simple validation classification does not silently select a large validation model.

## Standalone preference routing

`subagent_route` prepares one bound batch and starts no children. Each task supplies:

- `prompt` and `name`;
- `classification.intent`: `scout`, `small_slice`, `lint`, `implementation`, or `validation`;
- optional `classification.complexity`: `simple`, `normal`, or `hard`;
- optional explicit `harness`, `model`, `reasoning_effort`, and `working_dir`.

Example:

```json
{
  "tasks": [
    {
      "name": "inspect parser",
      "prompt": "Find the parser boundary and report risks. Do not edit files.",
      "classification": { "intent": "scout", "complexity": "normal" }
    },
    {
      "name": "implement fix",
      "prompt": "Implement the approved parser fix and run focused tests.",
      "classification": { "intent": "implementation", "complexity": "normal" }
    }
  ]
}
```

The result contains a proposal ID, binding digest, exact effective runtimes, and approval status. Preference-derived runtimes require a newer user response. After that approval, admit the unchanged batch with:

```json
{
  "proposal_id": "route_…",
  "binding_digest": "…"
}
```

using `subagent_approve`. Approval is session-local and binds task text, working directory, runtime, and the settings snapshot. Changed, expired, cross-session, or stale-settings proposals fail instead of silently rerouting. Repeated approval does not duplicate admission.

When routing is enabled, `subagent_spawn` requires `classification`, even when `harness` and `model` are supplied. Routing resolves the saved preference first; runtime fields request overrides, not user authorization. Every resolved runtime returns a proposal instead of starting immediately. Review the saved preference, requested runtime, and effective runtime, then use its ID and digest with `subagent_approve` after newer user approval. Missing classifications or saved routes fail before any child starts. When routing is disabled, continue to provide an explicit `harness`.

Routing is deterministic and makes no Jev request. Missing classifications, routes, unavailable models, and ambiguous bare Pi model IDs fail or remain unresolved; the extension does not silently substitute another runtime.

Workflow `proof` and `review` kinds default to normal validation. A caller must explicitly classify a lightweight validation task with `complexity: "simple"` to use `simple_validation`.

## `ask_jev`

`ask_jev` sends only the supplied `state` and named questions to the remote Jev service. It does not read files, upload the transcript, start work, approve routes, or prove that checks passed.

Choice example:

```json
{
  "state": "The requested deliverable is a read-only report of parser risks.",
  "questions": {
    "intent": {
      "type": "choice",
      "question": "What is the main deliverable?",
      "options": ["scout", "implementation", "validation"]
    }
  }
}
```

Score example:

```json
{
  "state": "The report lists two reproduced failures and one unverified hypothesis.",
  "questions": {
    "evidence": {
      "type": "score",
      "question": "How complete is the evidence?",
      "criteria": ["insufficient", "partial", "substantial", "complete"]
    }
  }
}
```

The configured environment variable or saved global fallback must contain a credential; no separate Jev opt-in setting is required. The default credential variable is `TYPESAFE_API_KEY`, and its current value takes precedence over the saved key. Settings display only `configured` or `missing`, never a value. Merely configuring a credential does not make a request: `ask_jev` must be invoked directly or a gate/evaluation step must be declared and reached. Normal tests use an injected fake transport and temporary credential paths; they do not contact Jev or modify personal settings. No live Jev call is claimed by this repository verification.

For a score question, `criteria` is an ordered scale of meaningful labels. Jev returns a zero-based numeric index into that array: the example above maps `0` to `insufficient` and `3` to `complete`.

Current request limits are 32 KiB for the complete encoded Jev input—including state, model, and transformed questions—16 questions, and 16 choices or score criteria per question. Responses are bounded to 16 KiB. The configured timeout covers queueing and transport, concurrency is bounded, and no automatic retry is performed. Errors are returned as categories such as `not_configured`, `unauthorized`, `rate_limited`, `timeout`, `cancelled`, `overloaded`, `transport_error`, or `invalid_response`.

Only send information that is appropriate for the configured remote service. Keep secrets, credentials, unnecessary source, and unrelated conversation content out of `state`.

## Standalone post-run gates

`subagent_spawn` and each task in `subagent_route` accept an optional declarative `gate`. Only the implemented Jev evaluator is valid. The gate runs after a successful coding process and holds `subagent_wait` and parent delivery until its predicate passes, rejects, or errors.

Choice gate example for `subagent_spawn`:

```json
{
  "name": "implement parser fix",
  "prompt": "Implement the parser fix and report the checks that ran.",
  "harness": "pi",
  "gate": {
    "evaluator": "jev",
    "questions": {
      "verdict": {
        "type": "choice",
        "question": "Does the report provide sufficient evidence for the requested change?",
        "options": ["pass", "reject"]
      }
    },
    "predicate": {
      "type": "choice_equals",
      "question_id": "verdict",
      "value": "pass"
    },
    "timeout_ms": 10000
  }
}
```

A score gate uses the zero-based criterion index as its threshold:

```json
{
  "evaluator": "jev",
  "questions": {
    "evidence": {
      "type": "score",
      "question": "How complete is the verification evidence?",
      "criteria": ["insufficient", "partial", "complete"]
    }
  },
  "predicate": {
    "type": "score_at_least",
    "question_id": "evidence",
    "value": 2
  }
}
```

Standalone gate predicates use snake-case `question_id`; `timeout_ms` is optional, defaults to 10 seconds, and must be between 1 and 120,000 milliseconds. The predicate must reference a declared question, choice values must be declared options, and score thresholds must be valid criterion indexes. The gate sends a bounded evidence envelope containing the task goal, final report, process outcome, and completeness flags. Missing or oversized evidence fails the gate rather than silently passing it.

For standalone gated children, routine result delivery is deliberately compact. Automatic parent messages and `subagent_wait` return the pass/reject/error verdict, plus a bounded single-line reason for reject or error, without duplicating the report in message or tool details. The full work product remains owned by the subagent manager. Call `subagent_inspect({ id })` to retrieve the terminal gated report explicitly; inspection returns up to 24 KiB and 600 lines. If a larger report exceeds that inspection bound, use `/subagents` to inspect the retained transcript. Ungated children continue to return their report directly.

This compact verdict is not a correctness proof. Jev judges the bounded report supplied by the child against the declared questions and predicate; it does not independently inspect the repository, rerun checks, or establish that the report is true. Retrieve the report and use deterministic verification when correctness depends on its claims.

## Typed workflow evaluations and gates

In a static `flow({ tasks: [...] })` definition, a read-only task can use `execution.type: "evaluation"`. Its payload contains explicit state and the same choice/score question shapes used by `ask_jev`. It does not spawn a coding child or consume a coding slot. `needs` controls readiness, while `consumes` explicitly appends bounded completed dependency results to the evaluation input.

```js
flow({
  tasks: [
    {
      id: "classify",
      label: "Classify evidence",
      kind: "review",
      prompt: "Classify the selected evidence",
      readOnly: true,
      execution: {
        type: "evaluation",
        payload: {
          state: "The selected report describes the observed failures.",
          questions: {
            readiness: {
              type: "score",
              question: "How ready is this evidence for implementation?",
              criteria: ["not ready", "needs work", "ready"],
            },
          },
        },
      },
    },
    {
      id: "implement",
      label: "Implement fix",
      kind: "writer",
      prompt: "Implement the approved fix using the classified evidence.",
      needs: ["classify"],
      consumes: ["classify"],
      owns: ["src/parser.ts"],
    },
  ],
});
```

An agent task can instead attach a post-run `gate`. Workflow gates use camel-case `questionId`, have no `evaluator` or per-gate timeout field, and use the session's configured Jev evaluator and timeout:

```js
flow({
  tasks: [
    {
      id: "implement",
      label: "Implement fix",
      kind: "writer",
      prompt: "Implement the fix and report verification evidence.",
      owns: ["src/parser.ts"],
      gate: {
        questions: {
          verdict: {
            type: "choice",
            question: "Is the reported evidence sufficient?",
            options: ["pass", "reject"],
          },
        },
        predicate: {
          type: "choice_equals",
          questionId: "verdict",
          value: "pass",
        },
      },
    },
    {
      id: "verify",
      label: "Verify accepted fix",
      kind: "proof",
      prompt: "Run deterministic verification.",
      needs: ["implement"],
      consumes: ["implement"],
      readOnly: true,
    },
  ],
});
```

Evaluation tasks must be `readOnly: true` and cannot also declare a gate. Workflow gate rejection is recorded as `gate_rejected`, does not become a backend failure, and does not trigger backend retry policy. Dependants remain blocked until the gate result is persisted and accepted. Truncated or missing required evidence fails closed.

## Acceptance state

A standalone child may expose an acceptance state in `subagent_inspect`, list output, and compact wait/final result delivery:

- `pending`: the coding process has finished, but final wait and parent delivery are held;
- `pass`: acceptance completed successfully;
- `reject`: the process succeeded but the acceptance decision rejected its result;
- `error`: acceptance timed out, was cancelled, returned invalid data, or failed.

Process outcome and acceptance outcome remain separate. A pending gate releases its coding slot, cannot receive follow-up messages, is protected from pruning, and is covered by cancellation and shutdown. Raw evaluator/provider errors are not copied into the acceptance reason.

The executable callback behind acceptance remains internal; public tools accept only declarative gate JSON.

## Remaining scope

This usage guide describes the implemented public surface and is authoritative over the earlier planning document. The following work remains outside the implemented surface or was not verified in this rollout:

- Automatic Jev ambiguity classification is not wired into routing. A user or orchestrator can call `ask_jev`, inspect the answer, and then provide an explicit classification label.
- Live provider tests were not run; normal verification uses injected evaluators and fake transport.
- No personal route or model preference is installed by the package.
- Settings edits that change a cached Jev model or its limits require a reload or new session.
- Settings or workflow artifacts containing the removed `jev.enabled` or `evaluationPolicy.enabled` fields fail validation with a migration error; remove the field and review/recreate affected workflow artifacts.
- The planning matrix's proposed 1,000-case generated suites and live UI/provider exercises were not executed as part of this work.

## Not currently supported

- Routing does not infer assignment labels from names or prompts.
- Jev does not autonomously approve, spawn, reroute, retry, or repair work.
- There is no automatic transcript or file upload.
- There is no automatic fallback when a configured route or requested Jev evaluation is unavailable.
- Personal default routes are not installed by this package.
