type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type ActiveWorkItemDraft = Mutable<ActiveWorkItem>;

import { Compile } from "typebox/compile";
import { Type, type Static } from "typebox";
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

const ActiveWorkItemSchema = Type.Object({
  version: Type.Literal(1),
  key: Type.String(),
  kind: Type.Union([Type.Literal("subagent"), Type.Literal("workflow")]),
  label: Type.String(),
  status: Type.Union([Type.Literal("running"), Type.Literal("quiet")]),
  summary: Type.String(),
  currentOperation: Type.Optional(Type.String()),
  runningProcesses: Type.Number(),
  startedAt: Type.Number(),
  lastActivityAt: Type.Number(),
  modelLabel: Type.Optional(Type.String()),
  contextPercent: Type.Optional(Type.Number()),
  completedOperations: Type.Optional(Type.Number()),
});
const ActiveWorkRemovalSchema = Type.Object({
  version: Type.Literal(1),
  key: Type.String(),
  status: Type.Optional(
    Type.Union([Type.Literal("done"), Type.Literal("error")]),
  ),
  title: Type.Optional(Type.String()),
  ops: Type.Optional(Type.Number()),
  settledAt: Type.Optional(Type.Number()),
});
const ActiveWorkItemValidator = Compile(ActiveWorkItemSchema);
const ActiveWorkRemovalValidator = Compile(ActiveWorkRemovalSchema);
export type ActivityProtocolBoundary =
  Static<typeof ActiveWorkItemSchema> | Static<typeof ActiveWorkRemovalSchema>;
export function parseActiveWorkItem(
  value: ActivityProtocolBoundary,
): ActiveWorkItem | undefined {
  if (
    !ActiveWorkItemValidator.Check(value) ||
    !value.key.startsWith(`${value.kind}:`)
  )
    return undefined;
  // SAFETY: the validator and prefix branch establish the protocol key contract.
  const key = (
    value.key.startsWith("subagent:")
      ? `subagent:${value.key.slice(9)}`
      : `workflow:${value.key.slice(9)}`
  ) as ActiveWorkItem["key"];
  return { ...value, key };
}
export function parseActiveWorkRemoval(
  value: ActivityProtocolBoundary,
): ActiveWorkRemoval | undefined {
  if (
    !ActiveWorkRemovalValidator.Check(value) ||
    (!value.key.startsWith("subagent:") && !value.key.startsWith("workflow:"))
  )
    return undefined;
  // SAFETY: the validator and prefix branch establish the protocol key contract.
  const key = (
    value.key.startsWith("subagent:")
      ? `subagent:${value.key.slice(9)}`
      : `workflow:${value.key.slice(9)}`
  ) as ActiveWorkItem["key"];
  return { ...value, key };
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
    ? singleLine(
        `${current.name}${current.argsPreview ? ` ${current.argsPreview}` : ""}`,
      )
    : undefined;
  const item: ActiveWorkItemDraft = {
    version: 1,
    key: `subagent:${snapshot.id}`,
    kind: "subagent",
    label: bounded(`${snapshot.id} · ${snapshot.title}`, 72),
    status: quiet ? "quiet" : "running",
    summary:
      operation ?? (quiet ? "quiet · no recent events" : "model working"),
    runningProcesses: 0,
    startedAt: snapshot.createdAt,
    lastActivityAt: snapshot.lastActivityAt,
  };
  if (operation) item.currentOperation = operation;
  if (snapshot.meta.modelLabel)
    item.modelLabel = bounded(snapshot.meta.modelLabel, 28);
  if (
    snapshot.usage.tokens !== undefined &&
    snapshot.usage.contextWindow !== undefined &&
    snapshot.usage.contextWindow > 0
  ) {
    item.contextPercent = Math.round(
      Math.min(
        100,
        Math.max(
          0,
          (snapshot.usage.tokens / snapshot.usage.contextWindow) * 100,
        ),
      ),
    );
  }
  if (snapshot.completedOperations > 0)
    item.completedOperations = snapshot.completedOperations;
  return item;
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
