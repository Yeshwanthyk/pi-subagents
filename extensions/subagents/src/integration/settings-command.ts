/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- Filesystem errno values and command tokens are narrowed at this local settings boundary. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Input,
  type Focusable,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_SUBAGENT_SETTINGS,
  loadSubagentSettings,
} from "../routing/settings.ts";
import {
  DEFAULT_JEV_CREDENTIALS_PATH,
  hasJevCredential,
  saveJevApiKey,
} from "../jev/credentials.ts";

export interface SettingsCommandContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly mode?: "tui" | "rpc" | "json" | "print";
  isProjectTrusted(): boolean;
  readonly ui: {
    custom?: ExtensionUIContext["custom"];
    editor?(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

type SettingsScope = "global" | "project";

export interface SubagentsSettingsCommandOptions {
  readonly globalPath?: string;
  readonly credentialsPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

class MaskedSecretInput implements Focusable {
  readonly #input = new Input();
  readonly #done: (value: string | undefined) => void;
  #focused = false;

  constructor(done: (value: string | undefined) => void) {
    this.#done = done;
    this.#input.onSubmit = (value) => this.#done(value);
    this.#input.onEscape = () => this.#done(undefined);
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#input.focused = value;
  }

  handleInput(data: string): void {
    const previous = this.#input.getValue();
    this.#input.handleInput(data);
    if (Buffer.byteLength(this.#input.getValue(), "utf8") > 8 * 1024) {
      this.#input.setValue(previous);
    }
  }

  render(width: number): string[] {
    const available = Math.max(0, width - 2);
    const count = Array.from(this.#input.getValue()).length;
    const visible = "•".repeat(Math.min(count, Math.max(0, available - 1)));
    const marker = this.#focused ? CURSOR_MARKER : "";
    return [
      truncateToWidth("Set Jev API key", width),
      truncateToWidth(`> ${visible}${marker}\x1b[7m \x1b[27m`, width, ""),
      truncateToWidth("enter save • esc cancel", width),
    ];
  }

  invalidate(): void {
    this.#input.invalidate();
  }
}

function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic link ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${text.trimEnd()}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup: the target rename already determines save success.
    }
  }
}

function inspectSettings(
  ctx: SettingsCommandContext,
  options: SubagentsSettingsCommandOptions,
): string {
  const snapshot = loadSubagentSettings({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    globalPath: options.globalPath,
  });
  const { routing, jev } = snapshot.settings;
  const routes = Object.entries(routing.routes);
  return [
    `Routing: ${routing.enabled ? "enabled" : "disabled"}`,
    `Approval: ${routing.approval}; ambiguous: ${routing.ambiguous}; unavailable: ${routing.unavailable}`,
    `Routes: ${routes.length === 0 ? "none" : routes.map(([key, value]) => `${key}=${value.harness ?? "?"}/${value.model ?? "?"}${value.effort ? `:${value.effort}` : ""}`).join(", ")}`,
    `Jev: model=${jev.model}; timeout=${jev.timeoutMs}ms; maxConcurrent=${jev.maxConcurrent}`,
    `Jev credential: ${hasJevCredential({ apiKeyEnv: jev.apiKeyEnv, env: options.env, credentialsPath: options.credentialsPath ?? DEFAULT_JEV_CREDENTIALS_PATH }) ? "configured" : "missing"}`,
    `Global: ${snapshot.globalPath}`,
    `Project: ${snapshot.projectPath} (${snapshot.projectApplied ? "applied" : ctx.isProjectTrusted() ? "not present" : "untrusted/ignored"})`,
    ...snapshot.notices.map((notice) => `Notice: ${notice}`),
  ].join("\n");
}

function parseArgs(raw: string): {
  scope?: SettingsScope;
  edit: boolean;
  setJevKey: boolean;
} {
  const parts = raw.trim().split(/\s+/u).filter(Boolean);
  const edit = parts.includes("edit");
  const setJevKey = parts.includes("set-jev-key");
  const scope = parts.find(
    (part): part is SettingsScope => part === "global" || part === "project",
  );
  const unknown = parts.filter(
    (part) => part !== "edit" && part !== "set-jev-key" && part !== scope,
  );
  if (unknown.length > 0) {
    throw new Error(
      "Usage: /subagents-settings [global|project] [edit] | set-jev-key",
    );
  }
  if (setJevKey && parts.length !== 1)
    throw new Error("set-jev-key cannot be combined with other arguments");
  if (edit && !scope)
    throw new Error("Editing requires an explicit global or project scope");
  return { scope, edit, setJevKey };
}

async function setJevKey(
  ctx: SettingsCommandContext,
  options: SubagentsSettingsCommandOptions,
): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui.custom) {
    throw new Error("Setting a Jev API key requires the interactive TUI");
  }
  const key = await ctx.ui.custom<string | undefined>(
    (tui, _theme, _kb, done) => {
      const input = new MaskedSecretInput(done);
      return {
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
        render: (width) => input.render(width),
        invalidate: () => input.invalidate(),
        handleInput: (data) => {
          input.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
  if (key === undefined) return;
  saveJevApiKey(key, options.credentialsPath ?? DEFAULT_JEV_CREDENTIALS_PATH);
  ctx.ui.notify("Saved Jev API key. It is available immediately.", "info");
}

async function editSettings(
  scope: SettingsScope,
  ctx: SettingsCommandContext,
  options: SubagentsSettingsCommandOptions,
): Promise<void> {
  if (scope === "project" && !ctx.isProjectTrusted()) {
    throw new Error(
      "Project settings can only be edited for a trusted project",
    );
  }
  if (!ctx.hasUI || !ctx.ui.editor) {
    throw new Error("Settings editing requires an interactive editor");
  }
  const current = loadSubagentSettings({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    globalPath: options.globalPath,
  });
  const target = scope === "global" ? current.globalPath : current.projectPath;
  const existing = readOptional(target);
  const fallback =
    scope === "global"
      ? JSON.stringify(DEFAULT_SUBAGENT_SETTINGS, null, 2)
      : JSON.stringify({ version: 1 }, null, 2);
  const edited = await ctx.ui.editor(
    `Edit ${scope} subagent settings`,
    existing ?? fallback,
  );
  if (edited === undefined) return;

  // Validate the proposed text through the same strict loader before writing.
  loadSubagentSettings({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    globalPath: current.globalPath,
    readFile: (file) => {
      if (path.resolve(file) === path.resolve(target)) return edited;
      return readOptional(file);
    },
  });
  atomicWrite(target, edited);
  ctx.ui.notify(
    `Saved validated ${scope} subagent settings to ${target}. Reload or start a new session to apply them.`,
    "info",
  );
}

export function registerSubagentsSettingsCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  options: SubagentsSettingsCommandOptions = {},
): void {
  pi.registerCommand(
    "subagents-settings",
    createSubagentsSettingsCommand(options),
  );
}

export function createSubagentsSettingsCommand(
  options: SubagentsSettingsCommandOptions = {},
) {
  return {
    description:
      "Inspect/edit subagent settings or securely set the global Jev API key",
    handler: async (rawArgs: string, ctx: SettingsCommandContext) => {
      try {
        const args = parseArgs(rawArgs);
        if (args.setJevKey) await setJevKey(ctx, options);
        if (args.edit && args.scope)
          await editSettings(args.scope, ctx, options);
        ctx.ui.notify(inspectSettings(ctx, options), "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  };
}
