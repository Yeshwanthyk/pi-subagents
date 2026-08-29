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
