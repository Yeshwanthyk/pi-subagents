/* eslint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof -- Adversarial fixtures intentionally construct malformed untyped service payloads. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createJevClient,
  evaluateJev,
  JEV_ENDPOINT,
  JEV_LIMITS,
  type JevEvaluationInput,
  type JevTransport,
} from "./index.ts";

const input = {
  state: "A small bounded report",
  questions: {
    verdict: {
      type: "choice",
      question: "What is the verdict?",
      options: ["ok", "blocked"],
    },
    risk: {
      type: "score",
      question: "How severe is the risk?",
      criteria: ["low", "medium", "high"],
    },
  },
} as const;

function successBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: {
      verdict: {
        type: "choice",
        choice: "ok",
        confidence: 0.8,
        probabilities: { ok: 0.8, blocked: 0.2 },
      },
      risk: {
        type: "score",
        score: 1.25,
        confidence: 0.7,
        legend: { 0: "low", 1: "medium", 2: "high" },
        probabilities: { 0: 0.1, 1: 0.55, 2: 0.35 },
      },
    },
    usage: { input_tokens: 12, output_tokens: 0 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(transport: JevTransport, extra: Record<string, unknown> = {}) {
  return createJevClient({
    env: { TEST_JEV_KEY: "secret" },
    apiKeyEnv: "TEST_JEV_KEY",
    transport,
    ...extra,
  });
}

async function errorCode(
  promise: ReturnType<ReturnType<typeof client>["evaluate"]>,
): Promise<string> {
  const result = await promise;
  assert.equal(result.ok, false);
  return result.error.code;
}

test("sends the documented first-party wire contract and normalizes answers", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const evaluator = client(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse(successBody());
  });

  const result = await evaluateJev(evaluator, input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.answers.verdict, {
    type: "choice",
    value: "ok",
    confidence: 0.8,
    probabilities: { ok: 0.8, blocked: 0.2 },
  });
  assert.equal(result.answers.risk.value, 1.25);
  assert.deepEqual(result.metadata.usage, { inputTokens: 12, outputTokens: 0 });
  assert.equal(result.metadata.inputDigest.length, 64);
  assert.equal(capturedUrl, JEV_ENDPOINT);
  assert.equal(capturedInit?.method, "POST");
  assert.ok(capturedInit);
  assert.equal(
    (capturedInit.headers as Record<string, string>).Authorization,
    "Bearer secret",
  );
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    state: input.state,
    model: "jev-1.13.0",
    questions: {
      verdict: {
        type: "choice",
        instructions: "What is the verdict?",
        criteria: { ok: null, blocked: null },
      },
      risk: {
        type: "score",
        instructions: "How severe is the risk?",
        criteria: ["low", "medium", "high"],
      },
    },
  });
});

test("environment credential is sufficient and missing credentials never call transport", async () => {
  let calls = 0;
  const transport = async (): Promise<Response> => {
    calls += 1;
    return jsonResponse(successBody());
  };
  const configured = createJevClient({
    env: { TYPESAFE_API_KEY: "secret" },
    transport,
  });
  assert.equal(calls, 0);
  assert.equal((await configured.evaluate(input)).ok, true);
  assert.equal(calls, 1);
  assert.equal(
    await errorCode(createJevClient({ env: {}, transport }).evaluate(input)),
    "not_configured",
  );
  assert.equal(calls, 1);
});

test("strictly validates inputs before transport", async () => {
  let calls = 0;
  const evaluator = client(async () => {
    calls += 1;
    return jsonResponse(successBody());
  });
  const cases: unknown[] = [
    { ...input, extra: true },
    { ...input, state: "" },
    { ...input, questions: {} },
    {
      ...input,
      questions: { q: { type: "choice", question: "q", options: ["x"] } },
    },
    {
      ...input,
      questions: {
        q: { type: "choice", question: "q", options: ["x", "x"] },
      },
    },
    {
      ...input,
      questions: {
        q: {
          type: "choice",
          question: "q",
          options: ["ok", "__proto__"],
        },
      },
    },
    {
      ...input,
      questions: {
        q: { type: "score", question: "q", criteria: ["x", "y"], nope: 1 },
      },
    },
    {
      ...input,
      questions: Object.fromEntries(
        Array.from({ length: JEV_LIMITS.maxQuestions + 1 }, (_, index) => [
          `q${index}`,
          { type: "choice", question: "q", options: ["x", "y"] },
        ]),
      ),
    },
    {
      ...input,
      questions: {
        q: {
          type: "score",
          question: "q",
          criteria: Array.from({ length: 11 }, (_, index) => `level-${index}`),
        },
      },
    },
    { ...input, state: "x".repeat(JEV_LIMITS.maxInputBytes) },
  ];
  for (const value of cases) {
    assert.equal(
      await errorCode(evaluator.evaluate(value as JevEvaluationInput)),
      "invalid_input",
    );
  }
  assert.equal(calls, 0);
});

test("rejects malformed or semantically invalid service answers", async () => {
  const bodies = [
    "not json",
    { ...successBody(), extra: true },
    successBody({ answers: {} }),
    successBody({
      answers: {
        ...(successBody().answers as Record<string, unknown>),
        verdict: { type: "choice", choice: "unknown" },
      },
    }),
    successBody({
      answers: {
        ...(successBody().answers as Record<string, unknown>),
        risk: { type: "score", score: Number.NaN },
      },
    }),
    successBody({
      answers: {
        ...(successBody().answers as Record<string, unknown>),
        risk: { type: "score", score: 3 },
      },
    }),
    successBody({
      answers: {
        ...(successBody().answers as Record<string, unknown>),
        verdict: {
          type: "choice",
          choice: "ok",
          probabilities: { ok: 1.1, blocked: -0.1 },
        },
      },
    }),
  ];
  for (const body of bodies) {
    const evaluator = client(async () =>
      typeof body === "string" ? new Response(body) : jsonResponse(body),
    );
    assert.equal(
      await errorCode(evaluator.evaluate(input)),
      "invalid_response",
    );
  }
});

test("requires documented answer and usage fields", async () => {
  const complete = successBody();
  const completeAnswers = complete.answers as Record<string, unknown>;
  const verdict = completeAnswers.verdict as Record<string, unknown>;
  const risk = completeAnswers.risk as Record<string, unknown>;
  const bodies = [
    { ...complete, usage: undefined },
    {
      ...complete,
      answers: {
        ...completeAnswers,
        verdict: { ...verdict, confidence: undefined },
      },
    },
    {
      ...complete,
      answers: {
        ...completeAnswers,
        verdict: { ...verdict, probabilities: undefined },
      },
    },
    {
      ...complete,
      answers: { ...completeAnswers, risk: { ...risk, legend: undefined } },
    },
  ];
  for (const body of bodies) {
    assert.equal(
      await errorCode(client(async () => jsonResponse(body)).evaluate(input)),
      "invalid_response",
    );
  }
});

test("bounds response bytes with and without content-length", async () => {
  const oversized = "x".repeat(JEV_LIMITS.maxResponseBytes + 1);
  const declared = client(
    async () =>
      new Response("{}", {
        headers: { "content-length": String(JEV_LIMITS.maxResponseBytes + 1) },
      }),
  );
  const streamed = client(async () => new Response(oversized));
  assert.equal(await errorCode(declared.evaluate(input)), "invalid_response");
  assert.equal(await errorCode(streamed.evaluate(input)), "invalid_response");
});

test("normalizes HTTP and transport failures without exposing response bodies", async () => {
  const cases: readonly [number, string][] = [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "rate_limited"],
    [422, "invalid_input"],
    [500, "transport_error"],
  ];
  for (const [status, code] of cases) {
    const result = await client(
      async () => new Response("sensitive upstream detail", { status }),
    ).evaluate(input);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, code);
    assert.equal(result.error.message.includes("sensitive"), false);
  }
  assert.equal(
    await errorCode(
      client(async () => {
        throw new Error("secret transport diagnostic");
      }).evaluate(input),
    ),
    "transport_error",
  );
});

test("makes exactly one transport attempt", async () => {
  let calls = 0;
  const evaluator = client(async () => {
    calls += 1;
    return new Response(null, { status: 500 });
  });
  assert.equal(await errorCode(evaluator.evaluate(input)), "transport_error");
  assert.equal(calls, 1);
});

test("non-2xx disposal never waits for a stalled body cancellation", async () => {
  let calls = 0;
  let cancellations = 0;
  const evaluator = client(
    async () => {
      calls += 1;
      return new Response(
        new ReadableStream({
          cancel() {
            cancellations += 1;
            return new Promise<void>(() => undefined);
          },
        }),
        { status: 500 },
      );
    },
    { maxConcurrent: 1, timeoutMs: 100 },
  );
  assert.equal(await errorCode(evaluator.evaluate(input)), "transport_error");
  assert.equal(await errorCode(evaluator.evaluate(input)), "transport_error");
  assert.equal(calls, 2);
  assert.equal(cancellations, 2);
});

test("total timeout covers transport that ignores cancellation", async () => {
  const evaluator = client(() => new Promise<Response>(() => undefined), {
    timeoutMs: 20,
  });
  const started = Date.now();
  assert.equal(await errorCode(evaluator.evaluate(input)), "timeout");
  assert.ok(Date.now() - started < 500);
});

test("caller cancellation is distinct from timeout", async () => {
  const evaluator = client(() => new Promise<Response>(() => undefined), {
    timeoutMs: 1_000,
  });
  const controller = new AbortController();
  const pending = evaluator.evaluate(input, { signal: controller.signal });
  controller.abort();
  assert.equal(await errorCode(pending), "cancelled");
});

test("stalled response reads observe timeout and cancel without retaining the slot", async () => {
  let calls = 0;
  let cancellations = 0;
  const evaluator = client(
    async () => {
      calls += 1;
      if (calls > 1) return jsonResponse(successBody());
      return new Response(
        new ReadableStream({
          pull() {
            return new Promise<void>(() => undefined);
          },
          cancel() {
            cancellations += 1;
            return new Promise<void>(() => undefined);
          },
        }),
      );
    },
    { maxConcurrent: 1, timeoutMs: 40 },
  );
  assert.equal(await errorCode(evaluator.evaluate(input)), "timeout");
  assert.equal(cancellations, 1);
  assert.equal((await evaluator.evaluate(input)).ok, true);
  assert.equal(calls, 2);
});

test("bounds concurrency and pending queue", async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const evaluator = client(
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return jsonResponse(successBody());
    },
    { maxConcurrent: 1, maxQueue: 1, timeoutMs: 1_000 },
  );
  const first = evaluator.evaluate(input);
  const second = evaluator.evaluate(input);
  const third = evaluator.evaluate(input);
  assert.equal(await errorCode(third), "overloaded");
  assert.equal(peak, 1);
  releases.shift()?.();
  assert.equal((await first).ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peak, 1);
  releases.shift()?.();
  assert.equal((await second).ok, true);
});

test("total timeout includes time waiting in the admission queue", async () => {
  let release: (() => void) | undefined;
  const evaluator = client(
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return jsonResponse(successBody());
    },
    { maxConcurrent: 1, maxQueue: 1, timeoutMs: 30 },
  );
  const first = evaluator.evaluate(input);
  const second = evaluator.evaluate(input);
  assert.equal(await errorCode(second), "timeout");
  release?.();
  assert.equal(await errorCode(first), "timeout");
});

test("validates client configuration synchronously", () => {
  for (const enabled of [false, true]) {
    const legacy = { apiKeyEnv: "TYPESAFE_API_KEY", enabled };
    assert.throws(
      () => createJevClient(legacy),
      /enabled.*obsolete/,
    );
  }
  assert.throws(() => createJevClient({ apiKeyEnv: "not valid" }), TypeError);
  assert.throws(() => createJevClient({ timeoutMs: 0 }), TypeError);
  assert.throws(() => createJevClient({ maxConcurrent: 0 }), TypeError);
  assert.doesNotThrow(() => createJevClient({ maxQueue: 0 }));
});
