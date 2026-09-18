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
import {
  MAX_EVALUATION_STATE_BYTES,
  type WorkflowEvaluator,
} from "./evaluator.ts";
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

const evaluationPolicy = {
  provider: "jev" as const,
  apiKeyEnv: "TYPESAFE_API_KEY",
  model: "jev-1.13.0",
  timeoutMs: 10_000,
  maxConcurrent: 2,
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

test("independent roots are admitted in one wave while SubagentManager owns capacity", async () => {
  await withStubManager(async (manager) => {
    const definition: ValidatedWorkflowDefinition = {
      tasks: ["a", "b", "c", "d", "e"].map((id) => task(id)),
    };
    const { workflows, handle } = run(manager, definition);
    await waitUntil(() => {
      const state = current(workflows, handle.runId);
      const active = Object.values(state.tasks).filter(
        (item) => item.status === "queued" || item.status === "running",
      );
      return active.length === 5;
    }, "all roots should be recorded as queued or running");

    const state = current(workflows, handle.runId);
    const active = Object.values(state.tasks).filter(
      (item) => item.status === "queued" || item.status === "running",
    );
    assert.equal(active.length, 5);
    assert.equal(
      manager.view
        .list()
        .filter((snapshot) => snapshot.workflow?.runId === handle.runId).length,
      5,
    );
    assert.ok(
      Object.values(state.tasks).some((item) => item.status === "queued"),
      "the fifth child should wait in the shared manager queue",
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

test("typed evaluation tasks use no coding slot and publish bounded answers to declared consumers", async () => {
  let spawns = 0;
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, spawnTask) => {
      spawns++;
      return executionChild(
        `consumer-${spawns}`,
        spawnTask.workflow!,
        "running",
      );
    },
    awaitSettlement: async (id, expected) =>
      executionChild(id, expected!, "done", {
        _tag: "Completed",
        finalText: "consumer complete",
      }),
    cancel: async () => [],
  };
  const evaluator: WorkflowEvaluator = {
    evaluate: async () => ({
      ok: true,
      answers: {
        intent: { type: "choice", value: "implementation", confidence: 0.8 },
      },
    }),
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-typed-evaluation",
    execution: { executor, evaluator, evaluationPolicy },
  });
  const created = workflows.createRun({
    evaluationPolicy,
    tasks: [
      {
        id: "classify",
        label: "Classify",
        kind: "scout",
        prompt: "Classify evidence",
        readOnly: true,
        execution: {
          type: "evaluation",
          payload: {
            state: "Selected evidence",
            questions: {
              intent: {
                type: "choice",
                question: "What is the intent?",
                options: ["implementation", "validation"],
              },
            },
          },
        },
      },
      task("consumer", "Use classification", {
        needs: ["classify"],
        consumes: ["classify"],
      }),
    ],
  });
  const settled = await workflows.execute(created.id).completion;
  assert.equal(settled.status, "completed");
  assert.equal(spawns, 1);
  assert.equal(settled.tasks.classify?.childId, undefined);
  assert.equal(
    settled.tasks.classify?.outcome?._tag === "Completed"
      ? settled.tasks.classify.outcome.evaluationResult?.answers.intent?.value
      : undefined,
    "implementation",
  );
  const consumer = workflows
    .events(created.id)
    .find((item) => item._tag === "TaskQueued" && item.taskId === "consumer");
  assert.ok(consumer);
});

test("a delayed post-run gate blocks dependants until its persisted pass", async () => {
  let release!: () => void;
  const gateWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let spawns = 0;
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, spawnTask) => {
      spawns++;
      return executionChild(
        `gate-child-${spawns}`,
        spawnTask.workflow!,
        "running",
      );
    },
    awaitSettlement: async (id, expected) =>
      executionChild(id, expected!, "done", {
        _tag: "Completed",
        finalText: "checks passed",
      }),
    cancel: async () => [],
  };
  const evaluator: WorkflowEvaluator = {
    evaluate: async () => {
      await gateWait;
      return {
        ok: true,
        answers: { verdict: { type: "choice", value: "pass" } },
      };
    },
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-gate-delay",
    execution: { executor, evaluator, evaluationPolicy },
  });
  const created = workflows.createRun({
    evaluationPolicy,
    tasks: [
      task("gated", "produce report", {
        gate: {
          questions: {
            verdict: {
              type: "choice",
              question: "Accept the report?",
              options: ["pass", "reject"],
            },
          },
          predicate: {
            type: "choice_equals",
            questionId: "verdict",
            value: "pass",
          },
        },
      }),
      task("dependent", "after gate", { needs: ["gated"] }),
    ],
  });
  const handle = workflows.execute(created.id);
  await waitUntil(
    () =>
      workflows.get(created.id)?.tasks.gated?.status === "running" &&
      spawns === 1,
    "gate should remain pending",
  );
  assert.equal(workflows.get(created.id)?.tasks.dependent?.status, "blocked");
  release();
  const settled = await handle.completion;
  assert.equal(settled.status, "completed");
  assert.equal(spawns, 2);
  const completion = workflows
    .events(created.id)
    .find((item) => item._tag === "TaskCompleted" && item.taskId === "gated");
  assert.ok(
    completion &&
      completion._tag === "TaskCompleted" &&
      completion.evaluationResult,
  );
});

test("gate rejection is semantic, skips dependants, and never becomes a backend retry", async () => {
  let spawns = 0;
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, spawnTask) => {
      spawns++;
      return executionChild(
        `reject-child-${spawns}`,
        spawnTask.workflow!,
        "running",
      );
    },
    awaitSettlement: async (id, expected) =>
      executionChild(id, expected!, "done", {
        _tag: "Completed",
        finalText: "insufficient evidence",
      }),
    cancel: async () => [],
  };
  const evaluator: WorkflowEvaluator = {
    evaluate: async () => ({
      ok: true,
      answers: { verdict: { type: "choice", value: "reject" } },
    }),
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-gate-reject",
    execution: { executor, evaluator, evaluationPolicy },
  });
  const created = workflows.createRun({
    evaluationPolicy,
    tasks: [
      task("gated", "produce report", {
        retry: { maxAttempts: 2, on: ["backend_failure"] },
        gate: {
          questions: {
            verdict: {
              type: "choice",
              question: "Accept?",
              options: ["pass", "reject"],
            },
          },
          predicate: {
            type: "choice_equals",
            questionId: "verdict",
            value: "pass",
          },
        },
      }),
      task("dependent", "must not run", { needs: ["gated"] }),
    ],
  });
  const settled = await workflows.execute(created.id).completion;
  assert.equal(settled.status, "failed");
  assert.equal(spawns, 1);
  assert.equal(settled.tasks.dependent?.status, "skipped");
  assert.equal(
    settled.tasks.gated?.outcome?._tag === "Failed"
      ? settled.tasks.gated.outcome.evaluationFailureKind
      : undefined,
    "gate_rejected",
  );
  assert.equal(
    workflows
      .events(created.id)
      .some((item) => item._tag === "TaskRetryRequested"),
    false,
  );
});

test("workflow cancellation aborts an in-flight evaluator and ignores its late answer", async () => {
  let aborted = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const evaluator: WorkflowEvaluator = {
    evaluate: async (_payload, options) => {
      options?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      await pending;
      return {
        ok: true,
        answers: { verdict: { type: "choice", value: "pass" } },
      };
    },
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-evaluator-cancel",
    execution: {
      evaluator,
      evaluationPolicy,
      executor: {
        spawn: async () => {
          throw new Error("evaluation must not spawn");
        },
        awaitSettlement: async () => undefined,
        cancel: async () => [],
      },
    },
  });
  const created = workflows.createRun({
    evaluationPolicy,
    tasks: [
      {
        id: "evaluate",
        label: "Evaluate",
        kind: "review",
        prompt: "evaluate",
        readOnly: true,
        execution: {
          type: "evaluation",
          payload: {
            state: "evidence",
            questions: {
              verdict: {
                type: "choice",
                question: "Pass?",
                options: ["pass", "reject"],
              },
            },
          },
        },
      },
    ],
  });
  const handle = workflows.execute(created.id);
  await waitUntil(
    () => workflows.get(created.id)?.tasks.evaluate?.status === "running",
    "evaluation should start",
  );
  const cancellation = handle.cancel("stop evaluator");
  await waitUntil(() => aborted, "evaluator abort signal");
  const cancelled = await cancellation;
  release();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(
    workflows.events(created.id).some((item) => item._tag === "TaskCompleted"),
    false,
  );
});

test("synchronous evaluator failures fail closed without hanging cleanup", async () => {
  const evaluator: WorkflowEvaluator = {
    evaluate: () => {
      throw new Error("synchronous evaluator failure");
    },
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-evaluator-sync-failure",
    execution: { evaluator, evaluationPolicy },
  });
  const created = workflows.createRun({
    evaluationPolicy,
    tasks: [
      {
        id: "evaluate",
        label: "Evaluate",
        kind: "review",
        prompt: "evaluate",
        readOnly: true,
        execution: {
          type: "evaluation",
          payload: {
            state: "x".repeat(MAX_EVALUATION_STATE_BYTES),
            questions: {
              verdict: {
                type: "choice",
                question: "Pass?",
                options: ["pass", "reject"],
              },
            },
          },
        },
      },
    ],
  });
  const settled = await workflows.execute(created.id).completion;
  assert.equal(settled.status, "failed");
  await workflows.shutdown();
});

test("a pretruncated child report never reaches its gate evaluator", async () => {
  let evaluations = 0;
  const evaluator: WorkflowEvaluator = {
    evaluate: async () => {
      evaluations++;
      return {
        ok: true,
        answers: { verdict: { type: "choice", value: "pass" } },
      };
    },
  };
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, spawnTask) =>
      executionChild("pretruncated-child", spawnTask.workflow!, "running"),
    awaitSettlement: async (id, expected) => ({
      ...executionChild(id, expected!, "done", {
        _tag: "Completed",
        finalText: "partial report",
      }),
      finalTextTruncated: true,
    }),
    cancel: async () => [],
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-pretruncated-gate",
    execution: { executor, evaluator, evaluationPolicy },
  });
  const created = workflows.createRun({
    evaluationPolicy,
    tasks: [
      task("gated", "produce report", {
        gate: {
          questions: {
            verdict: {
              type: "choice",
              question: "Accept?",
              options: ["pass", "reject"],
            },
          },
          predicate: {
            type: "choice_equals",
            questionId: "verdict",
            value: "pass",
          },
        },
      }),
    ],
  });
  const settled = await workflows.execute(created.id).completion;
  assert.equal(settled.status, "failed");
  assert.equal(evaluations, 0);
});

test("oversized composed evaluation handoff fails before evaluator admission", async () => {
  let evaluatorCalls = 0;
  const evaluator: WorkflowEvaluator = {
    evaluate: async () => {
      evaluatorCalls++;
      return {
        ok: true,
        answers: { verdict: { type: "choice", value: "pass" } },
      };
    },
  };
  const executor: WorkflowChildExecutor = {
    spawn: async (_backend, spawnTask) =>
      executionChild("source-child", spawnTask.workflow!, "running"),
    awaitSettlement: async (id, expected) =>
      executionChild(id, expected!, "done", {
        _tag: "Completed",
        finalText: "source evidence",
      }),
    cancel: async () => [],
  };
  const workflows = new WorkflowManager({
    createId: () => "wf-oversized-evaluation-input",
    execution: { executor, evaluator, evaluationPolicy },
  });
  const created = workflows.createRun({
    evaluationPolicy,
    tasks: [
      task("source"),
      {
        id: "evaluate",
        label: "Evaluate",
        kind: "review",
        prompt: "evaluate",
        needs: ["source"],
        consumes: ["source"],
        readOnly: true,
        execution: {
          type: "evaluation",
          payload: {
            state: "x".repeat(MAX_EVALUATION_STATE_BYTES),
            questions: {
              verdict: {
                type: "choice",
                question: "Pass?",
                options: ["pass", "reject"],
              },
            },
          },
        },
      },
    ],
  });
  const settled = await workflows.execute(created.id).completion;
  assert.equal(settled.status, "failed");
  assert.equal(evaluatorCalls, 0);
  await workflows.shutdown();
});

test("workflow execution rejects changed evaluator policy and obsolete enabled fields", () => {
  const evaluator: WorkflowEvaluator = {
    evaluate: async () => ({
      ok: true,
      answers: { verdict: { type: "choice", value: "pass" } },
    }),
  };
  const definition = {
    evaluationPolicy,
    tasks: [
      {
        id: "evaluate",
        label: "Evaluate",
        kind: "review",
        prompt: "evaluate",
        readOnly: true,
        execution: {
          type: "evaluation",
          payload: {
            state: "evidence",
            questions: {
              verdict: {
                type: "choice",
                question: "Pass?",
                options: ["pass", "reject"],
              },
            },
          },
        },
      },
    ],
  };
  const legacyPolicy = { ...evaluationPolicy, enabled: false };
  for (const [id, current, expected] of [
    [
      "wf-policy-model-change",
      { ...evaluationPolicy, model: "jev-new" },
      /policy/iu,
    ],
    [
      "wf-policy-obsolete-enabled",
      legacyPolicy,
      /enabled.*obsolete/iu,
    ],
  ] as const) {
    const workflows = new WorkflowManager({
      createId: () => id,
      execution: { evaluator, evaluationPolicy: current },
    });
    const created = workflows.createRun(definition);
    assert.throws(() => workflows.execute(created.id), expected);
  }
});
