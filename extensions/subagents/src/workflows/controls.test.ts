import assert from "node:assert/strict";
import test from "node:test";
import type {
  ParentContext,
  SpawnTask,
  SubagentFailureKind,
  SubagentSnapshot,
} from "../domain.ts";
import type { ValidatedWorkflowDefinition } from "./domain.ts";
import type { WorkflowEvent } from "./events.ts";
import { WorkflowControlError, WorkflowControls } from "./controls.ts";
import { WorkflowManager, type WorkflowChildExecutor } from "./manager.ts";
import { foldWorkflowEvents, reduceWorkflowEvent } from "./reducer.ts";

type WorkflowEventInput = WorkflowEvent extends infer Event
  ? Event extends WorkflowEvent
    ? Omit<Event, "runId" | "at">
    : never
  : never;

function event(
  runId: string,
  at: number,
  value: WorkflowEventInput,
): WorkflowEvent {
  // SAFETY: WorkflowEventInput removes only the two shared event fields.
  return { ...value, runId, at } as WorkflowEvent;
}

const graph: ValidatedWorkflowDefinition = {
  name: "operator controls",
  tasks: [
    {
      id: "root",
      label: "Root",
      kind: "scout",
      prompt: "inspect",
      readOnly: true,
      retry: { maxAttempts: 2, on: ["provider_stall", "backend_failure"] },
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

function runningEvents(
  definition: ValidatedWorkflowDefinition = graph,
  runId = "wf-controls",
): WorkflowEvent[] {
  return [
    event(runId, 1, { _tag: "WorkflowCreated", definition }),
    event(runId, 2, { _tag: "WorkflowStarted" }),
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: true,
};

function childSnapshot(
  task: SpawnTask,
  id: string,
  status: SubagentSnapshot["status"],
  options: {
    readonly errorText?: string;
    readonly failureKind?: SubagentFailureKind;
    readonly finalText?: string;
  } = {},
): SubagentSnapshot {
  const failure =
    options.errorText === undefined
      ? undefined
      : {
          _tag: "Failed" as const,
          errorText: options.errorText,
          failureKind: options.failureKind,
        };
  return {
    id,
    backend: "pi",
    owner: task.owner ?? "workflow-test",
    workflow: task.workflow,
    resultDelivery: "workflow",
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    status,
    createdAt: 1,
    startedAt: 1,
    settledAt: status === "running" ? undefined : 2,
    lastActivityAt: 2,
    errorText: options.errorText,
    failureKind: options.failureKind,
    outcome: failure,
    meta: { backend: "pi", modelLabel: "test/pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    finalText: options.finalText ?? "",
    turns: 0,
  };
}

interface ScriptedExecutor {
  readonly executor: WorkflowChildExecutor;
  readonly spawnCount: () => number;
}

function scriptedExecutor(
  outcomes: ReadonlyArray<
    | { readonly status: "done"; readonly finalText?: string }
    | {
        readonly status: "error";
        readonly errorText: string;
        readonly failureKind?: SubagentFailureKind;
      }
  >,
): ScriptedExecutor {
  const children = new Map<string, SubagentSnapshot>();
  let count = 0;
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, task) => {
      const id = `child-${++count}`;
      const initial = childSnapshot(task, id, "running");
      const outcome = outcomes[count - 1] ?? {
        status: "done" as const,
        finalText: "done",
      };
      const terminal =
        outcome.status === "done"
          ? childSnapshot(task, id, "done", {
              finalText: outcome.finalText ?? "done",
            })
          : childSnapshot(task, id, "error", outcome);
      children.set(id, terminal);
      return initial;
    },
    awaitSettlement: async (id) => children.get(id),
    cancel: async () => [],
  };
  return { executor, spawnCount: () => count };
}

interface PausableExecutor extends ScriptedExecutor {
  settle(id: string, snapshot: SubagentSnapshot): void;
  readonly cancelled: ReadonlyArray<string>;
}

function pausableExecutor(): PausableExecutor {
  const children = new Map<
    string,
    {
      readonly initial: SubagentSnapshot;
      readonly settlement: ReturnType<typeof deferred<SubagentSnapshot>>;
    }
  >();
  const cancelled: string[] = [];
  let count = 0;
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, task) => {
      const id = `child-${++count}`;
      const initial = childSnapshot(task, id, "running");
      children.set(id, { initial, settlement: deferred<SubagentSnapshot>() });
      return initial;
    },
    awaitSettlement: async (id) => children.get(id)?.settlement.promise,
    cancel: async (ids) => {
      cancelled.push(...ids);
      return [];
    },
  };
  return {
    executor,
    spawnCount: () => count,
    settle: (id, snapshot) => children.get(id)?.settlement.resolve(snapshot),
    cancelled,
  };
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("pause is append-only, allows existing child events, and replays", () => {
  const events: WorkflowEvent[] = [
    ...runningEvents(),
    event("wf-controls", 3, {
      _tag: "TaskQueued",
      taskId: "root",
      childId: "child-1",
      attemptId: "attempt-1",
    }),
    event("wf-controls", 4, {
      _tag: "WorkflowPaused",
      reason: "operator review",
    }),
    event("wf-controls", 5, {
      _tag: "TaskStarted",
      taskId: "root",
      attemptId: "attempt-1",
    }),
    event("wf-controls", 6, {
      _tag: "TaskCompleted",
      taskId: "root",
      attemptId: "attempt-1",
      resultPreview: "done",
    }),
    event("wf-controls", 7, { _tag: "WorkflowResumed" }),
  ];
  const state = foldWorkflowEvents(events);

  assert.equal(state.status, "running");
  assert.equal(state.tasks.root?.status, "completed");
  assert.equal(state.tasks.child?.status, "ready");
  assert.deepEqual(foldWorkflowEvents(events), state);
});

test("pause blocks new admissions while a running child settles", async () => {
  const child = pausableExecutor();
  const workflows = new WorkflowManager({
    createId: () => "wf-pause",
    now: () => Date.now(),
  });
  workflows.createRun({
    tasks: [
      {
        id: "first",
        label: "First",
        kind: "scout",
        prompt: "first",
        readOnly: true,
      },
      {
        id: "second",
        label: "Second",
        kind: "writer",
        prompt: "second",
        needs: ["first"],
        owns: ["src/second.ts"],
      },
    ],
  });
  const handle = workflows.execute("wf-pause", {
    executor: child.executor,
    cwd: process.cwd(),
    parent,
  });
  await waitUntil(
    () => workflows.get("wf-pause")?.tasks.first?.status === "running",
    "first task to start",
  );
  const paused = workflows.pause("wf-pause", "hold");
  assert.equal(paused.status, "paused");

  const firstChild = workflows.get("wf-pause")?.tasks.first?.childId;
  assert.ok(firstChild);
  child.settle(
    firstChild,
    childSnapshot(
      {
        prompt: "first",
        title: "first",
        cwd: process.cwd(),
        parent,
        workflow: {
          runId: "wf-pause",
          taskId: "first",
          attemptId: workflows.get("wf-pause")?.tasks.first?.attemptId,
        },
      },
      firstChild,
      "done",
      { finalText: "first done" },
    ),
  );
  await waitUntil(
    () => workflows.get("wf-pause")?.tasks.second?.status === "ready",
    "second task to become ready while paused",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(child.spawnCount(), 1);

  workflows.resume("wf-pause");
  await waitUntil(
    () =>
      workflows.get("wf-pause")?.tasks.second?.status === "running" &&
      child.spawnCount() === 2,
    "second task to start after resume",
  );
  const secondChild = workflows.get("wf-pause")?.tasks.second?.childId;
  assert.ok(secondChild);
  child.settle(
    secondChild,
    childSnapshot(
      {
        prompt: "second",
        title: "second",
        cwd: process.cwd(),
        parent,
        workflow: {
          runId: "wf-pause",
          taskId: "second",
          attemptId: workflows.get("wf-pause")?.tasks.second?.attemptId,
        },
      },
      secondChild,
      "done",
      { finalText: "second done" },
    ),
  );
  const settled = await handle.completion;
  assert.equal(settled.status, "completed");
  assert.equal(child.spawnCount(), 2);
  assert.deepEqual(child.cancelled, []);
});

test("explicit retry creates bounded attempt history and ignores late prior events", () => {
  const journal = [
    ...runningEvents(),
    event("wf-controls", 3, {
      _tag: "TaskQueued",
      taskId: "root",
      childId: "child-1",
      attemptId: "attempt-1",
    }),
    event("wf-controls", 4, {
      _tag: "TaskStarted",
      taskId: "root",
      attemptId: "attempt-1",
    }),
    event("wf-controls", 5, {
      _tag: "TaskFailed",
      taskId: "root",
      attemptId: "attempt-1",
      error: "provider stalled",
      failureKind: "provider_stall",
    }),
    event("wf-controls", 6, {
      _tag: "TaskRetryRequested",
      taskId: "root",
      attemptId: "attempt-2",
      previousAttemptId: "attempt-1",
      mode: "explicit",
      reason: "operator retry",
    }),
  ];
  const retried = foldWorkflowEvents(journal);
  assert.equal(retried.tasks.root?.status, "ready");
  assert.equal(retried.tasks.root?.attemptId, "attempt-2");
  assert.deepEqual(
    retried.tasks.root?.attempts.map((attempt) => [attempt.id, attempt.status]),
    [
      ["attempt-1", "failed"],
      ["attempt-2", "ready"],
    ],
  );

  const late = reduceWorkflowEvent(
    retried,
    event("wf-controls", 7, {
      _tag: "TaskCompleted",
      taskId: "root",
      attemptId: "attempt-1",
      resultPreview: "late",
    }),
  );
  assert.strictEqual(late, retried);

  const secondFailure = reduceWorkflowEvent(
    reduceWorkflowEvent(
      reduceWorkflowEvent(
        retried,
        event("wf-controls", 8, {
          _tag: "TaskQueued",
          taskId: "root",
          childId: "child-2",
          attemptId: "attempt-2",
        }),
      ),
      event("wf-controls", 9, {
        _tag: "TaskStarted",
        taskId: "root",
        attemptId: "attempt-2",
      }),
    ),
    event("wf-controls", 10, {
      _tag: "TaskFailed",
      taskId: "root",
      attemptId: "attempt-2",
      error: "second failure",
      failureKind: "backend_failure",
    }),
  );
  assert.throws(
    () =>
      reduceWorkflowEvent(
        secondFailure,
        event("wf-controls", 11, {
          _tag: "TaskRetryRequested",
          taskId: "root",
          attemptId: "attempt-3",
          previousAttemptId: "attempt-2",
          mode: "explicit",
        }),
      ),
    /maxAttempts/u,
  );
  assert.deepEqual(foldWorkflowEvents(journal), retried);
});

test("skip control marks descendants in declaration order and is replay-safe", () => {
  const workflows = new WorkflowManager({
    createId: () => "wf-skip",
    now: () => 1,
  });
  workflows.createRun(graph);
  workflows.start("wf-skip");
  const controls = new WorkflowControls(workflows);
  const skipped = controls.skipTask("wf-skip", "root", "not needed");

  assert.deepEqual(
    ["root", "child", "grandchild", "independent"].map(
      (id) => skipped.tasks[id]?.status,
    ),
    ["skipped", "skipped", "skipped", "ready"],
  );
  assert.deepEqual(skipped.tasks.grandchild?.outcome, {
    _tag: "Skipped",
    skippedByTaskId: "root",
    reason: "not needed",
  });
  assert.deepEqual(workflows.replay("wf-skip"), skipped);
});

test("automatic retry is classified, configured, and bounded", async () => {
  const child = scriptedExecutor([
    {
      status: "error",
      errorText: "provider stalled",
      failureKind: "provider_stall",
    },
    { status: "done", finalText: "recovered" },
  ]);
  const workflows = new WorkflowManager({
    createId: () => "wf-auto",
    now: () => Date.now(),
  });
  workflows.createRun({
    tasks: [
      {
        id: "retryable",
        label: "Retryable",
        kind: "scout",
        prompt: "retry",
        readOnly: true,
        retry: { maxAttempts: 2, on: ["provider_stall"] },
      },
    ],
  });
  const settled = await workflows.execute("wf-auto", {
    executor: child.executor,
    cwd: process.cwd(),
    parent,
  }).completion;

  assert.equal(settled.status, "completed");
  assert.equal(child.spawnCount(), 2);
  assert.deepEqual(
    settled.tasks.retryable?.attempts.map((attempt) => [
      attempt.number,
      attempt.status,
      attempt.outcome?._tag,
    ]),
    [
      [1, "failed", "Failed"],
      [2, "completed", "Completed"],
    ],
  );
  assert.equal(
    workflows
      .events("wf-auto")
      .filter((item) => item._tag === "TaskRetryRequested").length,
    1,
  );

  const unclassified = scriptedExecutor([
    { status: "error", errorText: "no classification" },
    { status: "done" },
  ]);
  const noRetry = new WorkflowManager({
    createId: () => "wf-no-auto",
    now: () => Date.now(),
  });
  noRetry.createRun({
    tasks: [
      {
        id: "not-retryable",
        label: "Not retryable",
        kind: "scout",
        prompt: "fail",
        readOnly: true,
        retry: { maxAttempts: 2, on: ["provider_stall", "backend_failure"] },
      },
    ],
  });
  const failed = await noRetry.execute("wf-no-auto", {
    executor: unclassified.executor,
    cwd: process.cwd(),
    parent,
  }).completion;
  assert.equal(failed.status, "failed");
  assert.equal(unclassified.spawnCount(), 1);
});

test("workflow controls reject unknown runs without targeting child authority", () => {
  const workflows = new WorkflowManager({ createId: () => "wf-known" });
  const controls = new WorkflowControls(workflows);
  assert.throws(() => controls.pause("wf-missing"), WorkflowControlError);
});
