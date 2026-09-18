/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Test fixtures intentionally exercise unknown JSON input. */
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_SUBAGENT_SETTINGS, loadSubagentSettings } from "./settings.ts";

function loader(global: unknown, project?: unknown, trusted = true) {
  const globalPath = path.resolve("/tmp/global-subagents.json");
  const projectPath = path.resolve("/workspace/.pi/subagents.json");
  const files = new Map<string, string>([
    [globalPath, JSON.stringify(global)],
    ...(project === undefined
      ? []
      : [[projectPath, JSON.stringify(project)] as [string, string]]),
  ]);
  return loadSubagentSettings({
    cwd: "/workspace",
    projectTrusted: trusted,
    globalPath,
    readFile: (file) => files.get(file),
  });
}

test("no files preserves disabled routing and default Jev configuration", () => {
  const snapshot = loadSubagentSettings({
    cwd: "/workspace",
    projectTrusted: true,
    globalPath: "/missing/global.json",
    readFile: () => undefined,
  });
  assert.deepEqual(snapshot.settings, DEFAULT_SUBAGENT_SETTINGS);
  assert.equal(snapshot.settings.routing.enabled, false);
  assert.equal(snapshot.settings.jev.apiKeyEnv, "TYPESAFE_API_KEY");
});

test("trusted routes merge by key and each route entry is replaced atomically", () => {
  const snapshot = loader(
    {
      version: 1,
      routing: {
        enabled: true,
        routes: {
          scout: { harness: "pi", model: "openai/scout", effort: "high" },
          lint: { harness: "pi", model: "openai/lint" },
        },
      },
    },
    {
      version: 1,
      routing: {
        routes: { scout: { harness: "codex", model: "scout-v2" } },
      },
    },
  );
  assert.deepEqual(snapshot.settings.routing.routes.scout, {
    harness: "codex",
    model: "scout-v2",
  });
  assert.deepEqual(snapshot.settings.routing.routes.lint, {
    harness: "pi",
    model: "openai/lint",
  });
  assert.equal(snapshot.projectApplied, true);
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
});

test("simple-validation route uses the existing explicit runtime schema", () => {
  const snapshot = loader({
    version: 1,
    routing: {
      enabled: true,
      routes: {
        simple_validation: {
          harness: "pi",
          model: "openai-codex/gpt-5.6-luna",
          effort: "medium",
        },
      },
    },
  });
  assert.deepEqual(snapshot.settings.routing.routes.simple_validation, {
    harness: "pi",
    model: "openai-codex/gpt-5.6-luna",
    effort: "medium",
  });
});

test("strict validation rejects unknown fields and incomplete route runtimes", () => {
  assert.throws(
    () => loader({ version: 1, routing: { surprise: true } }),
    /unsupported field "surprise"/,
  );
  assert.throws(
    () =>
      loader({ version: 1, routing: { routes: { scout: { model: "x" } } } }),
    /harness and model together/,
  );
  assert.throws(
    () => loader({ version: 1, routing: { approval: "never" } }),
    /routing.approval is invalid/,
  );
  assert.throws(
    () => loader({ version: 1, routing: { ambiguous: "fail" } }),
    /routing.ambiguous is invalid/,
  );
  assert.throws(() => loader({ version: 2 }), /unsupported version/);
});

test("untrusted project settings are ignored without parsing", () => {
  const globalPath = "/global.json";
  const snapshot = loadSubagentSettings({
    cwd: "/workspace",
    projectTrusted: false,
    globalPath,
    readFile: (file) =>
      file === globalPath
        ? JSON.stringify({ version: 1, routing: { enabled: true } })
        : "not-json",
  });
  assert.equal(snapshot.settings.routing.enabled, true);
  assert.equal(snapshot.projectApplied, false);
  assert.match(snapshot.notices[0]!, /Ignored untrusted project settings/);
});

test("legacy Jev enabled settings require migration", () => {
  for (const enabled of [false, true]) {
    assert.throws(
      () => loader({ version: 1, jev: { enabled } }),
      /jev\.enabled.*obsolete/,
    );
    assert.throws(
      () => loader({ version: 1 }, { version: 1, jev: { enabled } }),
      /jev\.enabled.*obsolete/,
    );
  }
});

test("project Jev settings cannot change credential selection", () => {
  assert.throws(
    () =>
      loader(
        { version: 1 },
        { version: 1, jev: { apiKeyEnv: "OTHER" } },
      ),
    /cannot change credentials/,
  );
  assert.throws(
    () =>
      loader(
        { version: 1 },
        { version: 1, jev: { endpoint: "https://example.test" } },
      ),
    /unsupported field "endpoint"/,
  );
});

test("project Jev settings may only restrict global limits", () => {
  const snapshot = loader(
    {
      version: 1,
      jev: {
        apiKeyEnv: "PRIVATE_KEY_NAME",
        timeoutMs: 20_000,
        maxConcurrent: 4,
      },
    },
    {
      version: 1,
      jev: { timeoutMs: 5_000, maxConcurrent: 1 },
    },
  );
  assert.equal(snapshot.settings.jev.apiKeyEnv, "PRIVATE_KEY_NAME");
  assert.equal(snapshot.settings.jev.timeoutMs, 5_000);
  assert.equal(snapshot.settings.jev.maxConcurrent, 1);
  assert.throws(
    () =>
      loader(
        { version: 1, jev: { timeoutMs: 5_000 } },
        { version: 1, jev: { timeoutMs: 5_001 } },
      ),
    /may only restrict/,
  );
});
