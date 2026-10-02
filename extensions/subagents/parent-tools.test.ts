import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type {
  ParentQuestion,
  ParentRef,
  SubagentSendMode,
  SubagentSnapshot,
} from "./src/domain.ts";
import type { SubagentManagerApi } from "./src/manager.ts";
import {
  createSubagentParentTools,
  projectSubagentInspection,
} from "./src/parent-tools.ts";
import {
  StandaloneRoutingController,
  type BoundRoutedSpawnTask,
} from "./src/integration/routing.ts";
import { loadSubagentSettings } from "./src/routing/settings.ts";
import type { ConcreteRuntimeSelection } from "./src/routing/domain.ts";
import { createSubagentsSettingsCommand } from "./src/integration/settings-command.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "./index.ts";
import {
  admitBatch,
  batchOutcomes,
  formatBatchSpawnResult,
  normalizeSpawnRequest,
} from "./src/integration/spawn-batch.ts";
import {
  parseWorkflowControlRequest,
  parseWorkflowToolRequest,
} from "./src/integration/workflow-params.ts";

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

function fixture(
  snapshots: SubagentSnapshot[],
  options: {
    readonly parentRef?: ParentRef;
    readonly isParentRefSafe?: (parentRef: ParentRef) => boolean;
  } = {},
) {
  const sends: Array<{ id: string; text: string; mode?: SubagentSendMode }> =
    [];
  const replyArguments: Array<{
    requestId?: string;
    parentRef?: ParentRef;
  }> = [];
  const manager = {
    spawn: () => Effect.die("unused"),
    waitFor: () => Effect.die("unused"),
    awaitSettlement: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    send: (id, text, mode, requestId, parentRef) =>
      Effect.sync(() => {
        sends.push({ id, text, mode });
        if (mode === "reply") replyArguments.push({ requestId, parentRef });
        return {
          id,
          mode:
            mode === "steer"
              ? ("steer" as const)
              : mode === "reply"
                ? ("reply" as const)
                : ("follow_up" as const),
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
    getParentRef: () => options.parentRef,
    isParentRefSafe: options.isParentRefSafe,
  });
  return { tools, sends, replyArguments };
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

test("inspection exposes a bounded pending question without parent ownership data", async () => {
  const inspected = snapshot("sa-question", {
    pendingQuestion: {
      childId: "sa-question",
      requestId: "pq-1",
      question: "Which option?",
      context: "Choose one",
      deadlineAt: 123_456,
      parentRef: {
        epoch: 9,
        sessionFile: "/private/session.jsonl",
        leafId: "secret-leaf",
      },
    } satisfies ParentQuestion,
  });
  const { tools } = fixture([inspected]);
  const result = await tools.inspect.execute("call-question", {
    id: inspected.id,
  });

  assert.deepEqual(result.details.pendingQuestion, {
    childId: "sa-question",
    requestId: "pq-1",
    question: "Which option?",
    context: "Choose one",
    deadlineAt: 123_456,
  });
  assert.doesNotMatch(result.content[0]!.text, /session\.jsonl|secret-leaf/);
  assert.match(result.content[0]!.text, /pq-1/);
  assert.match(result.content[0]!.text, /1970/);
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
test("reply uses the captured parent lineage after notification advances the leaf", async () => {
  const captured: ParentRef = {
    epoch: 3,
    sessionFile: "/parent.jsonl",
    leafId: "question-leaf",
  };
  const current: ParentRef = { ...captured, leafId: "notification-turn" };
  const inspected = snapshot("sa-lineage", {
    parentRef: captured,
    pendingQuestion: {
      childId: "sa-lineage",
      requestId: "pq-lineage",
      question: "Which branch?",
      deadlineAt: Date.now() + 300_000,
      parentRef: captured,
    },
  });
  const { tools, replyArguments } = fixture([inspected], {
    parentRef: current,
    isParentRefSafe: (parentRef) => parentRef.leafId === captured.leafId,
  });
  const result = await tools.send.execute("reply", {
    id: inspected.id,
    message: "Use the existing branch",
    mode: "reply",
    requestId: "pq-lineage",
  });
  assert.equal(result.details?.effectiveMode, "reply");
  assert.deepEqual(replyArguments, [
    { requestId: "pq-lineage", parentRef: captured },
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

for (const override of [false, true]) {
  test(`routed admission requires newer approval and is idempotent (override=${override})`, async () => {
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
    const task: BoundRoutedSpawnTask = {
      prompt: "inspect",
      name: "Scout",
      cwd: "/workspace",
      classification: { intent: "scout" },
    };
    const requestedTask: BoundRoutedSpawnTask = override
      ? {
          ...task,
          harness: "pi",
          model: "provider/other",
          reasoningEffort: "medium",
        }
      : task;
    const proposal = controller.prepare([requestedTask], context);
    let admissions = 0;
    assert.equal(proposal.status, "pending");
    assert.equal(
      proposal.items[0]?.runtime.preference?.model,
      "provider/scout",
    );
    assert.equal(
      proposal.items[0]?.runtime.effective.model,
      override ? "provider/other" : "provider/scout",
    );
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
    assert.equal(admissions, 0);
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
        controller.approveAndAdmit(
          { ...approvedContext, cwd: "/other" },
          admit,
        ),
      /different working directory/,
    );
    const repeated = await controller.approveAndAdmit(approvedContext, admit);
    assert.equal(first[0]?.id, "sa-routed");
    assert.equal(repeated[0]?.id, "sa-routed");
    assert.equal(admissions, 1);
  });
}

test("settings command validates and atomically saves only an explicit temp scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-settings-"));
  const globalPath = path.join(root, "agent", "subagents.json");
  const notifications: Array<{ message: string; type?: string }> = [];
  let edited = JSON.stringify({
    version: 1,
    routing: { enabled: false },
  });
  const command = createSubagentsSettingsCommand({ globalPath });
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
  assert.match(notifications.at(-1)!.message, /Routing: disabled/);

  const before = fs.readFileSync(globalPath, "utf8");
  edited = JSON.stringify({ version: 2 });
  await command.handler("global edit", ctx);
  assert.equal(fs.readFileSync(globalPath, "utf8"), before);
  assert.equal(notifications.at(-1)!.type, "error");
  fs.rmSync(root, { recursive: true, force: true });
});

/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof -- This fixture inspects raw registered JSON schemas and drives execute through an untyped stub API. */
interface CapturedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<unknown>;
}

/** Load the extension against a no-op API and capture every registered tool. */
function registeredTools(): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const noop = () => undefined;
  const base: Record<string, unknown> = {
    registerTool: (tool: CapturedTool) => tools.set(tool.name, tool),
    getFlag: noop,
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
    getThinkingLevel: () => "high",
    events: { on: () => noop, emit: noop },
  };
  // SAFETY: the proxy answers every other ExtensionAPI method with a no-op,
  // which is all extension loading needs to register its tools.
  const pi = new Proxy(base, {
    get: (target, key: string) => (key in target ? target[key] : noop),
  }) as unknown as ExtensionAPI;
  subagentsExtension(pi);
  return tools;
}

test("every registered tool exposes a provider-safe root object schema", () => {
  const tools = registeredTools();
  for (const name of [
    "subagent_spawn",
    "subagent_wait",
    "subagent_route",
    "subagent_approve",
    "workflow",
    "workflow_control",
  ]) {
    assert.ok(tools.has(name), `${name} should be registered`);
  }
  for (const tool of tools.values()) {
    const schema = tool.parameters;
    assert.equal(schema.type, "object", `${tool.name} root type`);
    for (const combinator of ["anyOf", "oneOf", "allOf", "not"]) {
      assert.equal(
        schema[combinator],
        undefined,
        `${tool.name} root must not use ${combinator}`,
      );
    }
    assert.equal(typeof schema.properties, "object", `${tool.name} properties`);
  }
});

/* oxlint-enable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof */

test("workflow params accept the four prepare/approve shapes and reject ambiguous ones", () => {
  assert.deepEqual(parseWorkflowToolRequest({ draftId: "d-1" }), {
    kind: "approve",
    draftId: "d-1",
  });
  // A stray preview on approval was accepted before and stays harmless.
  assert.deepEqual(parseWorkflowToolRequest({ draftId: "d-1", preview: "p" }), {
    kind: "approve",
    draftId: "d-1",
  });
  assert.deepEqual(
    parseWorkflowToolRequest({ preview: "p", source: "flow({tasks:[]})" }),
    { kind: "prepare", preview: "p", source: "flow({tasks:[]})" },
  );
  assert.deepEqual(
    parseWorkflowToolRequest({
      preview: "p",
      savedWorkflow: "review",
      args: "x",
      background: false,
    }),
    {
      kind: "prepare",
      preview: "p",
      savedWorkflow: "review",
      args: "x",
      background: false,
    },
  );
  const spec = { tasks: [] };
  const prepared = parseWorkflowToolRequest({ preview: "p", spec });
  assert.ok(prepared.kind === "prepare" && "spec" in prepared);
  assert.equal(prepared.spec, spec);
  assert.throws(
    () => parseWorkflowToolRequest({ draftId: "d-1", source: "s" }),
    /approval accepts only draftId; remove source/,
  );
  assert.throws(
    () => parseWorkflowToolRequest({ preview: "p", source: "s", spec }),
    /exactly one of source, spec, or savedWorkflow; received source, spec/,
  );
  assert.throws(
    () => parseWorkflowToolRequest({ preview: "p" }),
    /requires draftId to approve, or preview plus exactly one/,
  );
  assert.throws(
    () => parseWorkflowToolRequest({ source: "s" }),
    /requires preview/,
  );
});

test("workflow_control params require taskId exactly for task actions", () => {
  assert.deepEqual(
    parseWorkflowControlRequest({ action: "pause", runId: "r", reason: "x" }),
    { action: "pause", runId: "r", reason: "x" },
  );
  assert.deepEqual(
    parseWorkflowControlRequest({ action: "retry", runId: "r", taskId: "t" }),
    { action: "retry", runId: "r", taskId: "t" },
  );
  assert.throws(
    () => parseWorkflowControlRequest({ action: "skip", runId: "r" }),
    /skip requires taskId/,
  );
  assert.throws(
    () =>
      parseWorkflowControlRequest({
        action: "cancel",
        runId: "r",
        taskId: "t",
      }),
    /applies to the whole run; remove taskId/,
  );
});

test("batch spawn normalization applies top-level runtime defaults and rejects top-level prompt/name", () => {
  const one = { prompt: "p", name: "n", harness: "pi" as const };
  assert.deepEqual(normalizeSpawnRequest(one), { batch: false, tasks: [one] });
  assert.deepEqual(normalizeSpawnRequest({ tasks: [one, one] }), {
    batch: true,
    tasks: [one, one],
  });
  const bare = { prompt: "p", name: "a" };
  assert.deepEqual(
    normalizeSpawnRequest({
      tasks: [bare, { ...bare, name: "b", model: "own/model" }],
      harness: "pi",
      model: "shared/model",
      reasoning_effort: "low",
    }).tasks,
    [
      {
        harness: "pi",
        model: "shared/model",
        reasoning_effort: "low",
        ...bare,
      },
      {
        harness: "pi",
        model: "own/model",
        reasoning_effort: "low",
        prompt: "p",
        name: "b",
      },
    ],
  );
  assert.throws(
    () => normalizeSpawnRequest({ tasks: [one], prompt: "x", name: "y" }),
    /remove top-level prompt, name/,
  );
  assert.throws(() => normalizeSpawnRequest({ tasks: [] }), /1 to 16 items/);
  assert.throws(
    () =>
      normalizeSpawnRequest({ tasks: Array.from({ length: 17 }, () => one) }),
    /1 to 16 items/,
  );
  assert.throws(
    () => normalizeSpawnRequest({ name: "n" }),
    /requires "prompt"/,
  );
});

test("batch spawn outcomes report per-task ids and failures in order", () => {
  const outcomes = batchOutcomes(
    [{ name: "a" }, { name: "b" }],
    [
      {
        status: "fulfilled",
        value: { id: "sa-1", title: "a", cwd: "/w", harness: "pi", model: "m" },
      },
      { status: "rejected", reason: new Error("backend down") },
    ],
  );
  assert.deepEqual(outcomes, [
    {
      index: 0,
      name: "a",
      ok: true,
      id: "sa-1",
      title: "a",
      cwd: "/w",
      harness: "pi",
      model: "m",
    },
    { index: 1, name: "b", ok: false, error: "backend down" },
  ]);
  const text = formatBatchSpawnResult(outcomes);
  assert.match(text, /Spawned 1\/2 subagent\(s\); 1 failed/);
  assert.match(text, /tasks\[0\] sa-1 "a"/);
  assert.match(text, /tasks\[1\] "b" failed: backend down/);
  assert.match(text, /subagent_wait\(ids: \["sa-1"\]\)/);
});

test("admitBatch admits every task and isolates failures", async () => {
  const started: string[] = [];
  const settled = await admitBatch(["a", "b", "c"], async (name, index) => {
    started.push(name);
    if (name === "b") throw new Error("nope");
    return { id: `sa-${index}`, title: name, cwd: "/w", harness: "pi" };
  });
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.deepEqual(
    settled.map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
});

test("subagent_spawn rejects invalid batch input before starting any child", async () => {
  const spawn = registeredTools().get("subagent_spawn")!;
  const ctx = { cwd: process.cwd() };
  const task = { prompt: "p", name: "n", harness: "pi" };
  await assert.rejects(
    spawn.execute(
      "1",
      { tasks: [task], prompt: "p" },
      undefined,
      undefined,
      ctx,
    ),
    /remove top-level prompt/,
  );
  await assert.rejects(
    spawn.execute(
      "2",
      { tasks: [task], wait_mode: "any" },
      undefined,
      undefined,
      ctx,
    ),
    /wait_mode applies only with wait: true/,
  );
  await assert.rejects(
    spawn.execute(
      "3",
      {
        tasks: [task, { ...task, name: "bad", working_dir: "missing-dir-xyz" }],
      },
      undefined,
      undefined,
      ctx,
    ),
    /tasks\[1\] "bad": working_dir is not a directory[\s\S]*No child started/,
  );
});
