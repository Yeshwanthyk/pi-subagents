import assert from "node:assert/strict";
import test from "node:test";
import {
  currentExternalHost,
  launchPreparedPiInHerdr,
} from "./src/external-shell.ts";

test("external host follows the current terminal environment", () => {
  assert.equal(
    currentExternalHost({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "1" }),
    "herdr",
  );
  assert.equal(currentExternalHost({ CMUX_WORKSPACE_ID: "workspace" }), "cmux");
  assert.equal(currentExternalHost({ TMUX: "/tmp/tmux" }), "tmux");
  assert.equal(currentExternalHost({}), undefined);
});

test("nested host markers prefer Herdr, then cmux, then tmux", () => {
  assert.equal(
    currentExternalHost({
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "1",
      CMUX_WORKSPACE_ID: "workspace",
      TMUX: "/tmp/tmux",
    }),
    "herdr",
  );
});

test("prepared Pi sessions launch and receive their first prompt in a Herdr tab", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    return calls.length === 1
      ? JSON.stringify({
          result: {
            root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" },
          },
        })
      : "";
  };

  const launch = launchPreparedPiInHerdr(
    {
      name: "btw-1234",
      title: "Explain the design",
      cwd: "/tmp/project",
      sessionFile: "/tmp/session.jsonl",
      prompt: "Explain this",
      tools: ["read", "grep"],
      model: { provider: "openai", id: "gpt-test" },
      thinkingLevel: "high",
    },
    { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    run,
  );

  assert.deepEqual(launch, {
    host: "herdr",
    target: "btw-1234",
    focusCommand: "herdr agent focus 'btw-1234'",
  });
  assert.deepEqual(calls, [
    {
      command: "herdr",
      args: [
        "tab",
        "create",
        "--workspace",
        "w1",
        "--cwd",
        "/tmp/project",
        "--label",
        "Explain the design",
        "--no-focus",
      ],
    },
    {
      command: "herdr",
      args: [
        "agent",
        "start",
        "btw-1234",
        "--kind",
        "pi",
        "--pane",
        "w1:p2",
        "--timeout",
        "30000",
        "--",
        "--session",
        "/tmp/session.jsonl",
        "--tools",
        "read,grep",
        "--model",
        "openai/gpt-test",
        "--thinking",
        "high",
      ],
    },
    {
      command: "herdr",
      args: ["agent", "prompt", "btw-1234", "Explain this"],
    },
    {
      command: "herdr",
      args: ["agent", "focus", "btw-1234"],
    },
  ]);
});

test("failed prepared launches close the allocated Herdr tab", () => {
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "tab" && args[1] === "create") {
      return JSON.stringify({
        result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" } },
      });
    }
    if (args[0] === "agent" && args[1] === "start") {
      throw new Error("start failed");
    }
    return "";
  };

  assert.throws(
    () =>
      launchPreparedPiInHerdr(
        {
          name: "btw-1234",
          title: "Question",
          cwd: "/tmp/project",
          sessionFile: "/tmp/session.jsonl",
          prompt: "Question",
        },
        { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
        run,
      ),
    /start failed/,
  );
  assert.deepEqual(calls.at(-1), ["tab", "close", "w1:t2"]);
});
