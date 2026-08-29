import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { BackendRegistry, type SubagentBackend } from "../backend.ts";
import { makeStubBackend } from "../backends/stub.ts";
import type { BackendName, ParentContext } from "../domain.ts";
import { Layer, ManagedRuntime } from "effect";
import {
  parentSubagentView,
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerApi,
} from "../manager.ts";
import { WorkflowManager, type WorkflowExecutionOptions } from "./manager.ts";
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
