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
  /** Display model label for the running item's card, when known. */
  readonly modelLabel?: string;
  /** Rounded context utilization percent, when known. */
  readonly contextPercent?: number;
  /** Completed operations counter for the running item's card. */
  readonly completedOperations?: number;
}

export interface ActiveWorkRemoval {
  readonly version: 1;
  readonly key: ActiveWorkItem["key"];
  /** Settled status when the item finished; undefined = dropped while running. */
  readonly status?: "done" | "error";
  /** Title snapshot for the settle flash row. */
  readonly title?: string;
  /** Completed operation count at settle, for the flash row. */
  readonly ops?: number;
  /** Millisecond timestamp of the settle, for flash TTL. */
  readonly settledAt?: number;
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
  const operation = current
    ? bounded(
        `${current.name}${current.argsPreview ? ` ${current.argsPreview}` : ""}`,
      )
    : undefined;
  return {
    version: 1,
    key: `subagent:${snapshot.id}`,
    kind: "subagent",
    label: bounded(snapshot.title, 72),
    status: quiet ? "quiet" : "running",
    summary:
      operation ?? (quiet ? "quiet · no recent events" : "model working"),
    ...(operation ? { currentOperation: operation } : {}),
    runningProcesses: 0,
    startedAt: snapshot.createdAt,
    lastActivityAt: snapshot.lastActivityAt,
    ...(snapshot.meta.modelLabel
      ? { modelLabel: bounded(snapshot.meta.modelLabel, 28) }
      : {}),
    ...(typeof snapshot.usage.tokens === "number" &&
    typeof snapshot.usage.contextWindow === "number" &&
    snapshot.usage.contextWindow > 0
      ? {
          contextPercent: Math.round(
            Math.min(
              100,
              Math.max(
                0,
                (snapshot.usage.tokens / snapshot.usage.contextWindow) * 100,
              ),
            ),
          ),
        }
      : {}),
    ...(snapshot.completedOperations > 0
      ? { completedOperations: snapshot.completedOperations }
      : {}),
  };
}

export function subagentActiveWorkRemoval(
  snapshot: SubagentSnapshot,
): ActiveWorkRemoval {
  return {
    version: 1,
    key: `subagent:${snapshot.id}`,
    status: snapshot.status === "error" ? "error" : "done",
    title: bounded(snapshot.title, 72),
    ops: snapshot.completedOperations,
    settledAt: snapshot.settledAt ?? Date.now(),
  };
}
