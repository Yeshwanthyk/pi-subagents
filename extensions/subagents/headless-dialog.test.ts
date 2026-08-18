import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import subagentsExtension, {
  runHeadlessSubagentsDialog,
  type HeadlessSubagentsUI,
} from "./index.ts";
import type { SubagentSnapshot } from "./src/domain.ts";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "pi",
    owner: "subagents",
    resultDelivery: "parent",
    title: "Test agent",
    prompt: "test",
    cwd: process.cwd(),
    status: "running",
    createdAt: 0,
    lastActivityAt: 0,
    meta: { backend: "pi" },
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

function scriptedUI(options: {
  selects: Array<string | undefined>;
  inputs?: Array<string | undefined>;
  confirms?: boolean[];
}) {
  const notifications: Array<[string, string | undefined]> = [];
  const ui: HeadlessSubagentsUI = {
    async select() {
      return options.selects.shift();
    },
    async input() {
      return options.inputs?.shift();
    },
    async confirm() {
      return options.confirms?.shift() ?? false;
    },
    notify(message, type) {
      notifications.push([message, type]);
    },
  };
  return { ui, notifications };
}

test("headless subagents dialog steers a running subagent", async () => {
  const snap = snapshot();
  const sent: Array<[string, string]> = [];
  const { ui, notifications } = scriptedUI({
    selects: ["sa-1 [running] Test agent (pi)", "Steer…", "Back", "Close"],
    inputs: ["Focus on the failing test"],
  });

  await runHeadlessSubagentsDialog(ui, {
    list: () => [snap],
    get: () => snap,
    requestSend: (id, text) => sent.push([id, text]),
    requestAbort: () => {},
  });

  assert.deepEqual(sent, [["sa-1", "Focus on the failing test"]]);
  assert.deepEqual(notifications, [["Sent to sa-1", "info"]]);
});

test("headless subagents dialog confirms before aborting", async () => {
  const snap = snapshot({ id: "sa-2", title: "Abort fixture" });
  const aborted: string[] = [];
  const { ui, notifications } = scriptedUI({
    selects: ["sa-2 [running] Abort fixture (pi)", "Abort", "Back", "Close"],
    confirms: [true],
  });

  await runHeadlessSubagentsDialog(ui, {
    list: () => [snap],
    get: () => snap,
    requestSend: () => {},
    requestAbort: (id) => aborted.push(id),
  });

  assert.deepEqual(aborted, ["sa-2"]);
  assert.deepEqual(notifications, [["Abort requested for sa-2", "info"]]);
});

test("RPC command without dialogs keeps the TUI-only notification fallback", async () => {
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
    | undefined;
  const pi = {
    on() {},
    registerTool() {},
    registerCommand(name: string, command: { handler: typeof commandHandler }) {
      if (name === "subagents") commandHandler = command.handler;
    },
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
    events: {
      on: () => () => {},
      emit() {},
    },
  } satisfies ExtensionAPI;
  subagentsExtension(pi);

  const notifications: Array<[string, string | undefined]> = [];
  // SAFETY: This fixture implements the command-context fields read by the
  // RPC command handler (mode, hasUI, and the ui.notify surface).
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notifications.push([message, type]);
      },
    },
  } as ExtensionCommandContext;

  assert.ok(commandHandler);
  await commandHandler("", ctx);
  assert.deepEqual(notifications, [
    ["Subagent takeover is only available in the TUI", "error"],
  ]);
});
