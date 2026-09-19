import assert from "node:assert/strict";
import test from "node:test";
import { defineTool, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createToolCallTimeoutGuard } from "./src/backends/pi.ts";

const result = {
  content: [{ type: "text" as const, text: "ok" }],
  details: {},
};

function delayedTool(name: string, delayMs: number): ToolDefinition {
  return defineTool({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return result;
    },
  });
}

test("the generic Pi tool guard does not abort ask_parent deadlines", async () => {
  const regular = delayedTool("regular_tool", 30);
  const askParent = delayedTool("ask_parent", 30);
  const definitions = new Map([
    [regular.name, regular],
    [askParent.name, askParent],
  ]);
  // SAFETY: the guard only reads these two AgentSession methods while applying.
  const session = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
  } as AgentSession;

  createToolCallTimeoutGuard(10).apply(session);
  await assert.rejects(
    regular.execute("regular", {}, undefined, undefined, undefined!),
    /timed out after 0 minutes/,
  );
  await assert.doesNotReject(
    askParent.execute("ask", {}, undefined, undefined, undefined!),
  );
});
