import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { ValidatedWorkflowDefinition } from "./domain.ts";
import {
  assertWorkflowDraftApproved,
  assertWorkflowDraftArtifactMatches,
  createWorkflowDraft,
  loadWorkflowDraft,
  workflowDraftArtifactPath,
} from "./drafts.ts";
import { WorkflowManager } from "./manager.ts";
import {
  buildWorkflowDraftMessage,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  listSavedWorkflows,
  loadSavedWorkflow,
  workflowSourceSha256,
} from "./saved-workflows.ts";
import {
  WorkflowToolLifecycle,
  type WorkflowDefinitionPreparer,
} from "./tools.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "subagent-workflow-draft-"),
  );
  const workflowsDir = path.join(root, "state", "workflows");
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workflowsDir, cwd, agentDir };
}

function definition(name = "reviewed"): ValidatedWorkflowDefinition {
  return {
    name,
    tasks: [
      {
        id: "inspect",
        label: "Inspect",
        kind: "scout",
        prompt: "inspect without writing",
        readOnly: true,
      },
    ],
  };
}

function preparer(): WorkflowDefinitionPreparer {
  return {
    prepareSource(source) {
      if (source.includes("INVALID"))
        throw new Error("invalid workflow source");
      return definition(source.trim());
    },
    prepareSpec(spec) {
      return spec;
    },
  };
}

function lifecycle(t: TestContext) {
  const paths = fixture(t);
  let run = 0;
  const manager = new WorkflowManager({
    createId: () => `wf-${++run}`,
    now: (() => {
      let at = 100;
      return () => ++at;
    })(),
  });
  const tools = new WorkflowToolLifecycle({
    workflowsDir: paths.workflowsDir,
    agentDir: paths.agentDir,
    manager,
    preparer: preparer(),
    now: () => 42,
    createDraftId: () => "draft_123456789abc",
  });
  return { ...paths, manager, tools };
}

function save(file: string, source: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, "utf8");
}

test("immutable drafts round-trip exact source/spec execution inputs", (t) => {
  const { workflowsDir, cwd } = fixture(t);
  const created = createWorkflowDraft(workflowsDir, {
    sessionId: "session-a",
    cwd,
    preparedAtUserInput: 3,
    preview: "Inspect, then prove",
    definition: definition(),
    source: "flow({ tasks: [] })\n",
    args: "{not-json}",
    background: true,
    now: () => 10,
    createId: () => "draft_aaaaaaaaaaaa",
  });

  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.definition), true);
  assert.equal(Object.isFrozen(created.definition.tasks), true);
  assert.equal(created.provenance.kind, "inline-source");
  assert.equal(
    created.provenance.sha256,
    workflowSourceSha256("flow({ tasks: [] })\n"),
  );
  assert.deepEqual(loadWorkflowDraft(workflowsDir, created.draftId), created);

  const specDraft = createWorkflowDraft(workflowsDir, {
    sessionId: "session-a",
    cwd,
    preparedAtUserInput: 3,
    preview: "Direct declarative spec",
    definition: definition("spec"),
    now: () => 11,
    createId: () => "draft_bbbbbbbbbbbb",
  });
  assert.equal(specDraft.provenance.kind, "inline-spec");
  assert.equal(specDraft.source, undefined);
  assert.equal(specDraft.background, true);
});

test("draft loading and in-memory agreement fail closed on persisted changes", (t) => {
  const { workflowsDir, cwd } = fixture(t);
  const authoritative = createWorkflowDraft(workflowsDir, {
    sessionId: "session-a",
    cwd,
    preparedAtUserInput: 1,
    preview: "Reviewed preview",
    definition: definition(),
    source: "reviewed-source",
    createId: () => "draft_cccccccccccc",
  });
  const file = workflowDraftArtifactPath(workflowsDir, authoritative.draftId);

  fs.writeFileSync(
    file,
    JSON.stringify({ ...authoritative, preview: "changed" }),
  );
  const changed = loadWorkflowDraft(workflowsDir, authoritative.draftId);
  assert.throws(
    () => assertWorkflowDraftArtifactMatches(authoritative, changed),
    /changed after preparation/,
  );

  fs.writeFileSync(
    file,
    JSON.stringify({ ...authoritative, source: "different-source" }),
  );
  assert.throws(
    () => loadWorkflowDraft(workflowsDir, authoritative.draftId),
    /provenance|digest/,
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ ...authoritative, unsupported: true }),
  );
  assert.throws(
    () => loadWorkflowDraft(workflowsDir, authoritative.draftId),
    /unsupported field/,
  );

  fs.writeFileSync(
    file,
    JSON.stringify({
      ...authoritative,
      provenance: { ...authoritative.provenance, kind: "unknown" },
    }),
  );
  assert.throws(
    () => loadWorkflowDraft(workflowsDir, authoritative.draftId),
    /invalid provenance kind/,
  );
  assert.throws(
    () => loadWorkflowDraft(workflowsDir, "../draft_cccccccccccc"),
    /Invalid workflow draft ID/,
  );
});

test("approval requires a newer response in the same session and project", (t) => {
  const { workflowsDir, cwd } = fixture(t);
  const draft = createWorkflowDraft(workflowsDir, {
    sessionId: "session-a",
    cwd,
    preparedAtUserInput: 4,
    preview: "Review me",
    definition: definition(),
    createId: () => "draft_dddddddddddd",
  });

  assert.throws(
    () =>
      assertWorkflowDraftApproved(draft, {
        sessionId: "session-a",
        cwd,
        userInput: 4,
      }),
    /newer user response/,
  );
  assert.throws(
    () =>
      assertWorkflowDraftApproved(draft, {
        sessionId: "session-b",
        cwd,
        userInput: 5,
      }),
    /different session/,
  );
  assert.throws(
    () =>
      assertWorkflowDraftApproved(draft, {
        sessionId: "session-a",
        cwd: path.join(cwd, "other"),
        userInput: 5,
      }),
    /different project/,
  );
  assert.doesNotThrow(() =>
    assertWorkflowDraftApproved(draft, {
      sessionId: "session-a",
      cwd,
      userInput: 5,
    }),
  );
});

test("tool preparation never creates a run and exact later approval creates no child", (t) => {
  const { cwd, manager, tools } = lifecycle(t);
  const prepared = tools.prepare(
    { preview: "One read-only inspection", spec: definition("prepared") },
    { sessionId: "session-a", cwd, userInput: 7 },
  );

  assert.equal(manager.list().length, 0);
  assert.match(prepared.message, /no workflow run or child agent started/i);
  assert.throws(
    () =>
      tools.approve(prepared.draft.draftId, {
        sessionId: "session-a",
        cwd,
        userInput: 7,
      }),
    /newer user response/,
  );
  assert.equal(manager.list().length, 0);
  assert.throws(
    () =>
      tools.approve(prepared.draft.draftId, {
        sessionId: "other",
        cwd,
        userInput: 8,
      }),
    /different session/,
  );
  assert.throws(
    () =>
      tools.approve(prepared.draft.draftId, {
        sessionId: "session-a",
        cwd: path.join(cwd, "other"),
        userInput: 8,
      }),
    /different project/,
  );
  assert.equal(manager.list().length, 0);

  const approved = tools.approve(prepared.draft.draftId, {
    sessionId: "session-a",
    cwd,
    userInput: 8,
  });
  assert.equal(approved.run.status, "running");
  assert.equal(approved.run.definition.name, "prepared");
  assert.equal(approved.run.tasks.inspect?.childId, undefined);
  assert.equal(manager.events(approved.run.id).length, 2);
  assert.throws(
    () =>
      tools.approve(prepared.draft.draftId, {
        sessionId: "session-a",
        cwd,
        userInput: 9,
      }),
    /not pending in this process/,
  );
});

test("tool approval rejects a modified persisted artifact before manager creation", (t) => {
  const { workflowsDir, cwd, manager, tools } = lifecycle(t);
  const prepared = tools.prepare(
    { preview: "Immutable review", source: "original" },
    { sessionId: "session-a", cwd, userInput: 1 },
  );
  const file = workflowDraftArtifactPath(workflowsDir, prepared.draft.draftId);
  fs.writeFileSync(
    file,
    JSON.stringify({ ...prepared.draft, preview: "tampered" }),
  );

  assert.throws(
    () =>
      tools.approve(prepared.draft.draftId, {
        sessionId: "session-a",
        cwd,
        userInput: 2,
      }),
    /changed after preparation/,
  );
  assert.equal(manager.list().length, 0);
  assert.ok(tools.getPending(prepared.draft.draftId));
});

test("saved workflow discovery uses precedence and approval uses reviewed source snapshot", (t) => {
  const { cwd, agentDir, manager, tools } = lifecycle(t);
  const globalFile = path.join(agentDir, "workflows", "audit.js");
  const projectFile = path.join(cwd, ".pi", "workflows", "audit.js");
  save(globalFile, "global");
  save(projectFile, "project-v1");
  save(path.join(cwd, ".agents", "workflows", "release.js"), "release");
  save(path.join(cwd, ".pi", "workflows", "invalid.js"), "INVALID");

  assert.deepEqual(
    tools
      .discoverSaved({ cwd })
      .map((workflow) => [workflow.name, workflow.scope]),
    [
      ["audit", "project-pi"],
      ["release", "project-agents"],
    ],
  );
  const prepared = tools.prepare(
    { savedWorkflow: "audit", preview: "Run the reviewed audit" },
    { sessionId: "session-a", cwd, userInput: 1 },
  );
  assert.equal(prepared.draft.source, "project-v1");
  assert.deepEqual(prepared.draft.provenance, {
    kind: "saved",
    name: "audit",
    path: projectFile,
    scope: "project-pi",
    sha256: workflowSourceSha256("project-v1"),
  });

  fs.writeFileSync(projectFile, "project-v2", "utf8");
  const approved = tools.approve(prepared.draft.draftId, {
    sessionId: "session-a",
    cwd,
    userInput: 2,
  });
  assert.equal(approved.run.definition.name, "project-v1");
  assert.equal(manager.list().length, 1);
});

test("saved workflow filesystem boundary rejects unsafe, symlinked, and oversized sources", (t) => {
  const { cwd, agentDir } = fixture(t);
  const directory = path.join(cwd, ".pi", "workflows");
  const real = path.join(directory, "real.js");
  save(real, "real");
  fs.symlinkSync(real, path.join(directory, "linked.js"));
  save(path.join(directory, "oversized.js"), "x".repeat(512 * 1024 + 1));

  assert.deepEqual(
    listSavedWorkflows(cwd, agentDir).map((workflow) => workflow.name),
    ["real"],
  );
  assert.throws(
    () => loadSavedWorkflow("../real", cwd, agentDir),
    /Invalid saved workflow name/,
  );
  assert.throws(
    () => loadSavedWorkflow("oversized", cwd, agentDir),
    /exceeds 524288 bytes/,
  );
});

test("prompt contract makes prepare, review, and exact later approval explicit", (t) => {
  const { workflowsDir, cwd } = fixture(t);
  const draft = createWorkflowDraft(workflowsDir, {
    sessionId: "session-a",
    cwd,
    preparedAtUserInput: 1,
    preview: "Review this exact graph",
    definition: definition("prompt-contract"),
    createId: () => "draft_eeeeeeeeeeee",
  });
  const message = buildWorkflowDraftMessage({
    draft,
    artifactPath: workflowDraftArtifactPath(workflowsDir, draft.draftId),
  });

  assert.match(WORKFLOW_TOOL_DESCRIPTION, /creates no workflow run/i);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /newer explicit user response/i);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /only the exact draftId/i);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /process-memory metadata agree/i);
  assert.match(message, /Execution digest:/);
  assert.match(message, /exact immutable source\/spec/i);
  assert.match(message, /newer explicit user response/i);
  assert.match(message, /using only the exact draftId/i);
});
