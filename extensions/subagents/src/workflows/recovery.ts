/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Recovery reports convert untrusted filesystem failures into bounded public diagnostics. */
import { type WorkflowReadModel, isWorkflowTerminal } from "./domain.ts";
import {
  type WorkflowArtifactScanFailure,
  type WorkflowRunArtifactStore,
  WorkflowArtifactError,
} from "./artifacts.ts";
import {
  MAX_WORKFLOW_EVENT_TEXT_BYTES,
  type WorkflowEvent,
  boundWorkflowEvent,
  truncateUtf8,
  utf8Bytes,
} from "./events.ts";
import { foldWorkflowEvents } from "./reducer.ts";

export const WORKFLOW_ORPHANED_REASON =
  "orphaned/interrupted after process restart; native child sessions were not resumed.";
export const MAX_WORKFLOW_RECOVERY_FAILURES = 64;
export const MAX_WORKFLOW_RECOVERY_FAILURE_BYTES = 2 * 1024;
export const MAX_WORKFLOW_RECOVERED_RUNS = 128;
export const MAX_WORKFLOW_RECOVERY_BYTES = 16 * 1024 * 1024;
export const MAX_WORKFLOW_RECOVERY_OMISSIONS = 64;

export type WorkflowRecoveryOmissionReason = "run_limit" | "byte_budget";

export interface WorkflowRecoveryOmission {
  readonly runId: string;
  readonly path: string;
  readonly reason: WorkflowRecoveryOmissionReason;
}

export type WorkflowRecoveryFailurePhase = "scan" | "load" | "terminalize";

export interface WorkflowRecoveryFailure {
  readonly runId?: string;
  readonly path: string;
  readonly phase: WorkflowRecoveryFailurePhase;
  readonly message: string;
}

interface MutableWorkflowRecoveryFailure {
  runId?: string;
  path: string;
  phase: WorkflowRecoveryFailurePhase;
  message: string;
}

export interface WorkflowRecoveryReport {
  /** Terminal artifacts restored without changing their journal. */
  readonly restoredRunIds: ReadonlyArray<string>;
  /** Nonterminal artifacts atomically changed to an orphaned terminal state. */
  readonly orphanedRunIds: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<WorkflowRecoveryFailure>;
  /** Deterministic bounded report of artifacts skipped by recovery limits. */
  readonly omissions: ReadonlyArray<WorkflowRecoveryOmission>;
}

export interface WorkflowRecoveryResult {
  readonly runs: ReadonlyArray<WorkflowReadModel>;
  readonly journals: ReadonlyMap<string, ReadonlyArray<WorkflowEvent>>;
  readonly report: WorkflowRecoveryReport;
}

function boundedMessage(value: unknown): string {
  const source = value instanceof Error ? value.message : String(value);
  const clean = source.replace(/[\r\n]+/gu, " ").trim();
  if (utf8Bytes(clean) <= MAX_WORKFLOW_RECOVERY_FAILURE_BYTES) return clean;
  return `${truncateUtf8(clean, MAX_WORKFLOW_RECOVERY_FAILURE_BYTES - 1)}…`;
}

function failure(
  path: string,
  phase: WorkflowRecoveryFailurePhase,
  error: unknown,
  runId?: string,
): WorkflowRecoveryFailure {
  const item: MutableWorkflowRecoveryFailure = {
    path: truncateUtf8(path, MAX_WORKFLOW_EVENT_TEXT_BYTES),
    phase,
    message: boundedMessage(error),
  };
  if (runId !== undefined) item.runId = runId;
  return Object.freeze(item);
}

function report(
  restoredRunIds: ReadonlyArray<string>,
  orphanedRunIds: ReadonlyArray<string>,
  failures: ReadonlyArray<WorkflowRecoveryFailure>,
  omissions: ReadonlyArray<WorkflowRecoveryOmission>,
): WorkflowRecoveryReport {
  const restored = Object.freeze([...restoredRunIds]);
  const orphaned = Object.freeze([...orphanedRunIds]);
  return Object.freeze({
    restoredRunIds: restored,
    orphanedRunIds: orphaned,
    failures: Object.freeze([...failures]),
    omissions: Object.freeze([...omissions]),
  });
}

function scanFailure(
  item: WorkflowArtifactScanFailure,
): WorkflowRecoveryFailure {
  return failure(
    item.path,
    "scan",
    new WorkflowArtifactError(item.message),
    item.runId,
  );
}

function recoveryTime(state: WorkflowReadModel, now: () => number): number {
  let observed: number;
  try {
    observed = now();
  } catch {
    return state.lastActivityAt;
  }
  return Number.isFinite(observed) && observed >= 0
    ? Math.max(state.lastActivityAt, observed)
    : state.lastActivityAt;
}

/**
 * Restore only workflow-owned event journals. A nonterminal journal receives a
 * single bounded recovery failure event; the reducer marks all pending task
 * rows cancelled, so neither the run nor its tasks can look live afterwards.
 * This function never has a child executor and therefore cannot resume or
 * cancel a native session.
 */
export function recoverWorkflowArtifacts(
  store: WorkflowRunArtifactStore,
  options: {
    readonly now?: () => number;
    readonly maxEvents?: number;
    readonly maxRuns?: number;
    readonly maxBytes?: number;
  } = {},
): WorkflowRecoveryResult {
  const restored: string[] = [];
  const orphaned: string[] = [];
  const runs: WorkflowReadModel[] = [];
  const journals = new Map<string, ReadonlyArray<WorkflowEvent>>();
  const failures: WorkflowRecoveryFailure[] = [];
  const omissions: WorkflowRecoveryOmission[] = [];
  const maxRuns = Math.min(
    options.maxRuns ?? MAX_WORKFLOW_RECOVERED_RUNS,
    MAX_WORKFLOW_RECOVERED_RUNS,
  );
  const maxBytes = Math.min(
    options.maxBytes ?? MAX_WORKFLOW_RECOVERY_BYTES,
    MAX_WORKFLOW_RECOVERY_BYTES,
  );
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) {
    throw new WorkflowArtifactError("Invalid maximum recovered workflow runs.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new WorkflowArtifactError("Invalid workflow recovery byte budget.");
  }
  const addFailure = (item: WorkflowRecoveryFailure): void => {
    if (failures.length < MAX_WORKFLOW_RECOVERY_FAILURES) failures.push(item);
  };
  const addOmission = (
    artifact: { readonly runId: string; readonly path: string },
    reason: WorkflowRecoveryOmissionReason,
  ): void => {
    if (omissions.length >= MAX_WORKFLOW_RECOVERY_OMISSIONS) return;
    omissions.push(
      Object.freeze({
        runId: artifact.runId,
        path: truncateUtf8(artifact.path, MAX_WORKFLOW_EVENT_TEXT_BYTES),
        reason,
      }),
    );
  };
  let retainedBytes = 0;

  const scanned = store.scan();
  for (const item of scanned.failures) addFailure(scanFailure(item));
  for (const artifact of scanned.artifacts) {
    if (runs.length >= maxRuns) {
      addOmission(artifact, "run_limit");
      continue;
    }
    let events: ReadonlyArray<WorkflowEvent>;
    let state: WorkflowReadModel;
    try {
      events = store.load(artifact.runId);
      state = foldWorkflowEvents(events);
    } catch (error) {
      addFailure(failure(artifact.path, "load", error, artifact.runId));
      continue;
    }

    let candidateEvents = events;
    if (!isWorkflowTerminal(state.status)) {
      const maxEvents = options.maxEvents ?? store.maxEvents;
      if (events.length >= maxEvents) {
        addFailure(
          failure(
            artifact.path,
            "terminalize",
            new WorkflowArtifactError(
              `Recovery needs one event but the ${maxEvents}-event journal bound is exhausted.`,
            ),
            artifact.runId,
          ),
        );
        continue;
      }
      candidateEvents = [
        ...events,
        boundWorkflowEvent({
          _tag: "WorkflowFailed",
          runId: artifact.runId,
          at: recoveryTime(state, options.now ?? Date.now),
          error: WORKFLOW_ORPHANED_REASON,
          recovery: "orphaned",
        }),
      ];
    }
    let candidateBytes: number;
    try {
      candidateBytes = utf8Bytes(JSON.stringify(candidateEvents));
    } catch (error) {
      addFailure(failure(artifact.path, "load", error, artifact.runId));
      continue;
    }
    if (retainedBytes + candidateBytes > maxBytes) {
      addOmission(artifact, "byte_budget");
      continue;
    }
    if (isWorkflowTerminal(state.status)) {
      restored.push(artifact.runId);
      runs.push(state);
      journals.set(artifact.runId, events);
      retainedBytes += candidateBytes;
      continue;
    }

    try {
      store.replace(artifact.runId, candidateEvents);
      const recovered = foldWorkflowEvents(candidateEvents);
      if (!isWorkflowTerminal(recovered.status)) {
        throw new WorkflowArtifactError(
          "Recovery terminal event did not produce a terminal workflow.",
        );
      }
      orphaned.push(artifact.runId);
      runs.push(recovered);
      journals.set(artifact.runId, Object.freeze(candidateEvents));
      retainedBytes += candidateBytes;
    } catch (error) {
      addFailure(failure(artifact.path, "terminalize", error, artifact.runId));
    }
  }

  return {
    runs: Object.freeze(runs),
    journals,
    report: report(restored, orphaned, failures, omissions),
  };
}
