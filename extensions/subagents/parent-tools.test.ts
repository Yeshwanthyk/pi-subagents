import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import type { SubagentSendMode, SubagentSnapshot } from "./src/domain.ts";
import type { SubagentManagerApi } from "./src/manager.ts";
import {
  createSubagentParentTools,
  projectSubagentInspection,
} from "./src/parent-tools.ts";

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
