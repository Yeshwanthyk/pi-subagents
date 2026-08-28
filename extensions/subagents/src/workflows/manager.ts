import { randomUUID } from "node:crypto";
import type {
  ValidatedWorkflowDefinition,
  WorkflowReadModel,
} from "./domain.ts";
import {
  boundWorkflowEvent,
  MAX_WORKFLOW_EVENTS,
  type WorkflowEvent,
} from "./events.ts";
import { foldWorkflowEvents, reduceWorkflowEvent } from "./reducer.ts";

interface WorkflowEntry {
  state: WorkflowReadModel;
  readonly journal: WorkflowEvent[];
  readonly listeners: Set<WorkflowSubscription>;
}

export type WorkflowSubscription = (snapshot: WorkflowReadModel) => void;

export interface WorkflowManagerOptions {
  readonly now?: () => number;
  readonly createId?: () => string;
  /** Test/embedding override; cannot exceed the production hard bound. */
  readonly maxEvents?: number;
}

export class WorkflowNotFoundError extends Error {
  constructor(runId: string) {
    super(`Workflow "${runId}" is not tracked.`);
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowJournalLimitError extends Error {
  constructor(runId: string, maxEvents: number) {
    super(`Workflow "${runId}" reached the ${maxEvents}-event journal limit.`);
    this.name = "WorkflowJournalLimitError";
  }
}

/**
 * Process-memory owner for bounded workflow journals and their live folds.
 * This slice records lifecycle only; it deliberately has no child executor.
 */
export class WorkflowManager {
  private readonly entries = new Map<string, WorkflowEntry>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxEvents: number;

  constructor(options: WorkflowManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `wf-${randomUUID()}`);
    this.maxEvents = options.maxEvents ?? MAX_WORKFLOW_EVENTS;
    if (
      !Number.isInteger(this.maxEvents) ||
      this.maxEvents < 2 ||
      this.maxEvents > MAX_WORKFLOW_EVENTS
    ) {
      throw new RangeError(
        `maxEvents must be an integer between 2 and ${MAX_WORKFLOW_EVENTS}.`,
      );
    }
  }

  createRun(definition: ValidatedWorkflowDefinition): WorkflowReadModel {
    const runId = this.createId();
    if (this.entries.has(runId)) {
      throw new Error(
        `Workflow id generator returned duplicate id "${runId}".`,
      );
    }
    const event = boundWorkflowEvent({
      _tag: "WorkflowCreated",
      runId,
      at: this.eventTime(),
      definition,
    });
    const state = reduceWorkflowEvent(undefined, event);
    this.entries.set(runId, {
      state,
      journal: [event],
      listeners: new Set(),
    });
    return state;
  }

  append(event: WorkflowEvent): WorkflowReadModel {
    const entry = this.requireEntry(event.runId);
    let bounded = boundWorkflowEvent(event);
    const next = reduceWorkflowEvent(entry.state, bounded);
    // First-write-wins terminal events and exhausted logs are intentional no-ops.
    if (next === entry.state) return entry.state;
    if (bounded._tag === "WorkflowLogAdded") {
      const accepted = next.logs.at(-1);
      if (!accepted)
        throw new Error("Accepted workflow log was not projected.");
      bounded = { ...bounded, message: accepted.message };
    }
    const terminalEvent =
      bounded._tag === "WorkflowCompleted" ||
      bounded._tag === "WorkflowFailed" ||
      bounded._tag === "WorkflowCancelled";
    if (
      entry.journal.length >= this.maxEvents ||
      (entry.journal.length === this.maxEvents - 1 && !terminalEvent)
    ) {
      throw new WorkflowJournalLimitError(event.runId, this.maxEvents);
    }
    entry.journal.push(bounded);
    entry.state = next;
    const currentListeners = Array.from(entry.listeners);
    for (const listener of currentListeners) {
      try {
        listener(next);
      } catch {
        // Observers cannot roll back an accepted authoritative event.
      }
    }
    return next;
  }

  start(runId: string): WorkflowReadModel {
    return this.append({
      _tag: "WorkflowStarted",
      runId,
      at: this.eventTime(runId),
    });
  }

  queueTask(runId: string, taskId: string, childId: string): WorkflowReadModel {
    return this.append({
      _tag: "TaskQueued",
      runId,
      taskId,
      childId,
      at: this.eventTime(runId),
    });
  }

  startTask(runId: string, taskId: string): WorkflowReadModel {
    return this.append({
      _tag: "TaskStarted",
      runId,
      taskId,
      at: this.eventTime(runId),
    });
  }

  completeTask(
    runId: string,
    taskId: string,
    resultPreview?: string,
  ): WorkflowReadModel {
    return this.append({
      _tag: "TaskCompleted",
      runId,
      taskId,
      resultPreview,
      at: this.eventTime(runId),
    });
  }

  failTask(runId: string, taskId: string, error: string): WorkflowReadModel {
    return this.append({
      _tag: "TaskFailed",
      runId,
      taskId,
      error,
      at: this.eventTime(runId),
    });
  }

  cancelTask(runId: string, taskId: string, reason: string): WorkflowReadModel {
    return this.append({
      _tag: "TaskCancelled",
      runId,
      taskId,
      reason,
      at: this.eventTime(runId),
    });
  }

  complete(runId: string, summary?: string): WorkflowReadModel {
    return this.append({
      _tag: "WorkflowCompleted",
      runId,
      summary,
      at: this.eventTime(runId),
    });
  }

  fail(runId: string, error: string): WorkflowReadModel {
    return this.append({
      _tag: "WorkflowFailed",
      runId,
      error,
      at: this.eventTime(runId),
    });
  }

  cancel(runId: string, reason: string): WorkflowReadModel {
    return this.append({
      _tag: "WorkflowCancelled",
      runId,
      reason,
      at: this.eventTime(runId),
    });
  }

  log(
    runId: string,
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): WorkflowReadModel {
    return this.append({
      _tag: "WorkflowLogAdded",
      runId,
      level,
      message,
      at: this.eventTime(runId),
    });
  }

  get(runId: string): WorkflowReadModel | undefined {
    return this.entries.get(runId)?.state;
  }

  list(): ReadonlyArray<WorkflowReadModel> {
    return [...this.entries.values()].map((entry) => entry.state);
  }

  events(runId: string): ReadonlyArray<WorkflowEvent> {
    return structuredClone(this.requireEntry(runId).journal);
  }

  replay(runId: string): WorkflowReadModel {
    return foldWorkflowEvents(this.requireEntry(runId).journal);
  }

  subscribe(runId: string, listener: WorkflowSubscription): () => void {
    const listeners = this.requireEntry(runId).listeners;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  private requireEntry(runId: string): WorkflowEntry {
    const entry = this.entries.get(runId);
    if (!entry) throw new WorkflowNotFoundError(runId);
    return entry;
  }

  private eventTime(runId?: string): number {
    const observed = this.now();
    if (!Number.isFinite(observed) || observed < 0) {
      throw new Error("Workflow clock returned an invalid timestamp.");
    }
    const last = runId
      ? this.entries.get(runId)?.state.lastActivityAt
      : undefined;
    return last === undefined ? observed : Math.max(last, observed);
  }
}
