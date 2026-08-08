import type { SubagentSnapshot } from "./domain.ts";

export const ACTIVE_WORK_CHANNELS = {
  update: "agent-activity:update:v1",
  remove: "agent-activity:remove:v1",
} as const;

export interface ActiveWorkItem {
  readonly version: 1;
  readonly key: `subagent:${string}` | `workflow:${string}`;
  readonly kind: "subagent" | "workflow";
  readonly label: string;
  readonly status: "running" | "quiet";
  readonly summary: string;
  readonly currentOperation?: string;
  readonly runningProcesses: number;
  readonly startedAt: number;
  readonly lastActivityAt: number;
}

export interface ActiveWorkRemoval {
  readonly version: 1;
  readonly key: ActiveWorkItem["key"];
}

function singleLine(text: string) {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bounded(text: string, maxLength = 120) {
  const value = singleLine(text);
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

export function subagentActiveWorkItem(
  snapshot: SubagentSnapshot,
): ActiveWorkItem | undefined {
  if (snapshot.status !== "running") return undefined;
  const current = snapshot.liveTools[0];
  const quiet = Date.now() - snapshot.lastActivityAt >= 30_000;
  return {
    version: 1,
    key: `subagent:${snapshot.id}`,
    kind: "subagent",
    label: `${snapshot.id} · ${bounded(snapshot.title, 72)}`,
    status: quiet ? "quiet" : "running",
    summary: current
      ? bounded(
          `${current.name}${current.argsPreview ? ` ${current.argsPreview}` : ""}`,
        )
      : quiet
        ? "quiet · no recent events"
        : "model working",
    ...(current
      ? {
          currentOperation: bounded(
            `${current.name}${current.argsPreview ? ` ${current.argsPreview}` : ""}`,
          ),
        }
      : {}),
    runningProcesses: 0,
    startedAt: snapshot.createdAt,
    lastActivityAt: snapshot.lastActivityAt,
  };
}
