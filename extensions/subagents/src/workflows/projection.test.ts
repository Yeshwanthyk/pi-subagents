import assert from "node:assert/strict";
import test from "node:test";
import {
  parseActiveWorkItem,
  parseActiveWorkRemoval,
} from "../activity-protocol.ts";
import type { SubagentSnapshot } from "../domain.ts";
import type { ValidatedWorkflowDefinition } from "./domain.ts";
import type { WorkflowEvent } from "./events.ts";
import {
  formatWorkflowList,
  formatWorkflowProjection,
  projectWorkflowList,
  projectWorkflowRun,
  workflowActiveWorkItem,
  workflowActiveWorkRemoval,
  workflowResultEnvelope,
} from "./projection.ts";
import { foldWorkflowEvents } from "./reducer.ts";
import { WorkflowManager, type WorkflowChildExecutor } from "./manager.ts";

type WorkflowEventInput = WorkflowEvent extends infer Event
  ? Event extends WorkflowEvent
    ? Omit<Event, "runId" | "at">
    : never
  : never;

const definition: ValidatedWorkflowDefinition = {
  name: "visible flow",
  tasks: [
    {
      id: "read",
      label: "Read",
      kind: "scout",
      prompt: "read",
      readOnly: true,
    },
    {
      id: "write",
      label: "Write",
      kind: "writer",
      prompt: "write",
      needs: ["read"],
      owns: ["src/out.ts"],
    },
  ],
};

const statusDefinition: ValidatedWorkflowDefinition = {
  tasks: [
    {
      id: "ready",
      label: "Ready",
      kind: "scout",
      prompt: "ready",
      readOnly: true,
    },
    {
      id: "blocked",
      label: "Blocked",
      kind: "scout",
      prompt: "blocked",
      needs: ["waiting"],
      readOnly: true,
    },
    {
      id: "waiting",
      label: "Waiting",
      kind: "scout",
      prompt: "waiting",
      readOnly: true,
    },
    {
      id: "queued",
      label: "Queued",
      kind: "scout",
      prompt: "queued",
      readOnly: true,
    },
    {
      id: "running",
      label: "Running",
      kind: "scout",
      prompt: "running",
      readOnly: true,
    },
    {
      id: "failed",
      label: "Failed",
      kind: "scout",
      prompt: "failed",
      readOnly: true,
    },
    {
      id: "skipped",
      label: "Skipped",
      kind: "scout",
      prompt: "skipped",
      needs: ["failed"],
      readOnly: true,
    },
    {
      id: "completed",
      label: "Completed",
      kind: "scout",
      prompt: "completed",
      readOnly: true,
    },
  ],
};

function event(at: number, value: WorkflowEventInput): WorkflowEvent {
  // SAFETY: WorkflowEventInput distributes every event variant and this restores its two shared fields.
  return { ...value, runId: "wf-1", at } as WorkflowEvent;
}

function runningRun() {
  return foldWorkflowEvents([
    event(1, { _tag: "WorkflowCreated", definition }),
    event(2, { _tag: "WorkflowStarted" }),
    event(3, { _tag: "TaskQueued", taskId: "read", childId: "child-1" }),
    event(4, { _tag: "TaskStarted", taskId: "read" }),
  ]);
}
function statusRun() {
  return foldWorkflowEvents([
    event(1, { _tag: "WorkflowCreated", definition: statusDefinition }),
    event(2, { _tag: "WorkflowStarted" }),
    event(3, { _tag: "TaskQueued", taskId: "queued", childId: "child-q" }),
    event(4, { _tag: "TaskQueued", taskId: "running", childId: "child-r" }),
    event(5, { _tag: "TaskStarted", taskId: "running" }),
    event(6, { _tag: "TaskQueued", taskId: "failed", childId: "child-f" }),
    event(7, { _tag: "TaskStarted", taskId: "failed" }),
    event(8, { _tag: "TaskFailed", taskId: "failed", error: "provider" }),
    event(9, { _tag: "TaskQueued", taskId: "completed", childId: "child-c" }),
    event(10, { _tag: "TaskStarted", taskId: "completed" }),
    event(11, { _tag: "TaskCompleted", taskId: "completed" }),
  ]);
}

function child(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "child-1",
    backend: "pi",
    owner: "workflow:wf-1",
    workflow: { runId: "wf-1", taskId: "read" },
    resultDelivery: "workflow",
    title: "Read",
    prompt: "read",
    cwd: "/repo",
    status: "running",
    createdAt: 3,
    startedAt: 3,
    lastActivityAt: 8,
    meta: { backend: "pi", modelLabel: "model", reasoningEffort: "low" },
    usage: {},
    transcript: [{ kind: "user", text: "secret transcript" }],
    liveTools: [
      {
        toolId: "tool-1",
        name: "grep",
        argsPreview: "src",
        startedAt: 8,
        updatedAt: 8,
      },
    ],
    completedOperations: 2,
    processTelemetry: "unavailable",
    queued: [],
    finalText: "secret result",
    turns: 1,
    ...overrides,
  };
}

test("workflow task rows preserve every display status and scope", () => {
  const projection = projectWorkflowRun(statusRun());
  const statuses = new Map(
    projection.tasks.map((task) => [task.id, task.displayStatus]),
  );
  assert.equal(statuses.get("ready"), "ready");
  assert.equal(statuses.get("blocked"), "blocked");
  assert.equal(statuses.get("queued"), "queued");
  assert.equal(statuses.get("running"), "running");
  assert.equal(statuses.get("skipped"), "skipped");
  assert.equal(statuses.get("completed"), "terminal");
  assert.equal(statuses.get("failed"), "terminal");
  assert.equal(
    projection.tasks.find((task) => task.id === "skipped")?.terminal,
    true,
  );
  assert.equal(
    projection.tasks.find((task) => task.id === "failed")?.error,
    "provider",
  );
});

test("workflow projection is bounded, joined by ownership, and never copies transcripts", () => {
  const projection = projectWorkflowRun(runningRun(), [child()]);
  assert.equal(projection.tasks[0]?.childId, "child-1");
  assert.equal(projection.tasks[0]?.currentTool, "grep");
  assert.equal(projection.tasks[1]?.status, "blocked");
  assert.equal(projection.tasks[0]?.readOnly, true);
  assert.equal(projection.tasks[0]?.backend, "pi");
  assert.equal(projection.tasks[0]?.model, "model");
  assert.equal(projection.tasks[0]?.effort, "low");
  assert.equal(projection.tasks[0]?.completedOperations, 2);
  assert.equal(projection.tasks[0]?.turns, 1);
  assert.deepEqual(projection.tasks[1]?.dependencies, ["read"]);
  assert.deepEqual(projection.tasks[1]?.owns, ["src/out.ts"]);
  assert.equal(projection.tasks[1]?.readOnly, false);
  assert.equal("transcript" in projection, false);
  assert.equal("finalText" in projection.tasks[0]!, false);
  assert.match(formatWorkflowProjection(projection), /child:child-1/);
  assert.doesNotMatch(formatWorkflowProjection(projection), /secret/);
  assert.ok(
    Buffer.byteLength(
      formatWorkflowProjection(projection, { maxBytes: 128 }),
      "utf8",
    ) <= 128,
  );
  const unowned = projectWorkflowRun(runningRun(), [
    child({
      workflow: { runId: "other", taskId: "read" },
      errorText: "hidden",
    }),
  ]);
  assert.equal(unowned.tasks[0]?.currentTool, undefined);
  assert.equal(unowned.tasks[0]?.error, undefined);
});

test("workflow list and activity expose one bounded aggregate", () => {
  const run = runningRun();
  const list = projectWorkflowList([run]);
  assert.deepEqual(
    list.map((item) => item.id),
    ["wf-1"],
  );
  assert.match(formatWorkflowList([run]), /wf-1.*running/);
  const activity = workflowActiveWorkItem(run, [child()], 8);
  assert.equal(activity?.key, "workflow:wf-1");
  assert.equal(activity?.kind, "workflow");
  assert.equal(activity?.runningProcesses, 1);
  assert.match(activity?.summary ?? "", /grep/);
  assert.doesNotMatch(activity?.summary ?? "", /src/);
  assert.deepEqual(parseActiveWorkItem(activity!), activity);
});

test("workflow terminal result is one aggregate and remains bounded", () => {
  const run = foldWorkflowEvents([
    event(1, { _tag: "WorkflowCreated", definition }),
    event(2, { _tag: "WorkflowStarted" }),
    event(3, { _tag: "TaskQueued", taskId: "read", childId: "child-1" }),
    event(4, { _tag: "TaskStarted", taskId: "read" }),
    event(5, {
      _tag: "TaskCompleted",
      taskId: "read",
      resultPreview: "secret",
    }),
    event(6, { _tag: "TaskQueued", taskId: "write", childId: "child-2" }),
    event(7, { _tag: "TaskStarted", taskId: "write" }),
    event(8, { _tag: "TaskCompleted", taskId: "write", resultPreview: "done" }),
    event(9, { _tag: "WorkflowCompleted", summary: "all done" }),
  ]);
  const result = workflowResultEnvelope(run, { epoch: 1, leafId: null });
  assert.equal(result?.kind, "workflow");
  assert.equal(result?.id, "wf-1");
  assert.doesNotMatch(result?.output ?? "", /secret/);
  assert.equal(projectWorkflowRun(run).counts.completed, 2);
  const removal = workflowActiveWorkRemoval(run);
  assert.deepEqual(parseActiveWorkRemoval(removal), removal);
});

test("workflow terminal observation is emitted once after the authoritative fold", async () => {
  let now = 0;
  let observed = 0;
  const executor: WorkflowChildExecutor = {
    spawn: async () => {
      throw new Error("empty workflow must not spawn a child");
    },
    awaitSettlement: async () => undefined,
    cancel: async () => [],
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-terminal",
    now: () => ++now,
  });
  workflows.createRun({ tasks: [] });
  const handle = workflows.execute("wf-terminal", {
    executor,
    onTerminal: (run) => {
      observed++;
      assert.equal(run.status, "completed");
    },
  });
  const terminal = await handle.completion;
  assert.equal(terminal.status, "completed");
  workflows.cancel("wf-terminal", "too late");
  assert.equal(observed, 1);
});
