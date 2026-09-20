/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening -- Test fixtures construct generic, malformed, and dangerous untrusted objects. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionBatchProposalStore } from "./proposals.ts";
import { resolveRouting } from "./resolver.ts";
import { loadSubagentSettings } from "./settings.ts";

function fixture(requiresApproval = true) {
  const settings = loadSubagentSettings({
    cwd: "/workspace",
    projectTrusted: true,
    globalPath: "/global.json",
    readFile: (file) =>
      file === "/global.json"
        ? JSON.stringify({
            version: 1,
            routing: {
              enabled: true,
              routes: {
                scout: {
                  harness: "pi",
                  model: "provider/scout",
                  effort: "high",
                },
              },
            },
          })
        : undefined,
  });
  const runtime = resolveRouting({
    settings,
    classification: { intent: "scout" },
    explicit: requiresApproval
      ? undefined
      : { harness: "pi", model: "provider/scout" },
    lookupModel: (requested) => ({ available: true, effective: requested }),
  });
  if (runtime.status !== "resolved") throw new Error("fixture did not resolve");
  return { settings, runtime };
}

test("batch approval binds exact task, runtime, and settings snapshots", () => {
  let now = 100;
  const store = new SessionBatchProposalStore({
    now: () => now,
    createId: () => "route-one",
  });
  const { settings, runtime } = fixture();
  const mutable = {
    prompt: "inspect",
    title: "Scout",
    cwd: "/workspace",
    scope: { readOnly: true },
  };
  const proposal = store.create({
    sessionId: "session-a",
    preparedAtUserInput: 4,
    items: [{ input: mutable, runtime, settings }],
    ttlMs: 100,
  });
  mutable.prompt = "changed later";

  assert.equal(proposal.status, "pending");
  const snapshottedInput = proposal.items[0]!.input;
  assert.ok(
    snapshottedInput !== null &&
      typeof snapshottedInput === "object" &&
      !Array.isArray(snapshottedInput),
  );
  assert.equal(
    (snapshottedInput as { readonly prompt?: unknown }).prompt,
    "inspect",
  );
  assert.equal(proposal.items[0]!.settingsDigest, settings.digest);
  assert.equal(proposal.items[0]!.runtime.effective.model, "provider/scout");
  assert.match(proposal.bindingDigest, /^[a-f0-9]{64}$/);
  assert.throws(
    () =>
      store.approve(proposal.id, {
        sessionId: "session-a",
        userInput: 4,
        bindingDigest: proposal.bindingDigest,
      }),
    /newer user response/,
  );
  assert.throws(
    () =>
      store.approve(proposal.id, {
        sessionId: "session-b",
        userInput: 5,
        bindingDigest: proposal.bindingDigest,
      }),
    /different session/,
  );
  assert.throws(
    () =>
      store.approve(proposal.id, {
        sessionId: "session-a",
        userInput: 5,
        bindingDigest: "0".repeat(64),
      }),
    /do not match/,
  );

  const approved = store.approve(proposal.id, {
    sessionId: "session-a",
    userInput: 5,
    bindingDigest: proposal.bindingDigest,
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvalSource, "newer_user_response");
  assert.equal(
    store.requireApproved(approved.id, "session-a", approved.bindingDigest),
    approved,
  );

  const repeated = store.approve(proposal.id, {
    sessionId: "session-a",
    userInput: 6,
    bindingDigest: proposal.bindingDigest,
  });
  assert.equal(repeated, approved);
  assert.equal(repeated.approvedAtUserInput, 5);
  now = 200;
  assert.equal(store.get(proposal.id), undefined);
});

test("explicit runtime arguments require a newer approval too", () => {
  const store = new SessionBatchProposalStore({
    now: () => 10,
    createId: () => "route-explicit",
  });
  const { settings, runtime } = fixture(false);
  const proposal = store.create({
    sessionId: "session-a",
    preparedAtUserInput: 8,
    items: [
      {
        input: { prompt: "use this exact runtime", cwd: "/workspace" },
        runtime,
        settings,
      },
    ],
  });
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.approvalSource, undefined);
  assert.throws(
    () =>
      store.approve(proposal.id, {
        sessionId: "session-a",
        userInput: 8,
        bindingDigest: proposal.bindingDigest,
      }),
    /newer user response/,
  );
  const approved = store.approve(proposal.id, {
    sessionId: "session-a",
    userInput: 9,
    bindingDigest: proposal.bindingDigest,
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvalSource, "newer_user_response");
});

test("proposal creation rejects unresolved, mismatched, and unsafe inputs", () => {
  const store = new SessionBatchProposalStore({
    createId: () => "route-invalid",
  });
  const { settings, runtime } = fixture();
  assert.throws(
    () =>
      store.create({
        sessionId: "session-a",
        preparedAtUserInput: 1,
        items: [
          {
            input: { prompt: "x" },
            runtime,
            settings: { ...settings, digest: "bad" },
          },
        ],
      }),
    /digests do not match/,
  );
  const unsafe = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(unsafe, "__proto__", {
    enumerable: true,
    value: "bad",
  });
  assert.throws(
    () =>
      store.create({
        sessionId: "session-a",
        preparedAtUserInput: 1,
        items: [{ input: unsafe, runtime, settings }],
      }),
    /unsafe key/,
  );
});

test("store bounds retained proposals and prunes expired entries on create", () => {
  let now = 0;
  let id = 0;
  const store = new SessionBatchProposalStore({
    now: () => now,
    createId: () => `route-${++id}`,
    maxProposals: 1,
  });
  const { settings, runtime } = fixture();
  const create = () =>
    store.create({
      sessionId: "session-a",
      preparedAtUserInput: 1,
      ttlMs: 1,
      items: [{ input: { prompt: "bounded" }, runtime, settings }],
    });
  create();
  assert.throws(create, /capacity 1 is full/);
  now = 1;
  assert.doesNotThrow(create);
});

test("proposal snapshots reject cycles, excessive depth, and excessive width", () => {
  let id = 0;
  const store = new SessionBatchProposalStore({
    createId: () => `route-budget-${++id}`,
  });
  const { settings, runtime } = fixture();
  const propose = (input: unknown) =>
    store.create({
      sessionId: "session-a",
      preparedAtUserInput: 1,
      items: [{ input, runtime, settings }],
    });

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => propose(cyclic), /cannot contain cycles/);

  let deep: Record<string, unknown> = {};
  for (let depth = 0; depth < 40; depth++) deep = { child: deep };
  assert.throws(() => propose(deep), /maximum depth/);

  assert.throws(
    () => propose(Array.from({ length: 10_001 }, () => null)),
    /exceeds 10000 values/,
  );
});
