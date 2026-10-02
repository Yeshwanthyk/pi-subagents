import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { BackendRegistry, type SubagentBackend } from "../backend.ts";
import { makeStubBackend } from "../backends/stub.ts";
import type {
  BackendName,
  ParentContext,
  SubagentSnapshot,
} from "../domain.ts";
import { Layer, ManagedRuntime } from "effect";
import {
  DEFAULT_MAX_RUNNING,
  parentSubagentView,
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerApi,
} from "../manager.ts";
import {
  WorkflowManager,
  type WorkflowChildExecutor,
  type WorkflowExecutionOptions,
} from "./manager.ts";
import type {
  ValidatedWorkflowDefinition,
  WorkflowReadModel,
  WorkflowTaskDefinition,
} from "./domain.ts";
import {
  WorkflowToolLifecycle,
  staticWorkflowDefinitionPreparer,
} from "./tools.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: true,
};

const registry = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    makeStubBackend({
      backend: "pi",
      defaultModelLabel: "stub/pi",
      contextWindow: 32_000,
      toolName: "ls",
      cadenceMs: 8,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "stub/codex",
      contextWindow: 32_000,
      toolName: "shell",
      cadenceMs: 8,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

function task(
  id: string,
  prompt = `complete ${id}`,
  options: Partial<WorkflowTaskDefinition> = {},
): WorkflowTaskDefinition {
  // SAFETY: the helper always supplies exactly one valid readOnly scope;
  // callers only override fields that the graph validator accepts.
  return {
    id,
    label: id,
    kind: "writer",
    prompt,
    readOnly: true,
    ...options,
  } as WorkflowTaskDefinition;
}

function executionOptions(
  manager: SubagentManagerApi,
): WorkflowExecutionOptions {
  return {
    subagents: manager,
    cwd: process.cwd(),
    parent,
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

async function withStubManager(
  callback: (manager: SubagentManagerApi) => Promise<void>,
): Promise<void> {
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(registry)),
  );
  const manager = await runtime.runPromise(SubagentManager);
  try {
    await callback(manager);
  } finally {
    await runtime.dispose();
  }
}

function run(
  manager: SubagentManagerApi,
  definition: ValidatedWorkflowDefinition,
) {
  const workflows = new WorkflowManager({ subagents: manager });
  const created = workflows.createRun(definition);
  const handle = workflows.execute(created.id, executionOptions(manager));
  return { workflows, handle };
}

function current(workflows: WorkflowManager, runId: string): WorkflowReadModel {
  const state = workflows.get(runId);
  assert.ok(state);
  return state;
}

test("approval returns a run before stub child settlement and runs detached", async () => {
  await withStubManager(async (manager) => {
    const root = await fsTempDirectory();
    const workflows = new WorkflowManager({
      subagents: manager,
      createId: () => "wf-approval",
    });
    const lifecycle = new WorkflowToolLifecycle({
      workflowsDir: path.join(root, "workflows"),
      agentDir: path.join(root, "agent"),
      manager: workflows,
      preparer: staticWorkflowDefinitionPreparer,
      createDraftId: () => "draft_aaaaaaaaaaaa",
    });
    const definition: ValidatedWorkflowDefinition = {
      tasks: [task("approved")],
    };
    const prepared = lifecycle.prepare(
      { preview: "run the approved task", spec: definition },
      { sessionId: "session-1", cwd: process.cwd(), userInput: 1 },
    );
    const approved = lifecycle.approve(
      prepared.draft.draftId,
      { sessionId: "session-1", cwd: process.cwd(), userInput: 2 },
      executionOptions(manager),
    );

    assert.equal(approved.run.id, "wf-approval");
    assert.equal(approved.run.status, "running");
    assert.equal(
      current(workflows, approved.run.id).tasks.approved?.childId,
      undefined,
    );
    await waitUntil(
      () => current(workflows, approved.run.id).status === "completed",
      "approved workflow should settle",
    );
  });
});

// One more root than the shared manager's running cap, so one must queue.
const ROOT_COUNT = DEFAULT_MAX_RUNNING + 1;

test("independent roots are admitted in one wave while SubagentManager owns capacity", async () => {
  await withStubManager(async (manager) => {
    const definition: ValidatedWorkflowDefinition = {
      tasks: Array.from({ length: ROOT_COUNT }, (_, index) =>
        task(`root-${index}`),
      ),
    };
    const { workflows, handle } = run(manager, definition);
    await waitUntil(() => {
      const state = current(workflows, handle.runId);
      const active = Object.values(state.tasks).filter(
        (item) => item.status === "queued" || item.status === "running",
      );
      return active.length === ROOT_COUNT;
    }, "all roots should be recorded as queued or running");

    const state = current(workflows, handle.runId);
    const active = Object.values(state.tasks).filter(
      (item) => item.status === "queued" || item.status === "running",
    );
    assert.equal(active.length, ROOT_COUNT);
    assert.equal(
      manager.view
        .list()
        .filter((snapshot) => snapshot.workflow?.runId === handle.runId).length,
      ROOT_COUNT,
    );
    assert.ok(
      Object.values(state.tasks).some((item) => item.status === "queued"),
      "the child beyond the running cap should wait in the shared manager queue",
    );

    const settled = await handle.completion;
    assert.equal(settled.status, "completed");
    assert.ok(
      Object.values(settled.tasks).every((item) => item.status === "completed"),
    );
  });
});

test("a failed branch skips descendants while an independent stub branch completes", async () => {
  await withStubManager(async (manager) => {
    const definition: ValidatedWorkflowDefinition = {
      tasks: [
        task("fail", "FAIL: fail this branch"),
        task("dependent", "must be skipped", { needs: ["fail"] }),
        task("independent", "finish the other branch", { harness: "codex" }),
      ],
    };
    const { handle } = run(manager, definition);
    const settled = await handle.completion;
    assert.equal(settled.status, "failed");
    assert.equal(settled.tasks.fail?.status, "failed");
    assert.equal(settled.tasks.dependent?.status, "skipped");
    assert.equal(settled.tasks.independent?.status, "completed");
  });
});

test("cancellation seals the workflow, cancels queued/running children, and blocks later admissions", async () => {
  await withStubManager(async (manager) => {
    const definition: ValidatedWorkflowDefinition = {
      tasks: ["a", "b", "c", "d", "e"].map((id) => task(id)),
    };
    const { workflows, handle } = run(manager, definition);
    await waitUntil(() => {
      const state = current(workflows, handle.runId);
      return Object.values(state.tasks).some(
        (item) => item.status === "queued" || item.status === "running",
      );
    }, "workflow children should be admitted before cancellation");
    const cancelled = await handle.cancel("operator stopped workflow");
    assert.equal(cancelled.status, "cancelled");
    assert.ok(
      Object.values(cancelled.tasks).every(
        (item) => item.status === "cancelled" || item.status === "skipped",
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    const late = manager.view
      .list()
      .filter((snapshot) => snapshot.workflow?.runId === handle.runId);
    assert.ok(late.every((snapshot) => snapshot.status === "error"));
    assert.equal(current(workflows, handle.runId).status, "cancelled");
  });
});

test("pi and codex stub children preserve workflow delivery isolation and settle once", async () => {
  await withStubManager(async (manager) => {
    const observedSettlements: string[] = [];
    manager.view.setOnSettled((snapshot) => {
      if (snapshot.workflow?.runId === "wf-isolation")
        observedSettlements.push(snapshot.id);
    });
    const workflows = new WorkflowManager({
      subagents: manager,
      createId: () => "wf-isolation",
    });
    const created = workflows.createRun({
      tasks: [
        task("pi", "pi branch", { harness: "pi" }),
        task("codex", "codex branch", { harness: "codex" }),
      ],
    });
    const first = workflows.execute(created.id, executionOptions(manager));
    const second = workflows.execute(created.id, executionOptions(manager));
    assert.strictEqual(first.completion, second.completion);
    const settled = await first.completion;
    assert.equal(settled.status, "completed");
    assert.equal(observedSettlements.length, 2);

    const children = manager.view
      .list()
      .filter((snapshot) => snapshot.workflow?.runId === created.id);
    assert.equal(children.length, 2);
    assert.ok(
      children.every((snapshot) => snapshot.resultDelivery === "workflow"),
    );
    assert.ok(children.every((snapshot) => snapshot.client === undefined));
    const parentView = parentSubagentView(manager.view);
    assert.ok(
      children.every((snapshot) => parentView.get(snapshot.id) === undefined),
    );

    const terminalEvents = workflows
      .events(created.id)
      .filter(
        (event) =>
          event._tag === "WorkflowCompleted" ||
          event._tag === "WorkflowFailed" ||
          event._tag === "WorkflowCancelled",
      );
    assert.equal(terminalEvents.length, 1);
    assert.equal(workflows.cancel(created.id, "late cancel"), settled);
  });
});

async function fsTempDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "workflow-execution-"));
}
test("empty approved graphs complete without admitting a child", async () => {
  await withStubManager(async (manager) => {
    const workflows = new WorkflowManager({
      subagents: manager,
      createId: () => "wf-empty",
    });
    const created = workflows.createRun({ tasks: [] });
    const handle = workflows.execute(created.id, executionOptions(manager));
    const settled = await handle.completion;
    assert.equal(settled.status, "completed");
    assert.equal(
      manager.view
        .list()
        .filter((snapshot) => snapshot.workflow?.runId === created.id).length,
      0,
    );
    const terminals = workflows
      .events(created.id)
      .filter(
        (event) =>
          event._tag === "WorkflowCompleted" ||
          event._tag === "WorkflowFailed" ||
          event._tag === "WorkflowCancelled",
      );
    assert.equal(terminals.length, 1);
  });
});
test("downstream children receive only explicit bounded dependency handoffs", async () => {
  await withStubManager(async (manager) => {
    const definition: ValidatedWorkflowDefinition = {
      tasks: [
        task("source", "produce source output"),
        {
          id: "consumer",
          label: "consumer",
          kind: "writer",
          prompt: "consume source output",
          needs: ["source"],
          consumes: ["source"],
          owns: ["out/result.txt"],
        },
      ],
    };
    const { handle } = run(manager, definition);
    const settled = await handle.completion;
    assert.equal(settled.status, "completed");
    const child = manager.view
      .list()
      .find(
        (snapshot) =>
          snapshot.workflow?.runId === handle.runId &&
          snapshot.workflow.taskId === "consumer",
      );
    assert.ok(child);
    assert.match(child.prompt, /<workflow-handoff>/u);
    assert.match(child.prompt, /source/u);
    assert.doesNotMatch(child.prompt, /transcript/u);
  });
});

test("execution replays a bounded classified retry", async () => {
  let spawnCount = 0;
  const cancelled: string[] = [];
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, task) => {
      spawnCount++;
      const id = `child-${spawnCount}`;
      assert.ok(task.workflow?.attemptId);
      return executionChild(id, task.workflow!, "running");
    },
    awaitSettlement: async (id, expected) => {
      assert.equal(id, `child-${id === "child-1" ? 1 : 2}`);
      assert.ok(expected?.attemptId);
      if (id === "child-1") {
        return executionChild(id, expected!, "error", {
          _tag: "Failed",
          errorText: "provider stalled",
          failureKind: "provider_stall",
        });
      }
      return executionChild(id, expected!, "done", {
        _tag: "Completed",
        finalText: "completed on retry",
      });
    },
    cancel: async (ids) => {
      cancelled.push(...ids);
      return [];
    },
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-retry-execution",
    createAttemptId: (() => {
      let next = 0;
      return () => `attempt-${++next}`;
    })(),
    execution: { executor },
  });
  const created = workflows.createRun({
    tasks: [
      {
        id: "retry",
        label: "Retry",
        kind: "scout",
        prompt: "retry",
        readOnly: true,
        retry: { maxAttempts: 2, on: ["provider_stall"] },
      },
    ],
  });

  const settled = await workflows.execute(created.id).completion;
  assert.equal(settled.status, "completed");
  assert.equal(spawnCount, 2);
  assert.deepEqual(
    settled.tasks.retry?.attempts.map((attempt) => [
      attempt.number,
      attempt.status,
    ]),
    [
      [1, "failed"],
      [2, "completed"],
    ],
  );
  assert.deepEqual(
    workflows.events(created.id).map((event) => event._tag),
    [
      "WorkflowCreated",
      "WorkflowStarted",
      "TaskQueued",
      "TaskStarted",
      "TaskFailed",
      "TaskRetryRequested",
      "TaskQueued",
      "TaskStarted",
      "TaskCompleted",
      "WorkflowCompleted",
    ],
  );
  assert.deepEqual(cancelled, []);
  assert.deepEqual(workflows.replay(created.id), settled);
});

function executionChild(
  id: string,
  workflow: NonNullable<SubagentSnapshot["workflow"]>,
  status: SubagentSnapshot["status"],
  outcome?: SubagentSnapshot["outcome"],
): SubagentSnapshot {
  return {
    id,
    backend: "pi",
    owner: "workflow:wf-retry-execution",
    workflow,
    resultDelivery: "workflow",
    title: "retry",
    prompt: "retry",
    cwd: process.cwd(),
    status,
    createdAt: 1,
    startedAt: 1,
    lastActivityAt: 1,
    outcome,
    errorText: outcome?._tag === "Failed" ? outcome.errorText : undefined,
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    finalText: outcome?._tag === "Completed" ? outcome.finalText : "",
    turns: 0,
  };
}

test("driver failure atomically closes ready work and interrupts active children", async () => {
  let settleChild!: (snapshot: SubagentSnapshot) => void;
  const cancelled: string[] = [];
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, task) =>
      executionChild("child-live", task.workflow!, "running"),
    awaitSettlement: async () =>
      new Promise<SubagentSnapshot>((resolve) => {
        settleChild = resolve;
      }),
    cancel: async (ids) => {
      cancelled.push(...ids);
      return [];
    },
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-driver-failure",
    execution: { executor },
  });
  const created = workflows.createRun({
    tasks: [task("active"), task("ready")],
  });
  const handle = workflows.execute(created.id);
  await waitUntil(
    () => workflows.get(created.id)?.tasks.active?.status === "running",
    "active child admission",
  );
  const failed = workflows.fail(created.id, "driver failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.tasks.active?.status, "cancelled");
  assert.equal(failed.tasks.ready?.status, "cancelled");
  assert.deepEqual(
    workflows.events(created.id).map((event) => event._tag),
    [
      "WorkflowCreated",
      "WorkflowStarted",
      "TaskQueued",
      "TaskQueued",
      "TaskStarted",
      "TaskStarted",
      "WorkflowFailed",
    ],
  );
  await handle.completion;
  assert.deepEqual(cancelled, ["child-live"]);
  settleChild(failedSnapshot("child-live"));
});

function failedSnapshot(id: string): SubagentSnapshot {
  return executionChild(
    id,
    { runId: "wf-driver-failure", taskId: "active", attemptId: "attempt-1" },
    "error",
    { _tag: "Failed", errorText: "cancelled", failureKind: "backend_failure" },
  );
}

/** Fake executor whose children settle only when a test releases them. */
function controlledExecutor() {
  const spawned: string[] = [];
  const prompts = new Map<string, string>();
  const releases = new Map<string, (finalText?: string) => void>();
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, spawnTask) => {
      const workflow = spawnTask.workflow!;
      spawned.push(workflow.taskId);
      prompts.set(workflow.taskId, spawnTask.prompt);
      return executionChild(`child-${workflow.taskId}`, workflow, "running");
    },
    awaitSettlement: async (id, expected) =>
      new Promise<SubagentSnapshot>((resolve) => {
        releases.set(expected!.taskId, (finalText) =>
          resolve(
            executionChild(id, expected!, "done", {
              _tag: "Completed",
              finalText: finalText ?? `done ${expected!.taskId}`,
            }),
          ),
        );
      }),
    cancel: async () => [],
  };
  const release = async (taskId: string, finalText?: string) => {
    await waitUntil(() => releases.has(taskId), `${taskId} settlement wait`);
    releases.get(taskId)!(finalText);
  };
  return { executor, spawned, prompts, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a ready downstream task starts while an unrelated sibling is still running", async () => {
  const fake = controlledExecutor();
  const workflows = new WorkflowManager({
    createId: () => "wf-no-barrier",
    execution: { executor: fake.executor },
  });
  const created = workflows.createRun({
    tasks: [task("a"), task("b"), task("c", "after a", { needs: ["a"] })],
  });
  const handle = workflows.execute(created.id);
  await waitUntil(
    () => workflows.get(created.id)?.tasks.b?.status === "running",
    "slow sibling should be running",
  );
  await fake.release("a");
  await waitUntil(
    () => fake.spawned.includes("c"),
    "c should be admitted as soon as a completes",
  );
  const state = current(workflows, created.id);
  assert.equal(state.tasks.a?.status, "completed");
  assert.equal(state.tasks.b?.status, "running", "b has not settled yet");
  assert.ok(
    state.tasks.c?.status === "queued" || state.tasks.c?.status === "running",
  );
  await fake.release("b");
  await fake.release("c");
  assert.equal((await handle.completion).status, "completed");
});

test("pause while a child is active blocks new admissions until resume", async () => {
  const fake = controlledExecutor();
  const workflows = new WorkflowManager({
    createId: () => "wf-pause-active",
    execution: { executor: fake.executor },
  });
  const created = workflows.createRun({
    tasks: [
      task("a"),
      task("b", "after a", { needs: ["a"] }),
      task("slow"),
    ],
  });
  const handle = workflows.execute(created.id);
  await waitUntil(
    () => workflows.get(created.id)?.tasks.a?.status === "running",
    "a should be running",
  );
  workflows.pause(created.id);
  await fake.release("a");
  await waitUntil(
    () => workflows.get(created.id)?.tasks.a?.status === "completed",
    "running child settles while paused",
  );
  await tick();
  assert.equal(fake.spawned.includes("b"), false, "paused run admits nothing");
  assert.equal(current(workflows, created.id).tasks.b?.status, "ready");
  assert.equal(current(workflows, created.id).tasks.slow?.status, "running");

  workflows.resume(created.id);
  await waitUntil(() => fake.spawned.includes("b"), "resume admits b");
  assert.equal(current(workflows, created.id).tasks.slow?.status, "running");
  await fake.release("b");
  await fake.release("slow");
  assert.equal((await handle.completion).status, "completed");
});

test("overlapping writers stay serialized while non-conflicting work proceeds", async () => {
  // Graph validation requires overlapping writers to be dependency ordered;
  // the scheduler's active-writer check must still hold w2 back while w1 runs.
  const fake = controlledExecutor();
  const workflows = new WorkflowManager({
    createId: () => "wf-writer-conflict",
    execution: { executor: fake.executor },
  });
  const writer = (
    id: string,
    owns: readonly [string, ...string[]],
    needs?: readonly [string, ...string[]],
  ): WorkflowTaskDefinition => {
    const definition: WorkflowTaskDefinition = {
      id,
      label: id,
      kind: "writer",
      prompt: `write ${id}`,
      owns,
    };
    if (needs === undefined) return definition;
    return { ...definition, needs };
  };
  const created = workflows.createRun({
    tasks: [
      writer("w1", ["src/shared"]),
      writer("w2", ["src/shared/file.ts"], ["w1"]),
      writer("w3", ["docs/other.md"]),
      task("reader"),
    ],
  });
  const handle = workflows.execute(created.id);
  await waitUntil(
    () =>
      ["w1", "w3", "reader"].every(
        (id) => workflows.get(created.id)?.tasks[id]?.status === "running",
      ),
    "non-conflicting tasks should run together",
  );
  await fake.release("reader");
  await waitUntil(
    () => workflows.get(created.id)?.tasks.reader?.status === "completed",
    "reader completes",
  );
  await tick();
  assert.equal(fake.spawned.includes("w2"), false, "w2 waits for w1");

  await fake.release("w1");
  await waitUntil(() => fake.spawned.includes("w2"), "w2 admitted after w1");
  // w2 did not wait for the unrelated w3 writer to settle.
  assert.equal(current(workflows, created.id).tasks.w3?.status, "running");
  await fake.release("w2");
  await fake.release("w3");
  assert.equal((await handle.completion).status, "completed");
});

test("a 10 KB dependency result reaches its consumer intact while the journal keeps a preview", async () => {
  const fake = controlledExecutor();
  const workflows = new WorkflowManager({
    createId: () => "wf-handoff-budget",
    execution: { executor: fake.executor },
  });
  const created = workflows.createRun({
    tasks: [
      task("source"),
      task("consumer", "use the source", {
        needs: ["source"],
        consumes: ["source"],
      }),
    ],
  });
  const handle = workflows.execute(created.id);
  const output = Array.from({ length: 1_300 }, (_, i) => `word${i}`).join(" ");
  assert.ok(Buffer.byteLength(output) > 10_000);
  assert.ok(Buffer.byteLength(output) < 16 * 1024);
  await fake.release("source", output);
  await waitUntil(() => fake.prompts.has("consumer"), "consumer admitted");
  const prompt = fake.prompts.get("consumer")!;
  assert.ok(prompt.includes(output), "full result must be handed off");
  assert.doesNotMatch(prompt, /details truncated/u);

  const completed = workflows
    .events(created.id)
    .find(
      (event) => event._tag === "TaskCompleted" && event.taskId === "source",
    );
  assert.ok(completed?._tag === "TaskCompleted");
  assert.ok(Buffer.byteLength(completed.resultPreview ?? "") <= 4 * 1024);
  await fake.release("consumer");
  assert.equal((await handle.completion).status, "completed");
});
