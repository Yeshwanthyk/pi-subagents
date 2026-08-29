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
  const lifecycle =
    value._tag === "TaskQueued" ||
    value._tag === "TaskStarted" ||
    value._tag === "TaskCompleted" ||
    value._tag === "TaskFailed" ||
    value._tag === "TaskCancelled" ||
    value._tag === "TaskSkipped";
  // SAFETY: The helper restores the shared fields for a typed fixture.
  let result = { ...value, runId: "wf-test", at } as WorkflowEvent;
  if (lifecycle && (!("attemptId" in value) || value.attemptId === undefined)) {
    // SAFETY: This branch is restricted to lifecycle variants that carry an
    // optional attemptId, and supplies the fixture's first-attempt identity.
    result = { ...result, attemptId: "attempt-1" } as WorkflowEvent;
  }
  return result;
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

test("reducer read models are deeply immutable projections", () => {
  let state = foldWorkflowEvents(runningEvents());
  state = reduceWorkflowEvent(
    state,
    event(3, { _tag: "TaskQueued", taskId: "root", childId: "sa-1" }),
  );
  state = reduceWorkflowEvent(
    state,
    event(4, { _tag: "TaskStarted", taskId: "root" }),
  );
  state = reduceWorkflowEvent(
    state,
    event(5, { _tag: "TaskCompleted", taskId: "root", resultPreview: "done" }),
  );
  state = reduceWorkflowEvent(
    state,
    event(6, { _tag: "WorkflowLogAdded", level: "info", message: "log" }),
  );
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.definition), true);
  assert.equal(Object.isFrozen(state.definition.tasks), true);
  assert.equal(Object.isFrozen(state.tasks), true);
  assert.equal(Object.isFrozen(state.tasks.root), true);
  assert.equal(Object.isFrozen(state.tasks.root?.outcome), true);
  assert.equal(Object.isFrozen(state.logs), true);
  assert.equal(Object.isFrozen(state.logs[0]), true);
  assert.throws(
    () =>
      Object.defineProperty(state.tasks, "new", { value: state.tasks.root }),
    TypeError,
  );
  assert.throws(
    () =>
      Object.defineProperty(state.tasks.root!, "status", { value: "failed" }),
    TypeError,
  );
  assert.throws(
    () => Object.defineProperty(state.logs[0]!, "message", { value: "leak" }),
    TypeError,
  );
  assert.equal(state.tasks.root?.status, "completed");
  assert.equal(state.logs[0]?.message, "log");
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

test("opaque task IDs remain own keys throughout the reducer projection", () => {
  const ids = ["__proto__", "constructor", "prototype"];
  const definition: ValidatedWorkflowDefinition = {
    tasks: ids.map((id) => ({
      id,
      label: id,
      kind: "scout" as const,
      prompt: `inspect ${id}`,
      readOnly: true as const,
    })),
  };
  const events: WorkflowEvent[] = [
    event(1, { _tag: "WorkflowCreated", definition }),
    event(2, { _tag: "WorkflowStarted" }),
  ];
  let state = foldWorkflowEvents(events);

  assert.equal(Object.getPrototypeOf(state.tasks), null);
  assert.deepEqual(Object.keys(state.tasks), ids);
  for (const id of ids) assert.equal(state.tasks[id]?.status, "ready");

  let at = 2;
  for (const id of ids) {
    state = reduceWorkflowEvent(
      state,
      event(++at, { _tag: "TaskQueued", taskId: id, childId: `child-${id}` }),
    );
    state = reduceWorkflowEvent(
      state,
      event(++at, { _tag: "TaskStarted", taskId: id }),
    );
    state = reduceWorkflowEvent(
      state,
      event(++at, { _tag: "TaskCompleted", taskId: id }),
    );
  }

  assert.deepEqual(
    ids.map((id) => state.tasks[id]?.status),
    ["completed", "completed", "completed"],
  );
  assert.deepEqual(Object.keys(state.tasks), ids);
  assert.equal(Object.getPrototypeOf(state.tasks), null);
});

test("paused workflows continue folding already-admitted children", () => {
  const state = foldWorkflowEvents([
    ...runningEvents(),
    event(3, {
      _tag: "TaskQueued",
      taskId: "root",
      childId: "child-1",
      attemptId: "attempt-1",
    }),
    event(4, { _tag: "WorkflowPaused", reason: "hold admissions" }),
    event(5, { _tag: "TaskStarted", taskId: "root", attemptId: "attempt-1" }),
    event(6, {
      _tag: "TaskCompleted",
      taskId: "root",
      attemptId: "attempt-1",
    }),
  ]);

  assert.equal(state.status, "paused");
  assert.equal(state.tasks.root?.status, "completed");
  assert.equal(state.tasks.child?.status, "ready");
});

test("retry creates a new attempt and ignores stale terminals", () => {
  const retryDefinition: ValidatedWorkflowDefinition = {
    tasks: [
      {
        id: "root",
        label: "Root",
        kind: "writer",
        prompt: "root",
        readOnly: true,
        retry: { maxAttempts: 2, on: ["provider_stall"] },
      },
    ],
  };
  const events: WorkflowEvent[] = [
    event(1, { _tag: "WorkflowCreated", definition: retryDefinition }),
    event(2, { _tag: "WorkflowStarted" }),
    event(3, {
      _tag: "TaskQueued",
      taskId: "root",
      childId: "old-child",
      attemptId: "old-attempt",
    }),
    event(4, { _tag: "TaskStarted", taskId: "root", attemptId: "old-attempt" }),
    event(5, {
      _tag: "TaskFailed",
      taskId: "root",
      attemptId: "old-attempt",
      error: "stalled",
      failureKind: "provider_stall",
    }),
    event(6, {
      _tag: "TaskRetryRequested",
      taskId: "root",
      previousAttemptId: "old-attempt",
      attemptId: "new-attempt",
      mode: "explicit",
    }),
  ];
  let state = foldWorkflowEvents(events);
  const stale = reduceWorkflowEvent(
    state,
    event(7, {
      _tag: "TaskCompleted",
      taskId: "root",
      attemptId: "old-attempt",
      resultPreview: "late",
    }),
  );
  assert.strictEqual(stale, state);

  state = reduceWorkflowEvent(
    state,
    event(8, {
      _tag: "TaskQueued",
      taskId: "root",
      childId: "new-child",
      attemptId: "new-attempt",
    }),
  );
  state = reduceWorkflowEvent(
    state,
    event(9, { _tag: "TaskStarted", taskId: "root", attemptId: "new-attempt" }),
  );
  state = reduceWorkflowEvent(
    state,
    event(10, {
      _tag: "TaskCompleted",
      taskId: "root",
      attemptId: "new-attempt",
    }),
  );
  assert.equal(state.tasks.root?.status, "completed");
  assert.deepEqual(
    state.tasks.root?.attempts.map((attempt) => attempt.status),
    ["failed", "completed"],
  );
});

test("automatic retry requires a configured failure classification", () => {
  const retryDefinition: ValidatedWorkflowDefinition = {
    tasks: [
      {
        id: "root",
        label: "Root",
        kind: "scout",
        prompt: "root",
        readOnly: true,
        retry: { maxAttempts: 2, on: ["provider_stall"] },
      },
    ],
  };
  const base = [
    event(1, { _tag: "WorkflowCreated", definition: retryDefinition }),
    event(2, { _tag: "WorkflowStarted" }),
    event(3, { _tag: "TaskQueued", taskId: "root", childId: "child" }),
    event(4, { _tag: "TaskStarted", taskId: "root" }),
  ];
  const backendFailure = foldWorkflowEvents([
    ...base,
    event(5, {
      _tag: "TaskFailed",
      taskId: "root",
      error: "backend down",
      failureKind: "backend_failure",
    }),
  ]);
  assert.equal(backendFailure.tasks.root?.status, "failed");
  assert.equal(backendFailure.tasks.root?.attempts.length, 1);

  const providerFailure = foldWorkflowEvents([
    ...base,
    event(5, {
      _tag: "TaskFailed",
      taskId: "root",
      error: "provider stalled",
      failureKind: "provider_stall",
    }),
  ]);
  const providerRetry = reduceWorkflowEvent(
    providerFailure,
    event(6, {
      _tag: "TaskRetryRequested",
      taskId: "root",
      previousAttemptId: providerFailure.tasks.root?.attemptId,
      attemptId: "retry-attempt",
      mode: "automatic",
      failureKind: "provider_stall",
    }),
  );
  assert.equal(providerRetry.tasks.root?.status, "ready");

  assert.throws(
    () =>
      reduceWorkflowEvent(
        backendFailure,
        event(6, {
          _tag: "TaskRetryRequested",
          taskId: "root",
          attemptId: "retry-attempt",
          mode: "automatic",
          failureKind: "backend_failure",
        }),
      ),
    WorkflowInvariantError,
  );
});

test("workflow terminal events atomically terminalize every nonterminal task", () => {
  const state = foldWorkflowEvents([
    ...runningEvents(),
    event(3, {
      _tag: "TaskQueued",
      taskId: "root",
      childId: "child-root",
    }),
    event(4, { _tag: "TaskStarted", taskId: "root" }),
  ]);
  const cancelled = reduceWorkflowEvent(
    state,
    event(5, { _tag: "WorkflowCancelled", reason: "operator" }),
  );
  assert.equal(cancelled.status, "cancelled");
  for (const task of Object.values(cancelled.tasks)) {
    assert.equal(
      ["completed", "failed", "cancelled", "skipped"].includes(task.status),
      true,
    );
  }
  assert.equal(cancelled.tasks.root?.status, "cancelled");
  assert.equal(cancelled.tasks.child?.status, "cancelled");
  assert.equal(cancelled.tasks.independent?.status, "cancelled");
});

test("lifecycle events after attempt one require their attempt identity", () => {
  const retryDefinition: ValidatedWorkflowDefinition = {
    tasks: [
      {
        id: "root",
        label: "Root",
        kind: "scout",
        prompt: "root",
        readOnly: true,
        retry: { maxAttempts: 2, on: ["backend_failure"] },
      },
    ],
  };
  let state = foldWorkflowEvents([
    event(1, { _tag: "WorkflowCreated", definition: retryDefinition }),
    event(2, { _tag: "WorkflowStarted" }),
    event(3, {
      _tag: "TaskQueued",
      taskId: "root",
      childId: "child-1",
      attemptId: "attempt-1",
    }),
    event(4, { _tag: "TaskStarted", taskId: "root", attemptId: "attempt-1" }),
    event(5, {
      _tag: "TaskFailed",
      taskId: "root",
      attemptId: "attempt-1",
      error: "backend",
      failureKind: "backend_failure",
    }),
    event(6, {
      _tag: "TaskRetryRequested",
      taskId: "root",
      previousAttemptId: "attempt-1",
      attemptId: "attempt-2",
      mode: "explicit",
    }),
  ]);
  assert.throws(
    () =>
      reduceWorkflowEvent(
        state,
        // SAFETY: This fixture is a TaskQueued event with its optional
        // attemptId explicitly removed to exercise the lifecycle boundary.
        {
          ...event(7, {
            _tag: "TaskQueued",
            taskId: "root",
            childId: "child-2",
          }),
          attemptId: undefined,
        } as WorkflowEvent,
      ),
    WorkflowInvariantError,
  );
  assert.throws(
    () =>
      reduceWorkflowEvent(
        state,
        // SAFETY: This fixture removes the attempt identity from a task
        // lifecycle event after the task has already retried.
        {
          ...event(7, {
            _tag: "TaskSkipped",
            taskId: "root",
            reason: "missing identity",
          }),
          attemptId: undefined,
        } as WorkflowEvent,
      ),
    WorkflowInvariantError,
  );
  state = reduceWorkflowEvent(
    state,
    event(7, {
      _tag: "TaskQueued",
      taskId: "root",
      childId: "child-2",
      attemptId: "attempt-2",
    }),
  );
  assert.equal(state.tasks.root?.status, "queued");
});
