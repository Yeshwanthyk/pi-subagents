import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createChildSessionManager } from "./src/backends/pi.ts";
import type { SpawnTask } from "./src/domain.ts";

function task(cwd: string, sessionSeed: SpawnTask["sessionSeed"]): SpawnTask {
  return {
    title: "seed test",
    prompt: "continue",
    cwd,
    sessionSeed,
    parent: { parentCwd: cwd, projectTrusted: false },
  };
}

test("fork seed copies only the captured branch into the target cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-seed-"));
  try {
    const parentCwd = join(root, "parent");
    const childCwd = join(root, "child");
    mkdirSync(parentCwd);
    mkdirSync(childCwd);
    const parent = SessionManager.create(
      parentCwd,
      join(root, "parent-sessions"),
    );
    const first = parent.appendMessage({
      role: "user",
      content: "first",
      timestamp: Date.now(),
    });
    parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "flushed response" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    parent.appendMessage({
      role: "user",
      content: "not in captured branch",
      timestamp: Date.now(),
    });
    const parentFile = parent.getSessionFile();
    assert.ok(parentFile);

    const child = createChildSessionManager(
      task(childCwd, {
        kind: "fork",
        parentSessionFile: parentFile,
        parentLeafId: first,
      }),
      join(root, "child-sessions"),
    );

    assert.equal(child.getCwd(), childCwd);
    assert.deepEqual(
      child
        .getEntries()
        .filter((entry) => entry.type === "message")
        .map((entry) =>
          entry.type === "message" && entry.message.role === "user"
            ? entry.message.content
            : undefined,
        ),
      ["first"],
    );
    assert.equal(child.getHeader()?.parentSession, parentFile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh seed records its parent without copying messages", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-fresh-"));
  try {
    const cwd = join(root, "child");
    mkdirSync(cwd);
    const child = createChildSessionManager(
      task(cwd, { kind: "fresh", parentSession: "/tmp/parent.jsonl" }),
      join(root, "sessions"),
    );
    assert.equal(child.getEntries().length, 0);
    assert.equal(child.getHeader()?.parentSession, "/tmp/parent.jsonl");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
