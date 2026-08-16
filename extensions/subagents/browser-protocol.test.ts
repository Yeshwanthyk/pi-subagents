import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import {
  BROWSER_ACTIVITY_LIMITS,
  BROWSER_ACTIVITY_WIDGET_KEY,
  decodeBrowserActivitySnapshot,
  encodeBrowserActivitySnapshot,
  encodeBrowserActivityWidget,
  isBrowserActivitySnapshot,
  projectBrowserActivity,
  projectBrowserTerminal,
} from "./src/browser-protocol.ts";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "claude",
    owner: "subagents",
    visibility: "standard",
    resultDelivery: "parent",
    title: "Browser fixture",
    prompt: "Inspect the repository",
    cwd: "/private/project",
    status: "running",
    createdAt: 1_000,
    lastActivityAt: 2_000,
    meta: {
      backend: "claude",
      modelLabel: "claude/test",
      sessionFilePath: "/private/session.jsonl",
      nativeSessionId: "native-secret",
    },
    usage: { tokens: 12, contextWindow: 100 },
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

test("browser projection is public, bounded, and caps live standard children", () => {
  const running = Array.from({ length: 6 }, (_, index) =>
    snapshot({
      id: `sa-${index + 1}`,
      title: "x".repeat(BROWSER_ACTIVITY_LIMITS.maxTitleLength + 50),
      prompt: "p".repeat(BROWSER_ACTIVITY_LIMITS.maxPromptLength + 50),
      finalText: "o".repeat(BROWSER_ACTIVITY_LIMITS.maxOutputLength + 50),
      transcript: [
        {
          kind: "user",
          text: "t".repeat(
            BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength + 50,
          ),
        },
      ],
      liveTools: [
        {
          toolId: "tool-1",
          name: "bash",
          argsPreview: "a".repeat(
            BROWSER_ACTIVITY_LIMITS.maxToolArgsLength + 50,
          ),
          outputPreview: "r".repeat(
            BROWSER_ACTIVITY_LIMITS.maxToolOutputLength + 50,
          ),
          startedAt: 1_500,
          updatedAt: 2_000,
        },
      ],
    }),
  );
  const privateChild = snapshot({
    id: "sa-private",
    visibility: "private",
    owner: "btw",
  });
  const terminal = snapshot({
    id: "sa-finished",
    status: "error",
    settledAt: 3_000,
    finalText: "partial output",
    errorText: "failed without exposing session details",
  });

  const projected = projectBrowserActivity(
    [...running, privateChild, terminal],
    7,
    terminal,
    4_000,
  );
  assert.equal(projected.version, 1);
  assert.equal(projected.revision, 7);
  assert.equal(projected.generatedAt, 4_000);
  assert.equal(projected.children.length, 4);
  assert.deepEqual(
    projected.children.map((child) => child.id),
    ["sa-1", "sa-2", "sa-3", "sa-4"],
  );
  assert.equal(projected.terminal?.id, "sa-finished");
  assert.equal(projected.terminal?.status, "error");
  assert.ok(
    (projected.children[0]?.prompt.length ?? Infinity) <=
      BROWSER_ACTIVITY_LIMITS.maxPromptLength,
  );
  const firstTranscript = projected.children[0]?.transcript[0];
  assert.equal(firstTranscript?.kind, "user");
  if (firstTranscript?.kind === "user") {
    assert.ok(
      firstTranscript.text.length <=
        BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength,
    );
  }
  assert.ok(
    (projected.children[0]?.tools[0]?.args?.length ?? Infinity) <=
      BROWSER_ACTIVITY_LIMITS.maxToolArgsLength,
  );

  const encoded = encodeBrowserActivitySnapshot(projected);
  assert.ok(
    Buffer.byteLength(encoded, "utf8") <=
      BROWSER_ACTIVITY_LIMITS.maxSnapshotBytes,
  );
  assert.doesNotMatch(encoded, /sessionFilePath|nativeSessionId|cwd|owner|btw/);
  assert.equal(encoded, JSON.stringify(JSON.parse(encoded)));
  assert.deepEqual(decodeBrowserActivitySnapshot(encoded), JSON.parse(encoded));
  assert.deepEqual(encodeBrowserActivityWidget(projected), [encoded]);
  assert.equal(BROWSER_ACTIVITY_WIDGET_KEY, "pi-subagents/activity/v1");
});

test("browser protocol rejects unsafe or unbounded payload shapes", () => {
  const projected = projectBrowserActivity([snapshot()], 1, undefined, 10_000);
  assert.equal(isBrowserActivitySnapshot(projected), true);

  const unsafe = {
    ...projected,
    children: [{ ...projected.children[0], cwd: "/private/project" }],
  };
  assert.equal(isBrowserActivitySnapshot(unsafe), false);
  assert.equal(
    decodeBrowserActivitySnapshot(JSON.stringify(unsafe)),
    undefined,
  );

  const oversized = {
    ...projected,
    children: [
      {
        ...projected.children[0],
        prompt: "x".repeat(BROWSER_ACTIVITY_LIMITS.maxPromptLength + 1),
      },
    ],
  };
  assert.equal(isBrowserActivitySnapshot(oversized), false);
  assert.equal(decodeBrowserActivitySnapshot("not json"), undefined);
  assert.equal(decodeBrowserActivitySnapshot(["{}", "extra"]), undefined);
});

test("terminal projection carries one bounded final status/output/failure", () => {
  const done = snapshot({
    status: "done",
    settledAt: 5_000,
    finalText: "final answer",
  });
  const terminal = projectBrowserTerminal(done);
  assert.deepEqual(terminal, {
    id: "sa-1",
    title: "Browser fixture",
    status: "done",
    output: "final answer",
    settledAt: 5_000,
  });

  const failed = projectBrowserTerminal(
    snapshot({
      status: "error",
      settledAt: 6_000,
      finalText: "partial",
      errorText: "failure",
    }),
  );
  assert.deepEqual(failed, {
    id: "sa-1",
    title: "Browser fixture",
    status: "error",
    output: "partial",
    failure: "failure",
    settledAt: 6_000,
  });
  assert.equal(projectBrowserTerminal(snapshot()), undefined);
});
