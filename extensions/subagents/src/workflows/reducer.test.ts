import assert from "node:assert/strict";
import test from "node:test";
import type { ValidatedWorkflowDefinition } from "./domain.ts";
import type { WorkflowEvent } from "./events.ts";
import {
  foldWorkflowEvents,
  reduceWorkflowEvent,
  WorkflowInvariantError,
} from "./reducer.ts";

const definition: ValidatedWorkflowDefinition = {
  name: "dependency branches",
  tasks: [
    {
      id: "root",
      label: "Root",
      kind: "scout",
      prompt: "inspect",
      readOnly: true,
    },
    {
      id: "child",
      label: "Child",
      kind: "writer",
      prompt: "write",
      needs: ["root"],
      owns: ["src/child.ts"],
    },
    {
      id: "grandchild",
      label: "Grandchild",
      kind: "proof",
      prompt: "prove",
      needs: ["child"],
      readOnly: true,
    },
    {
      id: "independent",
      label: "Independent",
      kind: "review",
      prompt: "review",
      readOnly: true,
    },
  ],
};

type WorkflowEventInput = WorkflowEvent extends infer Event
  ? Event extends WorkflowEvent
    ? Omit<Event, "runId" | "at">
    : never
  : never;

function event(at: number, value: WorkflowEventInput): WorkflowEvent {
  // SAFETY: WorkflowEventInput is the distributive union with only base fields removed.
  return { ...value, runId: "wf-test", at } as WorkflowEvent;
}

function runningEvents(): WorkflowEvent[] {
  return [
    event(1, { _tag: "WorkflowCreated", definition }),
    event(2, { _tag: "WorkflowStarted" }),
  ];
}

test("pure replay matches incremental folding", () => {
  const events: WorkflowEvent[] = [
    ...runningEvents(),
    event(3, { _tag: "TaskQueued", taskId: "root", childId: "sa-1" }),
    event(4, { _tag: "TaskStarted", taskId: "root" }),
    event(5, {
      _tag: "TaskCompleted",
      taskId: "root",
      resultPreview: "found it",
    }),
  ];

  let live = reduceWorkflowEvent(undefined, events[0]!);
  for (const next of events.slice(1)) live = reduceWorkflowEvent(live, next);

  assert.deepEqual(foldWorkflowEvents(events), live);
  assert.equal(live.tasks.child?.status, "ready");
  assert.equal(live.createdAt, 1);
  assert.equal(live.startedAt, 2);
  assert.equal(live.finishedAt, undefined);
  assert.equal(live.lastActivityAt, 5);
});

test("invalid task transitions fail closed without changing prior state", () => {
  const state = foldWorkflowEvents(runningEvents());

  assert.throws(
    () =>
      reduceWorkflowEvent(
        state,
        event(3, { _tag: "TaskStarted", taskId: "root" }),
      ),
    WorkflowInvariantError,
  );
  assert.equal(state.tasks.root?.status, "ready");
  assert.equal(state.version, 2);
});

test("a failed dependency skips only transitive descendants", () => {
  const events: WorkflowEvent[] = [
    ...runningEvents(),
    event(3, { _tag: "TaskQueued", taskId: "root", childId: "sa-1" }),
    event(4, { _tag: "TaskStarted", taskId: "root" }),
    event(5, { _tag: "TaskFailed", taskId: "root", error: "no source" }),
  ];
  const state = foldWorkflowEvents(events);

  assert.equal(state.tasks.root?.status, "failed");
  assert.equal(state.tasks.child?.status, "skipped");
  assert.equal(state.tasks.grandchild?.status, "skipped");
  assert.equal(state.tasks.independent?.status, "ready");
  assert.deepEqual(state.tasks.grandchild?.outcome, {
    _tag: "Skipped",
    failedDependencyId: "root",
    reason: "no source",
  });
});

test("task and workflow terminal states are first-write-wins", () => {
  let state = foldWorkflowEvents([
    ...runningEvents(),
    event(3, { _tag: "TaskQueued", taskId: "root", childId: "sa-1" }),
    event(4, { _tag: "TaskStarted", taskId: "root" }),
    event(5, { _tag: "TaskFailed", taskId: "root", error: "first" }),
  ]);
  const afterLateTaskTerminal = reduceWorkflowEvent(
    state,
    event(6, { _tag: "TaskCompleted", taskId: "root" }),
  );
  assert.strictEqual(afterLateTaskTerminal, state);
  assert.deepEqual(state.tasks.root?.outcome, {
    _tag: "Failed",
    error: "first",
  });

  state = reduceWorkflowEvent(
    state,
    event(7, { _tag: "WorkflowFailed", error: "first workflow outcome" }),
  );
  const afterLateWorkflowTerminal = reduceWorkflowEvent(
    state,
    event(1, { _tag: "WorkflowCancelled", reason: "late cancellation" }),
  );
  assert.strictEqual(afterLateWorkflowTerminal, state);
  assert.deepEqual(state.outcome, {
    _tag: "Failed",
    error: "first workflow outcome",
  });
});
