import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  defineTool,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  clearPiChildResourceCache,
  createPiChildResources,
  createToolCallTimeoutGuard,
  TimedLoadCache,
  waitForRunToStop,
} from "./src/backends/pi.ts";

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

// --- Child resource cache ----------------------------------------------------

function counter<V>(value: (n: number) => V) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    load: async () => value(++calls),
  };
}

test("TimedLoadCache reuses a key and separates different keys", async () => {
  const cache = new TimedLoadCache<number>(30_000);
  const loads = counter((n) => n);
  assert.equal(await cache.get("a", "f", loads.load), 1);
  assert.equal(await cache.get("a", "f", loads.load), 1);
  assert.equal(await cache.get("b", "f", loads.load), 2);
  assert.equal(loads.calls, 2);
});

test("TimedLoadCache shares one in-flight load among concurrent first calls", async () => {
  const cache = new TimedLoadCache<number>(30_000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const load = async () => {
    calls++;
    await gate;
    return calls;
  };
  const all = Promise.all(Array.from({ length: 5 }, () => cache.get("k", "f", load)));
  release();
  assert.deepEqual(await all, [1, 1, 1, 1, 1]);
  assert.equal(calls, 1);
});

test("TimedLoadCache invalidates on TTL, fingerprint change, clear, and failure", async () => {
  let now = 0;
  const cache = new TimedLoadCache<number>(1_000, () => now);
  const loads = counter((n) => n);
  assert.equal(await cache.get("k", "f1", loads.load), 1);
  now = 999;
  assert.equal(await cache.get("k", "f1", loads.load), 1);
  now = 1_000;
  assert.equal(await cache.get("k", "f1", loads.load), 2, "expired by TTL");
  assert.equal(await cache.get("k", "f2", loads.load), 3, "fingerprint changed");
  cache.clear();
  assert.equal(await cache.get("k", "f2", loads.load), 4, "cleared");

  let fail = true;
  const flaky = async () => {
    if (fail) throw new Error("boom");
    return 9;
  };
  await assert.rejects(cache.get("x", "f", flaky), /boom/);
  fail = false;
  assert.equal(await cache.get("x", "f", flaky), 9, "a rejected load is not cached");
});

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skill(name: string) {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-child-resources-"));
  const agentDir = join(root, "agent");
  const cwdA = join(root, "a");
  const cwdB = join(root, "b");
  writeFile(join(agentDir, "skills", "global-skill", "SKILL.md"), skill("global-skill"));
  writeFile(join(cwdA, "AGENTS.md"), "project a v1");
  writeFile(join(cwdA, ".pi", "skills", "project-skill", "SKILL.md"), skill("project-skill"));
  writeFile(join(cwdB, "AGENTS.md"), "project b");
  return { root, agentDir, cwdA, cwdB };
}

const skillNames = (r: Awaited<ReturnType<typeof createPiChildResources>>) =>
  r.loader.getSkills().skills.map((s) => s.name).sort();
const contextOf = (r: Awaited<ReturnType<typeof createPiChildResources>>, cwd: string) =>
  r.loader.getAgentsFiles().agentsFiles.find((f) => f.path === join(cwd, "AGENTS.md"))?.content;

test("child resources reuse a snapshot per key with fresh per-child settings and extensions", async (t) => {
  clearPiChildResourceCache();
  const { root, agentDir, cwdA } = fixture();
  t.after(() => {
    clearPiChildResourceCache();
    rmSync(root, { recursive: true, force: true });
  });

  const [first, ...rest] = await Promise.all(
    Array.from({ length: 4 }, () => createPiChildResources(cwdA, true, agentDir)),
  );
  assert.deepEqual(skillNames(first), ["global-skill", "project-skill"]);
  assert.equal(contextOf(first, cwdA), "project a v1");
  for (const other of rest) {
    // One shared load: the snapshot's context-file entries are the same instances.
    assert.equal(other.loader.getAgentsFiles().agentsFiles[0], first.loader.getAgentsFiles().agentsFiles[0]);
    // Mutable/session-bound state is never shared.
    assert.notEqual(other.settingsManager, first.settingsManager);
    assert.notEqual(other.loader.getExtensions().runtime, first.loader.getExtensions().runtime);
  }

  // A warm hit does not re-read disk...
  writeFile(join(cwdA, "AGENTS.md"), "project a v2");
  const warm = await createPiChildResources(cwdA, true, agentDir);
  assert.equal(contextOf(warm, cwdA), "project a v1");
  // ...until the cache is cleared,
  clearPiChildResourceCache();
  const cleared = await createPiChildResources(cwdA, true, agentDir);
  assert.equal(contextOf(cleared, cwdA), "project a v2");
  // or a settings file changes.
  writeFile(join(cwdA, "AGENTS.md"), "project a v3");
  writeFile(join(agentDir, "settings.json"), "{}");
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(agentDir, "settings.json"), future, future);
  const edited = await createPiChildResources(cwdA, true, agentDir);
  assert.equal(contextOf(edited, cwdA), "project a v3");
});

test("child resources are cached separately per cwd and project trust", async (t) => {
  clearPiChildResourceCache();
  const { root, agentDir, cwdA, cwdB } = fixture();
  t.after(() => {
    clearPiChildResourceCache();
    rmSync(root, { recursive: true, force: true });
  });

  const trusted = await createPiChildResources(cwdA, true, agentDir);
  const untrusted = await createPiChildResources(cwdA, false, agentDir);
  const other = await createPiChildResources(cwdB, true, agentDir);
  assert.deepEqual(skillNames(trusted), ["global-skill", "project-skill"]);
  assert.deepEqual(skillNames(untrusted), ["global-skill"]);
  assert.equal(contextOf(other, cwdB), "project b");
  assert.equal(contextOf(other, cwdA), undefined);
});

// --- Interrupt wait ------------------------------------------------------------

function fakeStreamingSession() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session = {
    isStreaming: true,
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const settle = () => {
    session.isStreaming = false;
    for (const listener of listeners) listener({ type: "agent_settled" });
  };
  return { session, settle, listeners };
}

test("waitForRunToStop resolves on agent_settled and unsubscribes", async () => {
  const { session, settle, listeners } = fakeStreamingSession();
  let resolved = false;
  const wait = waitForRunToStop(session, 60_000).then(() => (resolved = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  settle();
  await wait;
  assert.equal(listeners.size, 0);
});

test("waitForRunToStop is immediate when idle and bounded when no event arrives", async () => {
  const { session, listeners } = fakeStreamingSession();
  session.isStreaming = false;
  await waitForRunToStop(session, 60_000);
  session.isStreaming = true;
  const started = Date.now();
  await waitForRunToStop(session, 20);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(listeners.size, 0);
});
