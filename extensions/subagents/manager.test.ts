/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the codex name (the production backend
 * launches a real process and has its own live test file), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type {
  BackendName,
  ParentContext,
  SubagentEvent,
  SpawnTask,
  SubagentSnapshot,
} from "./src/domain.ts";
import { SpawnError } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  parentSubagentView,
  operatorSubagentView,
  type SubagentManagerApi,
} from "./src/manager.ts";
import { createParentResultCoordinator } from "./src/parent-coordinator.ts";
import type { ParentSessionManager } from "./src/parent-ref.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

function makeControlledBackend(
  steering = true,
  backendName: BackendName = "codex",
) {
  const starts: string[] = [];
  const sends: Array<{ prompt: string; text: string; mode: string }> = [];
  const sessions = new Map<string, Queue.Queue<SubagentEvent>>();
  const tasks = new Map<string, SpawnTask>();
  const backend: SubagentBackend = {
    name: backendName,
    capabilities: {
      steering,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: (spawnTask) =>
      Effect.gen(function* () {
        starts.push(spawnTask.prompt);
        tasks.set(spawnTask.prompt, spawnTask);
        if (spawnTask.prompt.startsWith("SPAWN_FAIL:")) {
          return yield* new SpawnError({ message: "controlled spawn failure" });
        }
        const events = yield* Queue.make<SubagentEvent>();
        sessions.set(spawnTask.prompt, events);
        return {
          meta: Effect.succeed({
            backend: backendName,
            modelLabel: "controlled/codex",
          }),
          events: Stream.fromQueue(events),
          send: (text, mode) =>
            Effect.sync(() =>
              sends.push({ prompt: spawnTask.prompt, text, mode }),
            ),
          interrupt: Queue.offer(events, {
            _tag: "RunSettled",
            outcome: { _tag: "Interrupted" },
          }).pipe(Effect.asVoid),
        };
      }),
  };

  const emit = (prompt: string, event: SubagentEvent) => {
    const events = sessions.get(prompt);
    assert.ok(events, `No controlled session for ${prompt}`);
    return Effect.runPromise(Queue.offer(events, event));
  };

  return {
    backend,
    starts,
    sends,
    task: (prompt: string) => tasks.get(prompt),
    complete: (prompt: string, finalText = prompt) =>
      emit(prompt, {
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText },
      }),
    emit,
  };
}

const createRuntimeWith = (backend: SubagentBackend) =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(
        Layer.succeed(
          BackendRegistry,
          new Map<BackendName, SubagentBackend>([[backend.name, backend]]),
        ),
      ),
    ),
  );

async function withControlledManager(
  run: (
    manager: SubagentManagerApi,
    runtime: ReturnType<typeof createRuntimeWith>,
    controlled: ReturnType<typeof makeControlledBackend>,
  ) => Promise<void>,
) {
  const controlled = makeControlledBackend();
  const runtime = createRuntimeWith(controlled.backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime, controlled);
  } finally {
    await runtime.dispose();
  }
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, message);
}

async function withPiControlledManager(
  run: (
    manager: SubagentManagerApi,
    runtime: ReturnType<typeof createRuntimeWith>,
    controlled: ReturnType<typeof makeControlledBackend>,
  ) => Promise<void>,
) {
  const controlled = makeControlledBackend(true, "pi");
  const runtime = createRuntimeWith(controlled.backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime, controlled);
  } finally {
    await runtime.dispose();
  }
}

async function withManager(
  run: (
    manager: SubagentManagerApi,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

async function waitForSettlement(
  manager: SubagentManagerApi,
  id: string,
): Promise<SubagentSnapshot> {
  const deadline = Date.now() + 3_000;
  while (
    (manager.view.get(id)?.status === "queued" ||
      manager.view.get(id)?.status === "running") &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const snapshot = manager.view.get(id);
  assert.ok(snapshot);
  assert.notEqual(snapshot.status, "queued");
  assert.notEqual(snapshot.status, "running");
  return snapshot;
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "codex");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:codex\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});
test("listener re-subscription waits for the next notification pass", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`occupy-${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    await waitUntil(
      () => controlled.starts.length === 4,
      "four tasks should occupy the slots",
    );
    const calls: string[] = [];
    let unsubscribeFirst = () => {};
    const second = () => calls.push("second");
    const first = () => {
      calls.push("first");
      unsubscribeFirst();
      manager.view.subscribe(second);
    };
    unsubscribeFirst = manager.view.subscribe(first);

    const queued = await runTool(
      runtime,
      manager.spawn("codex", task("queued-listener-test")),
    );
    assert.deepEqual(calls, ["first"]);

    await runTool(runtime, manager.cancel([queued.id]));
    assert.equal(calls[0], "first");
    assert.ok(calls.slice(1).every((call) => call === "second"));
    assert.ok(calls.includes("second"));
  });
});

test("activity snapshots track live and completed tool operations", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("Observe tool activity")),
    );
    const deadline = Date.now() + 3_000;
    while (
      manager.view.get(snap.id)?.liveTools.length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const active = manager.view.get(snap.id);
    assert.equal(active?.liveTools[0]?.name, "shell");
    assert.ok((active?.liveTools[0]?.startedAt ?? 0) > 0);
    assert.ok((active?.lastActivityAt ?? 0) >= active!.createdAt);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.equal(done?.completedOperations, 1);
    assert.equal(done?.lastCompletedOperation?.name, "shell");
    assert.equal(done?.processTelemetry, "unavailable");
  });
});

test("backend metadata propagates effective reasoning effort", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", {
        ...task("Reason about metadata"),
        reasoningEffort: "high",
      }),
    );

    assert.equal(snap.meta.reasoningEffort, "high");
    assert.equal(manager.view.get(snap.id)?.meta.reasoningEffort, "high");
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (
      manager.view.get(snap.id)?.status === "queued" ||
      manager.view.get(snap.id)?.status === "running"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("shared admission is FIFO across direct and workflow-owned tasks", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4, 5, 6, 7],
        (n) => {
          const spawnTask = task(`Task ${n}`);
          return manager.spawn(
            "codex",
            n === 6
              ? {
                  ...spawnTask,
                  workflow: { runId: "wf-1", taskId: "writer" },
                }
              : spawnTask,
          );
        },
        { concurrency: "unbounded" },
      ),
    );
    await waitUntil(
      () => controlled.starts.length === 4,
      "only four backend sessions should start initially",
    );
    assert.deepEqual(controlled.starts, [
      "Task 1",
      "Task 2",
      "Task 3",
      "Task 4",
    ]);
    assert.deepEqual(
      spawns.slice(4).map((snapshot) => snapshot.status),
      ["queued", "queued", "queued"],
    );
    assert.deepEqual(spawns[5]?.workflow, {
      runId: "wf-1",
      taskId: "writer",
    });

    await controlled.complete("Task 2");
    await waitUntil(
      () => controlled.starts.length === 5,
      "Task 5 should start",
    );
    assert.equal(controlled.starts[4], "Task 5");
    const fifthSettlement = runTool(
      runtime,
      manager.awaitSettlement(spawns[4]!.id),
    );
    await controlled.complete("Task 5", "fifth result");
    assert.equal((await fifthSettlement)?.finalText, "fifth result");

    await controlled.complete("Task 4");
    await waitUntil(
      () => controlled.starts.length === 6,
      "Task 6 should start",
    );
    assert.equal(controlled.starts[5], "Task 6");
    await controlled.complete("Task 1");
    await waitUntil(
      () => controlled.starts.length === 7,
      "Task 7 should start",
    );
    assert.equal(controlled.starts[6], "Task 7");
  });
});

test("cancelling queued work never starts its backend session", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4, 5],
        (n) => manager.spawn("codex", task(`cancel-queued-${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    await waitUntil(
      () => controlled.starts.length === 4,
      "four tasks should start",
    );
    const queued = spawns[4]!;
    assert.equal(queued.status, "queued");
    const [result] = await runTool(runtime, manager.cancel([queued.id]));
    assert.equal(result?.cancelled, true);
    assert.equal(manager.view.get(queued.id)?.outcome?._tag, "Interrupted");

    await controlled.complete("cancel-queued-1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(controlled.starts.includes("cancel-queued-5"), false);
  });
});

test("running cancellation releases one slot exactly once", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4, 5, 6],
        (n) => manager.spawn("codex", task(`cancel-running-${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    await waitUntil(
      () => controlled.starts.length === 4,
      "four tasks should start",
    );
    await runTool(runtime, manager.cancel([spawns[0]!.id]));
    await waitUntil(
      () => controlled.starts.length === 5,
      "fifth task should start",
    );
    assert.equal(controlled.starts[4], "cancel-running-5");

    await controlled.emit("cancel-running-1", {
      _tag: "RunSettled",
      outcome: { _tag: "Interrupted" },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(controlled.starts.length, 5);
    assert.equal(manager.view.get(spawns[5]!.id)?.status, "queued");

    await controlled.complete("cancel-running-2");
    await waitUntil(
      () => controlled.starts.length === 6,
      "sixth task should start",
    );
    assert.equal(controlled.starts[5], "cancel-running-6");
  });
});

test("parallel spawns reserve no more than the global running limit", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index + 1),
        (n) => manager.spawn("codex", task(`parallel-${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    await waitUntil(
      () => controlled.starts.length === 4,
      "four tasks should start",
    );
    assert.equal(controlled.starts.length, 4);
    assert.equal(
      spawns.filter((snapshot) => snapshot.status === "running").length,
      4,
    );
    assert.equal(
      spawns.filter((snapshot) => snapshot.status === "queued").length,
      16,
    );
  });
});

test("backend admission failure settles the record and releases its slot", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        ["SPAWN_FAIL: first", "hold-2", "hold-3", "hold-4", "after-failure"],
        (prompt) => manager.spawn("codex", task(prompt)),
        { concurrency: "unbounded" },
      ),
    );
    const failed = await runTool(
      runtime,
      manager.awaitSettlement(spawns[0]!.id),
    );
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /controlled spawn failure/);
    await waitUntil(
      () => controlled.starts.includes("after-failure"),
      "failure should release capacity for the queued task",
    );
  });
});

test("pi admission failures settle through the shared manager record", async () => {
  await withManager(async (manager, runtime) => {
    const pi = await runTool(
      runtime,
      manager.spawn("pi", task("needs a registry")),
    );
    const failed = await runTool(runtime, manager.awaitSettlement(pi.id));
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /model registry/);

    // The failed Pi admission must release its global slot for Codex work.
    const codex = await runTool(
      runtime,
      manager.spawn("codex", task("after pi failure")),
    );
    await runTool(runtime, manager.waitFor([codex.id]));
    assert.equal(manager.view.get(codex.id)?.status, "done");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("codex", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("settled client agents cannot restart from the manager view", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", {
        ...task("Client task"),
        owner: "pi-tasks",
        resultDelivery: "client",
        client: { id: "pi-tasks", correlationId: "execution-1" },
      }),
    );
    await runTool(runtime, manager.waitFor([snap.id]));

    manager.view.requestSend(snap.id, "run again");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(manager.view.get(snap.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

test("send resolves auto and preserves explicit follow-up semantics", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("mode test")),
    );
    await waitUntil(
      () => manager.view.get(snap.id)?.status === "running",
      "mode-test child should be admitted",
    );

    const automatic = await runTool(runtime, manager.send(snap.id, "steer me"));
    assert.deepEqual(automatic, { id: snap.id, mode: "steer" });
    const followUp = await runTool(
      runtime,
      manager.send(snap.id, "follow later", "follow_up"),
    );
    assert.deepEqual(followUp, { id: snap.id, mode: "follow_up" });
    assert.deepEqual(
      controlled.sends.map(({ text, mode }) => ({ text, mode })),
      [
        { text: "steer me", mode: "steer" },
        { text: "follow later", mode: "follow_up" },
      ],
    );
  });
});

test("explicit steering fails when a backend does not support it", async () => {
  const controlled = makeControlledBackend(false);
  const runtime = createRuntimeWith(controlled.backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("unsupported steer")),
    );
    await waitUntil(
      () => manager.view.get(snap.id)?.status === "running",
      "unsupported-steer child should be admitted",
    );

    await assert.rejects(
      runTool(runtime, manager.send(snap.id, "must steer", "steer")),
      /does not support steering/,
    );
    const result = await runTool(
      runtime,
      manager.send(snap.id, "follow instead", "auto"),
    );
    assert.deepEqual(result, { id: snap.id, mode: "follow_up" });
    assert.deepEqual(controlled.sends, [
      {
        prompt: "unsupported steer",
        text: "follow instead",
        mode: "follow_up",
      },
    ]);
  } finally {
    await runtime.dispose();
  }
});

test("parent questions yield before settlement and replies preserve the running slot", async () => {
  await withPiControlledManager(async (manager, runtime, controlled) => {
    const parentRef = { epoch: 7, sessionFile: "/parent.jsonl", leafId: "leaf" } as const;
    const child = await runTool(
      runtime,
      manager.spawn("pi", { ...task("ask-parent"), parentRef }),
    );
    await waitUntil(() => controlled.task("ask-parent") !== undefined, "Pi child should be admitted");
    const ask = controlled.task("ask-parent")!.askParent!({
      question: "Which option?",
      context: "Two valid options remain.",
    });
    await waitUntil(() => manager.view.get(child.id)?.pendingQuestion !== undefined, "question should be visible");
    const waiting = runTool(runtime, manager.waitForParent!([child.id]));
    const result = await waiting;
    assert.equal(result.questions[0]?.question, "Which option?");
    assert.equal(manager.view.get(child.id)?.status, "running");
    const reply = await runTool(
      runtime,
      manager.send(child.id, "choose B", "reply", result.questions[0]!.requestId, parentRef),
    );
    assert.deepEqual(reply, {
      id: child.id,
      mode: "reply",
      requestId: result.questions[0]!.requestId,
    });
    assert.equal(await ask, "choose B");
    await controlled.complete("ask-parent", "done after answer");
    assert.equal((await runTool(runtime, manager.awaitSettlement(child.id)))?.finalText, "done after answer");
  });
});
test("parent wait keeps acceptance-pending terminals pending", async () => {
  await withPiControlledManager(async (manager, runtime, controlled) => {
    let release!: (result: { status: "pass" }) => void;
    const verdict = new Promise<{ status: "pass" }>((resolve) => {
      release = resolve;
    });
    const child = await runTool(
      runtime,
      manager.spawn("pi", {
        ...task("parent-wait-acceptance"),
        acceptance: { timeoutMs: 2_000, evaluate: () => verdict },
      }),
    );
    await waitUntil(
      () => controlled.task("parent-wait-acceptance") !== undefined,
      "acceptance child should be admitted",
    );
    await controlled.complete("parent-wait-acceptance", "accepted later");
    await waitUntil(
      () =>
        manager.view.get(child.id)?.status === "done" &&
        manager.view.get(child.id)?.acceptance?.status === "pending",
      "process should settle behind the acceptance gate",
    );

    let returned = false;
    const waiting = runTool(runtime, manager.waitForParent!([child.id])).then(
      (result) => {
        returned = true;
        return result;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(returned, false);
    release({ status: "pass" });
    const result = await waiting;
    assert.deepEqual(result.questions, []);
    assert.deepEqual(result.settledIds, [child.id]);
  });
});

test("parent wait observes a sibling settlement without suppressing its delivery", async () => {
  await withPiControlledManager(async (manager, runtime, controlled) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snapshot, consumed) =>
      settled.push({ id: snapshot.id, consumed }),
    );
    const parentRef = { epoch: 10, sessionFile: "/parent.jsonl", leafId: "leaf" } as const;
    const questionChild = await runTool(
      runtime,
      manager.spawn("pi", { ...task("parent-wait-question"), parentRef }),
    );
    const sibling = await runTool(
      runtime,
      manager.spawn("pi", { ...task("parent-wait-sibling"), parentRef }),
    );
    await waitUntil(
      () =>
        controlled.task("parent-wait-question") !== undefined &&
        controlled.task("parent-wait-sibling") !== undefined,
      "both parent-owned Pi children should be admitted",
    );
    let waitStarted = false;
    const waiting = runTool(
      runtime,
      manager.waitForParent!([questionChild.id, sibling.id], () => {
        waitStarted = true;
      }),
    );
    await waitUntil(() => waitStarted, "parent wait should be observing");
    await controlled.complete("parent-wait-sibling", "sibling done");
    await waitUntil(
      () => manager.view.get(sibling.id)?.status === "done",
      "sibling should settle while parent wait is observing",
    );
    const ask = controlled.task("parent-wait-question")!.askParent!({
      question: "Need sibling context",
    });
    const result = await waiting;
    assert.equal(result.questions[0]?.childId, questionChild.id);
    assert.deepEqual(result.settledIds, [sibling.id]);
    assert.deepEqual(
      settled.filter((entry) => entry.id === sibling.id),
      [{ id: sibling.id, consumed: false }],
    );
    await runTool(runtime, manager.cancel([questionChild.id]));
    await assert.rejects(ask, /cancelled with the child/);
  });
});

test("parent question replies reject wrong, stale, duplicate, expired, and queued-answer paths", async () => {
  await withPiControlledManager(async (manager, runtime, controlled) => {
    const parentRef = { epoch: 8, sessionFile: "/parent.jsonl", leafId: "leaf" } as const;
    const child = await runTool(runtime, manager.spawn("pi", { ...task("question-races"), parentRef }));
    await waitUntil(() => controlled.task("question-races") !== undefined, "race child should be admitted");
    const ask = controlled.task("question-races")!.askParent!({ question: "Need a choice" });
    await waitUntil(() => manager.view.get(child.id)?.pendingQuestion !== undefined, "race question should be visible");
    const request = manager.view.get(child.id)!.pendingQuestion!;
    await assert.rejects(
      runTool(runtime, manager.send(child.id, "wrong owner", "reply", request.requestId, { ...parentRef, leafId: "other" })),
      /parent ownership/,
    );
    await assert.rejects(
      runTool(runtime, manager.send(child.id, "stale", "reply", "pq-stale", parentRef)),
      /stale/,
    );
    const followUp = await runTool(runtime, manager.send(child.id, "queued work", "follow_up"));
    assert.equal(followUp.mode, "follow_up");
    assert.notEqual(manager.view.get(child.id)?.pendingQuestion, undefined);
    await runTool(runtime, manager.send(child.id, "steer instead", "steer"));
    await assert.rejects(ask, /cancelled by steering/);
    assert.equal(manager.view.get(child.id)?.pendingQuestion, undefined);

    const expired = controlled.task("question-races")!.askParent!({ question: "Expire me" });
    await waitUntil(() => manager.view.get(child.id)?.pendingQuestion?.requestId !== request.requestId, "second question should be visible");
    const second = manager.view.get(child.id)!.pendingQuestion!;
    const originalNow = Date.now;
    Date.now = () => originalNow() + 301_000;
    try {
      await assert.rejects(
        runTool(runtime, manager.send(child.id, "too late", "reply", second.requestId, parentRef)),
        /expired/,
      );
    } finally {
      Date.now = originalNow;
    }
    await assert.rejects(expired, /timed out/);
    await controlled.complete("question-races", "race done");
  });
});

test("parent question cleanup covers tool abort and child cancellation", async () => {
  await withPiControlledManager(async (manager, runtime, controlled) => {
    const parentRef = { epoch: 9, sessionFile: "/parent.jsonl", leafId: "leaf" } as const;
    const child = await runTool(runtime, manager.spawn("pi", { ...task("abort-question"), parentRef }));
    await waitUntil(() => controlled.task("abort-question") !== undefined, "abort child should be admitted");
    const controller = new AbortController();
    const aborted = controlled.task("abort-question")!.askParent!({ question: "Abort me" }, controller.signal);
    await waitUntil(() => manager.view.get(child.id)?.pendingQuestion !== undefined, "abort question should be visible");
    controller.abort();
    await assert.rejects(aborted, /aborted/);
    assert.equal(manager.view.get(child.id)?.pendingQuestion, undefined);

    const cancelled = controlled.task("abort-question")!.askParent!({ question: "Cancel me" });
    await waitUntil(() => manager.view.get(child.id)?.pendingQuestion !== undefined, "cancel question should be visible");
    await runTool(runtime, manager.cancel([child.id]));
    await assert.rejects(cancelled, /cancelled with the child/);
    assert.equal(manager.view.get(child.id)?.pendingQuestion, undefined);
  });
});

test("running follow-up stays live and settles after the queued turn", async () => {
  await withManager(async (manager, runtime) => {
    const child = await runTool(
      runtime,
      manager.spawn("codex", task("follow-up-lifecycle")),
    );
    await waitUntil(
      () => manager.view.get(child.id)?.status === "running",
      "child should be running",
    );
    const sent = await runTool(
      runtime,
      manager.send(child.id, "queued continuation", "follow_up"),
    );
    assert.equal(sent.mode, "follow_up");
    await waitUntil(
      () => (manager.view.get(child.id)?.turns ?? 0) >= 2,
      "initial turn should finish before the continuation",
    );
    assert.equal(manager.view.get(child.id)?.status, "running");

    await runTool(runtime, manager.waitFor([child.id]));
    const settled = manager.view.get(child.id);
    assert.equal(settled?.turns, 4);
    assert.match(settled?.finalText ?? "", /queued continuation/);
  });
});

test("parent-facing view hides client-correlated jobs while the full view retains them", async () => {
  await withManager(async (manager, runtime) => {
    const parentRun = await runTool(
      runtime,
      manager.spawn("codex", task("parent-owned task")),
    );
    const clientRun = await runTool(
      runtime,
      manager.spawn("codex", {
        ...task("client-owned task"),
        owner: "client-owner",
        resultDelivery: "client",
        client: { id: "client-owner", correlationId: "run-1" },
      }),
    );

    const parentView = parentSubagentView(manager.view);
    assert.deepEqual(
      parentView.list().map((snapshot) => snapshot.id),
      [parentRun.id],
    );
    assert.equal(parentView.get(clientRun.id), undefined);
    assert.equal(manager.view.get(clientRun.id)?.client?.id, "client-owner");

    await runTool(runtime, manager.cancel([parentRun.id, clientRun.id]));
  });
});

test("manager settlement seam never sends client jobs through the parent coordinator", async () => {
  await withManager(async (manager, runtime) => {
    const sessionManager: ParentSessionManager = {
      getSessionFile: () => "/parent/session.jsonl",
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "root" }, { id: "leaf-1" }],
    };
    const context = { sessionManager, isIdle: () => true };
    const sent: string[] = [];
    const coordinator = createParentResultCoordinator({
      sendBatch: (batch) => sent.push(...batch.map((result) => result.id)),
    });
    coordinator.startSession(context, 12);
    manager.view.setOnSettled((snapshot, consumed) =>
      coordinator.onSettled(snapshot, consumed),
    );

    const parentRef = {
      epoch: 12,
      sessionFile: "/parent/session.jsonl",
      leafId: "leaf-1",
    } as const;
    const parentRun = await runTool(
      runtime,
      manager.spawn("codex", {
        ...task("parent result"),
        parentRef,
      }),
    );
    const clientRun = await runTool(
      runtime,
      manager.spawn("codex", {
        ...task("client result"),
        resultDelivery: "client",
        client: { id: "client-owner", correlationId: "run-2" },
        parentRef,
      }),
    );

    await waitForSettlement(manager, parentRun.id);
    assert.equal(coordinator.flush(context), true);
    await waitForSettlement(manager, clientRun.id);
    assert.equal(coordinator.flush(context), false);
    assert.deepEqual(sent, [parentRun.id]);
    assert.equal(coordinator.mailbox.size(), 0);
  });
});

test("workflow observation rejects mismatched ownership without replacing the settle hook", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const owner = { runId: "wf-owner", taskId: "task-1" } as const;
    const snap = await runTool(
      runtime,
      manager.spawn("codex", { ...task("owner-check"), workflow: owner }),
    );
    const wrong = { runId: owner.runId, taskId: "other-task" } as const;

    await assert.rejects(
      runTool(runtime, manager.awaitSettlement(snap.id, wrong)),
      /not owned by workflow/,
    );
    await assert.rejects(
      runTool(runtime, manager.awaitAdmission!(snap.id, wrong)),
      /not owned by workflow/,
    );

    const observed = await runTool(
      runtime,
      manager.observeWorkflow!(snap.id, owner),
    );
    assert.ok(observed);
    assert.equal(observed.ownership.runId, owner.runId);
    assert.equal(manager.view.get(snap.id)?.resultDelivery, "workflow");
    assert.equal(parentSubagentView(manager.view).get(snap.id), undefined);
    const operatorView = operatorSubagentView(manager.view);
    assert.equal(operatorView.get(snap.id)?.id, snap.id);
    const statusBeforeOperatorActions = manager.view.get(snap.id)?.status;
    operatorView.requestSend(snap.id, "must not steer workflow children");
    operatorView.requestAbort(snap.id);
    assert.equal(
      manager.view.get(snap.id)?.status,
      statusBeforeOperatorActions,
    );
    await runTool(runtime, observed.admission);

    await controlled.complete("owner-check", "owned result");
    assert.equal(
      (await runTool(runtime, observed.settlement)).finalText,
      "owned result",
    );
    await runTool(runtime, observed.release);
  });
});

test("workflow observation closes the queued-to-running-to-terminal race", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`admission-hold-${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    await waitUntil(
      () => controlled.starts.length === 4,
      "four slots should be full",
    );

    const owner = { runId: "wf-race", taskId: "queued" } as const;
    const queued = await runTool(
      runtime,
      manager.spawn("codex", { ...task("admission-queued"), workflow: owner }),
    );
    assert.equal(queued.status, "queued");
    const observed = await runTool(
      runtime,
      manager.observeWorkflow!(queued.id, owner),
    );
    assert.ok(observed);
    const admitted = runTool(runtime, observed.admission);

    await controlled.complete("admission-hold-1");
    await waitUntil(
      () => controlled.starts.includes("admission-queued"),
      "queued workflow child should be admitted",
    );
    assert.equal((await admitted).status, "running");

    const settled = runTool(runtime, observed.settlement);
    await controlled.complete("admission-queued", "race-safe");
    assert.equal((await settled).finalText, "race-safe");
    await runTool(runtime, observed.release);
  });
});

test("claimed workflow settlement survives terminal pruning and late lookup", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const owner = { runId: "wf-retention", taskId: "first" } as const;
    const prompts = Array.from(
      { length: 65 },
      (_, index) => `retained-${index}`,
    );
    const snapshots = await runTool(
      runtime,
      Effect.forEach(
        prompts,
        (prompt, index) => {
          const spawnTask = task(prompt);
          return manager.spawn(
            "codex",
            index === 0 ? { ...spawnTask, workflow: owner } : spawnTask,
          );
        },
        { concurrency: "unbounded" },
      ),
    );
    const observed = await runTool(
      runtime,
      manager.observeWorkflow!(snapshots[0]!.id, owner),
    );
    assert.ok(observed);

    for (const prompt of prompts) {
      await waitUntil(
        () => controlled.starts.includes(prompt),
        `${prompt} should be admitted in FIFO order`,
      );
      await controlled.complete(prompt);
    }
    const first = await runTool(runtime, observed.settlement);
    assert.equal(first.status, "done");
    assert.ok(manager.view.get(first.id));

    // A further terminal record forces pruning after the claim is released.
    await runTool(runtime, observed.release);
    const extra = await runTool(
      runtime,
      manager.spawn("codex", task("retained-extra")),
    );
    await controlled.complete("retained-extra");
    await runTool(runtime, manager.awaitSettlement(extra.id));
    assert.equal(manager.view.get(first.id), undefined);

    // The bounded lifecycle handle remains usable after the display row is gone.
    const late = await runTool(
      runtime,
      manager.awaitSettlement(first.id, owner),
    );
    assert.equal(late?.finalText, first.finalText);
  });
});

test("workflow cancellation settles once and releases exactly one slot", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const settled: string[] = [];
    manager.view.setOnSettled((snapshot) => settled.push(snapshot.id));
    const owner = { runId: "wf-cancel", taskId: "cancelled" } as const;
    const snap = await runTool(
      runtime,
      manager.spawn("codex", { ...task("cancel-observed"), workflow: owner }),
    );
    const observed = await runTool(
      runtime,
      manager.claimWorkflow!(snap.id, owner),
    );
    assert.ok(observed);

    await runTool(runtime, manager.cancel([snap.id]));
    const result = await runTool(runtime, observed.settlement);
    assert.equal(result.outcome?._tag, "Interrupted");
    assert.deepEqual(settled, [snap.id]);

    // A late backend terminal notification cannot publish or release again.
    await controlled.emit("cancel-observed", {
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText: "late" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(settled, [snap.id]);
    await runTool(runtime, observed.release);
  });
});

test("standalone acceptance holds settlement and delivery while releasing coding capacity", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    let release!: (value: { status: "pass" }) => void;
    const verdict = new Promise<{ status: "pass" }>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    manager.view.setOnSettled((snapshot) => delivered.push(snapshot.id));
    const gated = await runtime.runPromise(
      manager.spawn("codex", {
        ...task("gated"),
        acceptance: { timeoutMs: 2000, evaluate: () => verdict },
      }),
    );
    await waitUntil(
      () => controlled.starts.includes("gated"),
      "gated child starts",
    );
    let settled = false;
    const settlement = runtime
      .runPromise(manager.awaitSettlement(gated.id))
      .then(() => {
        settled = true;
      });
    let waited = false;
    const waiting = runtime.runPromise(manager.waitFor([gated.id])).then(() => {
      waited = true;
    });
    await controlled.complete("gated");
    await waitUntil(
      () => gated.acceptance?.status === "pending",
      "gate starts",
    );
    assert.equal(gated.status, "done");
    assert.equal(settled, false);
    assert.equal(waited, false);
    assert.deepEqual(delivered, []);
    await assert.rejects(
      runtime.runPromise(manager.send(gated.id, "continue")),
      /awaiting acceptance/,
    );
    for (let index = 0; index < 4; index++) {
      await runtime.runPromise(
        manager.spawn("codex", task(`capacity-${index}`)),
      );
    }
    await waitUntil(
      () => controlled.starts.length === 5,
      "gate does not occupy coding capacity",
    );
    release({ status: "pass" });
    await Promise.all([settlement, waiting]);
    assert.equal(gated.acceptance?.status, "pass");
    assert.deepEqual(delivered, [gated.id]);
  });
});

test("standalone acceptance cancellation ignores late verdicts and publishes once", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    let release!: (value: { status: "pass" }) => void;
    let signal: AbortSignal | undefined;
    const verdict = new Promise<{ status: "pass" }>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    manager.view.setOnSettled((snapshot) => delivered.push(snapshot.id));
    const gated = await runtime.runPromise(
      manager.spawn("codex", {
        ...task("cancel-gate"),
        acceptance: {
          timeoutMs: 2000,
          evaluate: (_snapshot, abortSignal) => {
            signal = abortSignal;
            return verdict;
          },
        },
      }),
    );
    await waitUntil(() => controlled.starts.length === 1, "child starts");
    await controlled.complete("cancel-gate");
    await waitUntil(() => signal !== undefined, "gate evaluates");
    const results = await runtime.runPromise(manager.cancel([gated.id]));
    assert.equal(results[0]?.cancelled, true);
    assert.equal(signal?.aborted, true);
    assert.equal(gated.acceptance?.status, "error");
    release({ status: "pass" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gated.acceptance?.status, "error");
    assert.deepEqual(delivered, [gated.id]);
  });
});

test("standalone acceptance timeout is not process failure and does not expose evaluator errors", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const gated = await runtime.runPromise(
      manager.spawn("codex", {
        ...task("timeout-gate"),
        acceptance: { timeoutMs: 20, evaluate: () => new Promise(() => {}) },
      }),
    );
    await waitUntil(() => controlled.starts.length === 1, "child starts");
    await controlled.complete("timeout-gate");
    await runtime.runPromise(manager.awaitSettlement(gated.id));
    assert.equal(gated.status, "done");
    assert.equal(gated.outcome?._tag, "Completed");
    assert.deepEqual(gated.acceptance, {
      status: "error",
      reason: "Acceptance gate timed out.",
    });
  });
});

test("manager rejects acceptance hooks on workflow-owned children", async () => {
  await withControlledManager(async (manager, runtime) => {
    await assert.rejects(
      runtime.runPromise(
        manager.spawn("codex", {
          ...task("workflow-gate"),
          workflow: { runId: "run", taskId: "task", attemptId: "attempt" },
          acceptance: {
            timeoutMs: 1000,
            evaluate: async () => ({ status: "pass" }),
          },
        }),
      ),
      /parent-owned task/,
    );
  });
});

test("process failure bypasses standalone acceptance", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    let evaluations = 0;
    const failed = await runtime.runPromise(
      manager.spawn("codex", {
        ...task("failed-before-gate"),
        acceptance: {
          timeoutMs: 1000,
          evaluate: async () => {
            evaluations++;
            return { status: "pass" };
          },
        },
      }),
    );
    await waitUntil(() => controlled.starts.length === 1, "child starts");
    await controlled.emit("failed-before-gate", {
      _tag: "RunSettled",
      outcome: { _tag: "Failed", errorText: "process failed" },
    });
    const settled = await runtime.runPromise(
      manager.awaitSettlement(failed.id),
    );
    assert.equal(settled?.outcome?._tag, "Failed");
    assert.equal(settled?.acceptance, undefined);
    assert.equal(evaluations, 0);
  });
});

test("standalone acceptance preserves rejection and hides evaluator errors", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const rejected = await runtime.runPromise(
      manager.spawn("codex", {
        ...task("rejected-gate"),
        acceptance: {
          timeoutMs: 1000,
          evaluate: async () => ({
            status: "reject",
            reason: "insufficient proof",
          }),
        },
      }),
    );
    const errored = await runtime.runPromise(
      manager.spawn("codex", {
        ...task("errored-gate"),
        acceptance: {
          timeoutMs: 1000,
          evaluate: async () => {
            throw new Error("private provider failure");
          },
        },
      }),
    );
    await waitUntil(() => controlled.starts.length === 2, "children start");
    await Promise.all([
      controlled.complete("rejected-gate"),
      controlled.complete("errored-gate"),
    ]);
    await Promise.all([
      runtime.runPromise(manager.awaitSettlement(rejected.id)),
      runtime.runPromise(manager.awaitSettlement(errored.id)),
    ]);
    assert.equal(rejected.outcome?._tag, "Completed");
    assert.deepEqual(rejected.acceptance, {
      status: "reject",
      reason: "insufficient proof",
    });
    assert.equal(errored.outcome?._tag, "Completed");
    assert.deepEqual(errored.acceptance, {
      status: "error",
      reason: "Acceptance gate evaluation failed.",
    });
  });
});

test("standalone acceptance converts invalid evaluator output to a bounded error", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    const invalid = await runtime.runPromise(
      manager.spawn("codex", {
        ...task("invalid-gate"),
        acceptance: {
          timeoutMs: 1000,
          // SAFETY: Deliberately violate the compile-time callback contract to
          // prove that JavaScript evaluator output is checked at runtime.
          evaluate: async () => ({ status: "maybe", reason: 42 }) as never,
        },
      }),
    );
    await waitUntil(() => controlled.starts.length === 1, "child starts");
    await controlled.complete("invalid-gate");
    await runtime.runPromise(manager.awaitSettlement(invalid.id));
    assert.deepEqual(invalid.acceptance, {
      status: "error",
      reason: "Acceptance gate returned an invalid result.",
    });
  });
});

test("acceptance timeout fences late gate and process results exactly once", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    let release!: (value: { status: "pass" }) => void;
    let signal: AbortSignal | undefined;
    const verdict = new Promise<{ status: "pass" }>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    manager.view.setOnSettled((snapshot) => delivered.push(snapshot.id));
    const gated = await runtime.runPromise(
      manager.spawn("codex", {
        ...task("late-gate"),
        acceptance: {
          timeoutMs: 20,
          evaluate: (_snapshot, abortSignal) => {
            signal = abortSignal;
            return verdict;
          },
        },
      }),
    );
    await waitUntil(() => controlled.starts.length === 1, "child starts");
    await controlled.complete("late-gate");
    await runtime.runPromise(manager.awaitSettlement(gated.id));
    assert.equal(signal?.aborted, true);
    release({ status: "pass" });
    await controlled.complete("late-gate", "duplicate process result");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(gated.acceptance, {
      status: "error",
      reason: "Acceptance gate timed out.",
    });
    assert.deepEqual(delivered, [gated.id]);
  });
});

test("shutdown aborts a pending acceptance and settles its handle without delivery", async () => {
  const controlled = makeControlledBackend();
  const runtime = createRuntimeWith(controlled.backend);
  const manager = await runtime.runPromise(SubagentManager);
  let signal: AbortSignal | undefined;
  const delivered: string[] = [];
  manager.view.setOnSettled((snapshot) => delivered.push(snapshot.id));
  const gated = await runtime.runPromise(
    manager.spawn("codex", {
      ...task("shutdown-gate"),
      acceptance: {
        timeoutMs: 2000,
        evaluate: (_snapshot, abortSignal) => {
          signal = abortSignal;
          return new Promise(() => {});
        },
      },
    }),
  );
  await waitUntil(() => controlled.starts.length === 1, "child starts");
  await controlled.complete("shutdown-gate");
  await waitUntil(() => signal !== undefined, "gate starts");
  await runtime.runPromise(manager.disposeAll);
  const settled = await runtime.runPromise(manager.awaitSettlement(gated.id));
  assert.equal(signal?.aborted, true);
  assert.deepEqual(settled?.acceptance, {
    status: "error",
    reason: "Acceptance gate was cancelled during shutdown.",
  });
  assert.deepEqual(delivered, []);
  await runtime.dispose();
});

test("manager rejects acceptance on client delivery and invalid timeouts", async () => {
  await withControlledManager(async (manager, runtime) => {
    const acceptance = {
      timeoutMs: 1000,
      evaluate: async () => ({ status: "pass" as const }),
    };
    await assert.rejects(
      runtime.runPromise(
        manager.spawn("codex", {
          ...task("client-gate"),
          resultDelivery: "client",
          client: { id: "owner", correlationId: "correlation" },
          acceptance,
        }),
      ),
      /parent-owned task/,
    );
    await assert.rejects(
      runtime.runPromise(
        manager.spawn("codex", {
          ...task("invalid-timeout"),
          acceptance: { ...acceptance, timeoutMs: 0 },
        }),
      ),
      /valid bounded timeout/,
    );
  });
});

test("pending acceptance survives tracked-entry pruning", async () => {
  await withControlledManager(async (manager, runtime, controlled) => {
    let release!: (value: { status: "pass" }) => void;
    const verdict = new Promise<{ status: "pass" }>((resolve) => {
      release = resolve;
    });
    const gated = await runtime.runPromise(
      manager.spawn("codex", {
        ...task("retained-gate"),
        acceptance: { timeoutMs: 2000, evaluate: () => verdict },
      }),
    );
    const others = await runtime.runPromise(
      Effect.forEach(
        Array.from({ length: 64 }, (_, index) => `gate-prune-${index}`),
        (prompt) => manager.spawn("codex", task(prompt)),
        { concurrency: "unbounded" },
      ),
    );
    await waitUntil(
      () => controlled.starts.includes("retained-gate"),
      "gated child starts",
    );
    await controlled.complete("retained-gate");
    await waitUntil(
      () => gated.acceptance?.status === "pending",
      "gate becomes pending",
    );

    for (let index = 0; index < others.length; index++) {
      const prompt = `gate-prune-${index}`;
      await waitUntil(
        () => controlled.starts.includes(prompt),
        `${prompt} starts`,
      );
      await controlled.complete(prompt);
    }
    assert.equal(manager.view.get(gated.id)?.acceptance?.status, "pending");
    release({ status: "pass" });
    const settled = await runtime.runPromise(manager.awaitSettlement(gated.id));
    assert.equal(settled?.acceptance?.status, "pass");
  });
});
