/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- Filesystem errno values and command tokens are narrowed at this local settings boundary. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SUBAGENT_SETTINGS,
  loadSubagentSettings,
} from "../routing/settings.ts";

export interface SettingsCommandContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  isProjectTrusted(): boolean;
  readonly ui: {
    editor?(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

type SettingsScope = "global" | "project";

export interface SubagentsSettingsCommandOptions {
  readonly globalPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
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
    `Jev credential ${jev.apiKeyEnv}: ${(options.env ?? process.env)[jev.apiKeyEnv]?.trim() ? "present" : "absent"}`,
    `Global: ${snapshot.globalPath}`,
    `Project: ${snapshot.projectPath} (${snapshot.projectApplied ? "applied" : ctx.isProjectTrusted() ? "not present" : "untrusted/ignored"})`,
    ...snapshot.notices.map((notice) => `Notice: ${notice}`),
  ].join("\n");
}

function parseArgs(raw: string): { scope?: SettingsScope; edit: boolean } {
  const parts = raw.trim().split(/\s+/u).filter(Boolean);
  const edit = parts.includes("edit");
  const scope = parts.find(
    (part): part is SettingsScope => part === "global" || part === "project",
  );
  const unknown = parts.filter((part) => part !== "edit" && part !== scope);
  if (unknown.length > 0) {
    throw new Error("Usage: /subagents-settings [global|project] [edit]");
  }
  if (edit && !scope)
    throw new Error("Editing requires an explicit global or project scope");
  return { scope, edit };
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
      "Inspect or edit validated global/project subagent routing and Jev settings",
    handler: async (rawArgs: string, ctx: SettingsCommandContext) => {
      try {
        const args = parseArgs(rawArgs);
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
