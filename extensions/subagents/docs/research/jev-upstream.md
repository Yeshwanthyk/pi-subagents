# pi-subagents / Jev upstream research

**As of 2026-09-18 UTC.** Read-only research of `nicobailon/pi-subagents` upstream and TypeSafe's first-party documentation/source. No Jev API call was made and no application code was changed.

## Bottom line

- **Claim (1) is shipped, but it is generic rather than Jev-specific.** Upstream PR [#2315](https://github.com/nicobailon/pi-subagents/pull/2315) (`feat(acceptance): typed gates bridge json stdout into structuredOutput`) was merged at [36eb766](https://github.com/nicobailon/pi-subagents/commit/36eb76604ef58459f9987bc88df53bb49f35186f) and is now upstream `main`. A `gate` can run a local command after a child finishes, parse its JSON stdout, validate an optional schema, and expose it as `child.structuredOutput` for workflow branching.
- **Claim (2) is only partially true.** Upstream ships a generic `runner.type: external-cli` “typed step” pattern and example `classifier` agent. It does **not** ship a Jev adapter, Jev registration API, Jev dependency, or a Jev script. The example's `classify` executable is a vendor-free keyword stand-in; its source says to replace `score` with “TypeSafe Jev, a local model, [or] a lookup service” ([source](https://github.com/nicobailon/pi-subagents/blob/main/examples/typed-gate/classify#L1-L8)).
- Recent upstream issue/PR title+body search found no separate Jev-specific issue, and recent issue-comment/commit-message scans found no Jev discussion. The Jev connection is an intended use of the generic feature, not an upstream integration commitment.

## What is shipped in pi-subagents

### 1. Typed post-run gate

Contract: `gate: { command, output: "json", schema?, timeoutMs? }`; the string form remains unchanged. The command runs after the child's output file is saved, in the child cwd/managed worktree. A successful command must emit one JSON document, at most 12,000 characters. The parsed value is copied to `result.structuredOutput`, the verification ledger, and `status.json`; `runs.lanes` blocks later stages when `structuredOutput.verdict === "blocked"`. See the shipped [typed-gate docs](https://github.com/nicobailon/pi-subagents/blob/main/docs/tool-reference.md#typed-gates) and [workflow example](https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md#typed-post-run-checks-and-typed-steps).

Important guards:

- empty, truncated, non-JSON, or schema-invalid stdout changes the otherwise passing gate to `failed` with `structuredOutputError`; explicit acceptance rejects the run;
- typed gates are never memoized because a report/log can change without the Git tree changing;
- `output: "json"` cannot coexist with an `outputSchema` from launch params or agent frontmatter: one child has one structured-output source;
- accepted object keys are exactly `command`, `output`, `schema`, and `timeoutMs`; `schema` requires `output: "json"`, and `timeoutMs` is an integer >= 1 ([runtime parser](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/acceptance.ts#L205-L257)).

This directly supports “child finishes -> run a Jev-backed classifier -> return a verdict,” provided the local classifier command implements the Jev call and stdout contract.

### 2. Generic typed command-runner step

The shipped pattern is an agent frontmatter entry such as [this classifier](https://github.com/nicobailon/pi-subagents/blob/main/examples/typed-gate/.pi/agents/classifier.md):

```yaml
runner:
  type: external-cli
  command: classify
  args: [--stdin, --json]
  promptDelivery: stdin
async: true
```

The workflow sends task text on stdin and parses the returned `r.output` itself ([docs](https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md#typed-post-run-checks-and-typed-steps), lines 219–243). This is **not** runtime-typed JSON: the runner returns output text; the workflow owns `JSON.parse` and any schema/score checks. It is async-only, gets the assembled prompt rather than a forked transcript, and cannot produce native `structuredOutput` by itself. It is suitable for a Jev wrapper that scores/classifies the prompt or a bounded slice of accessible files.

## Jev: primary documentation, source, and invocation

Primary sources:

- [TypeSafe API reference](https://docs.typesafe.ai/api): `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <API_KEY>`, JSON body `{ state, model, questions }`.
- [Quick start](https://docs.typesafe.ai/introduction/quickstart): curl request and response examples.
- [Questions/primitives](https://docs.typesafe.ai/primitives): `choice`, `score`, and `noul`; the response is structured and probabilistic.
- Official JS SDK source: [`typesafe-ai/typesafe-sdk-js` v0.6.0 client](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts), [types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts), and [README](https://github.com/typesafe-ai/typesafe-sdk-js/tree/v0.6.0).

Minimal implementation shape for a local `classify` command (illustrative, not shipped):

```ts
import { choice, score, TypeSafeClient } from "@typesafe-ai/sdk";
const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY; default model jev-latest
const response = await client.systemOne({
  state: reportText,
  questions: {
    verdict: choice("Is this review acceptable or blocked?", { ok: null, blocked: null }),
    risk: score("How serious is the highest finding?", ["low", "medium", "high"]),
  },
});
process.stdout.write(JSON.stringify({
  verdict: response.answers.verdict.choice,
  risk: response.answers.risk.score,
}));
```

The wrapper must keep diagnostics off stdout (or emit only one JSON document), preserve the API key outside persisted workflow/agent text, and use the gate schema to constrain the boundary.

## Runtime, security, cost, and failure constraints

### pi-subagents execution

- **Gate command:** upstream executes the verification command as a host child with `shell: true`, no stdin, piped stdout/stderr, child/worktree cwd, and a default verification timeout of 120,000 ms unless overridden ([source](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/acceptance.ts#L1450-L1506)). This is a trusted-local-command boundary, not a sandbox. Treat workflow/agent gate strings as code with the host user's permissions.
- Gate stdout/stderr are trimmed to 12,000 characters; a typed gate detects the truncation marker and fails rather than guessing. A timeout sends SIGTERM and then SIGKILL after 1 second. Nonzero exit, timeout, spawn error, invalid JSON, or schema failure rejects explicit acceptance.
- **External CLI step:** upstream uses `spawn(command, args, { shell: false, stdio: ["pipe","pipe","pipe"] })`, writes the prompt to stdin, and owns the process tree ([source](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/external-cli-runner.ts#L326-L414)). Output tails are capped at 64 KiB and raw stdout/stderr logs at 8 MiB by default. Without an environment allowlist, the command inherits the process environment ([source](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/external-cli-runner.ts#L88-L100)); use an allowlist where supported.
- External CLI agents are async-only and do not inherit a forked transcript. They are local-only generic commands; do not assume worktree isolation or native Pi structured-output/acceptance semantics beyond what the profile explicitly implements.

### Jev service

- [Models/pricing/limits](https://docs.typesafe.ai/models): Jev 1.13 is listed at **$42 per billion input tokens ($0.042/Mtok)**; output tokens are free. Current documented limits are 250,000 tokens/second and 1,200 requests/minute, with a 64k total request context and a 32k state + longest-question budget. Limits may change dynamically.
- Input is text only (string, JSON object, or array of text); images/audio/video need preprocessing. `jev-latest` is an alias and can move; pin `jev-1.13.0` when reproducibility matters. The response reports the versioned model used.
- Official JS SDK defaults are Node >=20, `jev-latest`, a 10,000 ms timeout **per attempt**, and two retries with exponential backoff (500 ms up to 5 s, jitter), honoring `Retry-After` up to 60 s. It retries 408/429/5xx, connection errors, and timeouts; 401/422 are not retryable. See the SDK [retry implementation](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/retry.ts), [client implementation](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts), and [error docs](https://docs.typesafe.ai/sdk/python/api/exceptions.md).
- TypeSafe documents that Jev can be literal, weak at arithmetic/counting/date comparison, sensitive to irrelevant context and adversarial content, and is not a generative model ([Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)). Keep thresholds and arithmetic in code; test false positives/negatives on project data.
- Security/data: the SDK refuses browser use by default because it would expose the key; `dangerouslyAllowBrowser` opts in ([SDK config](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md)). TypeSafe says requests/responses are not used to train models and offers zero-data-retention for enterprise customers, but the precise retention/DPA terms need review for the intended account ([legal docs](https://docs.typesafe.ai/legal)). At SDK debug logging, headers are redacted but request bodies are not; do not enable debug logging with sensitive reports.

## Unresolved questions

1. Should a Jev-backed gate be explicitly marked/allowlisted as a first-class provider, rather than remaining arbitrary shell code?
2. What exact API-key/environment propagation policy is acceptable for async runners, especially on shared machines and Herdr? The generic external runner can inherit environment unless constrained.
3. Does the workflow need a total Jev budget, concurrency limiter, or deduplication policy? pi-subagents' typed gates deliberately disable memoization; every changed report can incur a new Jev call.
4. What evidence should be persisted: raw Jev probabilities, model version, input/state digest, threshold, and retry metadata, or only the final verdict? The current gate persists parsed stdout, not Jev-specific provenance.
5. Which failure policy is desired for a classifier outage: fail closed (current explicit gate behavior), allow/route to human, or distinguish “service unavailable” from “blocked”?
6. Has the target TypeSafe account accepted the current dynamic rate limits, pricing, retention, and data-processing terms?

## Recommendations

- Treat [#2315](https://github.com/nicobailon/pi-subagents/pull/2315) as the shipped integration seam, not evidence of a shipped Jev integration.
- Prefer a **typed gate** for post-run review/report verdicts: it runs after the output is durable, has JSON Schema validation, and exposes `structuredOutput` directly to lanes.
- Use an **external-cli typed step** for independent prompt/item classification or fanout; make the wrapper print only compact JSON and validate it in workflow code. Do not call it “native typed output” unless adding a separate schema contract.
- Pin `jev-1.13.0` for stable behavior, batch independent questions in one API request, keep state minimal, set an explicit gate timeout that covers SDK retries, and budget input tokens/concurrency.
- Keep API keys in an environment/file controlled by the runner, never in agent frontmatter or workflow source. Disable debug logging for sensitive states, redact reports before transmission where possible, and record model/version, probabilities, threshold, and failure class in a separate bounded evidence object.
