import type { BackendName, ReasoningEffort } from "../domain.ts";

export const WORKFLOW_TASK_KINDS = [
  "scout",
  "writer",
  "proof",
  "review",
  "repair",
] as const;
export type WorkflowTaskKind = (typeof WORKFLOW_TASK_KINDS)[number];

export interface WorkflowTaskRetry {
  readonly maxAttempts: number;
  readonly on: ReadonlyArray<"provider_stall" | "backend_failure">;
}

interface WorkflowTaskBase {
  readonly id: string;
  readonly label: string;
  readonly kind: WorkflowTaskKind;
  readonly prompt: string;
  readonly needs?: ReadonlyArray<string>;
  readonly consumes?: ReadonlyArray<string>;
  readonly harness?: BackendName;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  readonly retry?: WorkflowTaskRetry;
}

export type WorkflowTaskDefinition = WorkflowTaskBase &
  (
    | { readonly readOnly: true; readonly owns?: never }
    | {
        readonly readOnly?: never;
        readonly owns: readonly [string, ...string[]];
      }
  );

/** A graph that has passed the caller's graph validation boundary. */
export interface ValidatedWorkflowDefinition {
  readonly name?: string;
  readonly description?: string;
  readonly tasks: ReadonlyArray<WorkflowTaskDefinition>;
}

export type WorkflowStatus =
  "pending_approval" | "running" | "completed" | "failed" | "cancelled";

export type WorkflowTerminalStatus = Extract<
  WorkflowStatus,
  "completed" | "failed" | "cancelled"
>;

export type WorkflowTaskStatus =
  | "declared"
  | "blocked"
  | "ready"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type WorkflowTaskTerminalStatus = Extract<
  WorkflowTaskStatus,
  "completed" | "failed" | "cancelled" | "skipped"
>;

export type WorkflowOutcome =
  | { readonly _tag: "Completed"; readonly summary?: string }
  | { readonly _tag: "Failed"; readonly error: string }
  | { readonly _tag: "Cancelled"; readonly reason: string };

export type WorkflowTaskOutcome =
  | { readonly _tag: "Completed"; readonly resultPreview?: string }
  | { readonly _tag: "Failed"; readonly error: string }
  | { readonly _tag: "Cancelled"; readonly reason: string }
  | {
      readonly _tag: "Skipped";
      readonly failedDependencyId: string;
      readonly reason: string;
    };

export interface WorkflowLogEntry {
  readonly at: number;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface WorkflowTaskReadModel {
  readonly definition: WorkflowTaskDefinition;
  readonly status: WorkflowTaskStatus;
  readonly declaredAt: number;
  readonly lastActivityAt: number;
  readonly queuedAt?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly childId?: string;
  readonly outcome?: WorkflowTaskOutcome;
}

export interface WorkflowReadModel {
  readonly id: string;
  readonly definition: ValidatedWorkflowDefinition;
  readonly status: WorkflowStatus;
  /** Strictly increases for every event that changes this projection. */
  readonly version: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly outcome?: WorkflowOutcome;
  readonly tasks: Readonly<Record<string, WorkflowTaskReadModel>>;
  readonly logs: ReadonlyArray<WorkflowLogEntry>;
}

export function isWorkflowTerminal(
  status: WorkflowStatus,
): status is WorkflowTerminalStatus {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function isWorkflowTaskTerminal(
  status: WorkflowTaskStatus,
): status is WorkflowTaskTerminalStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "skipped"
  );
}
