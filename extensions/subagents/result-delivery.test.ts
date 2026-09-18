import assert from "node:assert/strict";
import test from "node:test";
import {
  createParentMailbox,
  PARENT_RESULT_LIMITS,
  parentResultEnvelope,
  type ParentResultEnvelope,
} from "./src/parent-mailbox.ts";
import type { ParentRef, SubagentSnapshot } from "./src/domain.ts";
import {
  buildParentResultBatchMessage,
  PARENT_RESULT_BATCH_OPTIONS,
} from "./src/parent-message.ts";
import { buildSubagentWaitResult } from "./src/result-delivery.ts";

function ref(overrides: Partial<ParentRef> = {}): ParentRef {
  return {
    epoch: 1,
    sessionFile: "/tmp/parent.jsonl",
    leafId: "leaf-1",
    ...overrides,
  };
}

function envelope(
  id: string,
  parentRef: ParentRef = ref(),
  output = id,
): ParentResultEnvelope {
  return {
    id,
    title: id,
    status: "done",
    output,
    parentRef,
  };
}

test("mailbox preserves settlement order and replaces without reordering", () => {
  const mailbox = createParentMailbox({ maxCount: 8, maxBytes: 10_000 });
  mailbox.enqueue(envelope("first"));
  mailbox.enqueue(envelope("second"));
  mailbox.enqueue(envelope("first", ref(), "replacement"));

  assert.deepEqual(
    mailbox.list().map((result) => [result.id, result.output]),
    [
      ["first", "replacement"],
      ["second", "second"],
    ],
  );
});

test("mailbox drops deterministic oldest entries at count and UTF-8 byte bounds", () => {
  const countBounded = createParentMailbox({ maxCount: 2, maxBytes: 10_000 });
  countBounded.enqueue(envelope("a"));
  countBounded.enqueue(envelope("b"));
  countBounded.enqueue(envelope("c"));
  assert.deepEqual(
    countBounded.list().map((result) => result.id),
    ["b", "c"],
  );
  assert.ok(countBounded.size() <= 2);

  const byteBounded = createParentMailbox({ maxCount: 8, maxBytes: 180 });
  byteBounded.enqueue(envelope("old", ref(), "😀".repeat(30)));
  byteBounded.enqueue(envelope("new", ref(), "ok"));
  assert.ok(byteBounded.byteSize() <= 180);
  assert.deepEqual(
    byteBounded.list().map((result) => result.id),
    ["new"],
  );
});

test("mailbox keeps directly enqueued envelopes pre-bounded", () => {
  const mailbox = createParentMailbox();
  mailbox.enqueue(
    envelope(
      "i".repeat(PARENT_RESULT_LIMITS.maxIdLength * 2),
      ref(),
      "x".repeat(PARENT_RESULT_LIMITS.maxOutputBytes * 2),
    ),
  );
  const result = mailbox.list()[0];
  assert.ok(result);
  assert.ok(result.id.length <= PARENT_RESULT_LIMITS.maxIdLength);
  assert.ok(
    Buffer.byteLength(result.output, "utf8") <=
      PARENT_RESULT_LIMITS.maxOutputBytes,
  );
  assert.ok(Buffer.byteLength(result.title, "utf8") > 0);
});
test("consume and drain are isolated by ParentRef", () => {
  const mailbox = createParentMailbox({ maxCount: 8, maxBytes: 10_000 });
  const first = ref();
  const second = ref({ epoch: 2 });
  mailbox.enqueue(envelope("same", first));
  mailbox.enqueue(envelope("same", second));

  mailbox.consume(["same"], first);
  assert.deepEqual(
    mailbox.list().map((result) => result.parentRef.epoch),
    [2],
  );
  assert.deepEqual(mailbox.drain(first), []);
  assert.deepEqual(
    mailbox.drain(second).map((result) => result.id),
    ["same"],
  );
});

test("snapshot conversion bounds terminal fields and omits private metadata", () => {
  const snapshot: SubagentSnapshot = {
    id: "sa-1",
    backend: "pi",
    owner: "subagents",
    resultDelivery: "parent",
    parentRef: ref(),
    title: "title\nwith whitespace",
    prompt: "prompt",
    cwd: "/private/project",
    status: "error",
    createdAt: 1,
    settledAt: 2,
    lastActivityAt: 2,
    errorText: "😀".repeat(3_000),
    finalText: "output",
    meta: {
      backend: "pi",
      sessionFilePath: "/private/child.jsonl",
      nativeSessionId: "secret",
    },
    usage: {},
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    turns: 0,
  };
  const result = parentResultEnvelope(snapshot);
  assert.ok(result);
  assert.equal(
    parentResultEnvelope({
      ...snapshot,
      resultDelivery: "client",
      client: { id: "client-owner", correlationId: "run-1" },
    }),
    undefined,
  );
  assert.equal(result?.title, "title with whitespace");
  assert.equal(result?.output, "output");
  assert.ok(Buffer.byteLength(result?.error ?? "", "utf8") <= 4 * 1024);
  assert.doesNotMatch(
    JSON.stringify({
      id: result?.id,
      title: result?.title,
      status: result?.status,
      error: result?.error,
      output: result?.output,
    }),
    /private|session|native|cwd|model/,
  );
});

test("parent message is one bounded batch with public details and follow-up options", () => {
  const message = buildParentResultBatchMessage([
    envelope("one", ref(), "first"),
    envelope("two", ref(), "second"),
  ]);
  assert.equal(message.customType, "subagent-result-batch");
  assert.equal(message.display, true);
  assert.deepEqual(message.details, {
    results: [
      { id: "one", title: "one", status: "done" },
      { id: "two", title: "two", status: "done" },
    ],
  });
  assert.deepEqual(PARENT_RESULT_BATCH_OPTIONS, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  assert.doesNotMatch(
    JSON.stringify(message),
    /sessionFile|leafId|epoch|cwd|model/,
  );
});

test("workflow aggregate keeps its kind on the existing parent result rail", () => {
  const aggregate: ParentResultEnvelope = {
    kind: "workflow",
    id: "wf-1",
    title: "workflow one",
    status: "done",
    output: "Workflow wf-1 completed.",
    parentRef: ref(),
  };
  const mailbox = createParentMailbox();
  mailbox.enqueue(aggregate);
  assert.equal(mailbox.list()[0]?.kind, "workflow");
  const message = buildParentResultBatchMessage([aggregate]);
  assert.deepEqual(message.details, {
    results: [
      { kind: "workflow", id: "wf-1", title: "workflow one", status: "done" },
    ],
  });
  assert.match(message.content, /^Workflow wf-1/);
});

test("automatic parent delivery preserves pass, reject, and error acceptance", () => {
  const snapshot = (
    id: string,
    acceptance: NonNullable<SubagentSnapshot["acceptance"]>,
  ): SubagentSnapshot => ({
    id,
    backend: "pi",
    owner: "subagents",
    resultDelivery: "parent",
    parentRef: ref(),
    title: id,
    prompt: "produce evidence",
    cwd: "/private/project",
    status: "done",
    createdAt: 1,
    settledAt: 2,
    lastActivityAt: 2,
    outcome: {
      _tag: "Completed",
      finalText: `SECRET FULL REPORT ${id}`,
    },
    acceptance,
    finalText: `SECRET FULL REPORT ${id}`,
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    turns: 0,
  });
  const pending = parentResultEnvelope(
    snapshot("pending", { status: "pending" }),
  );
  assert.equal(pending, undefined);

  const envelopes = [
    parentResultEnvelope(snapshot("passed", { status: "pass" })),
    parentResultEnvelope(
      snapshot("rejected", { status: "reject", reason: "proof is incomplete" }),
    ),
    parentResultEnvelope(
      snapshot("errored", {
        status: "error",
        reason: "evaluation timed out",
      }),
    ),
  ];
  assert.ok(envelopes.every((result) => result !== undefined));
  const batch = buildParentResultBatchMessage(
    envelopes.filter((result): result is ParentResultEnvelope => !!result),
  );

  assert.deepEqual(batch.details.results, [
    {
      id: "passed",
      title: "passed",
      status: "done",
      acceptance: { status: "pass" },
    },
    {
      id: "rejected",
      title: "rejected",
      status: "done",
      acceptance: { status: "reject", reason: "proof is incomplete" },
    },
    {
      id: "errored",
      title: "errored",
      status: "done",
      acceptance: { status: "error", reason: "evaluation timed out" },
    },
  ]);
  assert.match(batch.content, /passed acceptance/);
  assert.match(batch.content, /rejected by acceptance/);
  assert.match(batch.content, /acceptance failed/);
  assert.match(batch.content, /Acceptance: reject — proof is incomplete/);
  assert.match(batch.content, /Acceptance: error — evaluation timed out/);
  assert.doesNotMatch(batch.content, /SECRET FULL REPORT/);
  assert.doesNotMatch(JSON.stringify(batch.details), /SECRET FULL REPORT/);
  assert.match(batch.content, /subagent_inspect/);

  const wait = buildSubagentWaitResult(
    envelopes.map((result) => {
      assert.ok(result);
      const acceptance = result.acceptance;
      assert.ok(acceptance);
      return {
        id: result.id,
        snapshot: snapshot(result.id, acceptance),
      };
    }),
  );
  assert.match(wait.text, /passed acceptance/);
  assert.match(wait.text, /rejected by acceptance/);
  assert.match(wait.text, /acceptance failed/);
  assert.doesNotMatch(wait.text, /SECRET FULL REPORT/);
  assert.doesNotMatch(JSON.stringify(wait.details), /SECRET FULL REPORT/);
  assert.deepEqual(
    wait.details.results.map((result) => result.acceptance?.status),
    ["pass", "reject", "error"],
  );
});

test("ungated automatic and wait delivery retain report content", () => {
  const ungated = envelope("ungated", ref(), "UNCHANGED FULL REPORT");
  const automatic = buildParentResultBatchMessage([ungated]);
  assert.match(automatic.content, /UNCHANGED FULL REPORT/);

  const snap: SubagentSnapshot = {
    id: "ungated",
    backend: "pi",
    owner: "subagents",
    resultDelivery: "parent",
    parentRef: ref(),
    title: "ungated",
    prompt: "report",
    cwd: "/project",
    status: "done",
    createdAt: 1,
    settledAt: 2,
    lastActivityAt: 2,
    outcome: { _tag: "Completed", finalText: "UNCHANGED FULL REPORT" },
    finalText: "UNCHANGED FULL REPORT",
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    turns: 0,
  };
  const wait = buildSubagentWaitResult([{ id: snap.id, snapshot: snap }]);
  assert.match(wait.text, /UNCHANGED FULL REPORT/);
  assert.deepEqual(wait.details.results, [
    { id: "ungated", title: "ungated", status: "done" },
  ]);
});

test("automatic parent delivery bounds acceptance reasons", () => {
  const mailbox = createParentMailbox();
  mailbox.enqueue({
    ...envelope("bounded-acceptance"),
    acceptance: { status: "reject", reason: "😀".repeat(3_000) },
  });
  const reason = mailbox.list()[0]?.acceptance?.reason ?? "";
  assert.ok(
    Buffer.byteLength(reason, "utf8") <=
      PARENT_RESULT_LIMITS.maxAcceptanceReasonBytes,
  );
});
