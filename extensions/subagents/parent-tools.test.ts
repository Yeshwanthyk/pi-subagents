import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type { SubagentSendMode, SubagentSnapshot } from "./src/domain.ts";
import type { SubagentManagerApi } from "./src/manager.ts";
import {
  createSubagentParentTools,
  projectSubagentInspection,
} from "./src/parent-tools.ts";
import { StandaloneRoutingController } from "./src/integration/routing.ts";
import { loadSubagentSettings } from "./src/routing/settings.ts";
import type { ConcreteRuntimeSelection } from "./src/routing/domain.ts";
import { createAskJevTool } from "./src/integration/jev.ts";
import { createSubagentsSettingsCommand } from "./src/integration/settings-command.ts";
import { createStandaloneJevAcceptance } from "./src/integration/standalone-gate.ts";
import { createWorkflowRoutingPreparer } from "./src/integration/workflow-routing.ts";
import { staticWorkflowDefinitionPreparer } from "./src/workflows/tools.ts";

function snapshot(
  id: string,
  overrides: Partial<SubagentSnapshot> = {},
): SubagentSnapshot {
  return {
    id,
    backend: "pi",
    owner: "subagents",
    resultDelivery: "parent",
    title: id,
    prompt: "inspect me",
    cwd: process.cwd(),
    status: "running",
    createdAt: 1,
    lastActivityAt: 2,
    meta: { backend: "pi", modelLabel: "pi/test" },
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    usage: {},
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  };
}

function fixture(snapshots: SubagentSnapshot[]) {
  const sends: Array<{ id: string; text: string; mode?: SubagentSendMode }> =
    [];
  const manager = {
    spawn: () => Effect.die("unused"),
    waitFor: () => Effect.die("unused"),
    awaitSettlement: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    send: (id, text, mode) =>
      Effect.sync(() => {
        sends.push({ id, text, mode });
        return {
          id,
          mode: mode === "steer" ? ("steer" as const) : ("follow_up" as const),
        };
      }),
    get: (id) => Effect.succeed(snapshots.find((item) => item.id === id)),
    list: Effect.succeed(snapshots),
    disposeAll: Effect.void,
    view: {
      list: () => snapshots,
      get: (id) => snapshots.find((item) => item.id === id),
      size: () => snapshots.length,
      subscribe: () => () => {},
      subscribeTo: () => () => {},
      requestSend: () => {},
      requestAbort: () => {},
      setOnSettled: () => {},
    },
  } satisfies SubagentManagerApi;
  const tools = createSubagentParentTools({
    getManager: async () => manager,
    runEffect: (effect) => Effect.runPromise(effect),
  });
  return { tools, sends };
}

test("inspect is canonical and check is an exact handler/projection alias", () => {
  const { tools } = fixture([snapshot("sa-parent")]);
  assert.equal(tools.inspect.name, "subagent_inspect");
  assert.equal(tools.check.name, "subagent_check");
  assert.equal(tools.check.execute, tools.inspect.execute);
  assert.equal(tools.check.parameters, tools.inspect.parameters);
});

test("inspection is bounded and does not mutate or consume the snapshot", async () => {
  const long = "x".repeat(4_000);
  const inspected = snapshot("sa-parent", {
    liveAssistant: { text: long, thinking: "" },
    liveTools: Array.from({ length: 6 }, (_, index) => ({
      toolId: `tool-${index}`,
      name: `tool-${index}`,
      argsPreview: long,
      outputPreview: long,
      startedAt: index,
      updatedAt: index + 1,
    })),
    queued: Array.from({ length: 6 }, (_, index) => ({
      kind: "follow-up" as const,
      text: `${index}:${long}`,
    })),
    completedOperations: 9,
    lastCompletedOperation: {
      toolId: "finished",
      name: "finished",
      isError: false,
      outputPreview: long,
      finishedAt: 10,
    },
  });
  const before = structuredClone(inspected);
  const { tools } = fixture([inspected]);
  const result = await tools.inspect.execute("call-1", {
    id: inspected.id,
  });

  assert.deepEqual(inspected, before);
  assert.equal(result.details?.currentTools?.length, 4);
  assert.equal(result.details?.queuedInstructions?.length, 4);
  assert.equal(result.details?.omittedCurrentTools, 2);
  assert.equal(result.details?.omittedQueuedInstructions, 2);
  assert.equal(result.details?.latestOutputTruncated, true);
  assert.ok(
    Buffer.byteLength(String(result.details?.latestOutput), "utf8") <= 2_048,
  );
  assert.equal(result.details?.completedOperations, 9);
  assert.deepEqual(result.details?.capabilities, inspected.capabilities);
});

test("inspection returns the latest finalized assistant output between turns", async () => {
  const inspected = snapshot("sa-between-turns", {
    transcript: [
      {
        kind: "assistant",
        parts: [{ type: "text", text: "first turn output" }],
      },
    ],
  });
  const { tools } = fixture([inspected]);
  const result = await tools.inspect.execute("call-between", {
    id: inspected.id,
  });
  assert.equal(result.details.latestOutput, "first turn output");
});

test("parent tools reject workflow and client children", async () => {
  const parent = snapshot("sa-parent");
  const workflow = snapshot("sa-workflow", {
    workflow: { runId: "wf-1", taskId: "task-1" },
    resultDelivery: "workflow",
  });
  const client = snapshot("sa-client", {
    owner: "pi-tasks",
    resultDelivery: "client",
    client: { id: "pi-tasks", correlationId: "execution-1" },
  });
  const { tools, sends } = fixture([parent, workflow, client]);

  for (const id of [workflow.id, client.id]) {
    await assert.rejects(
      tools.inspect.execute("inspect", { id }),
      /Unknown subagent id/,
    );
    await assert.rejects(
      tools.send.execute("send", {
        id,
        message: "must not deliver",
      }),
      /Unknown subagent id/,
    );
  }
  assert.deepEqual(sends, []);
});

test("send returns the manager's effective delivery mode", async () => {
  const { tools, sends } = fixture([snapshot("sa-parent")]);
  const result = await tools.send.execute("send", {
    id: "sa-parent",
    message: "  continue later  ",
    mode: "auto",
  });

  assert.equal(result.details?.requestedMode, "auto");
  assert.equal(result.details?.effectiveMode, "follow_up");
  assert.deepEqual(sends, [
    { id: "sa-parent", text: "continue later", mode: "auto" },
  ]);
});

test("projection exposes conservative capabilities when metadata is absent", () => {
  const projection = projectSubagentInspection(
    snapshot("sa-legacy", { capabilities: undefined }),
  );
  assert.deepEqual(projection.capabilities, {
    steering: false,
    modelSelection: false,
    reasoningEffort: false,
  });
});

test("inspection reports acceptance independently from process status", async () => {
  const inspected = snapshot("sa-gated", {
    status: "done",
    outcome: { _tag: "Completed", finalText: "process completed" },
    acceptance: { status: "reject", reason: "required evidence was missing" },
    finalText: "process completed",
  });
  const { tools } = fixture([inspected]);
  const result = await tools.inspect.execute("inspect-gated", {
    id: inspected.id,
  });

  assert.equal(result.details.acceptance?.status, "reject");
  assert.match(result.content[0]!.text, /Acceptance: reject/);
  assert.match(result.content[0]!.text, /required evidence was missing/);
  assert.match(result.content[0]!.text, /process completed/);
});

test("inspection explicitly retrieves a gated report beyond the routine preview limit", async () => {
  const report = `report start\n${"evidence line\n".repeat(180)}report end`;
  assert.ok(Buffer.byteLength(report, "utf8") > 2_048);
  const inspected = snapshot("sa-gated-report", {
    status: "done",
    outcome: { _tag: "Completed", finalText: report },
    acceptance: { status: "pass" },
    finalText: report,
  });
  const { tools } = fixture([inspected]);
  const result = await tools.inspect.execute("inspect-gated-report", {
    id: inspected.id,
  });

  assert.equal(result.details.latestOutput, report);
  assert.equal(result.details.latestOutputTruncated, false);
  assert.match(result.content[0]!.text, /report end/);
});

test("routed admission requires a newer user message and is idempotent", async () => {
  const settings = loadSubagentSettings({
    cwd: "/workspace",
    projectTrusted: true,
    globalPath: "/global.json",
    readFile: (file) =>
      file === "/global.json"
        ? JSON.stringify({
            version: 1,
            routing: {
              enabled: true,
              routes: {
                scout: {
                  harness: "pi",
                  model: "provider/scout",
                  effort: "high",
                },
              },
            },
          })
        : undefined,
  });
  const controller = new StandaloneRoutingController();
  const context = {
    sessionId: "session-a",
    cwd: "/workspace",
    userInputRevision: 3,
    settings,
    lookupModel: (requested: ConcreteRuntimeSelection) => ({
      available: true as const,
      effective: requested,
    }),
  };
  const proposal = controller.prepare(
    [
      {
        prompt: "inspect",
        name: "Scout",
        cwd: "/workspace",
        classification: { intent: "scout" },
      },
    ],
    context,
  );
  let admissions = 0;
  const admit = async () => {
    admissions += 1;
    return {
      id: "sa-routed",
      title: "Scout",
      cwd: "/workspace",
      harness: "pi" as const,
      model: "provider/scout",
    };
  };

  assert.throws(
    () =>
      controller.approveAndAdmit(
        {
          ...context,
          proposalId: proposal.id,
          bindingDigest: proposal.bindingDigest,
        },
        admit,
      ),
    /newer user response/,
  );
  const approvedContext = {
    ...context,
    userInputRevision: 4,
    proposalId: proposal.id,
    bindingDigest: proposal.bindingDigest,
  };
  const first = await controller.approveAndAdmit(approvedContext, admit);
  assert.throws(
    () =>
      controller.approveAndAdmit(
        { ...approvedContext, sessionId: "wrong-session" },
        admit,
      ),
    /different session/,
  );
  assert.throws(
    () =>
      controller.approveAndAdmit({ ...approvedContext, cwd: "/other" }, admit),
    /different working directory/,
  );
  const repeated = await controller.approveAndAdmit(approvedContext, admit);
  assert.equal(first[0]?.id, "sa-routed");
  assert.equal(repeated[0]?.id, "sa-routed");
  assert.equal(admissions, 1);
});

test("ask_jev forwards only explicit state/questions and returns safe unavailable errors", async () => {
  const seen: unknown[] = [];
  const tool = createAskJevTool({
    getEvaluator: () => ({
      async evaluate(input) {
        seen.push(input);
        return {
          ok: false as const,
          error: {
            code: "not_configured" as const,
            message: "Jev credential is missing",
          },
        };
      },
    }),
  });
  const result = await tool.execute(
    "ask",
    {
      state: "selected evidence",
      questions: {
        intent: {
          type: "choice",
          question: "Intent?",
          options: ["scout", "implementation"],
        },
      },
    },
    undefined,
    undefined,
    { cwd: "/workspace", isProjectTrusted: () => true },
  );

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    state: "selected evidence",
    questions: {
      intent: {
        type: "choice",
        question: "Intent?",
        options: ["scout", "implementation"],
      },
    },
  });
  assert.equal(result.details.ok, false);
  assert.match(result.content[0]!.text, /not_configured/);
});

test("default settings plus a credential prepare an explicitly declared Jev workflow", () => {
  const settings = loadSubagentSettings({
    cwd: "/workspace",
    projectTrusted: true,
    globalPath: "/missing/global.json",
    readFile: () => undefined,
  });
  const preparer = createWorkflowRoutingPreparer(
    staticWorkflowDefinitionPreparer,
    () => ({
      settings,
      jevCredentialPresent: true,
      lookupModel: (requested) => ({ available: true, effective: requested }),
    }),
  );
  const definition = preparer.prepareSpec({
    tasks: [
      {
        id: "evaluate",
        label: "Evaluate",
        kind: "review",
        prompt: "evaluate explicit evidence",
        readOnly: true,
        execution: {
          type: "evaluation",
          payload: {
            state: "explicit evidence",
            questions: {
              verdict: {
                type: "choice",
                question: "Accept?",
                options: ["yes", "no"],
              },
            },
          },
        },
      },
    ],
  });
  assert.equal(definition.evaluationPolicy?.apiKeyEnv, "TYPESAFE_API_KEY");
  assert.equal(
    Object.hasOwn(definition.evaluationPolicy ?? {}, "enabled"),
    false,
  );
});

test("standalone gate rejects missing or truncated evidence without evaluating", async () => {
  let evaluations = 0;
  const acceptance = createStandaloneJevAcceptance(
    {
      evaluator: "jev",
      questions: {
        verdict: {
          type: "choice",
          question: "Accept?",
          options: ["yes", "no"],
        },
      },
      predicate: {
        type: "choice_equals",
        question_id: "verdict",
        value: "yes",
      },
    },
    {
      async evaluate() {
        evaluations += 1;
        return {
          ok: false,
          error: {
            code: "transport_error" as const,
            message: "unexpected call",
          },
        };
      },
    },
  );
  const blank = snapshot("sa-blank", { status: "done", finalText: "  " });
  const truncated = snapshot("sa-truncated", {
    status: "done",
    finalText: "partial",
    finalTextTruncated: true,
  });
  assert.equal(
    (await acceptance.evaluate(blank, new AbortController().signal)).status,
    "error",
  );
  assert.equal(
    (await acceptance.evaluate(truncated, new AbortController().signal)).status,
    "error",
  );
  assert.equal(evaluations, 0);
});

test("settings command validates and atomically saves only an explicit temp scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-settings-"));
  const globalPath = path.join(root, "agent", "subagents.json");
  const notifications: Array<{ message: string; type?: string }> = [];
  let edited = JSON.stringify({
    version: 1,
    routing: { enabled: false },
    jev: { apiKeyEnv: "TEST_JEV_KEY" },
  });
  const command = createSubagentsSettingsCommand({
    globalPath,
    env: { TEST_JEV_KEY: "secret-not-for-output" },
  });
  const ctx = {
    cwd: root,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      async editor() {
        return edited;
      },
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
  };

  await command.handler("global edit", ctx);
  assert.equal(JSON.parse(fs.readFileSync(globalPath, "utf8")).version, 1);
  assert.match(notifications.at(-1)!.message, /Jev credential: configured/);
  assert.doesNotMatch(notifications.at(-1)!.message, /secret-not-for-output/);

  const before = fs.readFileSync(globalPath, "utf8");
  edited = JSON.stringify({ version: 2 });
  await command.handler("global edit", ctx);
  assert.equal(fs.readFileSync(globalPath, "utf8"), before);
  assert.equal(notifications.at(-1)!.type, "error");
  fs.rmSync(root, { recursive: true, force: true });
});
