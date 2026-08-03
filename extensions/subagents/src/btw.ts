import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createChildSessionManager } from "./backends/pi.ts";
import type { SpawnTask, SubagentSnapshot } from "./domain.ts";
import {
  currentExternalHost,
  launchInCurrentHost,
  launchPreparedPiInHerdr,
  type ExternalLaunch,
  type PreparedPiSession,
} from "./external-shell.ts";
import { scopedSubagentView, type SubagentManagerShape } from "./manager.ts";
import { runTool, type SubagentRuntime } from "./runtime.ts";
import { openSubagent } from "./ui/takeover.ts";

const OWNER = "btw";
const ENTRY_TYPE = "pi-btw-session";
export const BTW_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
] as const;

export interface BtwRecord {
  id: string;
  title: string;
  createdAt: number;
  sessionFile?: string;
  location: "floating" | "external" | "closed";
  host?: "herdr" | "cmux" | "tmux";
  target?: string;
}

export interface BtwRegistrationOptions {
  pi: ExtensionAPI;
  getManager(): Promise<SubagentManagerShape>;
  getRuntime(): SubagentRuntime;
  getSessionContext(): ExtensionContext | undefined;
  resolveChildProjectTrust(options: {
    parentCwd: string;
    childCwd: string;
    parentTrusted: boolean;
  }): boolean;
  env?: NodeJS.ProcessEnv;
  createSessionManager?: typeof createChildSessionManager;
  launchPrepared?: (
    prepared: PreparedPiSession,
    env?: NodeJS.ProcessEnv,
  ) => ExternalLaunch;
}

export function currentBtwExternalHost(
  env: NodeJS.ProcessEnv = process.env,
): "herdr" | undefined {
  return env.HERDR_ENV === "1" && env.HERDR_WORKSPACE_ID ? "herdr" : undefined;
}

export function titleForBtw(question: string): string {
  const firstLine =
    question
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "Side question";
  return firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
}

export function btwPrompt(question: string): string {
  return [
    "You are a persistent side conversation forked from the parent Pi session.",
    "Answer the user's question directly. You may inspect files and research with the available read-only tools.",
    "Do not modify files, execute shell commands, delegate work, or inject anything into the parent conversation.",
    "The user may continue this discussion across multiple turns.",
    "",
    question,
  ].join("\n");
}

export function btwRecordFromEntry(entry: SessionEntry): BtwRecord | undefined {
  if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) {
    return undefined;
  }
  const data = entry.data as Partial<BtwRecord> | undefined;
  if (!data || typeof data.id !== "string" || typeof data.title !== "string") {
    return undefined;
  }
  if (
    data.location !== "floating" &&
    data.location !== "external" &&
    data.location !== "closed"
  ) {
    return undefined;
  }
  return {
    id: data.id,
    title: data.title,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    sessionFile:
      typeof data.sessionFile === "string" ? data.sessionFile : undefined,
    location: data.location,
    host:
      data.host === "herdr" || data.host === "cmux" || data.host === "tmux"
        ? data.host
        : undefined,
    target: typeof data.target === "string" ? data.target : undefined,
  };
}

async function focusExternal(
  pi: ExtensionAPI,
  record: BtwRecord,
): Promise<void> {
  if (!record.host || !record.target) {
    throw new Error("External session target is unavailable.");
  }
  const command: [string, string[]] =
    record.host === "herdr"
      ? ["herdr", ["agent", "focus", record.target]]
      : record.host === "cmux"
        ? [
            "cmux",
            ["move-surface", "--surface", record.target, "--focus", "true"],
          ]
        : ["tmux", ["select-window", "-t", record.target]];
  const result = await pi.exec(command[0], command[1]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Focus failed.",
    );
  }
}

function recordFromSnapshot(
  snapshot: SubagentSnapshot,
  location: BtwRecord["location"],
): BtwRecord {
  return {
    id: snapshot.id,
    title: snapshot.title,
    createdAt: snapshot.createdAt,
    sessionFile: snapshot.meta.sessionFilePath,
    location,
  };
}

export function registerBtw(options: BtwRegistrationOptions): void {
  const { pi } = options;
  const env = options.env ?? process.env;
  const createSessionManager =
    options.createSessionManager ?? createChildSessionManager;
  const launchPrepared = options.launchPrepared ?? launchPreparedPiInHerdr;
  const records = new Map<string, BtwRecord>();

  const save = (record: BtwRecord) => {
    records.set(record.id, record);
    pi.appendEntry(ENTRY_TYPE, record);
  };

  const privateView = (manager: SubagentManagerShape) =>
    scopedSubagentView(manager.view, OWNER);

  const closeFloating = async (manager: SubagentManagerShape, id: string) => {
    const closed = await runTool(options.getRuntime(), manager.close(id));
    if (!closed) return;
    const current = records.get(id) ?? recordFromSnapshot(closed, "floating");
    save({ ...current, location: "closed" });
  };

  const popOut = async (
    manager: SubagentManagerShape,
    id: string,
  ): Promise<boolean> => {
    const snapshot = privateView(manager).get(id);
    if (!snapshot) return false;
    if (!currentExternalHost(env)) {
      options
        .getSessionContext()
        ?.ui.notify(
          "Not currently inside Herdr, cmux, or tmux; session remains floating.",
          "warning",
        );
      return false;
    }
    if (snapshot.status === "running") {
      options
        .getSessionContext()
        ?.ui.notify(
          "Waiting for the current side-session turn before opening its shell…",
          "info",
        );
      await runTool(options.getRuntime(), manager.waitFor([id]));
    }
    const released = await runTool(options.getRuntime(), manager.release(id));
    if (!released) return false;
    try {
      const launch = launchInCurrentHost(released, env);
      if (!launch) return false;
      save({
        ...recordFromSnapshot(released, "external"),
        host: launch.host,
        target: launch.target,
      });
      options
        .getSessionContext()
        ?.ui.notify(`Opened ${released.title} in ${launch.host}.`, "info");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options
        .getSessionContext()
        ?.ui.notify(
          `Could not open shell: ${message}. Resume ${released.meta.sessionFilePath ?? "the saved session"}.`,
          "error",
        );
      return false;
    }
  };

  const openFloating = async (manager: SubagentManagerShape, id: string) => {
    const ctx = options.getSessionContext();
    if (!ctx || ctx.mode !== "tui") {
      ctx?.ui.notify("Floating sessions require Pi's TUI mode.", "error");
      return;
    }
    await openSubagent(ctx, privateView(manager), id, {
      title: "BTW Sessions",
      floating: true,
      onPopOut: (sessionId) => popOut(manager, sessionId),
      onCloseSession: (sessionId) => closeFloating(manager, sessionId),
    });
  };

  pi.on("session_start", (_event, ctx) => {
    records.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      const record = btwRecordFromEntry(entry);
      if (record) records.set(record.id, record);
    }
  });

  pi.registerCommand("btw", {
    description: "Open a persistent read-only side conversation",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("BTW requires Pi's TUI mode.", "error");
        return;
      }
      const question =
        args.trim() ||
        (
          await ctx.ui.input(
            "BTW",
            "Ask a side question without changing the parent thread",
          )
        )?.trim();
      if (!question) return;
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      const parentLeafId = ctx.sessionManager.getLeafId();
      if (!parentSessionFile || !parentLeafId) {
        ctx.ui.notify("BTW requires a persisted parent conversation.", "error");
        return;
      }

      const title = titleForBtw(question);
      const parentModel = ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined;
      const task: SpawnTask = {
        title,
        prompt: btwPrompt(question),
        cwd: ctx.cwd,
        owner: OWNER,
        visibility: "private",
        resultDelivery: "none",
        tools: [...BTW_TOOLS],
        sessionSeed: {
          kind: "fork",
          parentSessionFile,
          parentLeafId,
        },
        parent: {
          parentCwd: ctx.cwd,
          projectTrusted: options.resolveChildProjectTrust({
            parentCwd: ctx.cwd,
            childCwd: ctx.cwd,
            parentTrusted: ctx.isProjectTrusted(),
          }),
          inheritedModel: parentModel,
          inheritedThinkingLevel: pi.getThinkingLevel(),
          modelRegistry: ctx.modelRegistry,
        },
      };

      try {
        if (currentBtwExternalHost(env)) {
          const createdAt = Date.now();
          const id = `btw-${randomUUID().slice(0, 8)}`;
          const child = createSessionManager(task);
          child.appendSessionInfo(`${OWNER}: ${title}`);
          const sessionFile = child.getSessionFile();
          if (!sessionFile) {
            throw new Error("Failed to create a persisted BTW session.");
          }
          try {
            const launch = launchPrepared(
              {
                name: id,
                title,
                cwd: ctx.cwd,
                sessionFile,
                prompt: task.prompt,
                tools: task.tools,
                model: parentModel,
                thinkingLevel: pi.getThinkingLevel(),
              },
              env,
            );
            save({
              id,
              title,
              createdAt,
              sessionFile,
              location: "external",
              host: launch.host,
              target: launch.target,
            });
          } catch (error) {
            try {
              fs.unlinkSync(sessionFile);
            } catch {
              // Best-effort cleanup of the unlaunched child session.
            }
            throw error;
          }
          return;
        }

        const manager = await options.getManager();
        const snapshot = await runTool(
          options.getRuntime(),
          manager.spawn("pi", task),
        );
        save(recordFromSnapshot(snapshot, "floating"));
        queueMicrotask(() => {
          void openFloating(manager, snapshot.id).catch((error) => {
            ctx.ui.notify(
              error instanceof Error ? error.message : String(error),
              "error",
            );
          });
        });
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.registerCommand("btw-sessions", {
    description: "List and reopen BTW sessions",
    handler: async (_args, ctx) => {
      try {
        const manager = await options.getManager();
        const live = privateView(manager).list();
        for (const session of live) {
          const current = records.get(session.id);
          records.set(session.id, {
            ...recordFromSnapshot(session, "floating"),
            location:
              current?.location === "external" ? "external" : "floating",
            host: current?.host,
            target: current?.target,
          });
        }
        const sessions = [...records.values()]
          .filter((record) => record.location !== "closed")
          .sort((a, b) => b.createdAt - a.createdAt);
        if (sessions.length === 0) {
          ctx.ui.notify("No BTW sessions.", "info");
          return;
        }
        const labels = sessions.map((record) => {
          const location =
            record.location === "external"
              ? (record.host ?? "shell")
              : "floating";
          return `${record.title}  ·  ${location}  ·  ${record.id}`;
        });
        const choice = await ctx.ui.select("BTW Sessions", labels);
        if (!choice) return;
        const record = sessions[labels.indexOf(choice)];
        if (!record) return;
        if (record.location === "external") {
          await focusExternal(pi, record);
          return;
        }
        if (!live.some((session) => session.id === record.id)) {
          ctx.ui.notify(
            `BTW session is no longer active. Resume its saved Pi session: ${record.sessionFile ?? "unknown"}`,
            "warning",
          );
          return;
        }
        await openFloating(manager, record.id);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
}
