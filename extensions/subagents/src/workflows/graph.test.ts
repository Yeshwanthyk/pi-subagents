import assert from "node:assert/strict";
import { test } from "node:test";
import {
  areTasksOrdered,
  buildWorkflowGraph,
  isOwnedPathContained,
  ownedPathsOverlap,
  validateWorkflowDefinition,
} from "./graph.ts";
import { selectReadyTasks } from "./scheduler.ts";
import type { ValidatedWorkflowGraph } from "./graph.ts";
import type { WorkflowTaskDefinition } from "./domain.ts";
import {
  decodeWorkflowGraph,
  decodeWorkflowSource,
  WorkflowSourceError,
} from "./sandbox.ts";
import {
  WORKFLOW_TOOL_DESCRIPTION,
  WORKFLOW_PROMPT_GUIDELINES,
} from "./prompt.ts";
import { WorkflowManager } from "./manager.ts";
import { createWorkflowDraft } from "./drafts.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type FixtureValue = string | string[] | boolean | undefined;
type FixtureExtras = Readonly<Record<string, FixtureValue>>;
type MutableValidatedWorkflowGraph = {
  -readonly [Key in keyof ValidatedWorkflowGraph]: ValidatedWorkflowGraph[Key];
};

function readOnlyTask(id: string, extra: FixtureExtras = {}) {
  return {
    id,
    label: id,
    kind: "scout",
    prompt: `inspect ${id}`,
    readOnly: true,
    ...extra,
  };
}

function writerTask(id: string, owns: string[], extra: FixtureExtras = {}) {
  return {
    id,
    label: id,
    kind: "writer",
    prompt: `write ${id}`,
    owns,
    ...extra,
  };
}

function validDefinition() {
  return {
    name: "graph",
    tasks: [
      readOnlyTask("scout"),
      writerTask("writer", ["./src/../src/app"]),
      writerTask("child", ["src/app/output.json"], {
        needs: ["writer"],
        consumes: ["writer"],
      }),
    ],
  };
}

function attemptTaskIndexMutation(
  index: ReadonlyMap<string, WorkflowTaskDefinition>,
  task: WorkflowTaskDefinition,
): void {
  // SAFETY: This deliberately widens the read-only test view to verify that
  // the runtime facade does not expose Map.prototype.set.
  const mutableIndex = index as ReadonlyMap<string, WorkflowTaskDefinition> & {
    set(key: string, value: WorkflowTaskDefinition): void;
  };
  mutableIndex.set("forged", task);
}

function attemptDependencyMutation(index: ReadonlySet<string>): void {
  // SAFETY: This deliberately widens the read-only test view to verify that
  // the runtime facade does not expose Set.prototype.add.
  const mutableIndex = index as ReadonlySet<string> & {
    add(value: string): void;
  };
  mutableIndex.add("forged");
}

function forgeGraph(graph: ValidatedWorkflowGraph): ValidatedWorkflowGraph {
  // SAFETY: This is an adversarial test fixture with intentionally forged
  // derived indexes; the scheduler must rebuild them from graph.definition.
  const forged = { ...graph } as MutableValidatedWorkflowGraph;
  forged.tasksById = new Map<string, WorkflowTaskDefinition>();
  forged.dependencies = new Map<string, ReadonlySet<string>>();
  forged.dependants = new Map<string, ReadonlySet<string>>();
  forged.transitiveDependencies = new Map<string, ReadonlySet<string>>();
  return forged;
}

test("graph validation normalizes safe scopes and computes transitive dependencies", () => {
  const graph = buildWorkflowGraph(validDefinition());
  assert.deepEqual(graph.definition.tasks[1]?.owns, ["src/app"]);
  assert.deepEqual(graph.definition.tasks[2]?.owns, ["src/app/output.json"]);
  assert.deepEqual([...graph.transitiveDependencies.get("child")!], ["writer"]);
  assert.deepEqual(graph.declarationOrder, ["scout", "writer", "child"]);
  assert.equal(isOwnedPathContained("src/app", "src/app/file.ts"), true);
  assert.equal(
    isOwnedPathContained("src/app", "src/application/file.ts"),
    false,
  );
  assert.equal(ownedPathsOverlap(["src/app"], ["src/application"]), false);
  assert.equal(ownedPathsOverlap(["src/app"], ["src/app/file.ts"]), true);
});

test("graph indexes are immutable and scheduling verifies forged indexes", () => {
  const graph = buildWorkflowGraph({
    tasks: [readOnlyTask("root"), readOnlyTask("child", { needs: ["root"] })],
  });
  assert.equal(Object.isFrozen(graph), true);
  assert.equal(Object.isFrozen(graph.definition), true);
  assert.equal(Object.isFrozen(graph.tasksById), true);
  assert.equal(Object.isFrozen(graph.dependencies), true);
  assert.equal("set" in graph.tasksById, false);
  assert.equal("add" in graph.dependencies.get("child")!, false);
  assert.throws(
    () => attemptTaskIndexMutation(graph.tasksById, graph.definition.tasks[0]!),
    TypeError,
  );
  assert.throws(
    () => attemptDependencyMutation(graph.dependencies.get("child")!),
    TypeError,
  );

  const forged = forgeGraph(graph);
  assert.deepEqual(selectReadyTasks(forged), ["root"]);
  assert.equal(areTasksOrdered(forged, "child", "root"), true);
  let getterCalled = false;
  const hostile = Object.defineProperty({}, "definition", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error("hostile definition getter");
    },
  });
  assert.throws(
    // SAFETY: the hostile object intentionally violates the graph type to exercise the runtime boundary.
    () => areTasksOrdered(hostile as typeof graph, "child", "root"),
    /getter or setter/,
  );
  assert.equal(getterCalled, false);
});

test("graph validation rejects duplicate, missing, self, cyclic, and invalid consumes edges", () => {
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: [readOnlyTask("x"), readOnlyTask("x")],
      }),
    /Duplicate workflow task/,
  );
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: [readOnlyTask("x", { needs: ["missing"] })],
      }),
    /unknown task/,
  );
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: [readOnlyTask("x", { needs: ["x"] })],
      }),
    /cannot depend on itself/,
  );
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: [
          readOnlyTask("a", { needs: ["b"] }),
          readOnlyTask("b", { needs: ["a"] }),
        ],
      }),
    /cycle/,
  );
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: [
          readOnlyTask("a"),
          readOnlyTask("b", { needs: ["a"], consumes: ["a", "a"] }),
        ],
      }),
    /duplicate consumed dependencies/,
  );
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: [readOnlyTask("a"), readOnlyTask("b", { consumes: ["a"] })],
      }),
    /without a dependency path/,
  );
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: [readOnlyTask("self", { consumes: ["self"] })],
      }),
    /cannot consume itself/,
  );
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: [
          readOnlyTask("a"),
          readOnlyTask("b", { consumes: ["missing"] }),
        ],
      }),
    /consumes unknown task/,
  );
});

test("graph validation enforces bounded IDs and task count", () => {
  assert.throws(
    () =>
      validateWorkflowDefinition({ tasks: [readOnlyTask("x".repeat(129))] }),
    /UTF-8 bytes/,
  );
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: Array.from({ length: 129 }, (_, index) =>
          readOnlyTask(`task-${index}`),
        ),
      }),
    /at most 128 items/,
  );
});

test("graph validation requires exactly one scope and rejects unsafe ownership", () => {
  const invalid = [
    readOnlyTask("both", { owns: ["src/file.ts"] }),
    {
      id: "false",
      label: "false",
      kind: "scout",
      prompt: "p",
      readOnly: false,
    },
    { id: "empty", label: "empty", kind: "writer", prompt: "p", owns: [] },
    writerTask("absolute", ["/tmp/out"]),
    writerTask("parent", ["../out"]),
    writerTask("drive", ["C:\\out"]),
    writerTask("dot", ["."]),
    writerTask("duplicate", ["src/a", "src/./a"]),
  ];
  for (const task of invalid) {
    assert.throws(
      () => validateWorkflowDefinition({ tasks: [task] }),
      /scope|relative|root|duplicate normalized|readOnly|owns/,
    );
  }
});

test("unordered overlapping writers fail while dependency-ordered overlaps pass", () => {
  assert.throws(
    () =>
      validateWorkflowDefinition({
        tasks: [
          writerTask("one", ["src/app"]),
          writerTask("two", ["src/app/file.ts"]),
        ],
      }),
    /overlapping owned paths without dependency order/,
  );

  const ordered = validateWorkflowDefinition({
    tasks: [
      writerTask("one", ["src/app"]),
      writerTask("two", ["src/app/file.ts"], { needs: ["one"] }),
    ],
  });
  assert.deepEqual(ordered.tasks[1]?.needs, ["one"]);
});

test("draft persistence and manager creation both enforce the complete graph boundary", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "workflow-graph-boundary-"),
  );
  const workflowsDir = path.join(root, "workflows");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const invalid = {
      tasks: [
        writerTask("one", ["src/app"]),
        writerTask("two", ["src/app/file.ts"]),
      ],
    };
    assert.throws(
      () =>
        createWorkflowDraft(workflowsDir, {
          sessionId: "session",
          cwd,
          preparedAtUserInput: 1,
          preview: "invalid",
          definition: invalid,
        }),
      /overlapping owned paths/,
    );

    const manager = new WorkflowManager({ createId: () => "wf-boundary" });
    assert.throws(() => manager.createRun(invalid), /overlapping owned paths/);
    assert.equal(manager.list().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sourceFor(body: string): string {
  return `flow({ tasks: [${body}] })`;
}

const staticTask = `{
  id: "scout",
  label: "Scout",
  kind: "scout",
  prompt: "inspect",
  readOnly: true,
}`;

test("sandbox statically decodes one flow literal and never executes source", () => {
  const graph = decodeWorkflowGraph(sourceFor(staticTask));
  assert.deepEqual(graph.declarationOrder, ["scout"]);
  assert.deepEqual(
    decodeWorkflowSource(sourceFor(staticTask)),
    graph.definition,
  );

  const forbidden = [
    `const task = ${staticTask}; flow({ tasks: [task] })`,
    `flow({ tasks: [${staticTask.replace('"inspect"', "process.exit()")}] })`,
    `flow({ tasks: [${staticTask.replace('"inspect"', "read()")}] })`,
    `flow({ tasks: [${staticTask.replace('"inspect"', "`inspect`")}] })`,
    `flow({ tasks: [${staticTask.replace('id: "scout"', '["id"]: "scout"')}] })`,
    `flow({ tasks: [{ id: "scout", label: "Scout", kind: "scout", prompt() {}, readOnly: true }] })`,
    `flow({ tasks: [{ id: "scout", label: "Scout", kind: "scout", get prompt() { return "inspect"; }, readOnly: true }] })`,
    `import x from "x"; ${sourceFor(staticTask)}`,
    `${sourceFor(staticTask)}; ${sourceFor(staticTask)}`,
    `flow({ tasks: [{ ...${staticTask} }] })`,
  ];
  for (const source of forbidden) {
    assert.throws(() => decodeWorkflowSource(source), WorkflowSourceError);
  }
});

test("prompt teaches declarative derived scheduling and bans imperative orchestration", () => {
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /flow\(\{\s*tasks/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /needs/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /consumes/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /readOnly|owns/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /derived/i);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /Do not use.*concurrency/i);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /agent\(\)/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /parallel\(\)/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /pipeline\(\)/);
  assert.ok(WORKFLOW_PROMPT_GUIDELINES.some((line) => /flow\(\)/.test(line)));
});
