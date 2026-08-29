import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { WorkflowRunArtifactStore } from "./artifacts.ts";
import {
  WorkflowArtifactBoundsError,
  WorkflowArtifactPathError,
  WorkflowArtifactStore,
  WORKFLOW_RUNS_NAMESPACE,
  parseWorkflowJournal,
  serializeWorkflowJournal,
} from "./artifacts.ts";
import type { ValidatedWorkflowDefinition } from "./domain.ts";
import type { SpawnTask, SubagentSnapshot } from "../domain.ts";
import {
  MAX_WORKFLOW_ARTIFACT_BYTES,
  MAX_WORKFLOW_EVENTS,
  WorkflowEventBoundsError,
  type WorkflowEvent,
} from "./events.ts";
import { WorkflowManager, type WorkflowChildExecutor } from "./manager.ts";

const definition: ValidatedWorkflowDefinition = {
  name: "artifact test",
  tasks: [],
};

function created(runId = "wf-artifact"): WorkflowEvent[] {
  return [
    { _tag: "WorkflowCreated", runId, at: 1, definition },
    { _tag: "WorkflowStarted", runId, at: 2 },
  ];
}

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-artifacts-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  return { root, project };
}

function privateMode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

test("run journals use an isolated runs namespace, private files, and round-trip only events", () => {
  const { root, project } = tempProject();
  try {
    const store = new WorkflowArtifactStore({
      workflowsDir: path.join(root, "workflows"),
      cwd: project,
    });
    const events = created();
    // SAFETY: this test deliberately verifies that the typed boundary strips an accidental parent reference.
    const contaminated = [
      { ...events[0]!, parentRef: { epoch: 1, leafId: "secret" } },
      events[1]!,
    ] as WorkflowEvent[];
    store.create("wf-artifact", contaminated);

    const journal = store.journalPath("wf-artifact");
    assert.ok(
      journal.includes(`${path.sep}${WORKFLOW_RUNS_NAMESPACE}${path.sep}`),
    );
    assert.equal(fs.lstatSync(journal).isSymbolicLink(), false);
    assert.equal(privateMode(journal), 0o600);
    assert.equal(privateMode(path.dirname(journal)), 0o700);
    assert.equal(privateMode(store.runsDir), 0o700);
    assert.deepEqual(store.load("wf-artifact"), events);
    const raw = fs.readFileSync(journal, "utf8");
    assert.doesNotMatch(raw, /parentRef|transcript|nativeSession/u);
    assert.equal(store.scan().artifacts.length, 1);

    const otherProject = path.join(root, "other-project");
    fs.mkdirSync(otherProject);
    const other = new WorkflowArtifactStore({
      workflowsDir: path.join(root, "workflows"),
      cwd: otherProject,
    });
    other.create("wf-artifact", created("wf-artifact"));
    assert.notEqual(
      store.journalPath("wf-artifact"),
      other.journalPath("wf-artifact"),
    );
    assert.equal(store.scan().artifacts.length, 1);
    assert.equal(other.scan().artifacts.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("journal parsing and paths fail closed at bounds and hostile fields", () => {
  assert.throws(
    () =>
      serializeWorkflowJournal(created(), {
        maxBytes: 8,
      }),
    WorkflowArtifactBoundsError,
  );
  assert.throws(
    () =>
      serializeWorkflowJournal(
        Array.from({ length: MAX_WORKFLOW_EVENTS + 1 }, () => created()[0]!),
      ),
    WorkflowArtifactBoundsError,
  );
  assert.throws(
    () =>
      parseWorkflowJournal(
        JSON.stringify([
          {
            _tag: "WorkflowCreated",
            runId: "wf-artifact",
            at: 1,
            definition,
            parentRef: "must not persist",
          },
        ]),
      ),
    WorkflowArtifactBoundsError,
  );
  assert.throws(
    () =>
      new WorkflowArtifactStore({
        workflowsDir: os.tmpdir(),
        cwd: process.cwd(),
      }).journalPath("../escape"),
    WorkflowArtifactPathError,
  );
  assert.throws(
    () => parseWorkflowJournal("x".repeat(MAX_WORKFLOW_ARTIFACT_BYTES + 1)),
    WorkflowArtifactBoundsError,
  );
});

test("symlinked journals are not read or treated as recoverable artifacts", () => {
  const { root, project } = tempProject();
  try {
    const store = new WorkflowArtifactStore({
      workflowsDir: path.join(root, "workflows"),
      cwd: project,
    });
    store.create("wf-symlink", created("wf-symlink"));
    const journal = store.journalPath("wf-symlink");
    const target = path.join(root, "target.json");
    fs.writeFileSync(target, fs.readFileSync(journal));
    fs.unlinkSync(journal);
    fs.symlinkSync(target, journal);
    assert.throws(() => store.load("wf-symlink"), WorkflowArtifactPathError);
    const scan = store.scan();
    assert.equal(scan.artifacts.length, 0);
    assert.equal(scan.failures.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accepted manager events persist before publication and failed replacement leaves both authorities unchanged", () => {
  const { root, project } = tempProject();
  try {
    const real = new WorkflowArtifactStore({
      workflowsDir: path.join(root, "workflows"),
      cwd: project,
    });
    let replacements = 0;
    const failing: WorkflowRunArtifactStore = {
      workflowsDir: real.workflowsDir,
      cwd: real.cwd,
      runsDir: real.runsDir,
      maxEvents: real.maxEvents,
      maxBytes: real.maxBytes,
      matchesCwd: (cwd) => real.matchesCwd(cwd),
      journalPath: (runId) => real.journalPath(runId),
      create: (runId, events) => real.create(runId, events),
      replace: (_runId, _events) => {
        replacements++;
        throw new Error("simulated post-write failure");
      },
      load: (runId) => real.load(runId),
      scan: () => real.scan(),
    };
    const workflows = new WorkflowManager({
      artifacts: failing,
      createId: () => "wf-atomic",
      now: () => 2,
    });
    const createdState = workflows.createRun(definition, { cwd: project });
    const versions: number[] = [];
    workflows.subscribe(createdState.id, (state) =>
      versions.push(state.version),
    );
    assert.throws(
      () => workflows.start(createdState.id),
      /simulated post-write failure/u,
    );
    assert.equal(replacements, 1);
    assert.equal(workflows.get(createdState.id)?.status, "pending_approval");
    assert.equal(workflows.events(createdState.id).length, 1);
    assert.deepEqual(real.load("wf-atomic"), workflows.events("wf-atomic"));
    assert.deepEqual(versions, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("terminal cancellation remains journal-bound when persistence fails", async () => {
  const { root, project } = tempProject();
  try {
    const real = new WorkflowArtifactStore({
      workflowsDir: path.join(root, "workflows"),
      cwd: project,
    });
    let failReplace = false;
    let cancelCalls = 0;
    const failing: WorkflowRunArtifactStore = {
      workflowsDir: real.workflowsDir,
      cwd: real.cwd,
      runsDir: real.runsDir,
      maxEvents: real.maxEvents,
      maxBytes: real.maxBytes,
      matchesCwd: (cwd) => real.matchesCwd(cwd),
      journalPath: (runId) => real.journalPath(runId),
      create: (runId, events) => real.create(runId, events),
      replace: (runId, events) => {
        if (failReplace)
          throw new Error("simulated terminal persistence failure");
        real.replace(runId, events);
      },
      load: (runId) => real.load(runId),
      scan: () => real.scan(),
    };
    const executor: WorkflowChildExecutor = {
      spawn: async (_backend, task) => runningChild(task),
      awaitSettlement: async () => new Promise<SubagentSnapshot>(() => {}),
      cancel: async () => {
        cancelCalls++;
        return [];
      },
    };
    const workflows = new WorkflowManager({
      artifacts: failing,
      createId: () => "wf-terminal-atomic",
      execution: { executor, cwd: project },
    });
    const createdState = workflows.createRun(
      {
        tasks: [
          {
            id: "active",
            label: "Active",
            kind: "writer",
            prompt: "wait",
            readOnly: true,
          },
        ],
      },
      { cwd: project },
    );
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    workflows.subscribe(createdState.id, (state) => {
      if (state.tasks.active?.status === "running") started();
    });
    const handle = workflows.execute(createdState.id);
    await startedPromise;
    failReplace = true;
    assert.throws(
      () => workflows.cancel(createdState.id, "operator stop"),
      /simulated terminal persistence failure/u,
    );
    assert.equal(workflows.get(createdState.id)?.status, "running");
    assert.equal(workflows.events(createdState.id).at(-1)?._tag, "TaskStarted");
    assert.equal(cancelCalls, 0);
    failReplace = false;
    await handle.cancel("operator stop");
    assert.equal(workflows.get(createdState.id)?.status, "cancelled");
    assert.equal(cancelCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runningChild(task: SpawnTask): SubagentSnapshot {
  if (!task.workflow)
    throw new Error("test child is missing workflow ownership");
  return {
    id: "child-terminal-atomic",
    backend: "pi",
    owner: task.owner ?? "workflow:test",
    workflow: task.workflow,
    resultDelivery: "workflow",
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    status: "running",
    createdAt: 1,
    startedAt: 1,
    lastActivityAt: 1,
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    finalText: "",
    turns: 0,
  };
}

test("persisted log levels are validated instead of trusted by a cast", () => {
  assert.throws(
    () =>
      parseWorkflowJournal(
        JSON.stringify([
          {
            _tag: "WorkflowCreated",
            runId: "wf-log-level",
            at: 1,
            definition,
          },
          { _tag: "WorkflowStarted", runId: "wf-log-level", at: 2 },
          {
            _tag: "WorkflowLogAdded",
            runId: "wf-log-level",
            at: 3,
            level: "verbose",
            message: "bad",
          },
        ]),
      ),
    WorkflowEventBoundsError,
  );
});

test("artifact scanning stops at its entry bound before recovery parsing", () => {
  const { root, project } = tempProject();
  try {
    const workflowsDir = path.join(root, "workflows");
    const writer = new WorkflowArtifactStore({ workflowsDir, cwd: project });
    for (let index = 0; index < 5; index++) {
      const runId = `wf-scan-${index}`;
      writer.create(runId, created(runId));
    }
    const bounded = new WorkflowArtifactStore({
      workflowsDir,
      cwd: project,
      maxScanEntries: 2,
    });
    const scan = bounded.scan();
    assert.equal(scan.artifacts.length, 2);
    assert.match(scan.failures.at(-1)?.message ?? "", /limited to 2 entries/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
