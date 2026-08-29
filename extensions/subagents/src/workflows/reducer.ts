import {
  isWorkflowTaskTerminal,
  isWorkflowTerminal,
  type ValidatedWorkflowDefinition,
  type WorkflowReadModel,
  type WorkflowTaskAttempt,
  type WorkflowTaskOutcome,
  type WorkflowTaskReadModel,
  type WorkflowRetryKind,
} from "./domain.ts";
import {
  boundWorkflowEvent,
  MAX_WORKFLOW_LOG_BYTES,
  MAX_WORKFLOW_LOGS,
  truncateUtf8,
  type WorkflowEvent,
  utf8Bytes,
} from "./events.ts";
import { validateWorkflowDefinition } from "./graph.ts";

export class WorkflowInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInvariantError";
  }
}

function cloneDefinition(
  definition: ValidatedWorkflowDefinition,
): ValidatedWorkflowDefinition {
  return validateWorkflowDefinition(definition);
}

function createTaskIndex(): Record<string, WorkflowTaskReadModel> {
  return Object.create(null);
}

function copyTaskIndex(
  source: Readonly<Record<string, WorkflowTaskReadModel>>,
): Record<string, WorkflowTaskReadModel> {
  const copy = createTaskIndex();
  for (const taskId of Object.keys(source)) copy[taskId] = source[taskId]!;
  return copy;
}

/** Every read model exposed by the reducer is an immutable authority. */
function freezeReadModel(state: WorkflowReadModel): WorkflowReadModel {
  Object.freeze(state.definition);
  Object.freeze(state.tasks);
  for (const taskId of Object.getOwnPropertyNames(state.tasks)) {
    const descriptor = Object.getOwnPropertyDescriptor(state.tasks, taskId);
    if (descriptor && "value" in descriptor) {
      const task = descriptor.value;
      Object.freeze(task.definition);
      Object.freeze(task.attempts);
      for (const attempt of task.attempts) {
        if (attempt.outcome) Object.freeze(attempt.outcome);
        Object.freeze(attempt);
      }
      if (task.outcome) Object.freeze(task.outcome);
      Object.freeze(task);
    }
  }
  for (const entry of state.logs) Object.freeze(entry);
  Object.freeze(state.logs);
  if (state.outcome) Object.freeze(state.outcome);
  return Object.freeze(state);
}

function createReadModel(
  event: Extract<WorkflowEvent, { readonly _tag: "WorkflowCreated" }>,
): WorkflowReadModel {
  const definition = cloneDefinition(event.definition);
  const taskIds = new Set<string>();
  for (const task of definition.tasks) {
    if (taskIds.has(task.id)) {
      throw new WorkflowInvariantError(`Duplicate workflow task "${task.id}".`);
    }
    taskIds.add(task.id);
  }
  for (const task of definition.tasks) {
    const needs = task.needs ?? [];
    if (new Set(needs).size !== needs.length) {
      throw new WorkflowInvariantError(
        `Task "${task.id}" contains duplicate dependencies.`,
      );
    }
    for (const dependencyId of needs) {
      if (!taskIds.has(dependencyId)) {
        throw new WorkflowInvariantError(
          `Task "${task.id}" depends on unknown task "${dependencyId}".`,
        );
      }
      if (dependencyId === task.id) {
        throw new WorkflowInvariantError(
          `Task "${task.id}" cannot depend on itself.`,
        );
      }
    }
  }

  const tasks = createTaskIndex();
  for (const task of definition.tasks) {
    tasks[task.id] = {
      definition: task,
      status: (task.needs?.length ?? 0) === 0 ? "ready" : "blocked",
      attemptNumber: 0,
      attempts: [],
      declaredAt: event.at,
      lastActivityAt: event.at,
    };
  }
  return freezeReadModel({
    id: event.runId,
    definition,
    status: "pending_approval",
    version: 1,
    createdAt: event.at,
    lastActivityAt: event.at,
    tasks,
    logs: [],
  });
}

function requireTask(
  state: WorkflowReadModel,
  taskId: string,
): WorkflowTaskReadModel {
  const descriptor = Object.getOwnPropertyDescriptor(state.tasks, taskId);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.value
  ) {
    throw new WorkflowInvariantError(
      `Workflow "${state.id}" has no task "${taskId}".`,
    );
  }
  return descriptor.value;
}

function replaceTask(
  state: WorkflowReadModel,
  taskId: string,
  task: WorkflowTaskReadModel,
): WorkflowReadModel {
  const tasks = copyTaskIndex(state.tasks);
  tasks[taskId] = task;
  return { ...state, tasks };
}

function withProgress(state: WorkflowReadModel, at: number): WorkflowReadModel {
  return freezeReadModel({
    ...state,
    version: state.version + 1,
    lastActivityAt: at,
  });
}

function assertActive(state: WorkflowReadModel, event: WorkflowEvent): void {
  if (state.status !== "running" && state.status !== "paused") {
    throw new WorkflowInvariantError(
      `${event._tag} requires an active workflow; "${state.id}" is ${state.status}.`,
    );
  }
}

function assertRunning(state: WorkflowReadModel, event: WorkflowEvent): void {
  if (state.status !== "running") {
    throw new WorkflowInvariantError(
      `${event._tag} requires a running workflow; "${state.id}" is ${state.status}.`,
    );
  }
}

function assertTerminalizable(
  state: WorkflowReadModel,
  event: WorkflowEvent,
): void {
  const recovery = event._tag === "WorkflowFailed" ? event.recovery : undefined;
  const canCancelPending = event._tag === "WorkflowCancelled";
  if (
    state.status !== "running" &&
    state.status !== "paused" &&
    !(
      (recovery !== undefined || canCancelPending) &&
      state.status === "pending_approval"
    )
  ) {
    throw new WorkflowInvariantError(
      `${event._tag} cannot change workflow "${state.id}" from ${state.status}.`,
    );
  }
}

function terminalTaskEvent(event: WorkflowEvent): boolean {
  return (
    event._tag === "TaskCompleted" ||
    event._tag === "TaskFailed" ||
    event._tag === "TaskCancelled" ||
    event._tag === "TaskSkipped"
  );
}

function generatedAttemptId(number: number): string {
  return `attempt-${number}`;
}

function attemptFor(
  task: WorkflowTaskReadModel,
  attemptId: string,
): WorkflowTaskAttempt | undefined {
  return task.attempts.find((attempt) => attempt.id === attemptId);
}

function updateAttempt(
  task: WorkflowTaskReadModel,
  attemptId: string,
  update: (attempt: WorkflowTaskAttempt) => WorkflowTaskAttempt,
): ReadonlyArray<WorkflowTaskAttempt> {
  const index = task.attempts.findIndex((attempt) => attempt.id === attemptId);
  if (index < 0) {
    const created = update({
      id: attemptId,
      number: task.attemptNumber > 0 ? task.attemptNumber : 1,
      status: "ready",
    });
    return [...task.attempts, created];
  }
  return task.attempts.map((attempt, currentIndex) =>
    currentIndex === index ? update(attempt) : attempt,
  );
}

function eventAttemptId(event: WorkflowEvent): string | undefined {
  return "attemptId" in event ? event.attemptId : undefined;
}

function assertAttemptLifecycleIdentity(
  task: WorkflowTaskReadModel,
  event: WorkflowEvent,
): void {
  if (task.attemptNumber > 0 && eventAttemptId(event) === undefined) {
    throw new WorkflowInvariantError(
      `Task "${task.definition.id}" lifecycle event requires attemptId after attempt 1.`,
    );
  }
}

/** Return true when a task event belongs to an already superseded attempt. */
function isLateAttemptEvent(
  task: WorkflowTaskReadModel,
  event: WorkflowEvent,
): boolean {
  if (event._tag === "TaskRetryRequested") {
    const newAttemptId = event.attemptId;
    if (newAttemptId !== undefined && newAttemptId === task.attemptId) {
      if (task.status === "failed") {
        throw new WorkflowInvariantError(
          `Task "${task.definition.id}" retry must use a new attempt identity.`,
        );
      }
      return true;
    }
    if (newAttemptId !== undefined && attemptFor(task, newAttemptId)) {
      return true;
    }
    if (
      event.previousAttemptId !== undefined &&
      task.attemptId !== event.previousAttemptId
    ) {
      if (newAttemptId !== undefined && attemptFor(task, newAttemptId)) {
        return true;
      }
      throw new WorkflowInvariantError(
        `Task "${task.definition.id}" retry does not target its current attempt.`,
      );
    }
    return false;
  }
  const supplied = eventAttemptId(event);
  if (supplied === undefined || task.attemptId === undefined) return false;
  if (supplied === task.attemptId) return false;
  if (attemptFor(task, supplied)) return true;
  throw new WorkflowInvariantError(
    `Task "${task.definition.id}" event targets unknown attempt "${supplied}".`,
  );
}

function resolveAttemptId(
  task: WorkflowTaskReadModel,
  event: WorkflowEvent,
): string {
  return eventAttemptId(event) ?? task.attemptId ?? generatedAttemptId(1);
}

function retryLimit(task: WorkflowTaskReadModel): number {
  return task.definition.retry?.maxAttempts ?? 1;
}

function automaticRetryAllowed(
  task: WorkflowTaskReadModel,
  failureKind: WorkflowRetryKind | undefined,
): boolean {
  return (
    failureKind !== undefined &&
    task.attemptNumber < retryLimit(task) &&
    task.definition.retry?.on.includes(failureKind) === true
  );
}

function descendantIds(
  state: WorkflowReadModel,
  rootTaskId: string,
): ReadonlyArray<string> {
  const included = new Set<string>([rootTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of state.definition.tasks) {
      if (
        !included.has(definition.id) &&
        (definition.needs ?? []).some((dependencyId) =>
          included.has(dependencyId),
        )
      ) {
        included.add(definition.id);
        changed = true;
      }
    }
  }
  return state.definition.tasks
    .map((definition) => definition.id)
    .filter((taskId) => taskId !== rootTaskId && included.has(taskId));
}

function skippedTask(
  task: WorkflowTaskReadModel,
  at: number,
  reason: string,
  skippedByTaskId?: string,
  failedDependencyId?: string,
): WorkflowTaskReadModel {
  let attempts = task.attempts;
  const currentAttempt =
    task.attemptId === undefined ? undefined : attemptFor(task, task.attemptId);
  if (
    currentAttempt &&
    (currentAttempt.status === "ready" ||
      currentAttempt.status === "queued" ||
      currentAttempt.status === "running")
  ) {
    attempts = updateAttempt(task, currentAttempt.id, (attempt) => ({
      ...attempt,
      status: "cancelled",
      finishedAt: at,
      outcome: { _tag: "Cancelled", reason },
    }));
  }
  let outcome: WorkflowTaskOutcome = { _tag: "Skipped", reason };
  if (failedDependencyId !== undefined) {
    outcome = { ...outcome, failedDependencyId };
  }
  if (skippedByTaskId !== undefined) {
    outcome = { ...outcome, skippedByTaskId };
  }
  return {
    ...task,
    status: "skipped",
    finishedAt: at,
    lastActivityAt: at,
    attempts,
    outcome,
  };
}

function interruptedTask(
  task: WorkflowTaskReadModel,
  at: number,
  reason: string,
): WorkflowTaskReadModel {
  let attempts = task.attempts;
  const currentAttempt =
    task.attemptId === undefined ? undefined : attemptFor(task, task.attemptId);
  if (
    currentAttempt &&
    (currentAttempt.status === "ready" ||
      currentAttempt.status === "queued" ||
      currentAttempt.status === "running")
  ) {
    attempts = updateAttempt(task, currentAttempt.id, (attempt) => ({
      ...attempt,
      status: "cancelled",
      finishedAt: at,
      outcome: { _tag: "Cancelled", reason },
    }));
  }
  return {
    ...task,
    status: "cancelled",
    finishedAt: at,
    lastActivityAt: at,
    attempts,
    outcome: { _tag: "Cancelled", reason },
  };
}

function interruptPendingTasks(
  state: WorkflowReadModel,
  at: number,
  reason: string,
): WorkflowReadModel {
  const tasks = copyTaskIndex(state.tasks);
  for (const definition of state.definition.tasks) {
    const task = tasks[definition.id]!;
    if (isWorkflowTaskTerminal(task.status)) continue;
    tasks[definition.id] = interruptedTask(task, at, reason);
  }
  return { ...state, tasks };
}

function skipFailedDescendants(
  state: WorkflowReadModel,
  failedTaskId: string,
  at: number,
  reason: string,
): WorkflowReadModel {
  const tasks = copyTaskIndex(state.tasks);
  for (const taskId of descendantIds(state, failedTaskId)) {
    const task = requireTask(state, taskId);
    if (isWorkflowTaskTerminal(task.status)) continue;
    if (task.status !== "blocked" && task.status !== "ready") {
      throw new WorkflowInvariantError(
        `Cannot skip descendant task "${taskId}" from ${task.status}.`,
      );
    }
    tasks[taskId] = skippedTask(task, at, reason, undefined, failedTaskId);
  }
  return { ...state, tasks };
}

function skipTaskAndDescendants(
  state: WorkflowReadModel,
  rootTaskId: string,
  at: number,
  reason: string,
  skippedByTaskId: string,
): WorkflowReadModel {
  const tasks = copyTaskIndex(state.tasks);
  for (const taskId of [rootTaskId, ...descendantIds(state, rootTaskId)]) {
    const task = requireTask(state, taskId);
    if (isWorkflowTaskTerminal(task.status)) continue;
    if (
      task.status !== "blocked" &&
      task.status !== "ready" &&
      task.status !== "queued" &&
      task.status !== "running"
    ) {
      throw new WorkflowInvariantError(
        `Cannot skip task "${taskId}" from ${task.status}.`,
      );
    }
    tasks[taskId] = skippedTask(task, at, reason, skippedByTaskId);
  }
  return { ...state, tasks };
}

function restoreRetriedDescendants(
  state: WorkflowReadModel,
  retriedTaskId: string,
  at: number,
): WorkflowReadModel {
  const tasks = copyTaskIndex(state.tasks);
  for (const taskId of descendantIds(state, retriedTaskId)) {
    const task = requireTask(state, taskId);
    if (
      task.status !== "skipped" ||
      task.outcome?._tag !== "Skipped" ||
      task.outcome.failedDependencyId !== retriedTaskId
    ) {
      continue;
    }
    tasks[taskId] = {
      ...task,
      status: "blocked",
      queuedAt: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      childId: undefined,
      lastActivityAt: at,
      outcome: undefined,
    };
  }
  return { ...state, tasks };
}

function unlockReadyTasks(
  state: WorkflowReadModel,
  at: number,
): WorkflowReadModel {
  let changed = false;
  const tasks = copyTaskIndex(state.tasks);
  for (const definition of state.definition.tasks) {
    const task = tasks[definition.id]!;
    if (task.status !== "blocked") continue;
    const ready = (definition.needs ?? []).every(
      (dependencyId) => tasks[dependencyId]?.status === "completed",
    );
    if (!ready) continue;
    changed = true;
    tasks[definition.id] = {
      ...task,
      status: "ready",
      lastActivityAt: at,
    };
  }
  return changed ? { ...state, tasks } : state;
}

/** Pure fold. Accepted transitions return a new model; ignored late events return the input. */
export function reduceWorkflowEvent(
  previous: WorkflowReadModel | undefined,
  unboundedEvent: WorkflowEvent,
): WorkflowReadModel {
  const event = boundWorkflowEvent(unboundedEvent);
  if (previous === undefined) {
    if (event._tag !== "WorkflowCreated") {
      throw new WorkflowInvariantError(
        `First workflow event must be WorkflowCreated, received ${event._tag}.`,
      );
    }
    return createReadModel(event);
  }
  if (event.runId !== previous.id) {
    throw new WorkflowInvariantError(
      `Event for "${event.runId}" cannot be folded into "${previous.id}".`,
    );
  }
  if (event._tag === "WorkflowCreated") {
    throw new WorkflowInvariantError(
      `Workflow "${previous.id}" has already been created.`,
    );
  }
  // Terminal ownership is sealed: every late event is a deterministic no-op.
  if (isWorkflowTerminal(previous.status)) return previous;
  if (
    (event._tag === "WorkflowPaused" && previous.status === "paused") ||
    (event._tag === "WorkflowResumed" && previous.status === "running")
  ) {
    return previous;
  }

  if ("taskId" in event) {
    const current = requireTask(previous, event.taskId);
    assertAttemptLifecycleIdentity(current, event);
    if (isLateAttemptEvent(current, event)) return previous;
    if (isWorkflowTaskTerminal(current.status)) {
      if (
        terminalTaskEvent(event) ||
        event._tag !== "TaskRetryRequested" ||
        current.status !== "failed"
      ) {
        return previous;
      }
      // A failed task is the one terminal task state that may be reopened by
      // an explicit or eligible automatic retry event.
    }
  }
  if (event.at < previous.lastActivityAt) {
    throw new WorkflowInvariantError(
      `Event timestamp ${event.at} precedes last activity ${previous.lastActivityAt}.`,
    );
  }

  let state = previous;
  switch (event._tag) {
    case "WorkflowStarted":
      if (state.status !== "pending_approval") {
        throw new WorkflowInvariantError(
          `Workflow "${state.id}" cannot start from ${state.status}.`,
        );
      }
      return withProgress(
        { ...state, status: "running", startedAt: event.at },
        event.at,
      );

    case "WorkflowPaused":
      if (state.status !== "running") {
        throw new WorkflowInvariantError(
          `Workflow "${state.id}" cannot pause from ${state.status}.`,
        );
      }
      return withProgress(
        { ...state, status: "paused", pausedAt: event.at },
        event.at,
      );

    case "WorkflowResumed":
      if (state.status !== "paused") {
        throw new WorkflowInvariantError(
          `Workflow "${state.id}" cannot resume from ${state.status}.`,
        );
      }
      return withProgress(
        { ...state, status: "running", resumedAt: event.at },
        event.at,
      );

    case "TaskQueued": {
      // ready -> queued; a pause is a scheduling barrier.
      assertRunning(state, event);
      const task = requireTask(state, event.taskId);
      if (task.status !== "ready") {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" cannot queue from ${task.status}.`,
        );
      }
      const attemptId = resolveAttemptId(task, event);
      const attemptNumber =
        attemptFor(task, attemptId)?.number ?? task.attempts.length + 1;
      const attempts = updateAttempt(task, attemptId, (attempt) => ({
        ...attempt,
        id: attemptId,
        number: attemptNumber,
        status: "queued",
        childId: event.childId,
        queuedAt: event.at,
      }));
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "queued",
        attemptId,
        attemptNumber,
        attempts,
        childId: event.childId,
        queuedAt: event.at,
        lastActivityAt: event.at,
      });
      return withProgress(state, event.at);
    }

    case "TaskStarted": {
      // queued -> running
      assertActive(state, event);
      const task = requireTask(state, event.taskId);
      if (task.status !== "queued") {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" cannot start from ${task.status}.`,
        );
      }
      const attemptId = resolveAttemptId(task, event);
      const attempt = attemptFor(task, attemptId);
      if (!attempt || attempt.status !== "queued") {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" attempt "${attemptId}" cannot start from ${attempt?.status ?? "missing"}.`,
        );
      }
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "running",
        attempts: updateAttempt(task, attemptId, (current) => ({
          ...current,
          status: "running",
          startedAt: event.at,
        })),
        startedAt: event.at,
        lastActivityAt: event.at,
      });
      return withProgress(state, event.at);
    }

    case "TaskCompleted": {
      // running -> completed, then unlock dependants
      assertActive(state, event);
      const task = requireTask(state, event.taskId);
      if (task.status !== "running") {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" cannot complete from ${task.status}.`,
        );
      }
      const attemptId = resolveAttemptId(task, event);
      const attempt = attemptFor(task, attemptId);
      if (!attempt || attempt.status !== "running") {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" attempt "${attemptId}" cannot complete from ${attempt?.status ?? "missing"}.`,
        );
      }
      const outcome = {
        _tag: "Completed" as const,
        resultPreview: event.resultPreview,
      };
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "completed",
        attempts: updateAttempt(task, attemptId, (current) => ({
          ...current,
          status: "completed",
          finishedAt: event.at,
          outcome,
        })),
        finishedAt: event.at,
        lastActivityAt: event.at,
        outcome,
      });
      state = unlockReadyTasks(state, event.at);
      return withProgress(state, event.at);
    }

    case "TaskFailed": {
      // running/queued/ready -> failed, then optionally await a retry request.
      assertActive(state, event);
      const task = requireTask(state, event.taskId);
      if (
        task.status !== "running" &&
        task.status !== "queued" &&
        task.status !== "ready"
      ) {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" cannot fail from ${task.status}.`,
        );
      }
      const attemptId = resolveAttemptId(task, event);
      const attemptNumber =
        attemptFor(task, attemptId)?.number ?? task.attempts.length + 1;
      let outcome: WorkflowTaskOutcome = {
        _tag: "Failed",
        error: event.error,
      };
      if (event.failureKind !== undefined) {
        outcome = { ...outcome, failureKind: event.failureKind };
      }
      const attempts = updateAttempt(task, attemptId, (current) => ({
        ...current,
        id: attemptId,
        number: attemptNumber,
        status: "failed",
        finishedAt: event.at,
        outcome,
      }));
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "failed",
        attemptId,
        attemptNumber,
        attempts,
        finishedAt: event.at,
        lastActivityAt: event.at,
        outcome,
      });
      if (
        !automaticRetryAllowed(state.tasks[event.taskId]!, event.failureKind)
      ) {
        state = skipFailedDescendants(
          state,
          event.taskId,
          event.at,
          event.error,
        );
      }
      return withProgress(state, event.at);
    }

    case "TaskCancelled": {
      // running/queued/ready/blocked -> cancelled
      assertActive(state, event);
      const task = requireTask(state, event.taskId);
      if (
        task.status !== "running" &&
        task.status !== "queued" &&
        task.status !== "ready" &&
        task.status !== "blocked"
      ) {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" cannot cancel from ${task.status}.`,
        );
      }
      const attemptId = resolveAttemptId(task, event);
      const attempt = attemptFor(task, attemptId);
      const attempts =
        attempt === undefined
          ? task.attempts
          : updateAttempt(task, attemptId, (current) => ({
              ...current,
              status: "cancelled",
              finishedAt: event.at,
              outcome: { _tag: "Cancelled", reason: event.reason },
            }));
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "cancelled",
        attempts,
        finishedAt: event.at,
        lastActivityAt: event.at,
        outcome: { _tag: "Cancelled", reason: event.reason },
      });
      return withProgress(state, event.at);
    }

    case "TaskRetryRequested": {
      assertActive(state, event);
      const task = requireTask(state, event.taskId);
      if (task.status !== "failed") {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" can retry only from failed, not ${task.status}.`,
        );
      }
      const mode = event.mode ?? "explicit";
      const failureKind =
        event.failureKind ??
        (task.outcome?._tag === "Failed"
          ? task.outcome.failureKind
          : undefined);
      if (mode === "automatic" && !automaticRetryAllowed(task, failureKind)) {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" is not eligible for automatic retry.`,
        );
      }
      if (task.attempts.length >= retryLimit(task)) {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" reached its maxAttempts (${retryLimit(task)}).`,
        );
      }
      const attemptId =
        event.attemptId ?? generatedAttemptId(task.attempts.length + 1);
      if (attemptId === task.attemptId) {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" retry must use a new attempt identity.`,
        );
      }
      if (attemptFor(task, attemptId)) return state;
      const attemptNumber = task.attempts.length + 1;
      const attempts = [
        ...task.attempts,
        {
          id: attemptId,
          number: attemptNumber,
          status: "ready" as const,
        },
      ];
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "ready",
        attemptId,
        attemptNumber,
        attempts,
        queuedAt: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        childId: undefined,
        lastActivityAt: event.at,
        outcome: undefined,
      });
      state = restoreRetriedDescendants(state, event.taskId, event.at);
      return withProgress(state, event.at);
    }

    case "TaskSkipped": {
      assertActive(state, event);
      const task = requireTask(state, event.taskId);
      if (isWorkflowTaskTerminal(task.status)) return state;
      const skippedByTaskId = event.skippedByTaskId ?? event.taskId;
      if (
        event.skippedByTaskId !== undefined &&
        !state.tasks[event.skippedByTaskId]
      ) {
        throw new WorkflowInvariantError(
          `Skipping task "${event.skippedByTaskId}" is not in workflow "${state.id}".`,
        );
      }
      state = skipTaskAndDescendants(
        state,
        event.taskId,
        event.at,
        event.reason,
        skippedByTaskId,
      );
      return withProgress(state, event.at);
    }

    case "WorkflowCompleted":
      assertTerminalizable(state, event);
      if (
        state.definition.tasks.some(
          (definition) =>
            requireTask(state, definition.id).status !== "completed",
        )
      ) {
        throw new WorkflowInvariantError(
          `Workflow "${state.id}" cannot complete before every task completes.`,
        );
      }
      return withProgress(
        {
          ...state,
          status: "completed",
          finishedAt: event.at,
          outcome: { _tag: "Completed", summary: event.summary },
        },
        event.at,
      );

    case "WorkflowFailed": {
      assertTerminalizable(state, event);
      // The workflow event is the only persisted terminal transition. It
      // closes every still-live task in the same reducer step, including
      // ready/blocked work that has never had a child.
      const interrupted = interruptPendingTasks(state, event.at, event.error);
      const outcome =
        event.recovery === undefined
          ? { _tag: "Failed" as const, error: event.error }
          : {
              _tag: "Failed" as const,
              error: event.error,
              recovery: event.recovery,
            };
      return withProgress(
        {
          ...interrupted,
          status: "failed",
          finishedAt: event.at,
          outcome,
        },
        event.at,
      );
    }

    case "WorkflowCancelled":
      assertTerminalizable(state, event);
      return withProgress(
        {
          // Cancellation, like failure and recovery, is one atomic journal
          // transition rather than a loop of per-task events.
          ...interruptPendingTasks(state, event.at, event.reason),
          status: "cancelled",
          finishedAt: event.at,
          outcome: { _tag: "Cancelled", reason: event.reason },
        },
        event.at,
      );

    case "WorkflowLogAdded": {
      // bounded projection; excess logs are no-ops
      if (state.logs.length >= MAX_WORKFLOW_LOGS) return state;
      const used = state.logs.reduce(
        (total, entry) => total + utf8Bytes(entry.message),
        0,
      );
      const remaining = MAX_WORKFLOW_LOG_BYTES - used;
      if (remaining <= 0) return state;
      const message = truncateUtf8(event.message, remaining);
      if (message.length === 0 && event.message.length > 0) return state;
      return withProgress(
        {
          ...state,
          logs: [...state.logs, { at: event.at, level: event.level, message }],
        },
        event.at,
      );
    }
  }
}

export function foldWorkflowEvents(
  events: ReadonlyArray<WorkflowEvent>,
): WorkflowReadModel {
  let state: WorkflowReadModel | undefined;
  for (const event of events) state = reduceWorkflowEvent(state, event);
  if (!state) {
    throw new WorkflowInvariantError(
      "Cannot fold an empty workflow event journal.",
    );
  }
  return state;
}
