import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowStatus } from "./domain.ts";
import {
  type WorkflowTerminalSource,
  waitForWorkflowTerminal,
} from "./wait.ts";

function fakeSource(initial: WorkflowStatus | undefined) {
  let status = initial;
  const listeners = new Set<(next: { status: WorkflowStatus }) => void>();
  const source: WorkflowTerminalSource = {
    get: () => (status === undefined ? undefined : { status }),
    subscribe: (_runId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    set(next: WorkflowStatus) {
      status = next;
      for (const listener of [...listeners]) listener({ status: next });
    },
  };
}

test("wait resolves immediately for terminal or unknown runs", async () => {
  assert.equal(
    await waitForWorkflowTerminal(fakeSource("completed").source, "r", 10),
    true,
  );
  assert.equal(
    await waitForWorkflowTerminal(fakeSource(undefined).source, "r", 10),
    true,
  );
  assert.equal(await waitForWorkflowTerminal(undefined, "r", 10), true);
});

test("wait resolves on the terminal transition and unsubscribes", async () => {
  const fake = fakeSource("running");
  const pending = waitForWorkflowTerminal(fake.source, "r", 5_000);
  fake.set("paused");
  assert.equal(fake.listeners.size, 1, "non-terminal change keeps waiting");
  fake.set("failed");
  assert.equal(await pending, true);
  assert.equal(fake.listeners.size, 0);
});

test("wait returns false on timeout or abort and unsubscribes", async () => {
  const timed = fakeSource("running");
  assert.equal(await waitForWorkflowTerminal(timed.source, "r", 20), false);
  assert.equal(timed.listeners.size, 0);

  const aborted = fakeSource("running");
  const controller = new AbortController();
  const pending = waitForWorkflowTerminal(
    aborted.source,
    "r",
    5_000,
    controller.signal,
  );
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(aborted.listeners.size, 0);
});
