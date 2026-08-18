import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { Type, type Static } from "typebox";
import {
  BACKEND_NAMES,
  REASONING_EFFORTS,
  type SubagentSnapshot,
} from "./domain.ts";
import type { SubagentManagerApi } from "./manager.ts";
import {
  SUBAGENT_CLIENT_CHANNELS,
  SUBAGENT_CLIENT_PROTOCOL_VERSION,
  type SubagentClientCancelRequest,
  type SubagentClientListRequest,
  type SubagentClientReply,
  type SubagentClientSettledEvent,
  type SubagentClientSnapshot,
  type SubagentClientSpawnRequest,
} from "./client-protocol.ts";
import { runTool, type SubagentRuntime } from "./runtime.ts";
import { captureParentRef, type ParentSessionManager } from "./parent-ref.ts";

export interface SubagentClientSessionContext {
  readonly cwd: string;
  readonly sessionManager: ParentSessionManager;
  readonly model: ExtensionContext["model"];
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  isProjectTrusted(): boolean;
}

export interface SubagentClientApiOptions {
  pi: ExtensionAPI;
  getManager(): Promise<SubagentManagerApi>;
  getRuntime(): SubagentRuntime;
  getSessionContext(): SubagentClientSessionContext | undefined;
  /** Current extension session epoch, generated at session_start. */
  getParentEpoch(): number;
  resolveChildProjectTrust(options: {
    parentCwd: string;
    childCwd: string;
    parentTrusted: boolean;
  }): boolean;
}

/**
 * Wire schemas for the client event protocol. Each channel payload is decoded
 * at the event boundary: the raw event-bus value is validated against the
 * schema before any handler observes a field.
 */
const ClientPingRequestSchema = Type.Object({
  requestId: Type.Optional(Type.String()),
});
const ClientSpawnRequestSchema = Type.Object({
  requestId: Type.String(),
  clientId: Type.String(),
  correlationId: Type.String(),
  harness: Type.Union(BACKEND_NAMES.map((name) => Type.Literal(name))),
  name: Type.String(),
  prompt: Type.String(),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  reasoningEffort: Type.Optional(
    Type.Union(REASONING_EFFORTS.map((effort) => Type.Literal(effort))),
  ),
});
const ClientCancelRequestSchema = Type.Object({
  requestId: Type.String(),
  clientId: Type.String(),
  agentId: Type.String(),
});
const ClientListRequestSchema = Type.Object({
  requestId: Type.String(),
  clientId: Type.String(),
});

const PingRequestValidator = Compile(ClientPingRequestSchema);
const SpawnRequestValidator = Compile(ClientSpawnRequestSchema);
const CancelRequestValidator = Compile(ClientCancelRequestSchema);
const ListRequestValidator = Compile(ClientListRequestSchema);

/** Decoded wire payloads accepted on the client request channels. */
export type ClientRequestBoundary =
  | Static<typeof ClientPingRequestSchema>
  | Static<typeof ClientSpawnRequestSchema>
  | Static<typeof ClientCancelRequestSchema>
  | Static<typeof ClientListRequestSchema>;

export interface SubagentClientPingRequest {
  requestId?: string;
}

export function decodeClientPingRequest(
  value: ClientRequestBoundary,
): SubagentClientPingRequest {
  if (!PingRequestValidator.Check(value)) {
    throw new Error("Invalid subagents client ping request.");
  }
  return value;
}

export function decodeClientSpawnRequest(
  value: ClientRequestBoundary,
): SubagentClientSpawnRequest {
  if (!SpawnRequestValidator.Check(value)) {
    throw new Error("Invalid subagents client spawn request.");
  }
  return value;
}

export function decodeClientCancelRequest(
  value: ClientRequestBoundary,
): SubagentClientCancelRequest {
  if (!CancelRequestValidator.Check(value)) {
    throw new Error("Invalid subagents client cancel request.");
  }
  return value;
}

export function decodeClientListRequest(
  value: ClientRequestBoundary,
): SubagentClientListRequest {
  if (!ListRequestValidator.Check(value)) {
    throw new Error("Invalid subagents client list request.");
  }
  return value;
}

/**
 * Best-effort request correlation for error replies whose full request decode
 * failed: only a string requestId can route a reply, and any other value is
 * dropped exactly like the previous boundary guard.
 */
function errorRequestId(payload: ClientRequestBoundary): string | undefined {
  if (!PingRequestValidator.Check(payload)) return undefined;
  return payload.requestId;
}

function reply<T>(
  pi: ExtensionAPI,
  channel: string,
  requestId: string | undefined,
  value: SubagentClientReply<T>,
) {
  if (requestId === undefined || requestId.length === 0) return;
  pi.events.emit(`${channel}:reply:${requestId}`, value);
}

function requiredString(value: string, name: string): string {
  if (value.trim().length === 0) {
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
  const on = (
    channel: string,
    handler: (payload: ClientRequestBoundary) => Promise<void> | void,
  ) => {
    unsubscribers.push(
      pi.events.on(channel, (raw) => {
        // SAFETY: each handler decodes the raw event payload against its
        // client protocol schema before reading request fields. Malformed
        // payloads may be ignored when no valid request id can be recovered.
        void handler(raw as ClientRequestBoundary);
      }),
    );
  };

  on(SUBAGENT_CLIENT_CHANNELS.ping, (payload) => {
    try {
      const request = decodeClientPingRequest(payload);
      reply(pi, SUBAGENT_CLIENT_CHANNELS.ping, request.requestId, {
        success: true,
        data: {
          version: SUBAGENT_CLIENT_PROTOCOL_VERSION,
          harnesses: [...BACKEND_NAMES],
        },
      });
    } catch {
      // Malformed ping payloads are ignored; a well-behaved client re-pings.
    }
  });

  on(SUBAGENT_CLIENT_CHANNELS.spawn, async (payload) => {
    try {
      const request = decodeClientSpawnRequest(payload);
      const sessionContext = options.getSessionContext();
      if (!sessionContext) throw new Error("No active parent session.");
      const clientId = requiredString(request.clientId, "clientId");
      const correlationId = requiredString(
        request.correlationId,
        "correlationId",
      );
      const name = requiredString(request.name, "name").slice(0, 160);
      const prompt = requiredString(request.prompt, "prompt");
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

      const cwd = path.resolve(sessionContext.cwd, request.cwd ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`cwd is not a directory: ${cwd}`);
      }
      const parentRef = captureParentRef(
        options.getParentEpoch(),
        sessionContext.sessionManager,
      );
      const snapshot = await runTool(
        options.getRuntime(),
        manager.spawn(request.harness, {
          title: name,
          prompt,
          cwd,
          owner: clientId,
          resultDelivery: "client",
          client: { id: clientId, correlationId },
          parentRef,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
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
      reply(pi, SUBAGENT_CLIENT_CHANNELS.spawn, errorRequestId(payload), {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  on(SUBAGENT_CLIENT_CHANNELS.cancel, async (payload) => {
    try {
      const request = decodeClientCancelRequest(payload);
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
      reply(pi, SUBAGENT_CLIENT_CHANNELS.cancel, errorRequestId(payload), {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  on(SUBAGENT_CLIENT_CHANNELS.list, async (payload) => {
    try {
      const request = decodeClientListRequest(payload);
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
      reply(pi, SUBAGENT_CLIENT_CHANNELS.list, errorRequestId(payload), {
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
