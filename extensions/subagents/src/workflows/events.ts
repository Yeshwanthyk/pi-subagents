import type {
  ValidatedWorkflowDefinition,
  WorkflowRecoveryKind,
  WorkflowRetryKind,
} from "./domain.ts";

export const MAX_WORKFLOW_EVENTS = 2_048;
export const MAX_WORKFLOW_TASKS = 128;
export const MAX_WORKFLOW_LOGS = 128;
export const MAX_WORKFLOW_LOG_BYTES = 64 * 1_024;
export const MAX_WORKFLOW_EVENT_TEXT_BYTES = 4 * 1_024;
export const MAX_WORKFLOW_DEFINITION_BYTES = 1_024 * 1_024;
export const MAX_WORKFLOW_ID_BYTES = 128;
export const MAX_WORKFLOW_ATTEMPT_ID_BYTES = MAX_WORKFLOW_ID_BYTES;
export const MAX_WORKFLOW_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const WORKFLOW_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type WorkflowRetryMode = "explicit" | "automatic";

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
      readonly _tag: "WorkflowPaused";
      readonly reason?: string;
    })
  | (WorkflowEventBase & { readonly _tag: "WorkflowResumed" })
  | (WorkflowEventBase & {
      readonly _tag: "TaskQueued";
      readonly taskId: string;
      readonly childId: string;
      readonly attemptId?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskStarted";
      readonly taskId: string;
      readonly attemptId?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskCompleted";
      readonly taskId: string;
      readonly resultPreview?: string;
      readonly attemptId?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskFailed";
      readonly taskId: string;
      readonly error: string;
      readonly failureKind?: WorkflowRetryKind;
      readonly attemptId?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskCancelled";
      readonly taskId: string;
      readonly reason: string;
      readonly attemptId?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskRetryRequested";
      readonly taskId: string;
      /** New identity for the attempt being made. */
      readonly attemptId?: string;
      readonly previousAttemptId?: string;
      readonly mode?: WorkflowRetryMode;
      readonly failureKind?: WorkflowRetryKind;
      readonly reason?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "TaskSkipped";
      readonly taskId: string;
      readonly reason: string;
      readonly attemptId?: string;
      readonly skippedByTaskId?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "WorkflowCompleted";
      readonly summary?: string;
    })
  | (WorkflowEventBase & {
      readonly _tag: "WorkflowFailed";
      readonly error: string;
      readonly recovery?: WorkflowRecoveryKind;
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

/** Run IDs are also directory names; keep them portable and path-safe. */
export function assertSafeWorkflowRunId(value: string): void {
  if (
    utf8Bytes(value) > MAX_WORKFLOW_ID_BYTES ||
    !WORKFLOW_RUN_ID_PATTERN.test(value)
  ) {
    throw new WorkflowEventBoundsError(
      "Workflow run id must be a portable path-safe identifier.",
    );
  }
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

function assertAttemptId(value: string, label: string): void {
  if (value.length === 0 || utf8Bytes(value) > MAX_WORKFLOW_ATTEMPT_ID_BYTES) {
    throw new WorkflowEventBoundsError(
      `${label} must be between 1 and ${MAX_WORKFLOW_ATTEMPT_ID_BYTES} UTF-8 bytes.`,
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

function assertRetryKind(
  value: WorkflowRetryKind | undefined,
  label: string,
): void {
  if (
    value !== undefined &&
    value !== "provider_stall" &&
    value !== "backend_failure"
  ) {
    throw new WorkflowEventBoundsError(`${label} is invalid.`);
  }
}

function assertRecoveryKind(
  value: WorkflowRecoveryKind | undefined,
  label: string,
): void {
  if (value !== undefined && value !== "orphaned" && value !== "interrupted") {
    throw new WorkflowEventBoundsError(`${label} is invalid.`);
  }
}

/**
 * Normalize all journal-owned text before append. Definitions fail closed;
 * lifecycle diagnostics are safely truncated because their full source stays
 * with the child/artifact owner. The returned object contains event fields
 * only, so accidental transcript/session/parent fields cannot enter a journal.
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
      return {
        _tag: "WorkflowCreated",
        runId: event.runId,
        at: event.at,
        definition: structuredClone(event.definition),
      };
    case "WorkflowStarted":
      return { _tag: "WorkflowStarted", runId: event.runId, at: event.at };
    case "WorkflowPaused":
      return {
        _tag: "WorkflowPaused",
        runId: event.runId,
        at: event.at,
        reason:
          event.reason === undefined
            ? undefined
            : truncateUtf8(event.reason, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "WorkflowResumed":
      return { _tag: "WorkflowResumed", runId: event.runId, at: event.at };
    case "TaskQueued":
      assertId(event.taskId, "Task id");
      assertId(event.childId, "Child id");
      if (event.attemptId !== undefined)
        assertAttemptId(event.attemptId, "Attempt id");
      return {
        _tag: "TaskQueued",
        runId: event.runId,
        at: event.at,
        taskId: event.taskId,
        childId: event.childId,
        attemptId: event.attemptId,
      };
    case "TaskStarted":
      assertId(event.taskId, "Task id");
      if (event.attemptId !== undefined)
        assertAttemptId(event.attemptId, "Attempt id");
      return {
        _tag: "TaskStarted",
        runId: event.runId,
        at: event.at,
        taskId: event.taskId,
        attemptId: event.attemptId,
      };
    case "TaskCompleted":
      assertId(event.taskId, "Task id");
      if (event.attemptId !== undefined)
        assertAttemptId(event.attemptId, "Attempt id");
      return {
        _tag: "TaskCompleted",
        runId: event.runId,
        at: event.at,
        taskId: event.taskId,
        resultPreview:
          event.resultPreview === undefined
            ? undefined
            : truncateUtf8(event.resultPreview, MAX_WORKFLOW_EVENT_TEXT_BYTES),
        attemptId: event.attemptId,
      };
    case "TaskFailed":
      assertId(event.taskId, "Task id");
      if (event.attemptId !== undefined)
        assertAttemptId(event.attemptId, "Attempt id");
      assertRetryKind(event.failureKind, "Task failure kind");
      return {
        _tag: "TaskFailed",
        runId: event.runId,
        at: event.at,
        taskId: event.taskId,
        error: truncateUtf8(event.error, MAX_WORKFLOW_EVENT_TEXT_BYTES),
        failureKind: event.failureKind,
        attemptId: event.attemptId,
      };
    case "TaskCancelled":
      assertId(event.taskId, "Task id");
      if (event.attemptId !== undefined)
        assertAttemptId(event.attemptId, "Attempt id");
      return {
        _tag: "TaskCancelled",
        runId: event.runId,
        at: event.at,
        taskId: event.taskId,
        reason: truncateUtf8(event.reason, MAX_WORKFLOW_EVENT_TEXT_BYTES),
        attemptId: event.attemptId,
      };
    case "TaskRetryRequested":
      assertId(event.taskId, "Task id");
      if (event.attemptId !== undefined)
        assertAttemptId(event.attemptId, "Attempt id");
      if (event.previousAttemptId !== undefined)
        assertAttemptId(event.previousAttemptId, "Previous attempt id");
      if (
        event.mode !== undefined &&
        event.mode !== "explicit" &&
        event.mode !== "automatic"
      ) {
        throw new WorkflowEventBoundsError("Task retry mode is invalid.");
      }
      assertRetryKind(event.failureKind, "Task retry failure kind");
      return {
        _tag: "TaskRetryRequested",
        runId: event.runId,
        at: event.at,
        taskId: event.taskId,
        attemptId: event.attemptId,
        previousAttemptId: event.previousAttemptId,
        mode: event.mode,
        failureKind: event.failureKind,
        reason:
          event.reason === undefined
            ? undefined
            : truncateUtf8(event.reason, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "TaskSkipped":
      assertId(event.taskId, "Task id");
      if (event.attemptId !== undefined)
        assertAttemptId(event.attemptId, "Attempt id");
      if (event.skippedByTaskId !== undefined)
        assertId(event.skippedByTaskId, "Skipping task id");
      return {
        _tag: "TaskSkipped",
        runId: event.runId,
        at: event.at,
        taskId: event.taskId,
        reason: truncateUtf8(event.reason, MAX_WORKFLOW_EVENT_TEXT_BYTES),
        attemptId: event.attemptId,
        skippedByTaskId: event.skippedByTaskId,
      };
    case "WorkflowCompleted":
      return {
        _tag: "WorkflowCompleted",
        runId: event.runId,
        at: event.at,
        summary:
          event.summary === undefined
            ? undefined
            : truncateUtf8(event.summary, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "WorkflowFailed":
      assertRecoveryKind(event.recovery, "Workflow recovery kind");
      return {
        _tag: "WorkflowFailed",
        runId: event.runId,
        at: event.at,
        error: truncateUtf8(event.error, MAX_WORKFLOW_EVENT_TEXT_BYTES),
        recovery: event.recovery,
      };
    case "WorkflowCancelled":
      return {
        _tag: "WorkflowCancelled",
        runId: event.runId,
        at: event.at,
        reason: truncateUtf8(event.reason, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    case "WorkflowLogAdded":
      if (
        event.level !== "info" &&
        event.level !== "warning" &&
        event.level !== "error"
      ) {
        throw new WorkflowEventBoundsError("Workflow log level is invalid.");
      }
      return {
        _tag: "WorkflowLogAdded",
        runId: event.runId,
        at: event.at,
        level: event.level,
        message: truncateUtf8(event.message, MAX_WORKFLOW_EVENT_TEXT_BYTES),
      };
    default:
      throw new WorkflowEventBoundsError("Unknown workflow event tag.");
  }
}
