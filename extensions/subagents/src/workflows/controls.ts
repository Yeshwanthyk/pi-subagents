import {
  isWorkflowTerminal,
  type WorkflowReadModel,
  type WorkflowRetryKind,
  type WorkflowTaskReadModel,
} from "./domain.ts";

export class WorkflowControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowControlError";
  }
}

export interface WorkflowRetryOptions {
  readonly mode?: "explicit" | "automatic";
  readonly reason?: string;
  readonly failureKind?: WorkflowRetryKind;
  readonly attemptId?: string;
  readonly expectedAttemptId?: string;
}

/** The small authority surface exposed to operator controls and tools. */
export interface WorkflowControlAuthority {
  get(runId: string): WorkflowReadModel | undefined;
  pause(runId: string, reason?: string): WorkflowReadModel;
  resume(runId: string): WorkflowReadModel;
  retryTask(
    runId: string,
    taskId: string,
    options?: WorkflowRetryOptions,
  ): WorkflowReadModel;
  skipTask(runId: string, taskId: string, reason?: string): WorkflowReadModel;
  cancelRun(runId: string, reason?: string): Promise<WorkflowReadModel>;
}

export function canAutomaticallyRetry(
  task: WorkflowTaskReadModel,
  failureKind: WorkflowRetryKind | undefined,
): boolean {
  return (
    task.status === "failed" &&
    failureKind !== undefined &&
    task.attemptNumber < (task.definition.retry?.maxAttempts ?? 1) &&
    task.definition.retry?.on.includes(failureKind) === true
  );
}

export class WorkflowControls {
  private readonly authority: WorkflowControlAuthority;

  constructor(authority: WorkflowControlAuthority) {
    this.authority = authority;
  }

  pause(runId: string, reason = "Paused by operator"): WorkflowReadModel {
    const current = this.requireRun(runId);
    if (isWorkflowTerminal(current.status) || current.status === "paused")
      return current;
    return this.authority.pause(runId, reason);
  }

  resume(runId: string): WorkflowReadModel {
    const current = this.requireRun(runId);
    if (isWorkflowTerminal(current.status) || current.status === "running")
      return current;
    if (current.status !== "paused") {
      throw new WorkflowControlError(
        `Workflow "${runId}" cannot resume from ${current.status}.`,
      );
    }
    return this.authority.resume(runId);
  }

  retryTask(
    runId: string,
    taskId: string,
    reason = "Retried by operator",
  ): WorkflowReadModel {
    this.requireRun(runId);
    return this.authority.retryTask(runId, taskId, {
      mode: "explicit",
      reason,
    });
  }

  skipTask(
    runId: string,
    taskId: string,
    reason = "Skipped by operator",
  ): WorkflowReadModel {
    this.requireRun(runId);
    return this.authority.skipTask(runId, taskId, reason);
  }

  cancelRun(
    runId: string,
    reason = "Cancelled by operator",
  ): Promise<WorkflowReadModel> {
    this.requireRun(runId);
    return this.authority.cancelRun(runId, reason);
  }

  private requireRun(runId: string): WorkflowReadModel {
    const run = this.authority.get(runId);
    if (!run)
      throw new WorkflowControlError(`Unknown workflow run "${runId}".`);
    return run;
  }
}
