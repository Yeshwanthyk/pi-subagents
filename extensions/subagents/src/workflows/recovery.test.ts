import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { SpawnTask } from "../domain.ts";
import { WorkflowArtifactStore } from "./artifacts.ts";
import type { ValidatedWorkflowDefinition } from "./domain.ts";
import {
  WORKFLOW_ORPHANED_REASON,
  MAX_WORKFLOW_RECOVERED_RUNS,
  MAX_WORKFLOW_RECOVERY_BYTES,
  recoverWorkflowArtifacts,
} from "./recovery.ts";
import { WorkflowManager, type WorkflowChildExecutor } from "./manager.ts";

const definition: ValidatedWorkflowDefinition = {
  name: "recoverable",
  tasks: [
    {
      id: "scout",
      label: "Scout",
      kind: "scout",
      prompt: "inspect",
      readOnly: true,
    },
  ],
};

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-recovery-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  return { root, project };
}

function interruptedJournal(runId: string) {
  return [
    { _tag: "WorkflowCreated" as const, runId, at: 1, definition },
    { _tag: "WorkflowStarted" as const, runId, at: 2 },
    {
      _tag: "TaskQueued" as const,
      runId,
      at: 3,
      taskId: "scout",
      childId: "native-child-reference",
      attemptId: "attempt-1",
    },
    {
      _tag: "TaskStarted" as const,
      runId,
      at: 4,
      taskId: "scout",
      attemptId: "attempt-1",
    },
  ];
}

function terminalJournal(runId: string) {
  return [
    {
      _tag: "WorkflowCreated" as const,
      runId,
      at: 1,
      definition: { tasks: [] },
    },
    { _tag: "WorkflowStarted" as const, runId, at: 2 },
    { _tag: "WorkflowCompleted" as const, runId, at: 3, summary: "done" },
  ];
}

function neverExecutor(calls: {
  spawns: number;
  cancels: number;
}): WorkflowChildExecutor {
  return {
    spawn: async (_backend, _task: SpawnTask) => {
      calls.spawns++;
      throw new Error("recovery must not spawn");
    },
    awaitSettlement: async () => undefined,
    cancel: async () => {
      calls.cancels++;
      return [];
    },
  };
}

test("startup recovery restores terminal artifacts and atomically orphan-terminalizes nonterminal runs", () => {
  const { root, project } = tempProject();
  try {
    const store = new WorkflowArtifactStore({
      workflowsDir: path.join(root, "workflows"),
      cwd: project,
    });
    store.create("wf-terminal", terminalJournal("wf-terminal"));
    store.create("wf-running", interruptedJournal("wf-running"));
    const before = store.load("wf-running");

    const first = recoverWorkflowArtifacts(store, { now: () => 10 });
    assert.deepEqual(first.report.restoredRunIds, ["wf-terminal"]);
    assert.deepEqual(first.report.orphanedRunIds, ["wf-running"]);
    assert.equal(first.report.failures.length, 0);
    const running = first.runs.find((run) => run.id === "wf-running");
    assert.ok(running);
    assert.equal(running.status, "failed");
    assert.deepEqual(running.outcome, {
      _tag: "Failed",
      error: WORKFLOW_ORPHANED_REASON,
      recovery: "orphaned",
    });
    assert.equal(running.tasks.scout?.status, "cancelled");
    assert.equal(running.tasks.scout?.attempts[0]?.status, "cancelled");
    assert.equal(store.load("wf-running").length, before.length + 1);
    assert.equal(store.load("wf-running").at(-1)?._tag, "WorkflowFailed");

    const afterFirst = fs.readFileSync(store.journalPath("wf-running"));
    const second = recoverWorkflowArtifacts(store, { now: () => 20 });
    assert.deepEqual(second.report.restoredRunIds, [
      "wf-running",
      "wf-terminal",
    ]);
    assert.deepEqual(second.report.orphanedRunIds, []);
    assert.deepEqual(
      fs.readFileSync(store.journalPath("wf-running")),
      afterFirst,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WorkflowManager startup recovery never starts, resumes, cancels, or publishes a recovered child", () => {
  const { root, project } = tempProject();
  try {
    const store = new WorkflowArtifactStore({
      workflowsDir: path.join(root, "workflows"),
      cwd: project,
    });
    store.create(
      "wf-manager-recovery",
      interruptedJournal("wf-manager-recovery"),
    );
    const calls = { spawns: 0, cancels: 0 };
    let published = 0;
    const workflows = new WorkflowManager({
      artifacts: store,
      executor: neverExecutor(calls),
      now: () => 10,
    });
    workflows.subscribe("wf-manager-recovery", () => {
      published++;
    });
    const recovered = workflows.get("wf-manager-recovery");
    assert.ok(recovered);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.tasks.scout?.status, "cancelled");
    assert.equal(calls.spawns, 0);
    assert.equal(calls.cancels, 0);
    assert.equal(published, 0);
    assert.equal(workflows.recoveryFailures.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery reports malformed or symlink artifacts without pretending they were recovered", () => {
  const { root, project } = tempProject();
  try {
    const store = new WorkflowArtifactStore({
      workflowsDir: path.join(root, "workflows"),
      cwd: project,
    });
    store.create("wf-bad", terminalJournal("wf-bad"));
    const journal = store.journalPath("wf-bad");
    const target = path.join(root, "outside.json");
    fs.writeFileSync(target, fs.readFileSync(journal));
    fs.unlinkSync(journal);
    fs.symlinkSync(target, journal);
    const result = recoverWorkflowArtifacts(store);
    assert.equal(result.runs.length, 0);
    assert.equal(result.report.failures.length, 1);
    assert.equal(result.report.failures[0]?.runId, "wf-bad");
    assert.equal(result.report.failures[0]?.phase, "scan");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery retains a deterministic bounded set by count and aggregate bytes", () => {
  const { root, project } = tempProject();
  try {
    const store = new WorkflowArtifactStore({
      workflowsDir: path.join(root, "workflows"),
      cwd: project,
    });
    for (const runId of ["wf-a", "wf-b", "wf-c"]) {
      store.create(runId, terminalJournal(runId));
    }
    const bounded = recoverWorkflowArtifacts(store, {
      maxRuns: 2,
      maxBytes: MAX_WORKFLOW_RECOVERY_BYTES,
    });
    assert.equal(bounded.runs.length, 2);
    assert.deepEqual(
      bounded.report.omissions.map((item) => [item.runId, item.reason]),
      [["wf-c", "run_limit"]],
    );
    const tooSmall = recoverWorkflowArtifacts(store, {
      maxRuns: MAX_WORKFLOW_RECOVERED_RUNS,
      maxBytes: 1,
    });
    assert.equal(tooSmall.runs.length, 0);
    assert.deepEqual(
      tooSmall.report.omissions.map((item) => item.reason),
      ["byte_budget", "byte_budget", "byte_budget"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
