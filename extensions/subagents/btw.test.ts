import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  BTW_TOOLS,
  btwPrompt,
  currentBtwExternalHost,
  registerBtw,
  titleForBtw,
} from "./src/btw.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";
import type { PreparedPiSession } from "./src/external-shell.ts";
import type { SubagentManagerShape } from "./src/manager.ts";
import type { SubagentRuntime } from "./src/runtime.ts";

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void> | void;

function runtime(): SubagentRuntime {
  return {
    runPromiseExit: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromiseExit(effect),
  } as SubagentRuntime;
}

function snapshot(task: SpawnTask): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "pi",
    owner: task.owner ?? "subagents",
    visibility: task.visibility ?? "standard",
    resultDelivery: task.resultDelivery ?? "parent",
    tools: task.tools,
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    status: "running",
    createdAt: 10,
    meta: { backend: "pi", sessionFilePath: "/tmp/btw-child.jsonl" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };
}

function managerWith(
  options: {
    spawn?: (task: SpawnTask) => SubagentSnapshot;
    snapshots?: SubagentSnapshot[];
  } = {},
): SubagentManagerShape {
  const snapshots = options.snapshots ?? [];
  const view = {
    list: () => snapshots,
    get: (id: string) => snapshots.find((item) => item.id === id),
    size: () => snapshots.length,
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestSend: () => {},
    requestAbort: () => {},
    setOnSettled: () => {},
  };
  return {
    spawn: (_backend: "pi", task: SpawnTask) =>
      Effect.sync(() => {
        const created = options.spawn?.(task) ?? snapshot(task);
        snapshots.push(created);
        return created;
      }),
    close: () => Effect.succeed(undefined),
    release: () => Effect.succeed(undefined),
    waitFor: () => Effect.void,
    view,
  } as unknown as SubagentManagerShape;
}

function harness(options: {
  manager?: SubagentManagerShape;
  entries?: SessionEntry[];
  env?: NodeJS.ProcessEnv;
  launchPrepared?: Parameters<typeof registerBtw>[0]["launchPrepared"];
  createSessionManager?: Parameters<
    typeof registerBtw
  >[0]["createSessionManager"];
  onExec?: (command: string, args: string[]) => void;
}) {
  const commands = new Map<string, CommandHandler>();
  const lifecycle = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>>
  >();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<[string, string | undefined]> = [];
  let selectedOptions: string[] = [];
  let customCalls = 0;
  const ui = {
    input: async () => undefined,
    select: async (_title: string, choices: string[]) => {
      selectedOptions = choices;
      return choices[0];
    },
    custom: async () => {
      customCalls++;
      return null;
    },
    notify: (message: string, type?: string) => {
      notifications.push([message, type]);
    },
  };
  const sessionManager = {
    getEntries: () => options.entries ?? [],
    getSessionFile: () => "/tmp/parent.jsonl",
    getLeafId: () => "parent-leaf",
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui,
    sessionManager,
    model: { provider: "openai", id: "gpt-test" },
    modelRegistry: {},
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext;
  let sessionContext: ExtensionContext | undefined = ctx;
  const pi = {
    on(
      event: string,
      listener: (event: unknown, ctx: ExtensionContext) => void,
    ) {
      const listeners = lifecycle.get(event) ?? [];
      listeners.push(listener);
      lifecycle.set(event, listeners);
    },
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      commands.set(name, definition.handler);
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
    getThinkingLevel: () => "high",
    async exec(command: string, args: string[]) {
      options.onExec?.(command, args);
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI;
  const manager = options.manager ?? managerWith();

  registerBtw({
    pi,
    getManager: async () => manager,
    getRuntime: runtime,
    getSessionContext: () => sessionContext,
    resolveChildProjectTrust: ({ parentTrusted }) => parentTrusted,
    env: options.env ?? {},
    launchPrepared: options.launchPrepared,
    createSessionManager: options.createSessionManager,
  });

  return {
    commands,
    appended,
    notifications,
    ctx,
    selectedOptions: () => selectedOptions,
    customCalls: () => customCalls,
    async startSession() {
      for (const listener of lifecycle.get("session_start") ?? []) {
        await listener({}, ctx);
      }
      sessionContext = ctx;
    },
  };
}

test("BTW launches externally only inside a Herdr workspace", () => {
  assert.equal(
    currentBtwExternalHost({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w17" }),
    "herdr",
  );
  assert.equal(currentBtwExternalHost({ HERDR_ENV: "1" }), undefined);
  assert.equal(
    currentBtwExternalHost({ HERDR_WORKSPACE_ID: "w17" }),
    undefined,
  );
  assert.equal(currentBtwExternalHost({}), undefined);
});

test("BTW derives a compact title and a read-only side prompt", () => {
  assert.equal(
    titleForBtw("\n  Why did this fail?\nMore"),
    "Why did this fail?",
  );
  assert.equal(titleForBtw("x".repeat(80)).length, 64);
  assert.match(btwPrompt("Why?"), /persistent side conversation/);
  assert.match(btwPrompt("Why?"), /Do not modify files/);
  assert.match(btwPrompt("Why?"), /\nWhy\?$/);
});

test("/btw forks the parent into a private read-only floating session", async () => {
  let spawnedTask: SpawnTask | undefined;
  const manager = managerWith({
    spawn(task) {
      spawnedTask = task;
      return snapshot(task);
    },
  });
  const fixture = harness({ manager });
  await fixture.startSession();

  const command = fixture.commands.get("btw");
  assert.ok(command);
  await command("Why is the test flaky?", fixture.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(spawnedTask?.owner, "btw");
  assert.equal(spawnedTask?.visibility, "private");
  assert.equal(spawnedTask?.resultDelivery, "none");
  assert.deepEqual(spawnedTask?.tools, BTW_TOOLS);
  assert.deepEqual(spawnedTask?.sessionSeed, {
    kind: "fork",
    parentSessionFile: "/tmp/parent.jsonl",
    parentLeafId: "parent-leaf",
  });
  assert.match(spawnedTask?.prompt ?? "", /Why is the test flaky\?/);
  assert.equal(fixture.customCalls(), 1);
  assert.deepEqual(fixture.appended, [
    {
      customType: "pi-btw-session",
      data: {
        id: "sa-1",
        title: "Why is the test flaky?",
        createdAt: 10,
        sessionFile: "/tmp/btw-child.jsonl",
        location: "floating",
      },
    },
  ]);
});

test("Herdr /btw prepares the fork before prompting the external agent", async () => {
  let prepared: PreparedPiSession | undefined;
  let childTask: SpawnTask | undefined;
  let sessionName: string | undefined;
  const fixture = harness({
    env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w17" },
    createSessionManager: ((task: SpawnTask) => {
      childTask = task;
      return {
        appendSessionInfo(name: string) {
          sessionName = name;
        },
        getSessionFile: () => "/tmp/prepared-btw.jsonl",
      } as unknown as SessionManager;
    }) as NonNullable<
      Parameters<typeof registerBtw>[0]["createSessionManager"]
    >,
    launchPrepared(value) {
      prepared = value;
      return {
        host: "herdr",
        target: value.name,
        focusCommand: `herdr agent focus '${value.name}'`,
      };
    },
  });
  await fixture.startSession();

  const command = fixture.commands.get("btw");
  assert.ok(command);
  await command("Explain the current design", fixture.ctx);

  assert.equal(childTask?.visibility, "private");
  assert.equal(childTask?.resultDelivery, "none");
  assert.deepEqual(childTask?.sessionSeed, {
    kind: "fork",
    parentSessionFile: "/tmp/parent.jsonl",
    parentLeafId: "parent-leaf",
  });
  assert.equal(sessionName, "btw: Explain the current design");
  assert.equal(prepared?.sessionFile, "/tmp/prepared-btw.jsonl");
  assert.match(prepared?.prompt ?? "", /Explain the current design/);
  assert.deepEqual(prepared?.tools, BTW_TOOLS);
  assert.equal(prepared?.model?.id, "gpt-test");
  assert.equal(prepared?.thinkingLevel, "high");
  assert.equal(
    (fixture.appended[0]?.data as { location?: string }).location,
    "external",
  );
});

test("/btw-sessions restores records and focuses an external session", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const entry = {
    type: "custom",
    id: "entry-1",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: "pi-btw-session",
    data: {
      id: "btw-restored",
      title: "Restored question",
      createdAt: 42,
      sessionFile: "/tmp/restored.jsonl",
      location: "external",
      host: "herdr",
      target: "btw-restored",
    },
  } as SessionEntry;
  const fixture = harness({
    entries: [entry],
    onExec: (command, args) => calls.push({ command, args }),
  });
  await fixture.startSession();

  const command = fixture.commands.get("btw-sessions");
  assert.ok(command);
  await command("", fixture.ctx);

  assert.match(fixture.selectedOptions()[0] ?? "", /Restored question/);
  assert.deepEqual(calls, [
    { command: "herdr", args: ["agent", "focus", "btw-restored"] },
  ]);
});
