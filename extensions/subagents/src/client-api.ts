import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BACKEND_NAMES,
  isReasoningEffort,
  type BackendName,
  type SubagentSnapshot,
} from "./domain.ts";
import type { SubagentManagerShape } from "./manager.ts";
import {
  SUBAGENT_CLIENT_CHANNELS,
  SUBAGENT_CLIENT_PROTOCOL_VERSION,
  type SubagentClientReply,
  type SubagentClientSettledEvent,
  type SubagentClientSnapshot,
} from "./client-protocol.ts";
import { runTool, type SubagentRuntime } from "./runtime.ts";

export interface SubagentClientApiOptions {
  pi: ExtensionAPI;
  getManager(): Promise<SubagentManagerShape>;
  getRuntime(): SubagentRuntime;
  getSessionContext(): ExtensionContext | undefined;
  resolveChildProjectTrust(options: {
    parentCwd: string;
    childCwd: string;
    parentTrusted: boolean;
  }): boolean;
}

function reply<T>(
  pi: ExtensionAPI,
  channel: string,
  requestId: unknown,
  value: SubagentClientReply<T>,
) {
  if (typeof requestId !== "string" || requestId.length === 0) return;
  pi.events.emit(`${channel}:reply:${requestId}`, value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function clientSnapshot(snapshot: SubagentSnapshot): SubagentClientSnapshot {
  if (!snapshot.client) throw new Error("Subagent has no client correlation.");
  return {
    id: snapshot.id,
    clientId: snapshot.client.id,
    correlationId: snapshot.client.correlationId,
    harness: snapshot.backend,
    name: snapshot.title,
    status: snapshot.status,
    cwd: snapshot.cwd,
  };
}

export function clientSettlement(
  snapshot: SubagentSnapshot,
): SubagentClientSettledEvent | undefined {
  if (!snapshot.client || !snapshot.outcome) return undefined;
  const base = {
    version: SUBAGENT_CLIENT_PROTOCOL_VERSION,
    clientId: snapshot.client.id,
    correlationId: snapshot.client.correlationId,
    agentId: snapshot.id,
  };
  switch (snapshot.outcome._tag) {
    case "Completed":
      return {
        ...base,
        outcome: "completed",
        result: snapshot.outcome.finalText,
      };
    case "Failed":
      return {
        ...base,
        outcome: "failed",
        result: snapshot.outcome.partialText,
        error: snapshot.outcome.errorText,
      };
    case "Interrupted":
      return {
        ...base,
        outcome: "cancelled",
        result: snapshot.outcome.partialText,
      };
  }
}

export function registerSubagentClientApi(
  options: SubagentClientApiOptions,
): () => void {
  const { pi } = options;
  const unsubscribers: Array<() => void> = [];
  const on = (channel: string, handler: (raw: unknown) => void) => {
    unsubscribers.push(pi.events.on(channel, handler));
  };

  on(SUBAGENT_CLIENT_CHANNELS.ping, (raw) => {
    const requestId = (raw as { requestId?: unknown })?.requestId;
    reply(pi, SUBAGENT_CLIENT_CHANNELS.ping, requestId, {
      success: true,
      data: {
        version: SUBAGENT_CLIENT_PROTOCOL_VERSION,
        harnesses: [...BACKEND_NAMES],
      },
    });
  });

  on(SUBAGENT_CLIENT_CHANNELS.spawn, async (raw) => {
    const request = raw as Record<string, unknown>;
    try {
      const sessionContext = options.getSessionContext();
      if (!sessionContext) throw new Error("No active parent session.");
      const clientId = requiredString(request.clientId, "clientId");
      const correlationId = requiredString(
        request.correlationId,
        "correlationId",
      );
      const name = requiredString(request.name, "name").slice(0, 160);
      const prompt = requiredString(request.prompt, "prompt");
      if (
        typeof request.harness !== "string" ||
        !BACKEND_NAMES.includes(request.harness as BackendName)
      ) {
        throw new Error(`Unsupported harness: ${String(request.harness)}.`);
      }
      if (
        request.reasoningEffort !== undefined &&
        !isReasoningEffort(request.reasoningEffort)
      ) {
        throw new Error(
          `Unsupported reasoning effort: ${String(request.reasoningEffort)}.`,
        );
      }
      const manager = await options.getManager();
      const duplicate = manager.view
        .list()
        .find(
          (snapshot) =>
            snapshot.client?.id === clientId &&
            snapshot.client.correlationId === correlationId,
        );
      if (duplicate) {
        reply(pi, SUBAGENT_CLIENT_CHANNELS.spawn, request.requestId, {
          success: true,
          data: clientSnapshot(duplicate),
        });
        return;
      }

      const cwd = path.resolve(
        sessionContext.cwd,
        typeof request.cwd === "string" ? request.cwd : ".",
      );
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`cwd is not a directory: ${cwd}`);
      }
      const snapshot = await runTool(
        options.getRuntime(),
        manager.spawn(request.harness as BackendName, {
          title: name,
          prompt,
          cwd,
          owner: clientId,
          visibility: "standard",
          resultDelivery: "client",
          client: { id: clientId, correlationId },
          model: typeof request.model === "string" ? request.model : undefined,
          reasoningEffort: isReasoningEffort(request.reasoningEffort)
            ? request.reasoningEffort
            : undefined,
          parent: {
            parentCwd: sessionContext.cwd,
            projectTrusted: options.resolveChildProjectTrust({
              parentCwd: sessionContext.cwd,
              childCwd: cwd,
              parentTrusted: sessionContext.isProjectTrusted(),
            }),
            inheritedModel: sessionContext.model
              ? {
                  provider: sessionContext.model.provider,
                  id: sessionContext.model.id,
                }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: sessionContext.modelRegistry,
          },
        }),
      );
      reply(pi, SUBAGENT_CLIENT_CHANNELS.spawn, request.requestId, {
        success: true,
        data: clientSnapshot(snapshot),
      });
    } catch (error) {
      reply(pi, SUBAGENT_CLIENT_CHANNELS.spawn, request.requestId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  on(SUBAGENT_CLIENT_CHANNELS.cancel, async (raw) => {
    const request = raw as Record<string, unknown>;
    try {
      const clientId = requiredString(request.clientId, "clientId");
      const agentId = requiredString(request.agentId, "agentId");
      const manager = await options.getManager();
      const snapshot = manager.view.get(agentId);
      if (!snapshot || snapshot.client?.id !== clientId) {
        throw new Error("Client subagent not found.");
      }
      const [result] = await runTool(
        options.getRuntime(),
        manager.cancel([agentId]),
      );
      reply(pi, SUBAGENT_CLIENT_CHANNELS.cancel, request.requestId, {
        success: true,
        data: result,
      });
    } catch (error) {
      reply(pi, SUBAGENT_CLIENT_CHANNELS.cancel, request.requestId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  on(SUBAGENT_CLIENT_CHANNELS.list, async (raw) => {
    const request = raw as Record<string, unknown>;
    try {
      const clientId = requiredString(request.clientId, "clientId");
      const manager = await options.getManager();
      const snapshots = manager.view
        .list()
        .filter((snapshot) => snapshot.client?.id === clientId)
        .map(clientSnapshot);
      reply(pi, SUBAGENT_CLIENT_CHANNELS.list, request.requestId, {
        success: true,
        data: snapshots,
      });
    } catch (error) {
      reply(pi, SUBAGENT_CLIENT_CHANNELS.list, request.requestId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  queueMicrotask(() =>
    pi.events.emit(SUBAGENT_CLIENT_CHANNELS.ready, {
      version: SUBAGENT_CLIENT_PROTOCOL_VERSION,
    }),
  );

  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };
}
