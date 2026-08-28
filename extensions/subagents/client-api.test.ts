import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  clientSettlement,
  registerSubagentClientApi,
  type ClientRequestBoundary,
  type SubagentClientSessionContext,
} from "./src/client-api.ts";
import {
  SUBAGENT_CLIENT_CHANNELS,
  type SubagentClientReply,
  type SubagentClientSnapshot,
} from "./src/client-protocol.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";
import type { SubagentManagerApi } from "./src/manager.ts";
import { createSubagentRuntime } from "./src/runtime.ts";

type EventPayload = Parameters<Parameters<ExtensionAPI["events"]["on"]>[1]>[0];

function eventBus() {
  const listeners = new Map<string, Set<(payload: EventPayload) => void>>();
  return {
    on(channel: string, listener: (payload: EventPayload) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
    emit(channel: string, payload: EventPayload) {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
}

function snapshot(task: SpawnTask): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "pi",
    owner: task.owner ?? "subagents",
    resultDelivery: task.resultDelivery ?? "parent",
    client: task.client,
    parentRef: task.parentRef,
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    status: "running",
    createdAt: 1,
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

async function request<T>(
  bus: ReturnType<typeof eventBus>,
  channel: string,
  payload: ClientRequestBoundary,
): Promise<SubagentClientReply<T>> {
  const requestId = String(payload.requestId);
  return new Promise((resolve) => {
    const unsubscribe = bus.on(`${channel}:reply:${requestId}`, (reply) => {
      unsubscribe();
      // SAFETY: reply channels are only ever written by the client API under
      // test, which emits exactly one SubagentClientReply for a requestId.
      resolve(reply as SubagentClientReply<T>);
    });
    bus.emit(channel, payload);
  });
}

test("client API spawns once per client correlation and lists the result", async () => {
  const bus = eventBus();
  const snapshots: SubagentSnapshot[] = [];
  let spawnCount = 0;
  const manager = {
    spawn: (_backend, task) =>
      Effect.sync(() => {
        spawnCount++;
        const created = snapshot(task);
        snapshots.push(created);
        return created;
      }),
    waitFor: () => Effect.void,
    awaitSettlement: () => Effect.succeed(undefined),
    cancel: () => Effect.succeed([]),
    send: () => Effect.void,
    get: () => Effect.succeed(undefined),
    list: Effect.succeed([]),
    disposeAll: Effect.succeed(undefined),
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
  const runtime = createSubagentRuntime();
  const pi = {
    on() {},
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag: () => undefined,
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "high",
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
    events: bus,
  } satisfies ExtensionAPI;
  // SAFETY: This fixture supplies exactly the session-context fields the
  // client API reads (cwd, project trust, model registry, current model).
  const ctx: SubagentClientSessionContext = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    model: undefined,
    // SAFETY: The manager fixture never resolves a model from this registry.
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    sessionManager: {
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getBranch: () => [],
    },
  };
  const dispose = registerSubagentClientApi({
    pi,
    getManager: async () => manager,
    getRuntime: () => runtime,
    getSessionContext: () => ctx,
    getParentEpoch: () => 7,
    resolveChildProjectTrust: () => true,
  });

  const payload = {
    requestId: "spawn-1",
    clientId: "pi-tasks",
    correlationId: "execution-1",
    harness: "pi",
    name: "Task one",
    prompt: "Do it",
  };
  const first = await request<SubagentClientSnapshot>(
    bus,
    SUBAGENT_CLIENT_CHANNELS.spawn,
    payload,
  );
  const duplicate = await request<SubagentClientSnapshot>(
    bus,
    SUBAGENT_CLIENT_CHANNELS.spawn,
    { ...payload, requestId: "spawn-2" },
  );
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual(duplicate, first);
  assert.equal(spawnCount, 1);
  assert.equal(snapshots[0]?.resultDelivery, "client");
  assert.deepEqual(snapshots[0]?.parentRef, {
    epoch: 7,
    leafId: null,
  });

  const listed = await request<SubagentClientSnapshot[]>(
    bus,
    SUBAGENT_CLIENT_CHANNELS.list,
    { requestId: "list-1", clientId: "pi-tasks" },
  );
  assert.equal(listed.success, true);
  if (listed.success)
    assert.equal(listed.data?.[0]?.correlationId, "execution-1");
  let malformedReply = false;
  const unsubscribeMalformed = bus.on(
    `${SUBAGENT_CLIENT_CHANNELS.ping}:reply:malformed`,
    () => {
      malformedReply = true;
    },
  );
  bus.emit(SUBAGENT_CLIENT_CHANNELS.ping, { requestId: 123 });
  assert.equal(malformedReply, false);
  unsubscribeMalformed();
  dispose();
});

test("client settlement distinguishes completion, failure, and cancellation", () => {
  const base = snapshot({
    title: "task",
    prompt: "do it",
    cwd: process.cwd(),
    client: { id: "pi-tasks", correlationId: "execution-1" },
    resultDelivery: "client",
    parent: { parentCwd: process.cwd(), projectTrusted: true },
  });
  assert.equal(
    clientSettlement({
      ...base,
      outcome: { _tag: "Completed", finalText: "done" },
    })?.outcome,
    "completed",
  );
  assert.equal(
    clientSettlement({
      ...base,
      outcome: { _tag: "Failed", errorText: "boom" },
    })?.outcome,
    "failed",
  );
  assert.equal(
    clientSettlement({
      ...base,
      outcome: { _tag: "Interrupted", partialText: "partial" },
    })?.outcome,
    "cancelled",
  );
});
