import assert from "node:assert/strict";
import test from "node:test";
import type { ParentRef, SubagentSnapshot } from "./src/domain.ts";
import {
  captureParentRef,
  type ParentSessionManager,
} from "./src/parent-ref.ts";
import { createParentResultCoordinator } from "./src/parent-coordinator.ts";

interface SessionFixture {
  readonly manager: ParentSessionManager;
  setLeaf(leaf: string | null, branch: string[]): void;
  setFile(file: string | undefined): void;
}

function ref(overrides: Partial<ParentRef> = {}): ParentRef {
  return {
    epoch: 4,
    sessionFile: "/parent/session.jsonl",
    leafId: "leaf-1",
    ...overrides,
  };
}

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "pi",
    owner: "subagents",
    resultDelivery: "parent",
    parentRef: ref(),
    title: "task",
    prompt: "do it",
    cwd: "/repo",
    status: "done",
    createdAt: 1,
    settledAt: 2,
    lastActivityAt: 2,
    outcome: { _tag: "Completed", finalText: "done" },
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    finalText: "done",
    turns: 1,
    ...overrides,
  };
}

function sessionManager(): SessionFixture {
  let file: string | undefined = "/parent/session.jsonl";
  let leaf: string | null = "leaf-1";
  let branch = ["root", "leaf-1"];
  const manager: ParentSessionManager = {
    getSessionFile: () => file,
    getLeafId: () => leaf,
    getBranch: () => branch.map((id) => ({ id })),
  };
  return {
    manager,
    setLeaf(nextLeaf, nextBranch) {
      leaf = nextLeaf;
      branch = nextBranch;
    },
    setFile(nextFile) {
      file = nextFile;
    },
  };
}

test("ParentRef captures session file, leaf, and in-memory root exactly once", () => {
  let fileReads = 0;
  let leafReads = 0;
  const manager: ParentSessionManager = {
    getSessionFile: () => {
      fileReads++;
      return "/parent/../parent/session.jsonl";
    },
    getLeafId: () => {
      leafReads++;
      return null;
    },
    getBranch: () => [],
  };

  const captured = captureParentRef(9, manager);
  assert.deepEqual(captured, {
    epoch: 9,
    sessionFile: "/parent/session.jsonl",
    leafId: null,
  });
  assert.equal(fileReads, 1);
  assert.equal(leafReads, 1);
});

test("coordinator sends one ordered batch and only flushes safe descendants", () => {
  const seam = sessionManager();
  const context = { sessionManager: seam.manager, isIdle: () => true };
  const sent: Array<ReadonlyArray<{ id: string; title: string }>> = [];
  const coordinator = createParentResultCoordinator({
    sendBatch: (batch) =>
      sent.push(
        batch.map((result) => ({ id: result.id, title: result.title })),
      ),
  });
  coordinator.startSession(context, 4);

  coordinator.onSettled(snapshot({ id: "sa-1", title: "first" }), false);
  coordinator.onSettled(snapshot({ id: "sa-2", title: "second" }), false);
  assert.equal(coordinator.flush(context), true);
  assert.deepEqual(sent, [
    [
      { id: "sa-1", title: "first" },
      { id: "sa-2", title: "second" },
    ],
  ]);

  seam.setLeaf("sibling", ["root", "sibling"]);
  coordinator.onSettled(snapshot({ id: "sa-sibling" }), false);
  assert.equal(coordinator.flush(context), false);
  assert.equal(coordinator.mailbox.size(), 1);

  seam.setLeaf("child", ["root", "leaf-1", "child"]);
  assert.equal(coordinator.flush(context), true);
  assert.equal(sent.length, 2);

  seam.setFile("/other/session.jsonl");
  coordinator.onSettled(snapshot({ id: "sa-other" }), false);
  assert.equal(coordinator.flush(context), false);
});

test("wait and cancel consumption prevent duplicate delivery, including settled ids", () => {
  const seam = sessionManager();
  const context = { sessionManager: seam.manager, isIdle: () => true };
  let sendCount = 0;
  const coordinator = createParentResultCoordinator({
    sendBatch: () => {
      sendCount++;
    },
  });
  coordinator.startSession(context, 4);
  const settled = snapshot({ id: "sa-consume" });
  coordinator.onSettled(settled, false);
  coordinator.consume([settled]);
  assert.equal(coordinator.flush(context), false);

  coordinator.onSettled(settled, true);
  assert.equal(coordinator.flush(context), false);
  const client = snapshot({
    id: "client-1",
    resultDelivery: "client",
    client: { id: "client-owner", correlationId: "client-run" },
  });
  coordinator.onSettled(client, false);
  assert.equal(coordinator.flush(context), false);
  assert.equal(sendCount, 0);
  assert.equal(coordinator.flush(context), false);
  const misroutedClient = snapshot({
    id: "client-misrouted",
    resultDelivery: "parent",
    client: { id: "client-owner", correlationId: "client-run-2" },
  });
  coordinator.onSettled(misroutedClient, false);
  assert.equal(coordinator.flush(context), false);
  assert.equal(coordinator.mailbox.size(), 0);
  assert.equal(sendCount, 0);
});

test("busy parents defer, changed epochs are isolated, and shutdown suppresses late delivery", () => {
  const seam = sessionManager();
  let idle = false;
  const context = { sessionManager: seam.manager, isIdle: () => idle };
  let sends = 0;
  const coordinator = createParentResultCoordinator({
    sendBatch: () => {
      sends++;
    },
  });
  coordinator.startSession(context, 4);
  coordinator.onSettled(snapshot({ id: "sa-busy" }), false);
  assert.equal(coordinator.flush(context), false);
  idle = true;
  assert.equal(coordinator.flush(context), true);
  assert.equal(sends, 1);

  coordinator.startSession(context, 5);
  coordinator.onSettled(snapshot({ id: "old-epoch", parentRef: ref() }), false);
  assert.equal(coordinator.flush(context), false);
  coordinator.close();
  coordinator.onSettled(snapshot({ id: "late" }), false);
  assert.equal(coordinator.flush(context), false);
  assert.equal(coordinator.mailbox.size(), 0);
  assert.equal(sends, 1);
});

test("persisted root captures reject descendant and sibling delivery", () => {
  const seam = sessionManager();
  seam.setLeaf(null, ["root"]);
  const captured = captureParentRef(4, seam.manager);
  const context = { sessionManager: seam.manager, isIdle: () => true };
  const sent: string[] = [];
  const coordinator = createParentResultCoordinator({
    sendBatch: (batch) => sent.push(...batch.map((result) => result.id)),
  });
  coordinator.startSession(context, 4);
  coordinator.onSettled(
    snapshot({ id: "persisted-root", parentRef: captured }),
    false,
  );

  seam.setLeaf("child", ["root", "child"]);
  assert.equal(coordinator.flush(context), false);
  seam.setLeaf("sibling", ["root", "sibling"]);
  assert.equal(coordinator.flush(context), false);
  assert.equal(coordinator.mailbox.size(), 1);

  seam.setLeaf(null, ["root"]);
  assert.equal(coordinator.flush(context), true);
  assert.deepEqual(sent, ["persisted-root"]);
});

test("in-memory root captures reject descendant and sibling delivery", () => {
  const seam = sessionManager();
  seam.setFile(undefined);
  seam.setLeaf(null, ["root"]);
  const captured = captureParentRef(4, seam.manager);
  const context = { sessionManager: seam.manager, isIdle: () => true };
  let sends = 0;
  const coordinator = createParentResultCoordinator({
    sendBatch: () => {
      sends++;
    },
  });
  coordinator.startSession(context, 4);
  coordinator.onSettled(
    snapshot({ id: "memory-root", parentRef: captured }),
    false,
  );

  seam.setLeaf("child", ["root", "child"]);
  assert.equal(coordinator.flush(context), false);
  seam.setLeaf("sibling", ["root", "sibling"]);
  assert.equal(coordinator.flush(context), false);
  assert.equal(coordinator.mailbox.size(), 1);

  seam.setLeaf(null, ["root"]);
  assert.equal(coordinator.flush(context), true);
  assert.equal(sends, 1);
});

test("workflow aggregate delivery is idle-gated and not duplicated", () => {
  const seam = sessionManager();
  let idle = false;
  const context = { sessionManager: seam.manager, isIdle: () => idle };
  const sent: string[] = [];
  const coordinator = createParentResultCoordinator({
    sendBatch: (batch) => sent.push(...batch.map((result) => result.id)),
  });
  coordinator.startSession(context, 4);
  const result = {
    kind: "workflow" as const,
    id: "wf-1",
    title: "workflow visible",
    status: "done" as const,
    output: "Workflow wf-1 completed.",
    parentRef: ref(),
  };
  coordinator.onWorkflowSettled(result, false);
  assert.equal(coordinator.flush(context), false);
  assert.deepEqual(sent, []);
  idle = true;
  assert.equal(coordinator.flush(context), true);
  assert.equal(coordinator.flush(context), false);
  assert.deepEqual(sent, ["wf-1"]);
});

test("workflow inspection consumption removes a queued aggregate before idle delivery", () => {
  const seam = sessionManager();
  const context = { sessionManager: seam.manager, isIdle: () => true };
  const sent: string[] = [];
  const coordinator = createParentResultCoordinator({
    sendBatch: (batch) => sent.push(...batch.map((result) => result.id)),
  });
  coordinator.startSession(context, 4);
  const result = {
    kind: "workflow" as const,
    id: "wf-inspected",
    title: "workflow inspected",
    status: "error" as const,
    error: "failed",
    output: "Workflow wf-inspected failed.",
    parentRef: ref(),
  };
  coordinator.onWorkflowSettled(result, false);
  coordinator.consumeWorkflow(result.id, result.parentRef);
  coordinator.onWorkflowSettled(result, false);
  assert.equal(coordinator.flush(context), false);
  assert.deepEqual(sent, []);
});
