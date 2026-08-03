import type {
  BackendName,
  ReasoningEffort,
  SubagentSnapshot,
} from "./domain.ts";

export const SUBAGENT_CLIENT_PROTOCOL_VERSION = 1;

export const SUBAGENT_CLIENT_CHANNELS = {
  ping: "subagents:client:ping",
  spawn: "subagents:client:spawn",
  cancel: "subagents:client:cancel",
  list: "subagents:client:list",
  ready: "subagents:client:ready",
  settled: "subagents:client:settled",
} as const;

export type SubagentClientReply<T = void> =
  { success: true; data?: T } | { success: false; error: string };

export interface SubagentClientSpawnRequest {
  requestId: string;
  clientId: string;
  correlationId: string;
  harness: BackendName;
  name: string;
  prompt: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface SubagentClientCancelRequest {
  requestId: string;
  clientId: string;
  agentId: string;
}

export interface SubagentClientCancelResult {
  id: string;
  title: string;
  status: SubagentSnapshot["status"];
  cancelled: boolean;
}

export interface SubagentClientListRequest {
  requestId: string;
  clientId: string;
}

export interface SubagentClientSnapshot {
  id: string;
  clientId: string;
  correlationId: string;
  harness: BackendName;
  name: string;
  status: SubagentSnapshot["status"];
  cwd: string;
}

export interface SubagentClientSettledEvent {
  version: number;
  clientId: string;
  correlationId: string;
  agentId: string;
  outcome: "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
}
