/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- This bounded projection intentionally normalizes optional public fields and supports owned child lookup sources. */
import type {
  ActiveWorkItem,
  ActiveWorkRemoval,
} from "../activity-protocol.ts";
import {
  PARENT_RESULT_LIMITS,
  type WorkflowResultEnvelope,
} from "../parent-mailbox.ts";
import type {
  BackendName,
  ParentRef,
  ReasoningEffort,
  SubagentSnapshot,
} from "../domain.ts";
import { truncateUtf8, utf8Bytes } from "./events.ts";
import {
  isWorkflowTerminal,
  type WorkflowReadModel,
  type WorkflowRecoveryKind,
  type WorkflowTaskAttempt,
  type WorkflowTaskReadModel,
  type WorkflowTaskStatus,
} from "./domain.ts";
import type {
  WorkflowRecoveryFailure,
  WorkflowRecoveryOmission,
} from "./recovery.ts";

/** Limits for the human/tool-facing workflow projection. */
export const WORKFLOW_PROJECTION_LIMITS = {
  maxTasks: 128,
  maxDependenciesPerTask: 64,
  maxOwnPathsPerTask: 64,
  maxIdBytes: 128,
  maxLabelBytes: 256,
  maxPathBytes: 256,
  maxOperationBytes: 512,
  maxErrorBytes: 2 * 1024,
  maxInspectionBytes: 64 * 1024,
  maxActivityLabelBytes: 120,
  maxActivitySummaryBytes: 512,
  maxAttempts: 64,
} as const;

export type WorkflowTaskDisplayStatus =
  "blocked" | "ready" | "queued" | "running" | "skipped" | "terminal";

export interface WorkflowTaskAttemptProjection {
  readonly id: string;
  readonly number: number;
  readonly status: WorkflowTaskAttempt["status"];
  readonly childId?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly error?: string;
  readonly failureKind?: "provider_stall" | "backend_failure";
}

export interface WorkflowTaskProjection {
  readonly id: string;
  readonly label: string;
  /** Exact lifecycle status from the authoritative workflow read model. */
  readonly status: WorkflowTaskStatus;
  readonly attemptId?: string;
  readonly attemptNumber: number;
  readonly attempts: ReadonlyArray<WorkflowTaskAttemptProjection>;
  /** Compact row status; completed/failed/cancelled share `terminal`. */
  readonly displayStatus: WorkflowTaskDisplayStatus;
  readonly terminal: boolean;
  readonly lastActivityAt: number;
  readonly dependencies: ReadonlyArray<string>;
  readonly owns: ReadonlyArray<string>;
  readonly readOnly: boolean;
  readonly backend: BackendName;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  readonly childId?: string;
  /** Current live child tool, never a copied transcript item. */
  readonly currentTool?: string;
  readonly completedOperations: number;
  readonly turns: number;
  readonly error?: string;
  readonly dependenciesOmitted?: number;
  readonly ownsOmitted?: number;
}

export interface WorkflowProjectionCounts {
  readonly total: number;
  readonly blocked: number;
  readonly ready: number;
  readonly queued: number;
  readonly running: number;
  readonly skipped: number;
  readonly terminal: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface WorkflowProjectionOutcome {
  readonly status: "completed" | "failed" | "cancelled";
  readonly message?: string;
  readonly recovery?: WorkflowRecoveryKind;
}

/**
 * Joined, deliberately small workflow view. It contains task metadata and
 * live child diagnostics, but never a child transcript or final output.
 */
export interface WorkflowProjection {
  readonly id: string;
  readonly runId: string;
  readonly name?: string;
  readonly description?: string;
  readonly status: WorkflowReadModel["status"];
  readonly version: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly pausedAt?: number;
  readonly resumedAt?: number;
  readonly outcome?: WorkflowProjectionOutcome;
  readonly error?: string;
  readonly tasks: ReadonlyArray<WorkflowTaskProjection>;
  readonly counts: WorkflowProjectionCounts;
}

export type WorkflowChildSource =
  | ReadonlyArray<SubagentSnapshot>
  | ReadonlyMap<string, SubagentSnapshot>
  | ((childId: string) => SubagentSnapshot | undefined);

function safeLine(value: string, maxBytes: number): string {
  const clean = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf8(clean, maxBytes);
}

function safeId(value: string): string {
  return safeLine(value, WORKFLOW_PROJECTION_LIMITS.maxIdBytes);
}

function nonNegativeInteger(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function childLookup(
  source: WorkflowChildSource | undefined,
): (childId: string) => SubagentSnapshot | undefined {
  if (source === undefined) return () => undefined;
  if (typeof source === "function") return source;
  if (source instanceof Map) return (childId) => source.get(childId);
  if (Array.isArray(source)) {
    return (childId) =>
      source.find((snapshot: SubagentSnapshot) => snapshot.id === childId);
  }
  return () => undefined;
}

function ownedChild(
  runId: string,
  taskId: string,
  taskAttemptId: string | undefined,
  childId: string | undefined,
  lookup: (childId: string) => SubagentSnapshot | undefined,
): SubagentSnapshot | undefined {
  if (childId === undefined) return undefined;
  const child = lookup(childId);
  return child?.id === childId &&
    child.workflow?.runId === runId &&
    child.workflow.taskId === taskId &&
    (taskAttemptId === undefined ||
      child.workflow.attemptId === undefined ||
      child.workflow.attemptId === taskAttemptId)
    ? child
    : undefined;
}

function displayStatus(status: WorkflowTaskStatus): WorkflowTaskDisplayStatus {
  switch (status) {
    case "blocked":
    case "ready":
    case "queued":
    case "running":
    case "skipped":
      return status;
    case "declared":
      return "blocked";
    case "completed":
    case "failed":
    case "cancelled":
      return "terminal";
  }
}

function taskError(
  task: WorkflowTaskReadModel,
  child: SubagentSnapshot | undefined,
): string | undefined {
  if (child?.errorText) {
    return safeLine(child.errorText, WORKFLOW_PROJECTION_LIMITS.maxErrorBytes);
  }
  if (child?.outcome?._tag === "Failed") {
    return safeLine(
      child.outcome.errorText,
      WORKFLOW_PROJECTION_LIMITS.maxErrorBytes,
    );
  }
  if (child?.outcome?._tag === "Interrupted") {
    return "interrupted";
  }
  const outcome = task.outcome;
  if (outcome?._tag === "Failed") {
    return safeLine(outcome.error, WORKFLOW_PROJECTION_LIMITS.maxErrorBytes);
  }
  if (outcome?._tag === "Cancelled") {
    return safeLine(outcome.reason, WORKFLOW_PROJECTION_LIMITS.maxErrorBytes);
  }
  if (outcome?._tag === "Skipped") {
    return safeLine(outcome.reason, WORKFLOW_PROJECTION_LIMITS.maxErrorBytes);
  }
  return undefined;
}

function attemptProjection(
  attempt: WorkflowTaskAttempt,
): WorkflowTaskAttemptProjection {
  const error =
    attempt.outcome?._tag === "Failed"
      ? safeLine(
          attempt.outcome.error,
          WORKFLOW_PROJECTION_LIMITS.maxErrorBytes,
        )
      : undefined;
  const failureKind =
    attempt.outcome?._tag === "Failed"
      ? attempt.outcome.failureKind
      : undefined;
  return Object.freeze({
    id: safeId(attempt.id),
    number: nonNegativeInteger(attempt.number),
    status: attempt.status,
    ...(attempt.childId === undefined
      ? {}
      : { childId: safeId(attempt.childId) }),
    ...(attempt.startedAt === undefined
      ? {}
      : { startedAt: nonNegativeInteger(attempt.startedAt) }),
    ...(attempt.finishedAt === undefined
      ? {}
      : { finishedAt: nonNegativeInteger(attempt.finishedAt) }),
    ...(error === undefined ? {} : { error }),
    ...(failureKind === undefined ? {} : { failureKind }),
  });
}

function currentTool(child: SubagentSnapshot | undefined): string | undefined {
  const tool = child?.liveTools[0];
  if (!tool) return undefined;
  return safeLine(tool.name, WORKFLOW_PROJECTION_LIMITS.maxOperationBytes);
}

function taskProjection(
  run: WorkflowReadModel,
  task: WorkflowTaskReadModel,
  lookup: (childId: string) => SubagentSnapshot | undefined,
): WorkflowTaskProjection {
  const child = ownedChild(
    run.id,
    task.definition.id,
    task.attemptId,
    task.childId,
    lookup,
  );
  const dependencies = (task.definition.needs ?? []).map(safeId);
  const owns = task.definition.readOnly
    ? []
    : (task.definition.owns ?? []).map((value) =>
        safeLine(value, WORKFLOW_PROJECTION_LIMITS.maxPathBytes),
      );
  const boundedDependencies = dependencies.slice(
    0,
    WORKFLOW_PROJECTION_LIMITS.maxDependenciesPerTask,
  );
  const boundedOwns = owns.slice(
    0,
    WORKFLOW_PROJECTION_LIMITS.maxOwnPathsPerTask,
  );
  const model = child?.meta.modelLabel ?? task.definition.model;
  const effort = child?.meta.reasoningEffort ?? task.definition.effort;
  const operation = currentTool(child);
  const error = taskError(task, child);
  const attempts = task.attempts
    .slice(0, WORKFLOW_PROJECTION_LIMITS.maxAttempts)
    .map(attemptProjection);
  const result: WorkflowTaskProjection = {
    id: safeId(task.definition.id),
    label: safeLine(
      task.definition.label,
      WORKFLOW_PROJECTION_LIMITS.maxLabelBytes,
    ),
    status: task.status,
    attemptNumber: nonNegativeInteger(task.attemptNumber),
    attempts: Object.freeze(attempts),
    displayStatus: displayStatus(task.status),
    terminal:
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled" ||
      task.status === "skipped",
    dependencies: Object.freeze(boundedDependencies),
    owns: Object.freeze(boundedOwns),
    readOnly: task.definition.readOnly === true,
    backend: child?.backend ?? task.definition.harness ?? "pi",
    lastActivityAt: nonNegativeInteger(
      child?.lastActivityAt ?? task.lastActivityAt,
    ),
    completedOperations: nonNegativeInteger(child?.completedOperations),
    turns: nonNegativeInteger(child?.turns),
    ...(model === undefined ? {} : { model: safeLine(model, 256) }),
    ...(effort === undefined ? {} : { effort }),
    ...(task.attemptId === undefined
      ? {}
      : { attemptId: safeId(task.attemptId) }),
    ...(task.childId === undefined ? {} : { childId: safeId(task.childId) }),
    ...(operation === undefined ? {} : { currentTool: operation }),
    ...(error === undefined ? {} : { error }),
    ...(dependencies.length > boundedDependencies.length
      ? {
          dependenciesOmitted: dependencies.length - boundedDependencies.length,
        }
      : {}),
    ...(owns.length > boundedOwns.length
      ? { ownsOmitted: owns.length - boundedOwns.length }
      : {}),
  };
  return Object.freeze(result);
}

function projectionCounts(
  tasks: ReadonlyArray<WorkflowTaskProjection>,
): WorkflowProjectionCounts {
  const counts = {
    total: tasks.length,
    blocked: 0,
    ready: 0,
    queued: 0,
    running: 0,
    skipped: 0,
    terminal: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) {
    if (task.displayStatus === "blocked") counts.blocked++;
    if (task.displayStatus === "ready") counts.ready++;
    if (task.displayStatus === "queued") counts.queued++;
    if (task.displayStatus === "running") counts.running++;
    if (task.displayStatus === "skipped") counts.skipped++;
    if (task.terminal) counts.terminal++;
    if (task.status === "completed") counts.completed++;
    if (task.status === "failed") counts.failed++;
    if (task.status === "cancelled") counts.cancelled++;
  }
  return Object.freeze(counts);
}

function workflowOutcome(
  run: WorkflowReadModel,
): WorkflowProjectionOutcome | undefined {
  if (!isWorkflowTerminal(run.status)) return undefined;
  const message =
    run.outcome?._tag === "Completed"
      ? run.outcome.summary
      : run.outcome?._tag === "Failed"
        ? run.outcome.error
        : run.outcome?._tag === "Cancelled"
          ? run.outcome.reason
          : undefined;
  const result: WorkflowProjectionOutcome = {
    status: run.status,
    ...(message === undefined
      ? {}
      : {
          message: safeLine(message, WORKFLOW_PROJECTION_LIMITS.maxErrorBytes),
        }),
    ...(run.outcome?._tag === "Failed" && run.outcome.recovery !== undefined
      ? { recovery: run.outcome.recovery }
      : {}),
  };
  return Object.freeze(result);
}

/** Join workflow task records to owned authoritative child snapshots. */
export function projectWorkflowRun(
  run: WorkflowReadModel,
  children?: WorkflowChildSource,
): WorkflowProjection {
  const lookup = childLookup(children);
  const tasks = run.definition.tasks
    .slice(0, WORKFLOW_PROJECTION_LIMITS.maxTasks)
    .map((definition) =>
      taskProjection(run, run.tasks[definition.id]!, lookup),
    );
  const outcome = workflowOutcome(run);
  const result: WorkflowProjection = {
    id: safeId(run.id),
    runId: safeId(run.id),
    ...(run.definition.name === undefined
      ? {}
      : {
          name: safeLine(
            run.definition.name,
            WORKFLOW_PROJECTION_LIMITS.maxLabelBytes,
          ),
        }),
    ...(run.definition.description === undefined
      ? {}
      : {
          description: safeLine(
            run.definition.description,
            WORKFLOW_PROJECTION_LIMITS.maxErrorBytes,
          ),
        }),
    status: run.status,
    version: nonNegativeInteger(run.version),
    createdAt: nonNegativeInteger(run.createdAt),
    lastActivityAt: nonNegativeInteger(run.lastActivityAt),
    ...(run.startedAt === undefined
      ? {}
      : { startedAt: nonNegativeInteger(run.startedAt) }),
    ...(run.finishedAt === undefined
      ? {}
      : { finishedAt: nonNegativeInteger(run.finishedAt) }),
    ...(run.pausedAt === undefined
      ? {}
      : { pausedAt: nonNegativeInteger(run.pausedAt) }),
    ...(run.resumedAt === undefined
      ? {}
      : { resumedAt: nonNegativeInteger(run.resumedAt) }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(outcome?.status === "failed" || outcome?.status === "cancelled"
      ? { error: outcome.message }
      : {}),
    tasks: Object.freeze(tasks),
    counts: projectionCounts(tasks),
  };
  return Object.freeze(result);
}

export const projectWorkflow = projectWorkflowRun;
export const projectWorkflowTasks = (
  run: WorkflowReadModel,
  children?: WorkflowChildSource,
) => projectWorkflowRun(run, children).tasks;

export interface WorkflowInspectionTextOptions {
  readonly maxBytes?: number;
}

function taskStatusText(task: WorkflowTaskProjection): string {
  return task.displayStatus === "terminal"
    ? `terminal/${task.status}`
    : task.displayStatus;
}

function taskScopeText(task: WorkflowTaskProjection): string {
  return task.readOnly ? "readOnly" : `owns:${task.owns.join(",") || "?"}`;
}

function appendBoundedLine(lines: string[], line: string, maxBytes: number) {
  const next = [...lines, line].join("\n");
  if (utf8Bytes(next) <= maxBytes) {
    lines.push(line);
    return true;
  }
  return false;
}

/** Render a bounded check/list body without child transcript or output text. */
export function formatWorkflowProjection(
  projection: WorkflowProjection,
  options: WorkflowInspectionTextOptions = {},
): string {
  const maxBytes = Math.max(
    1,
    Math.min(
      WORKFLOW_PROJECTION_LIMITS.maxInspectionBytes,
      options.maxBytes ?? WORKFLOW_PROJECTION_LIMITS.maxInspectionBytes,
    ),
  );
  const name = projection.name ? ` "${projection.name}"` : "";
  const lines = [
    `Workflow ${projection.runId}${name} [${projection.status}] · v${projection.version}`,
    `Tasks: ${projection.counts.terminal}/${projection.counts.total} terminal · ${projection.counts.running} running · ${projection.counts.queued} queued · ${projection.counts.ready} ready · ${projection.counts.blocked} blocked · ${projection.counts.skipped} skipped`,
  ];
  if (projection.error) lines.push(`Error: ${projection.error}`);
  if (projection.outcome?.recovery) {
    lines.push(
      `Recovery: ${projection.outcome.recovery} (native child sessions were not resumed)`,
    );
  }
  lines.push("Task rows:");
  for (const task of projection.tasks) {
    const dependencies = task.dependencies.join(",") || "-";
    const metadata = `${task.backend}/${task.model ?? "?"} · effort:${task.effort ?? "default"}`;
    const activity = [
      task.childId ? `child:${task.childId}` : undefined,
      task.currentTool ? `tool:${task.currentTool}` : undefined,
      `ops:${task.completedOperations}`,
      task.turns > 0 ? `turns:${task.turns}` : undefined,
      task.error ? `error:${task.error}` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · ");
    const omitted = [
      task.dependenciesOmitted
        ? `+${task.dependenciesOmitted} deps`
        : undefined,
      task.ownsOmitted ? `+${task.ownsOmitted} owns` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(", ");
    const suffix = omitted ? ` · omitted:${omitted}` : "";
    const line = `- [${taskStatusText(task)}] ${task.id} "${task.label}" · needs:${dependencies} · ${taskScopeText(task)} · ${metadata}${activity ? ` · ${activity}` : ""}${suffix}`;
    if (!appendBoundedLine(lines, line, maxBytes)) {
      lines.push("… [workflow task rows truncated]");
      break;
    }
  }
  return truncateUtf8(lines.join("\n"), maxBytes);
}

export const formatWorkflowInspection = formatWorkflowProjection;

const WORKFLOW_QUIET_MS = 30_000;

function workflowChildren(
  run: WorkflowReadModel,
  source: WorkflowChildSource | undefined,
): ReadonlyArray<SubagentSnapshot> {
  const lookup = childLookup(source);
  const children: SubagentSnapshot[] = [];
  for (const definition of run.definition.tasks) {
    const child = ownedChild(
      run.id,
      definition.id,
      run.tasks[definition.id]?.attemptId,
      run.tasks[definition.id]?.childId,
      lookup,
    );
    if (child) children.push(child);
  }
  return children;
}

/** One aggregate activity item for a workflow; child items remain private. */
export function workflowActiveWorkItem(
  run: WorkflowReadModel,
  children?: WorkflowChildSource,
  now = Date.now(),
): ActiveWorkItem | undefined {
  if (run.status !== "running" && run.status !== "paused") return undefined;
  const paused = run.status === "paused";
  const projection = projectWorkflowRun(run, children);
  const liveChildren = workflowChildren(run, children);
  const currentTool = projection.tasks.find(
    (task) => task.displayStatus === "running" && task.currentTool,
  )?.currentTool;
  const lastActivityAt = Math.max(
    run.lastActivityAt,
    ...projection.tasks.map((task) => {
      const child = liveChildren.find((item) => item.id === task.childId);
      return Math.max(
        task.lastActivityAt ?? run.lastActivityAt,
        child?.lastActivityAt ?? 0,
      );
    }),
    ...liveChildren.map((child) => child.lastActivityAt),
  );
  const running = projection.counts.running;
  const queued = projection.counts.queued;
  const activeText = `${projection.counts.terminal}/${projection.counts.total} tasks · ${running} running${queued > 0 ? ` · ${queued} queued` : ""}`;
  const operation = currentTool
    ? safeLine(currentTool, WORKFLOW_PROJECTION_LIMITS.maxOperationBytes)
    : undefined;
  const summary = safeLine(
    paused
      ? `paused · ${operation ? `${activeText} · ${operation}` : activeText}`
      : operation
        ? `${activeText} · ${operation}`
        : activeText,
    WORKFLOW_PROJECTION_LIMITS.maxActivitySummaryBytes,
  );
  const item: ActiveWorkItem = {
    version: 1,
    key: `workflow:${safeId(run.id)}`,
    kind: "workflow",
    label: safeLine(
      `workflow ${run.definition.name ?? run.id}`,
      WORKFLOW_PROJECTION_LIMITS.maxActivityLabelBytes,
    ),
    status:
      paused || now - lastActivityAt >= WORKFLOW_QUIET_MS ? "quiet" : "running",
    summary,
    runningProcesses: running,
    startedAt: nonNegativeInteger(run.startedAt ?? run.createdAt),
    lastActivityAt: nonNegativeInteger(lastActivityAt),
    ...(operation === undefined ? {} : { currentOperation: operation }),
    completedOperations: projection.tasks.reduce(
      (total, task) => total + task.completedOperations,
      0,
    ),
  };
  return Object.freeze(item);
}

export const projectWorkflowActivity = workflowActiveWorkItem;

export function workflowActiveWorkRemoval(
  run: WorkflowReadModel,
  children?: WorkflowChildSource,
): ActiveWorkRemoval {
  const projection = projectWorkflowRun(run, children);
  return {
    version: 1,
    key: `workflow:${safeId(run.id)}`,
    status: run.status === "completed" ? "done" : "error",
    title: safeLine(
      `workflow ${run.definition.name ?? run.id}`,
      WORKFLOW_PROJECTION_LIMITS.maxActivityLabelBytes,
    ),
    ops: projection.tasks.reduce(
      (total, task) => total + task.completedOperations,
      0,
    ),
    settledAt: nonNegativeInteger(run.finishedAt ?? run.lastActivityAt),
  };
}

/** Build the only parent-visible terminal record for a workflow. */
export function workflowResultEnvelope(
  run: WorkflowReadModel,
  parentRef: ParentRef,
): WorkflowResultEnvelope | undefined {
  if (!isWorkflowTerminal(run.status)) return undefined;
  const title = safeLine(
    `workflow ${run.definition.name ?? run.id}`,
    PARENT_RESULT_LIMITS.maxTitleLength,
  );
  const outcome = run.outcome;
  const message =
    outcome?._tag === "Completed"
      ? outcome.summary
      : outcome?._tag === "Failed"
        ? outcome.error
        : outcome?._tag === "Cancelled"
          ? outcome.reason
          : undefined;
  const status = run.status === "completed" ? "done" : "error";
  const output =
    run.status === "completed"
      ? `Workflow ${run.id} completed.${message ? ` ${safeLine(message, PARENT_RESULT_LIMITS.maxOutputBytes - 32)}` : ""}`
      : `Workflow ${run.id} ${run.status}.`;
  const result: WorkflowResultEnvelope = {
    kind: "workflow",
    id: safeId(run.id),
    title,
    status,
    ...(status === "error" && message !== undefined
      ? { error: safeLine(message, PARENT_RESULT_LIMITS.maxErrorBytes) }
      : {}),
    output: safeLine(output, PARENT_RESULT_LIMITS.maxOutputBytes),
    parentRef: { ...parentRef },
  };
  return Object.freeze(result);
}

export const projectWorkflowResult = workflowResultEnvelope;

export interface WorkflowListProjection {
  readonly id: string;
  readonly name?: string;
  readonly status: WorkflowReadModel["status"];
  readonly version: number;
  readonly lastActivityAt: number;
  readonly recovery?: WorkflowRecoveryKind;
  readonly counts: WorkflowProjectionCounts;
}

export function projectWorkflowList(
  runs: ReadonlyArray<WorkflowReadModel>,
): ReadonlyArray<WorkflowListProjection> {
  return Object.freeze(
    runs.slice(0, WORKFLOW_PROJECTION_LIMITS.maxTasks).map((run) => {
      const projection = projectWorkflowRun(run);
      const item = {
        id: projection.runId,
        name: projection.name,
        status: projection.status,
        version: projection.version,
        lastActivityAt: projection.lastActivityAt,
        recovery: projection.outcome?.recovery,
        counts: projection.counts,
      } satisfies WorkflowListProjection;
      return Object.freeze(item);
    }),
  );
}

export function formatWorkflowList(
  runs: ReadonlyArray<WorkflowReadModel>,
  options: WorkflowInspectionTextOptions = {},
): string {
  const maxBytes = Math.max(
    1,
    Math.min(
      WORKFLOW_PROJECTION_LIMITS.maxInspectionBytes,
      options.maxBytes ?? WORKFLOW_PROJECTION_LIMITS.maxInspectionBytes,
    ),
  );
  const lines = ["Workflows:"];
  for (const run of projectWorkflowList(runs)) {
    const name = run.name ? ` "${run.name}"` : "";
    const recovery = run.recovery ? ` · recovery:${run.recovery}` : "";
    const line = `- ${run.id}${name} [${run.status}] · ${run.counts.terminal}/${run.counts.total} terminal · v${run.version}${recovery}`;
    if (!appendBoundedLine(lines, line, maxBytes)) {
      lines.push("… [workflow rows truncated]");
      break;
    }
  }
  return truncateUtf8(lines.join("\n"), maxBytes);
}

export interface WorkflowRecoveryFailureProjection {
  readonly runId?: string;
  readonly path: string;
  readonly phase: "scan" | "load" | "terminalize";
  readonly message: string;
}

export interface WorkflowRecoveryOmissionProjection {
  readonly runId: string;
  readonly path: string;
  readonly reason: "run_limit" | "byte_budget";
}

export function projectWorkflowRecoveryOmissions(
  omissions: ReadonlyArray<WorkflowRecoveryOmission>,
): ReadonlyArray<WorkflowRecoveryOmissionProjection> {
  return Object.freeze(
    omissions.slice(0, 64).map((omission) =>
      Object.freeze({
        runId: safeId(omission.runId),
        path: safeLine(omission.path, WORKFLOW_PROJECTION_LIMITS.maxPathBytes),
        reason: omission.reason,
      }),
    ),
  );
}

export function projectWorkflowRecoveryFailures(
  failures: ReadonlyArray<WorkflowRecoveryFailure>,
): ReadonlyArray<WorkflowRecoveryFailureProjection> {
  return Object.freeze(
    failures.slice(0, 64).map((failure) =>
      Object.freeze({
        ...(failure.runId === undefined
          ? {}
          : { runId: safeId(failure.runId) }),
        path: safeLine(failure.path, WORKFLOW_PROJECTION_LIMITS.maxPathBytes),
        phase: failure.phase,
        message: safeLine(
          failure.message,
          WORKFLOW_PROJECTION_LIMITS.maxErrorBytes,
        ),
      }),
    ),
  );
}

export function formatWorkflowRecoveryFailures(
  failures: ReadonlyArray<WorkflowRecoveryFailure>,
  options: WorkflowInspectionTextOptions = {},
): string {
  const maxBytes = Math.max(
    1,
    Math.min(
      WORKFLOW_PROJECTION_LIMITS.maxInspectionBytes,
      options.maxBytes ?? WORKFLOW_PROJECTION_LIMITS.maxInspectionBytes,
    ),
  );
  const lines = ["Workflow recovery issues:"];
  for (const item of projectWorkflowRecoveryFailures(failures)) {
    const run = item.runId === undefined ? "" : ` ${item.runId}`;
    const line = `- [${item.phase}]${run} ${item.message} (${item.path})`;
    if (!appendBoundedLine(lines, line, maxBytes)) {
      lines.push("… [recovery rows truncated]");
      break;
    }
  }
  return truncateUtf8(lines.join("\n"), maxBytes);
}

export function formatWorkflowRecoveryOmissions(
  omissions: ReadonlyArray<WorkflowRecoveryOmission>,
  options: WorkflowInspectionTextOptions = {},
): string {
  const maxBytes = Math.max(
    1,
    Math.min(
      WORKFLOW_PROJECTION_LIMITS.maxInspectionBytes,
      options.maxBytes ?? WORKFLOW_PROJECTION_LIMITS.maxInspectionBytes,
    ),
  );
  const lines = ["Workflow recovery omissions:"];
  for (const item of projectWorkflowRecoveryOmissions(omissions)) {
    const line = `- [${item.reason}] ${item.runId} (${item.path})`;
    if (!appendBoundedLine(lines, line, maxBytes)) {
      lines.push("… [recovery rows truncated]");
      break;
    }
  }
  return truncateUtf8(lines.join("\n"), maxBytes);
}
