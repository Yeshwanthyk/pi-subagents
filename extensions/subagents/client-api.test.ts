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
} from "./src/client-api.ts";
import {
  SUBAGENT_CLIENT_CHANNELS,
  type SubagentClientReply,
  type SubagentClientSnapshot,
} from "./src/client-protocol.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";
import type { SubagentManagerShape } from "./src/manager.ts";
import type { SubagentRuntime } from "./src/runtime.ts";

function eventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel: string, listener: (data: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
    emit(channel: string, data: unknown) {
      for (const listener of [...(listeners.get(channel) ?? [])])
        listener(data);
    },
  };
}

function snapshot(task: SpawnTask): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "pi",
    owner: task.owner ?? "subagents",
    visibility: task.visibility ?? "standard",
    resultDelivery: task.resultDelivery ?? "parent",
    client: task.client,
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
  payload: Record<string, unknown>,
): Promise<SubagentClientReply<T>> {
  const requestId = String(payload.requestId);
  return new Promise((resolve) => {
    const unsubscribe = bus.on(`${channel}:reply:${requestId}`, (reply) => {
      unsubscribe();
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
    spawn: (_backend: "pi", task: SpawnTask) =>
      Effect.sync(() => {
        spawnCount++;
        const created = snapshot(task);
        snapshots.push(created);
        return created;
      }),
    cancel: () => Effect.succeed([]),
    view: {
      list: () => snapshots,
      get: (id: string) => snapshots.find((item) => item.id === id),
    },
  } as unknown as SubagentManagerShape;
  const runtime = {
    runPromiseExit: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromiseExit(effect),
  } as SubagentRuntime;
  const pi = {
    events: bus,
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    modelRegistry: {},
  } as unknown as ExtensionContext;
  const dispose = registerSubagentClientApi({
    pi,
    getManager: async () => manager,
    getRuntime: () => runtime,
    getSessionContext: () => ctx,
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
  assert.equal(snapshots[0]?.visibility, "standard");
  assert.equal(snapshots[0]?.resultDelivery, "client");

  const listed = await request<SubagentClientSnapshot[]>(
    bus,
    SUBAGENT_CLIENT_CHANNELS.list,
    { requestId: "list-1", clientId: "pi-tasks" },
  );
  assert.equal(listed.success, true);
  if (listed.success)
    assert.equal(listed.data?.[0]?.correlationId, "execution-1");
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
