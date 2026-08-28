import assert from "node:assert/strict";
import test from "node:test";
import type { ValidatedWorkflowDefinition } from "./domain.ts";
import {
  MAX_WORKFLOW_EVENT_TEXT_BYTES,
  MAX_WORKFLOW_LOG_BYTES,
  MAX_WORKFLOW_LOGS,
  utf8Bytes,
} from "./events.ts";
import { WorkflowJournalLimitError, WorkflowManager } from "./manager.ts";

const singleTask: ValidatedWorkflowDefinition = {
  name: "single task",
  tasks: [
    {
      id: "only",
      label: "Only",
      kind: "writer",
      prompt: "make the change",
      owns: ["src/only.ts"],
    },
  ],
};

function manager(options: { maxEvents?: number } = {}) {
  let at = 0;
  return new WorkflowManager({
    createId: () => "wf-1",
    now: () => ++at,
    ...options,
  });
}

function finishSingleTask(workflows: WorkflowManager): void {
  workflows.start("wf-1");
  workflows.queueTask("wf-1", "only", "sa-1");
  workflows.startTask("wf-1", "only");
  workflows.completeTask("wf-1", "only", "done");
}

test("manager live fold and journal replay remain equivalent", () => {
  const workflows = manager();
  workflows.createRun(singleTask);
  finishSingleTask(workflows);
  const live = workflows.complete("wf-1", "all done");

  assert.deepEqual(workflows.replay("wf-1"), live);
  assert.equal(live.status, "completed");
  assert.equal(live.tasks.only?.childId, "sa-1");
  assert.ok(live.finishedAt !== undefined);
  assert.ok(live.lastActivityAt >= live.startedAt!);
});

test("first terminal event owns the outcome and publishes only once", () => {
  const workflows = manager();
  const created = workflows.createRun(singleTask);
  const versions: number[] = [];
  workflows.subscribe(created.id, (snapshot) =>
    versions.push(snapshot.version),
  );
  workflows.start(created.id);
  const failed = workflows.fail(created.id, "provider failed");
  const eventCount = workflows.events(created.id).length;

  const late = workflows.cancel(created.id, "operator cancelled too late");

  assert.strictEqual(late, failed);
  assert.equal(workflows.events(created.id).length, eventCount);
  assert.deepEqual(versions, [2, 3]);
  assert.deepEqual(late.outcome, {
    _tag: "Failed",
    error: "provider failed",
  });
});

test("subscription versions are strictly monotonic and observer failures are isolated", () => {
  const workflows = manager();
  const created = workflows.createRun(singleTask);
  const versions: number[] = [];
  workflows.subscribe(created.id, () => {
    throw new Error("render failed");
  });
  const unsubscribe = workflows.subscribe(created.id, (snapshot) => {
    versions.push(snapshot.version);
  });

  finishSingleTask(workflows);
  unsubscribe();
  workflows.complete(created.id);

  assert.deepEqual(versions, [2, 3, 4, 5]);
  assert.ok(
    versions.every(
      (version, index) => index === 0 || version > versions[index - 1]!,
    ),
  );
});

test("logs are bounded per event, by count, and by aggregate bytes", () => {
  const workflows = manager();
  workflows.createRun({ tasks: [] });
  workflows.start("wf-1");
  const oversized = "😀".repeat(MAX_WORKFLOW_EVENT_TEXT_BYTES);
  for (let index = 0; index < MAX_WORKFLOW_LOGS + 20; index++) {
    workflows.log("wf-1", `${index}:${oversized}`);
  }

  const state = workflows.get("wf-1")!;
  assert.ok(state.logs.length <= MAX_WORKFLOW_LOGS);
  assert.ok(
    state.logs.every(
      (entry) => utf8Bytes(entry.message) <= MAX_WORKFLOW_EVENT_TEXT_BYTES,
    ),
  );
  assert.ok(
    state.logs.reduce((total, entry) => total + utf8Bytes(entry.message), 0) <=
      MAX_WORKFLOW_LOG_BYTES,
  );
  const journalLogs = workflows
    .events("wf-1")
    .filter((event) => event._tag === "WorkflowLogAdded");
  assert.equal(journalLogs.length, state.logs.length);
  assert.ok(
    journalLogs.every(
      (entry) => utf8Bytes(entry.message) <= MAX_WORKFLOW_EVENT_TEXT_BYTES,
    ),
  );
  assert.ok(
    journalLogs.reduce((total, entry) => total + utf8Bytes(entry.message), 0) <=
      MAX_WORKFLOW_LOG_BYTES,
  );
  assert.deepEqual(workflows.replay("wf-1"), state);
  const countBounded = new WorkflowManager({
    createId: () => "wf-count",
    now: () => 1,
  });
  countBounded.createRun({ tasks: [] });
  countBounded.start("wf-count");
  for (let index = 0; index < MAX_WORKFLOW_LOGS + 20; index++) {
    countBounded.log("wf-count", `entry-${index}`);
  }
  assert.equal(countBounded.get("wf-count")?.logs.length, MAX_WORKFLOW_LOGS);
});

test("journal event bound rejects further state changes without corrupting replay", () => {
  const workflows = manager({ maxEvents: 3 });
  workflows.createRun(singleTask);
  const running = workflows.start("wf-1");

  assert.throws(
    () => workflows.queueTask("wf-1", "only", "sa-1"),
    WorkflowJournalLimitError,
  );
  assert.equal(workflows.events("wf-1").length, 2);
  assert.deepEqual(workflows.get("wf-1"), running);
  assert.deepEqual(workflows.replay("wf-1"), running);
  const terminal = workflows.fail("wf-1", "journal capacity reached");
  assert.equal(terminal.status, "failed");
  assert.equal(workflows.events("wf-1").length, 3);
  assert.deepEqual(workflows.replay("wf-1"), terminal);
});

test("manager does not execute children or invent child records", () => {
  const workflows = manager();
  const state = workflows.createRun(singleTask);

  assert.equal(state.status, "pending_approval");
  assert.equal(state.tasks.only?.status, "ready");
  assert.equal(state.tasks.only?.childId, undefined);
  assert.equal(workflows.events(state.id).length, 1);
});
