/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- UI test doubles implement only the command-facing subset used by this test. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  createSubagentsSettingsCommand,
  type SettingsCommandContext,
} from "./settings-command.ts";
import { loadSavedJevApiKey } from "../jev/credentials.ts";

function context(
  notifications: string[],
  custom: ExtensionUIContext["custom"],
): SettingsCommandContext {
  return {
    cwd: "/workspace",
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
      custom,
      editor: async () => undefined,
      notify: (message) => notifications.push(message),
    },
  };
}

test("settings display reports only configured or missing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jev-settings-"));
  const notifications: string[] = [];
  const custom: ExtensionUIContext["custom"] = async () => undefined as never;
  const command = createSubagentsSettingsCommand({
    globalPath: path.join(directory, "subagents.json"),
    credentialsPath: path.join(directory, "missing.json"),
    env: { TYPESAFE_API_KEY: "display-secret" },
  });
  await command.handler("", context(notifications, custom));
  const output = notifications.join("\n");
  assert.match(output, /Jev credential: configured/);
  assert.equal(output.includes("display-secret"), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("set-jev-key uses masked TUI input and saves globally scoped credentials", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jev-settings-"));
  const credentialsPath = path.join(directory, "agent", "jev-credentials.json");
  const notifications: string[] = [];
  const secret = "widget-secret";
  const custom: ExtensionUIContext["custom"] = async (factory) => {
    let result: unknown;
    const component = await factory(
      { requestRender() {} } as unknown as TUI,
      {} as Theme,
      undefined as never,
      (value) => {
        result = value;
      },
    );
    component.handleInput?.(secret);
    const rendered = component.render(80).join("\n");
    assert.equal(rendered.includes(secret), false);
    assert.match(rendered, /•/);
    component.handleInput?.("\n");
    return result as never;
  };
  const command = createSubagentsSettingsCommand({
    globalPath: path.join(directory, "subagents.json"),
    credentialsPath,
    env: {},
  });
  await command.handler("set-jev-key", context(notifications, custom));
  assert.equal(loadSavedJevApiKey(credentialsPath), secret);
  assert.equal(notifications.join("\n").includes(secret), false);
  assert.match(notifications.join("\n"), /available immediately/);
  fs.rmSync(directory, { recursive: true, force: true });
});
