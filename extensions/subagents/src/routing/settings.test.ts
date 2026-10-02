/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Test fixtures intentionally exercise unknown JSON input. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  clearSubagentSettingsCache,
  DEFAULT_SUBAGENT_SETTINGS,
  loadSubagentSettings,
} from "./settings.ts";

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

test("no files preserves disabled routing defaults", () => {
  const snapshot = loadSubagentSettings({
    cwd: "/workspace",
    projectTrusted: true,
    globalPath: "/missing/global.json",
    readFile: () => undefined,
  });
  assert.deepEqual(snapshot.settings, DEFAULT_SUBAGENT_SETTINGS);
  assert.equal(snapshot.settings.routing.enabled, false);
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

test("project routing approval may restrict but never loosen the global policy", () => {
  assert.equal(
    loader({ version: 1, routing: { approval: "auto" } }).settings.routing
      .approval,
    "auto",
  );
  assert.equal(
    loader(
      { version: 1, routing: { approval: "auto" } },
      { version: 1, routing: { approval: "ask" } },
    ).settings.routing.approval,
    "ask",
  );
  assert.throws(
    () => loader({ version: 1 }, { version: 1, routing: { approval: "auto" } }),
    /may only restrict/,
  );
  assert.throws(
    () => loader({ version: 1, routing: { approval: "always" } }),
    /approval/,
  );
});

test("maxRunning defaults to six and the project overlay may only lower it", () => {
  assert.equal(loader({ version: 1 }).settings.maxRunning, 6);
  assert.equal(loader({ version: 1, maxRunning: 10 }).settings.maxRunning, 10);
  assert.equal(
    loader({ version: 1, maxRunning: 10 }, { version: 1, maxRunning: 3 })
      .settings.maxRunning,
    3,
  );
  assert.equal(
    loader({ version: 1 }, { version: 1, maxRunning: 6 }).settings.maxRunning,
    6,
  );
  assert.throws(
    () => loader({ version: 1 }, { version: 1, maxRunning: 7 }),
    /may only lower the global cap \(6\)/,
  );
  assert.throws(
    () => loader({ version: 1, maxRunning: 2 }, { version: 1, maxRunning: 4 }),
    /may only lower/,
  );
  // Untrusted overlays are ignored rather than rejected.
  assert.equal(
    loader({ version: 1 }, { version: 1, maxRunning: 32 }, false).settings
      .maxRunning,
    6,
  );
  for (const invalid of [0, 33, 2.5, "4"]) {
    assert.throws(
      () => loader({ version: 1, maxRunning: invalid }),
      /maxRunning must be an integer from 1 through 32/,
    );
  }
});

test("filesystem settings are cached by stat signature and reload on change", () => {
  clearSubagentSettingsCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-settings-"));
  try {
    const globalPath = path.join(root, "global.json");
    const cwd = path.join(root, "project");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(globalPath, JSON.stringify({ version: 1, maxRunning: 5 }));
    const load = () =>
      loadSubagentSettings({ cwd, projectTrusted: true, globalPath });
    const first = load();
    assert.equal(first.settings.maxRunning, 5);
    assert.equal(load(), first, "unchanged files reuse the cached snapshot");

    const projectPath = path.join(cwd, ".pi", "subagents.json");
    fs.writeFileSync(
      projectPath,
      JSON.stringify({ version: 1, maxRunning: 2 }),
    );
    const second = load();
    assert.notEqual(second, first);
    assert.equal(second.settings.maxRunning, 2);
    assert.equal(second.projectApplied, true);

    fs.writeFileSync(
      globalPath,
      JSON.stringify({ version: 1, maxRunning: 12, routing: {} }),
    );
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(globalPath, future, future);
    assert.equal(load().settings.maxRunning, 2);
    fs.rmSync(projectPath);
    assert.equal(load().settings.maxRunning, 12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    clearSubagentSettingsCache();
  }
});
