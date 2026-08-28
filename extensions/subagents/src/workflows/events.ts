import type { ValidatedWorkflowDefinition } from "./domain.ts";

export const MAX_WORKFLOW_EVENTS = 2_048;
export const MAX_WORKFLOW_TASKS = 128;
export const MAX_WORKFLOW_LOGS = 128;
export const MAX_WORKFLOW_LOG_BYTES = 64 * 1_024;
export const MAX_WORKFLOW_EVENT_TEXT_BYTES = 4 * 1_024;
export const MAX_WORKFLOW_DEFINITION_BYTES = 1_024 * 1_024;
export const MAX_WORKFLOW_ID_BYTES = 128;

interface WorkflowEventBase {
  readonly runId: string;
  readonly at: number;
}

export type WorkflowEvent =
  | (WorkflowEventBase & {
      readonly _tag: "WorkflowCreated";
      readonly definition: ValidatedWorkflowDefinition;
    })
  | (WorkflowEventBase & { readonly _tag: "WorkflowStarted" })
  | (WorkflowEventBase & {
      readonly _tag: "TaskQueued";
      readonly taskId: string;
      readonly childId: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskStarted";
      readonly taskId: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskCompleted";
      readonly taskId: string;
      readonly resultPreview?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskFailed";
      readonly taskId: string;
      readonly error: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskCancelled";
      readonly taskId: string;
      readonly reason: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "WorkflowCompleted";
      readonly summary?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "WorkflowFailed";
      readonly error: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "WorkflowCancelled";
      readonly reason: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "WorkflowLogAdded";
      readonly level: "info" | "warning" | "error";
      readonly message: string;
    });

export class WorkflowEventBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowEventBoundsError";
  }
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate without splitting a UTF-8 code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  while (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code < 0xd800 || code > 0xdbff) break;
    end--;
  }
  return value.slice(0, end);
}

function assertId(value: string, label: string): void {
  if (value.length === 0 || utf8Bytes(value) > MAX_WORKFLOW_ID_BYTES) {
    throw new WorkflowEventBoundsError(
      `${label} must be between 1 and ${MAX_WORKFLOW_ID_BYTES} UTF-8 bytes.`,
    );
  }
}

function definitionBytes(definition: ValidatedWorkflowDefinition): number {
  try {
    return utf8Bytes(JSON.stringify(definition));
  } catch {
    throw new WorkflowEventBoundsError(
      "Workflow definition must be JSON serializable.",
    );
  }
}

function assertDefinitionBounds(definition: ValidatedWorkflowDefinition): void {
  if (definition.tasks.length > MAX_WORKFLOW_TASKS) {
    throw new WorkflowEventBoundsError(
      `Workflow definitions are limited to ${MAX_WORKFLOW_TASKS} tasks.`,
    );
  }
  if (definitionBytes(definition) > MAX_WORKFLOW_DEFINITION_BYTES) {
    throw new WorkflowEventBoundsError(
      `Workflow definitions are limited to ${MAX_WORKFLOW_DEFINITION_BYTES} UTF-8 bytes.`,
    );
  }
  for (const task of definition.tasks) assertId(task.id, "Task id");
}

/**
 * Normalize all journal-owned text before append. Definitions fail closed;
 * lifecycle diagnostics are safely truncated because their full source stays
 * with the child/artifact owner.
 */
export function boundWorkflowEvent(event: WorkflowEvent): WorkflowEvent {
  if (!Number.isFinite(event.at) || event.at < 0) {
    throw new WorkflowEventBoundsError(
      "Workflow event timestamps must be finite and non-negative.",
    );
  }
  assertId(event.runId, "Workflow run id");
  switch (event._tag) {
    case "WorkflowCreated":
      assertDefinitionBounds(event.definition);
      return { ...event, definition: structuredClone(event.definition) };
    case "WorkflowStarted":
      return event;
    case "TaskQueued":
      assertId(event.taskId, "Task id");
      assertId(event.childId, "Child id");
      return event;
    case "TaskStarted":
      assertId(event.taskId, "Task id");
      return event;
    case "TaskCompleted":
      assertId(event.taskId, "Task id");
      return {
        ...event,
        resultPreview:
          event.resultPreview === undefined
            ? undefined
            : truncateUtf8(event.resultPreview, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "TaskFailed":
      assertId(event.taskId, "Task id");
      return {
        ...event,
        error: truncateUtf8(event.error, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "TaskCancelled":
      assertId(event.taskId, "Task id");
      return {
        ...event,
        reason: truncateUtf8(event.reason, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "WorkflowCompleted":
      return {
        ...event,
        summary:
          event.summary === undefined
            ? undefined
            : truncateUtf8(event.summary, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "WorkflowFailed":
      return {
        ...event,
        error: truncateUtf8(event.error, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "WorkflowCancelled":
      return {
        ...event,
        reason: truncateUtf8(event.reason, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "WorkflowLogAdded":
      return {
        ...event,
        message: truncateUtf8(event.message, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
  }
}
