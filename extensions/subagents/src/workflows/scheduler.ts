/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread -- Scheduler parses graph, read-model, and status inputs through descriptor checks before scheduling. */
import { isProxy } from "node:util/types";
import type {
  ValidatedWorkflowDefinition,
  WorkflowReadModel,
  WorkflowTaskDefinition,
  WorkflowTaskStatus,
} from "./domain.ts";
import {
  buildWorkflowGraph,
  ownedPathsOverlap,
  type ValidatedWorkflowGraph,
} from "./graph.ts";

export type SchedulerTarget =
  ValidatedWorkflowGraph | ValidatedWorkflowDefinition | WorkflowReadModel;

export type SchedulerStatusMap =
  | ReadonlyMap<string, WorkflowTaskStatus>
  | Readonly<Record<string, WorkflowTaskStatus>>;

export type SchedulerTaskIdCollection =
  ReadonlyArray<string> | ReadonlySet<string>;

/** Inputs are derived from the workflow read model; no pool or capacity lives here. */
export interface WorkflowSchedulerState {
  readonly statuses?: SchedulerStatusMap;
  readonly completedTaskIds?: SchedulerTaskIdCollection;
  readonly activeTaskIds?: SchedulerTaskIdCollection;
  readonly selectedTaskIds?: SchedulerTaskIdCollection;
  readonly completed?: SchedulerTaskIdCollection;
  readonly active?: SchedulerTaskIdCollection;
  readonly selected?: SchedulerTaskIdCollection;
}

export interface WorkflowScheduleRequest extends WorkflowSchedulerState {
  readonly target: SchedulerTarget;
}

export interface WorkflowGraphScheduleRequest extends WorkflowSchedulerState {
  readonly graph: SchedulerTarget;
}

export interface WorkflowSchedule {
  readonly readyTaskIds: ReadonlyArray<string>;
  readonly selectedTaskIds: ReadonlyArray<string>;
  readonly blockedTaskIds: ReadonlyArray<string>;
  readonly blockedByScope: ReadonlyMap<string, ReadonlyArray<string>>;
}

export class WorkflowSchedulingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSchedulingError";
  }
}

interface PresentValue {
  readonly present: boolean;
  readonly value: unknown;
}
function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
function ownDataProperty(
  value: object,
  key: string,
  label: string,
): PresentValue {
  if (isProxy(value))
    throw new WorkflowSchedulingError(`${label} cannot be a proxy`);
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new WorkflowSchedulingError(`${label}.${key} cannot be inspected`);
  }
  if (descriptor === undefined) return { present: false, value: undefined };
  if (!("value" in descriptor)) {
    throw new WorkflowSchedulingError(
      `${label}.${key} cannot be a getter or setter`,
    );
  }
  return { present: true, value: descriptor.value };
}
function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value))
    throw new WorkflowSchedulingError(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new WorkflowSchedulingError(`${label} cannot contain symbol keys`);
  }
}
type TargetKind = "graph" | "readModel" | "definition";
function targetKind(value: unknown): TargetKind {
  assertPlainRecord(value, "Scheduler target");
  const definition = ownDataProperty(value, "definition", "Scheduler target");
  const tasksById = ownDataProperty(value, "tasksById", "Scheduler target");
  const transitive = ownDataProperty(
    value,
    "transitiveDependencies",
    "Scheduler target",
  );
  const tasks = ownDataProperty(value, "tasks", "Scheduler target");
  const status = ownDataProperty(value, "status", "Scheduler target");
  if (tasks.present || status.present) {
    if (!definition.present || !tasks.present || !status.present) {
      throw new WorkflowSchedulingError(
        "Scheduler read model must expose own data definition, tasks, and status",
      );
    }
    return "readModel";
  }
  if (tasksById.present || transitive.present) {
    if (!definition.present || !tasksById.present || !transitive.present) {
      throw new WorkflowSchedulingError(
        "Scheduler graph must expose own data definition and indexes",
      );
    }
    return "graph";
  }
  return "definition";
}

function graphFor(target: SchedulerTarget): ValidatedWorkflowGraph {
  // A graph's indexes are an optimization, not authority. Rebuild them from
  // the frozen definition so a forged/spread graph or a mutated index cannot
  // influence scheduling.
  const kind = targetKind(target);
  if (kind === "definition") return buildWorkflowGraph(target);
  const definition = ownDataProperty(target, "definition", "Scheduler target");
  return buildWorkflowGraph(definition.value);
}

function isGenuineMap(value: unknown): value is Map<unknown, unknown> {
  if (!isObject(value) || isProxy(value)) return false;
  try {
    Map.prototype.has.call(value, undefined);
    return true;
  } catch {
    return false;
  }
}

function isGenuineSet(value: unknown): value is Set<unknown> {
  if (!isObject(value) || isProxy(value)) return false;
  try {
    Set.prototype.has.call(value, undefined);
    return true;
  } catch {
    return false;
  }
}

function assertCompleteStatusProjection(
  statuses: ReadonlyMap<string, WorkflowTaskStatus>,
  graph: ValidatedWorkflowGraph,
  label: string,
): void {
  assertKnownIds(new Set(statuses.keys()), graph, label);
  if (statuses.size !== graph.tasksById.size) {
    for (const taskId of graph.declarationOrder) {
      if (!statuses.has(taskId)) {
        throw new WorkflowSchedulingError(
          `${label} is missing status for task "${taskId}"`,
        );
      }
    }
    throw new WorkflowSchedulingError(`${label} contains extra task ids`);
  }
  for (const taskId of graph.declarationOrder) {
    if (!statuses.has(taskId)) {
      throw new WorkflowSchedulingError(
        `${label} is missing status for task "${taskId}"`,
      );
    }
  }
}

function isDescriptorPlainArray(
  value: unknown,
): value is ReadonlyArray<unknown> {
  if (!isObject(value) || isProxy(value)) return false;
  try {
    return (
      Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    );
  } catch {
    return false;
  }
}

function descriptorArrayValues(value: unknown, label: string): unknown[] {
  if (!isDescriptorPlainArray(value)) {
    throw new WorkflowSchedulingError(
      `${label} must be a descriptor-inspected plain array or Set`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new WorkflowSchedulingError(
      `${label} cannot contain symbol properties`,
    );
  }
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    length === undefined ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    throw new WorkflowSchedulingError(`${label} has an invalid length`);
  }
  const names = new Set(Object.getOwnPropertyNames(value));
  names.delete("length");
  for (const name of names) {
    if (!/^\d+$/u.test(name) || Number(name) >= length.value) {
      throw new WorkflowSchedulingError(
        `${label} contains unsupported array properties`,
      );
    }
  }
  const values: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new WorkflowSchedulingError(
        `${label} cannot contain holes, getters, or setters`,
      );
    }
    values.push(descriptor.value);
  }
  return values;
}

function isAcceptedIdCollection(
  value: unknown,
): value is SchedulerTaskIdCollection {
  return isDescriptorPlainArray(value) || isGenuineSet(value);
}

function normalizeStatuses(
  statuses: SchedulerStatusMap,
  graph: ValidatedWorkflowGraph,
): Map<string, WorkflowTaskStatus> {
  const normalized = new Map<string, WorkflowTaskStatus>();
  if (isGenuineMap(statuses)) {
    try {
      Map.prototype.forEach.call(
        statuses,
        (value: unknown, taskId: unknown) => {
          if (typeof taskId !== "string") {
            throw new WorkflowSchedulingError(
              "statuses contains a non-string task id",
            );
          }
          normalized.set(taskId, checkedStatus(value, taskId));
        },
      );
    } catch (error) {
      if (error instanceof WorkflowSchedulingError) throw error;
      throw new WorkflowSchedulingError("statuses map cannot be inspected");
    }
  } else {
    assertPlainRecord(statuses, "statuses");
    for (const taskId of Object.getOwnPropertyNames(statuses)) {
      const property = ownDataProperty(statuses, taskId, "statuses");
      if (!property.present) continue;
      normalized.set(taskId, checkedStatus(property.value, taskId));
    }
  }
  assertCompleteStatusProjection(normalized, graph, "statuses");
  return normalized;
}
function statusesFor(
  target: SchedulerTarget,
  override: SchedulerStatusMap | undefined,
  graph: ValidatedWorkflowGraph,
): Map<string, WorkflowTaskStatus> | undefined {
  if (targetKind(target) !== "readModel") {
    return override === undefined
      ? undefined
      : normalizeStatuses(override, graph);
  }
  const tasksProperty = ownDataProperty(
    target,
    "tasks",
    "Scheduler read model",
  );
  assertPlainRecord(tasksProperty.value, "Scheduler read model tasks");
  const statuses = new Map<string, WorkflowTaskStatus>();
  for (const taskId of Object.getOwnPropertyNames(tasksProperty.value)) {
    const taskProperty = ownDataProperty(
      tasksProperty.value,
      taskId,
      `Scheduler read model task "${taskId}"`,
    );
    assertPlainRecord(
      taskProperty.value,
      `Scheduler read model task "${taskId}"`,
    );
    const status = ownDataProperty(
      taskProperty.value,
      "status",
      `Scheduler read model task "${taskId}"`,
    );
    if (!status.present) {
      throw new WorkflowSchedulingError(
        `Scheduler read model task "${taskId}" has no status`,
      );
    }
    statuses.set(taskId, checkedStatus(status.value, taskId));
  }
  assertCompleteStatusProjection(
    statuses,
    graph,
    "Scheduler read model statuses",
  );
  if (override !== undefined) {
    const explicit = normalizeStatuses(override, graph);
    for (const taskId of graph.declarationOrder) {
      if (explicit.get(taskId) !== statuses.get(taskId)) {
        throw new WorkflowSchedulingError(
          `Explicit status for task "${taskId}" contradicts authoritative read model state`,
        );
      }
    }
  }
  return statuses;
}

function setFrom(
  value: unknown,
  label: string,
  graph: ValidatedWorkflowGraph,
): Set<string> {
  const result = new Set<string>();
  const add = (item: unknown): void => {
    if (typeof item !== "string") {
      throw new WorkflowSchedulingError(
        `${label} contains a non-string task id`,
      );
    }
    result.add(item);
    if (result.size > graph.tasksById.size) {
      throw new WorkflowSchedulingError(`${label} contains too many task ids`);
    }
  };
  if (value === undefined) return result;
  if (isDescriptorPlainArray(value)) {
    for (const item of descriptorArrayValues(value, label)) add(item);
    return result;
  }
  if (isGenuineSet(value)) {
    try {
      Set.prototype.forEach.call(value, (item: unknown) => add(item));
    } catch (error) {
      if (error instanceof WorkflowSchedulingError) throw error;
      throw new WorkflowSchedulingError(`${label} Set cannot be inspected`);
    }
    return result;
  }
  throw new WorkflowSchedulingError(
    `${label} must be a descriptor-inspected plain array or genuine Set`,
  );
}

function isWorkflowTaskStatus(value: unknown): value is WorkflowTaskStatus {
  return (
    value === "declared" ||
    value === "blocked" ||
    value === "ready" ||
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "skipped"
  );
}

function checkedStatus(value: unknown, taskId: string): WorkflowTaskStatus {
  if (!isWorkflowTaskStatus(value)) {
    throw new WorkflowSchedulingError(
      `Task "${taskId}" has an invalid workflow status`,
    );
  }
  return value;
}

function statusOf(
  statuses: ReadonlyMap<string, WorkflowTaskStatus> | undefined,
  taskId: string,
): WorkflowTaskStatus | undefined {
  return statuses?.get(taskId);
}

function assertKnownIds(
  ids: ReadonlySet<string>,
  graph: ValidatedWorkflowGraph,
  label: string,
): void {
  for (const id of ids) {
    if (!graph.tasksById.has(id)) {
      throw new WorkflowSchedulingError(
        `${label} contains unknown task "${id}"`,
      );
    }
  }
}

function owns(task: WorkflowTaskDefinition): ReadonlyArray<string> {
  return task.readOnly === true ? [] : task.owns;
}

function hasScopeConflict(
  candidate: WorkflowTaskDefinition,
  otherIds: ReadonlySet<string>,
  graph: ValidatedWorkflowGraph,
): string[] {
  const candidateOwns = owns(candidate);
  if (candidateOwns.length === 0) return [];
  const conflicts: string[] = [];
  for (const otherId of graph.declarationOrder) {
    if (!otherIds.has(otherId)) continue;
    const other = graph.tasksById.get(otherId);
    if (!other) continue;
    if (ownedPathsOverlap(candidateOwns, owns(other))) conflicts.push(otherId);
  }
  return conflicts;
}

type SchedulerInput =
  SchedulerTarget | WorkflowScheduleRequest | WorkflowGraphScheduleRequest;

function requestFromRecord(
  record: object,
  target: SchedulerTarget,
): WorkflowScheduleRequest {
  assertPlainRecord(record, "Scheduler request");
  const statuses = ownDataProperty(record, "statuses", "Scheduler request");
  const completedTaskIds = ownDataProperty(
    record,
    "completedTaskIds",
    "Scheduler request",
  );
  const activeTaskIds = ownDataProperty(
    record,
    "activeTaskIds",
    "Scheduler request",
  );
  const selectedTaskIds = ownDataProperty(
    record,
    "selectedTaskIds",
    "Scheduler request",
  );
  const completed = ownDataProperty(record, "completed", "Scheduler request");
  const active = ownDataProperty(record, "active", "Scheduler request");
  const selected = ownDataProperty(record, "selected", "Scheduler request");
  return {
    target,
    ...(statuses.present
      ? { statuses: statuses.value as SchedulerStatusMap }
      : {}),
    ...(completedTaskIds.present
      ? {
          completedTaskIds: completedTaskIds.value as SchedulerTaskIdCollection,
        }
      : {}),
    ...(activeTaskIds.present
      ? { activeTaskIds: activeTaskIds.value as SchedulerTaskIdCollection }
      : {}),
    ...(selectedTaskIds.present
      ? { selectedTaskIds: selectedTaskIds.value as SchedulerTaskIdCollection }
      : {}),
    ...(completed.present
      ? { completed: completed.value as SchedulerTaskIdCollection }
      : {}),
    ...(active.present
      ? { active: active.value as SchedulerTaskIdCollection }
      : {}),
    ...(selected.present
      ? { selected: selected.value as SchedulerTaskIdCollection }
      : {}),
  };
}
function asRequest(
  targetOrRequest: SchedulerInput,
  stateOrCompleted:
    WorkflowSchedulerState | SchedulerTaskIdCollection | undefined,
  activeTaskIds: SchedulerTaskIdCollection | undefined,
  selectedTaskIds: SchedulerTaskIdCollection | undefined,
): WorkflowScheduleRequest {
  if (isObject(targetOrRequest) && !isProxy(targetOrRequest)) {
    const target = ownDataProperty(
      targetOrRequest,
      "target",
      "Scheduler request",
    );
    if (target.present) {
      return requestFromRecord(
        targetOrRequest,
        target.value as SchedulerTarget,
      );
    }
    const graph = ownDataProperty(
      targetOrRequest,
      "graph",
      "Scheduler request",
    );
    if (graph.present) {
      return requestFromRecord(targetOrRequest, graph.value as SchedulerTarget);
    }
  }
  if (stateOrCompleted === undefined) {
    return { target: targetOrRequest as SchedulerTarget };
  }
  if (!isAcceptedIdCollection(stateOrCompleted)) {
    if (!isObject(stateOrCompleted)) {
      throw new WorkflowSchedulingError(
        "Scheduler state must be a plain object or iterable",
      );
    }
    return requestFromRecord(
      stateOrCompleted,
      targetOrRequest as SchedulerTarget,
    );
  }
  return {
    target: targetOrRequest as SchedulerTarget,
    completedTaskIds: stateOrCompleted,
    activeTaskIds,
    selectedTaskIds,
  };
}

/**
 * Pure declaration-order selection. Dependency readiness is calculated from
 * completed tasks, then writers are admitted greedily in declaration order;
 * active and earlier-selected overlapping writers block later writers.
 */
export function computeSchedule(
  targetOrRequest: SchedulerInput,
  stateOrCompleted?: WorkflowSchedulerState | SchedulerTaskIdCollection,
  activeTaskIds?: SchedulerTaskIdCollection,
  selectedTaskIds?: SchedulerTaskIdCollection,
): WorkflowSchedule {
  const request = asRequest(
    targetOrRequest,
    stateOrCompleted,
    activeTaskIds,
    selectedTaskIds,
  );
  const graph = graphFor(request.target);
  const statuses = statusesFor(request.target, request.statuses, graph);
  const completed = setFrom(
    request.completedTaskIds,
    "completedTaskIds",
    graph,
  );
  for (const id of setFrom(request.completed, "completed", graph))
    completed.add(id);
  const active = setFrom(request.activeTaskIds, "activeTaskIds", graph);
  for (const id of setFrom(request.active, "active", graph)) active.add(id);
  const externallySelected = setFrom(
    request.selectedTaskIds,
    "selectedTaskIds",
    graph,
  );
  for (const id of setFrom(request.selected, "selected", graph))
    externallySelected.add(id);
  assertKnownIds(completed, graph, "completedTaskIds");
  assertKnownIds(active, graph, "activeTaskIds");
  assertKnownIds(externallySelected, graph, "selectedTaskIds");
  // Status records are normalized to a genuine Map before this point.

  for (const id of graph.declarationOrder) {
    const status = statusOf(statuses, id);
    if (status === "completed") completed.add(id);
    if (status === "failed" || status === "cancelled" || status === "skipped") {
      completed.delete(id);
    }
  }

  const selected = new Set(externallySelected);
  const readyTaskIds: string[] = [];
  const blockedTaskIds: string[] = [];
  const blockedByScope = new Map<string, ReadonlyArray<string>>();
  // Queue admission is an ownership claim too. A queued writer must keep
  // later overlapping writers out even before the shared manager admits it.
  const activeWriters = new Set(
    graph.declarationOrder.filter((id) => {
      const task = graph.tasksById.get(id)!;
      const status = statusOf(statuses, id);
      return (
        (active.has(id) || status === "queued" || status === "running") &&
        owns(task).length > 0
      );
    }),
  );

  for (const taskId of graph.declarationOrder) {
    const task = graph.tasksById.get(taskId)!;
    const status = statusOf(statuses, taskId);
    if (
      active.has(taskId) ||
      selected.has(taskId) ||
      status === "queued" ||
      status === "running" ||
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "skipped"
    ) {
      continue;
    }

    if (statuses !== undefined && status !== undefined && status !== "ready") {
      continue;
    }

    const dependenciesComplete = [
      ...(graph.dependencies.get(taskId) ?? []),
    ].every((dependencyId) => completed.has(dependencyId));
    if (!dependenciesComplete) continue;

    const activeConflicts = hasScopeConflict(task, activeWriters, graph);
    const selectedConflicts = hasScopeConflict(task, selected, graph);
    const conflicts = [
      ...activeConflicts,
      ...selectedConflicts.filter((id) => !activeConflicts.includes(id)),
    ];
    if (conflicts.length > 0) {
      blockedTaskIds.push(taskId);
      blockedByScope.set(taskId, conflicts);
      continue;
    }

    readyTaskIds.push(taskId);
    selected.add(taskId);
  }

  return {
    readyTaskIds: Object.freeze(readyTaskIds),
    selectedTaskIds: Object.freeze([...selected]),
    blockedTaskIds: Object.freeze(blockedTaskIds),
    blockedByScope,
  };
}

/** Select only the task IDs that can be admitted in this scheduling wave. */
export function selectReadyTasks(
  targetOrRequest: SchedulerInput,
  stateOrCompleted?: WorkflowSchedulerState | SchedulerTaskIdCollection,
  activeTaskIds?: SchedulerTaskIdCollection,
  selectedTaskIds?: SchedulerTaskIdCollection,
): ReadonlyArray<string> {
  return computeSchedule(
    targetOrRequest,
    stateOrCompleted,
    activeTaskIds,
    selectedTaskIds,
  ).readyTaskIds;
}

export const scheduleReadyTasks = selectReadyTasks;
export const getReadyTaskIds = selectReadyTasks;
export const computeReadyTasks = selectReadyTasks;
export const getReadyTasks = selectReadyTasks;

/** Segment-aware writer conflict predicate exposed for scheduler/UI tests. */
export function writersConflict(
  left: WorkflowTaskDefinition,
  right: WorkflowTaskDefinition,
): boolean {
  return ownedPathsOverlap(owns(left), owns(right));
}
