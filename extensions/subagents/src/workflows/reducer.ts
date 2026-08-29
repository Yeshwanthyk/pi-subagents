import {
  isWorkflowTaskTerminal,
  isWorkflowTerminal,
  type ValidatedWorkflowDefinition,
  type WorkflowReadModel,
  type WorkflowTaskReadModel,
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
  for (const taskId of Object.keys(source)) {
    copy[taskId] = source[taskId]!;
  }
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

function assertRunning(state: WorkflowReadModel, event: WorkflowEvent): void {
  if (state.status !== "running") {
    throw new WorkflowInvariantError(
      `${event._tag} requires a running workflow; "${state.id}" is ${state.status}.`,
    );
  }
}

function terminalTaskEvent(event: WorkflowEvent): boolean {
  return (
    event._tag === "TaskCompleted" ||
    event._tag === "TaskFailed" ||
    event._tag === "TaskCancelled"
  );
}

function skipFailedDescendants(
  state: WorkflowReadModel,
  failedTaskId: string,
  at: number,
  reason: string,
): WorkflowReadModel {
  const descendants = new Set<string>();
  const pending = [failedTaskId];
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const definition of state.definition.tasks) {
      if (
        !descendants.has(definition.id) &&
        (definition.needs ?? []).includes(parent)
      ) {
        descendants.add(definition.id);
        pending.push(definition.id);
      }
    }
  }

  if (descendants.size === 0) return state;
  const tasks = copyTaskIndex(state.tasks);
  for (const taskId of descendants) {
    const task = requireTask(state, taskId);
    if (isWorkflowTaskTerminal(task.status)) continue;
    if (task.status !== "blocked" && task.status !== "ready") {
      throw new WorkflowInvariantError(
        `Cannot skip descendant task "${taskId}" from ${task.status}.`,
      );
    }
    tasks[taskId] = {
      ...task,
      status: "skipped",
      lastActivityAt: at,
      finishedAt: at,
      outcome: {
        _tag: "Skipped",
        failedDependencyId: failedTaskId,
        reason,
      },
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

/** Pure fold. Accepted transitions return a new model; ignored late terminals return the input. */
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

  if ("taskId" in event) {
    const current = requireTask(previous, event.taskId);
    if (isWorkflowTaskTerminal(current.status)) {
      if (terminalTaskEvent(event)) return previous;
      throw new WorkflowInvariantError(
        `Task "${event.taskId}" is already ${current.status}.`,
      );
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

    case "TaskQueued": {
      // ready -> queued
      assertRunning(state, event);
      const task = requireTask(state, event.taskId);
      if (task.status !== "ready") {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" cannot queue from ${task.status}.`,
        );
      }
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "queued",
        childId: event.childId,
        queuedAt: event.at,
        lastActivityAt: event.at,
      });
      return withProgress(state, event.at);
    }

    case "TaskStarted": {
      // queued -> running
      assertRunning(state, event);
      const task = requireTask(state, event.taskId);
      if (task.status !== "queued") {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" cannot start from ${task.status}.`,
        );
      }
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "running",
        startedAt: event.at,
        lastActivityAt: event.at,
      });
      return withProgress(state, event.at);
    }

    case "TaskCompleted": {
      // running -> completed, then unlock dependants
      assertRunning(state, event);
      const task = requireTask(state, event.taskId);
      if (task.status !== "running") {
        throw new WorkflowInvariantError(
          `Task "${event.taskId}" cannot complete from ${task.status}.`,
        );
      }
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "completed",
        finishedAt: event.at,
        lastActivityAt: event.at,
        outcome: { _tag: "Completed", resultPreview: event.resultPreview },
      });
      state = unlockReadyTasks(state, event.at);
      return withProgress(state, event.at);
    }

    case "TaskFailed": {
      // running/queued/ready -> failed, descendants -> skipped
      assertRunning(state, event);
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
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "failed",
        finishedAt: event.at,
        lastActivityAt: event.at,
        outcome: { _tag: "Failed", error: event.error },
      });
      state = skipFailedDescendants(state, event.taskId, event.at, event.error);
      return withProgress(state, event.at);
    }

    case "TaskCancelled": {
      // running/queued/ready/blocked -> cancelled
      assertRunning(state, event);
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
      state = replaceTask(state, event.taskId, {
        ...task,
        status: "cancelled",
        finishedAt: event.at,
        lastActivityAt: event.at,
        outcome: { _tag: "Cancelled", reason: event.reason },
      });
      return withProgress(state, event.at);
    }

    case "WorkflowCompleted":
      assertRunning(state, event);
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

    case "WorkflowFailed":
      assertRunning(state, event);
      return withProgress(
        {
          ...state,
          status: "failed",
          finishedAt: event.at,
          outcome: { _tag: "Failed", error: event.error },
        },
        event.at,
      );

    case "WorkflowCancelled":
      assertRunning(state, event);
      return withProgress(
        {
          ...state,
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
