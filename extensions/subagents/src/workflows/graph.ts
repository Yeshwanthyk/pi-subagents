/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread -- This module is the untrusted workflow graph boundary; it inspects plain data without invoking accessors and returns an owned immutable snapshot. */
import * as posixPath from "node:path/posix";
import { isProxy } from "node:util/types";
import {
  BACKEND_NAMES,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "../domain.ts";
import type {
  ValidatedWorkflowDefinition,
  WorkflowTaskDefinition,
  WorkflowTaskKind,
  WorkflowTaskRetry,
} from "./domain.ts";
import {
  MAX_WORKFLOW_DEFINITION_BYTES,
  MAX_WORKFLOW_ID_BYTES,
  MAX_WORKFLOW_TASKS,
  utf8Bytes,
} from "./events.ts";

/**
 * Deliberately small, portable ownership policy. Paths are normalized to
 * POSIX-style relative paths, with `.` segments removed. A path containing
 * `..` is accepted only when normalization proves it still remains below the
 * relative root (for example `src/../README.md`), while `../secret` fails.
 * Windows separators are normalized before the same segment check.
 */
export const MAX_WORKFLOW_OWN_PATH_BYTES = 4 * 1024;
export const MAX_WORKFLOW_OWN_PATHS = 128;
export const MAX_WORKFLOW_TASK_LABEL_BYTES = 16 * 1024;
export const MAX_WORKFLOW_TASK_PROMPT_BYTES = 256 * 1024;
export const MAX_WORKFLOW_NAME_BYTES = 160;
export const MAX_WORKFLOW_DESCRIPTION_BYTES = 8 * 1024;
export const MAX_WORKFLOW_RETRY_ATTEMPTS = Number.MAX_SAFE_INTEGER;

/** IDs are opaque labels, not JavaScript expressions or filesystem paths. */
export const MAX_WORKFLOW_TASK_ID_BYTES = MAX_WORKFLOW_ID_BYTES;

export class WorkflowGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowGraphValidationError";
  }
}

interface DataRecord {
  readonly [key: string]: unknown;
}

interface PropertyValue {
  readonly present: boolean;
  readonly value: unknown;
}

export interface ValidatedWorkflowGraph {
  readonly definition: ValidatedWorkflowDefinition;
  readonly declarationOrder: ReadonlyArray<string>;
  readonly tasksById: ReadonlyMap<string, WorkflowTaskDefinition>;
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dependants: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every strict ancestor of a task, in graph terms (not merely direct needs). */
  readonly transitiveDependencies: ReadonlyMap<string, ReadonlySet<string>>;
}

function fail(message: string): never {
  throw new WorkflowGraphValidationError(message);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isPlainRecord(value: unknown): value is DataRecord {
  if (!isObject(value) || Array.isArray(value)) return false;
  if (isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is DataRecord {
  if (!isPlainRecord(value)) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(`${label} cannot contain symbol keys`);
  }
}

function ownProperty(
  record: DataRecord,
  key: string,
  label: string,
): PropertyValue {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return { present: false, value: undefined };
  if (!("value" in descriptor)) {
    fail(`${label}.${key} cannot be a getter or setter`);
  }
  return { present: true, value: descriptor.value };
}

function assertAllowedKeys(
  record: DataRecord,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field "${key}"`);
  }
}

function arrayValues(
  value: unknown,
  label: string,
  maxLength: number,
): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (isProxy(value)) fail(`${label} cannot be a proxy`);
  if (value.length > maxLength) {
    fail(`${label} may contain at most ${maxLength} items`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(`${label} cannot contain symbol properties`);
  }
  const names = new Set(Object.getOwnPropertyNames(value));
  names.delete("length");
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) >= value.length) {
      fail(`${label} contains unsupported array properties`);
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(`${label} cannot contain holes, getters, or setters`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function boundedString(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean; readonly maxBytes: number },
): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (!options.allowEmpty && value.length === 0)
    fail(`${label} cannot be empty`);
  if (utf8Bytes(value) > options.maxBytes) {
    fail(`${label} exceeds ${options.maxBytes} UTF-8 bytes`);
  }
  if (/\p{Cc}/u.test(value)) fail(`${label} contains control characters`);
  return value;
}

function boundedId(value: unknown, label: string): string {
  const id = boundedString(value, label, {
    maxBytes: MAX_WORKFLOW_TASK_ID_BYTES,
  });
  if (id.trim() !== id)
    fail(`${label} cannot have leading or trailing whitespace`);
  return id;
}

function normalizeOwnPath(value: unknown, label: string): string {
  const raw = boundedString(value, label, {
    maxBytes: MAX_WORKFLOW_OWN_PATH_BYTES,
  });
  const slashPath = raw.replaceAll("\\", "/");
  if (
    slashPath.includes("?") ||
    slashPath.includes("*") ||
    slashPath.includes("[") ||
    slashPath.includes("]")
  ) {
    fail(`${label} cannot contain glob metacharacters`);
  }
  // Reject drive-qualified and root-qualified paths before normalization; they
  // must never become a project-relative ownership claim.
  if (
    slashPath.startsWith("/") ||
    slashPath.startsWith("//") ||
    /^[A-Za-z]:/.test(slashPath)
  ) {
    fail(`${label} must be a relative path`);
  }
  const normalized = posixPath.normalize(slashPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/")
  ) {
    fail(`${label} must remain below the relative project root`);
  }
  if (normalized.length === 0 || /\p{Cc}/u.test(normalized)) {
    fail(`${label} is not a safe relative path`);
  }
  return normalized;
}

function stringArray(
  value: unknown,
  label: string,
  maxLength: number,
  itemLabel: string,
): string[] {
  const values = arrayValues(value, label, maxLength);
  return values.map((item, index) =>
    boundedId(item, `${itemLabel} ${index + 1}`),
  );
}

function optionalString(
  record: DataRecord,
  key: string,
  label: string,
  maxBytes: number,
  allowEmpty = true,
): string | undefined {
  const property = ownProperty(record, key, label);
  if (!property.present) return undefined;
  return boundedString(property.value, `${label}.${key}`, {
    maxBytes,
    allowEmpty,
  });
}

function optionalStringArray(
  record: DataRecord,
  key: string,
  label: string,
): string[] | undefined {
  const property = ownProperty(record, key, label);
  if (!property.present) return undefined;
  return stringArray(
    property.value,
    `${label}.${key}`,
    MAX_WORKFLOW_TASKS,
    `${label}.${key} item`,
  );
}

function normalizeRetry(value: unknown, label: string): WorkflowTaskRetry {
  assertPlainRecord(value, `${label}.retry`);
  assertAllowedKeys(value, new Set(["maxAttempts", "on"]), `${label}.retry`);
  const maxAttempts = ownProperty(value, "maxAttempts", `${label}.retry`);
  const on = ownProperty(value, "on", `${label}.retry`);
  if (
    !maxAttempts.present ||
    typeof maxAttempts.value !== "number" ||
    !Number.isSafeInteger(maxAttempts.value) ||
    maxAttempts.value < 1 ||
    maxAttempts.value > MAX_WORKFLOW_RETRY_ATTEMPTS
  ) {
    fail(
      `${label}.retry.maxAttempts must be a safe integer from 1 to ${MAX_WORKFLOW_RETRY_ATTEMPTS}`,
    );
  }
  if (!on.present) fail(`${label}.retry.on is required`);
  const values = arrayValues(on.value, `${label}.retry.on`, MAX_WORKFLOW_TASKS);
  const normalized = values.map((item, index) => {
    if (item !== "provider_stall" && item !== "backend_failure") {
      fail(`${label}.retry.on item ${index + 1} is invalid`);
    }
    return item;
  });
  return { maxAttempts: maxAttempts.value, on: normalized };
}

const TASK_KEYS = new Set([
  "id",
  "label",
  "kind",
  "prompt",
  "needs",
  "consumes",
  "readOnly",
  "owns",
  "harness",
  "model",
  "effort",
  "retry",
]);
const DEFINITION_KEYS = new Set(["name", "description", "tasks"]);
const TASK_KINDS = new Set(["scout", "writer", "proof", "review", "repair"]);

function normalizeTask(value: unknown, index: number): WorkflowTaskDefinition {
  const label = `Workflow task ${index + 1}`;
  assertPlainRecord(value, label);
  assertAllowedKeys(value, TASK_KEYS, label);

  const id = boundedId(ownProperty(value, "id", label).value, `${label} id`);
  const taskLabel = boundedString(
    ownProperty(value, "label", label).value,
    `${label} label`,
    {
      maxBytes: MAX_WORKFLOW_TASK_LABEL_BYTES,
    },
  );
  const kind = ownProperty(value, "kind", label).value;
  if (typeof kind !== "string" || !TASK_KINDS.has(kind)) {
    fail(`${label} has an invalid kind`);
  }
  const taskKind = kind as WorkflowTaskKind;
  const prompt = boundedString(
    ownProperty(value, "prompt", label).value,
    `${label} prompt`,
    {
      maxBytes: MAX_WORKFLOW_TASK_PROMPT_BYTES,
    },
  );

  const needs = optionalStringArray(value, "needs", label);
  const consumes = optionalStringArray(value, "consumes", label);
  if (needs !== undefined && new Set(needs).size !== needs.length) {
    fail(`Task "${id}" contains duplicate dependencies`);
  }
  if (consumes !== undefined && new Set(consumes).size !== consumes.length) {
    fail(`Task "${id}" contains duplicate consumed dependencies`);
  }

  const readOnlyProperty = ownProperty(value, "readOnly", label);
  const ownsProperty = ownProperty(value, "owns", label);
  if (readOnlyProperty.present && readOnlyProperty.value !== true) {
    fail(`Task "${id}" requires readOnly:true when readOnly is present`);
  }
  if (readOnlyProperty.present === ownsProperty.present) {
    fail(
      `Task "${id}" requires exactly one of readOnly:true or non-empty owns`,
    );
  }

  let scope:
    | { readonly readOnly: true }
    | { readonly owns: readonly [string, ...string[]] };
  if (readOnlyProperty.present) {
    scope = { readOnly: true };
  } else {
    const rawOwns = arrayValues(
      ownsProperty.value,
      `Task "${id}" owns`,
      MAX_WORKFLOW_OWN_PATHS,
    );
    if (rawOwns.length === 0) fail(`Task "${id}" owns must be non-empty`);
    const owns = rawOwns.map((item, pathIndex) =>
      normalizeOwnPath(item, `Task "${id}" owns path ${pathIndex + 1}`),
    );
    if (new Set(owns).size !== owns.length) {
      fail(`Task "${id}" owns cannot contain duplicate normalized paths`);
    }
    scope = { owns: owns as [string, ...string[]] };
  }

  const harnessProperty = ownProperty(value, "harness", label);
  let harness: (typeof BACKEND_NAMES)[number] | undefined;
  if (harnessProperty.present) {
    if (
      typeof harnessProperty.value !== "string" ||
      !BACKEND_NAMES.includes(
        harnessProperty.value as (typeof BACKEND_NAMES)[number],
      )
    ) {
      fail(`Task "${id}" has an invalid harness`);
    }
    harness = harnessProperty.value as (typeof BACKEND_NAMES)[number];
  }

  const model = optionalString(
    value,
    "model",
    label,
    MAX_WORKFLOW_TASK_LABEL_BYTES,
  );
  const effortProperty = ownProperty(value, "effort", label);
  let effort: ReasoningEffort | undefined;
  if (effortProperty.present) {
    if (
      typeof effortProperty.value !== "string" ||
      !REASONING_EFFORTS.includes(effortProperty.value as ReasoningEffort)
    ) {
      fail(`Task "${id}" has an invalid effort`);
    }
    effort = effortProperty.value as ReasoningEffort;
  }

  const retryProperty = ownProperty(value, "retry", label);
  const retry = retryProperty.present
    ? normalizeRetry(retryProperty.value, `Task "${id}"`)
    : undefined;

  return {
    id,
    label: taskLabel,
    kind: taskKind,
    prompt,
    ...(needs === undefined ? {} : { needs }),
    ...(consumes === undefined ? {} : { consumes }),
    ...scope,
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(retry === undefined ? {} : { retry }),
  };
}

function normalizeDefinition(value: unknown): ValidatedWorkflowDefinition {
  assertPlainRecord(value, "Workflow definition");
  assertAllowedKeys(value, DEFINITION_KEYS, "Workflow definition");
  const tasksProperty = ownProperty(value, "tasks", "Workflow definition");
  if (!tasksProperty.present)
    fail("Workflow definition must contain a tasks array");
  const rawTasks = arrayValues(
    tasksProperty.value,
    "Workflow definition.tasks",
    MAX_WORKFLOW_TASKS,
  );
  const tasks = rawTasks.map((task, index) => normalizeTask(task, index));
  const name = optionalString(
    value,
    "name",
    "Workflow definition",
    MAX_WORKFLOW_NAME_BYTES,
  );
  const description = optionalString(
    value,
    "description",
    "Workflow definition",
    MAX_WORKFLOW_DESCRIPTION_BYTES,
  );
  const definition: ValidatedWorkflowDefinition = {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    tasks,
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(definition);
  } catch {
    fail("Workflow definition must be JSON serializable");
  }
  if (utf8Bytes(serialized) > MAX_WORKFLOW_DEFINITION_BYTES) {
    fail(
      `Workflow definition exceeds ${MAX_WORKFLOW_DEFINITION_BYTES} UTF-8 bytes`,
    );
  }
  return definition;
}

// immutable index helpers follow
function immutableSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const source = new Set(values);
  let view: ReadonlySet<T>;
  view = {
    get size() {
      return source.size;
    },
    has(value: T): boolean {
      return source.has(value);
    },
    entries(): ReturnType<Set<T>["entries"]> {
      return source.entries();
    },
    keys(): ReturnType<Set<T>["keys"]> {
      return source.keys();
    },
    values(): ReturnType<Set<T>["values"]> {
      return source.values();
    },
    forEach(callbackfn, thisArg): void {
      source.forEach((value) => callbackfn.call(thisArg, value, value, view));
    },
    [Symbol.iterator](): ReturnType<Set<T>["values"]> {
      return source.values();
    },
  };
  return Object.freeze(view);
}

function immutableMap<K, V>(
  entries: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
  const source = new Map(entries);
  let view: ReadonlyMap<K, V>;
  view = {
    get size() {
      return source.size;
    },
    get(key: K): V | undefined {
      return source.get(key);
    },
    has(key: K): boolean {
      return source.has(key);
    },
    entries(): ReturnType<Map<K, V>["entries"]> {
      return source.entries();
    },
    keys(): ReturnType<Map<K, V>["keys"]> {
      return source.keys();
    },
    values(): ReturnType<Map<K, V>["values"]> {
      return source.values();
    },
    forEach(callbackfn, thisArg): void {
      source.forEach((value, key) =>
        callbackfn.call(thisArg, value, key, view),
      );
    },
    [Symbol.iterator](): ReturnType<Map<K, V>["entries"]> {
      return source.entries();
    },
  };
  return Object.freeze(view);
}
function freezeDeep<T>(value: T): T {
  if (!isObject(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) freezeDeep(descriptor.value);
  }
  return value;
}

function pathContained(container: string, candidate: string): boolean {
  return container === candidate || candidate.startsWith(`${container}/`);
}

/** Segment-aware containment; `src/app` does not contain `src/application`. */
export function isOwnedPathContained(
  container: string,
  candidate: string,
): boolean {
  return pathContained(container, candidate);
}

export function ownedPathsOverlap(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return left.some((leftPath) =>
    right.some(
      (rightPath) =>
        pathContained(leftPath, rightPath) ||
        pathContained(rightPath, leftPath),
    ),
  );
}

function findCycle(
  declarationOrder: ReadonlyArray<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<string> | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): ReadonlyArray<string> | undefined => {
    const current = state.get(id);
    if (current === 2) return undefined;
    if (current === 1) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 1);
    stack.push(id);
    for (const dependencyId of dependencies.get(id) ?? []) {
      const cycle = visit(dependencyId);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of declarationOrder) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

function ancestorsOf(
  id: string,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  cache: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const cached = cache.get(id);
  if (cached) return cached;
  const ancestors = new Set<string>();
  for (const dependencyId of dependencies.get(id) ?? []) {
    ancestors.add(dependencyId);
    for (const ancestor of ancestorsOf(dependencyId, dependencies, cache)) {
      ancestors.add(ancestor);
    }
  }
  cache.set(id, ancestors);
  return ancestors;
}

function validateGraph(
  definition: ValidatedWorkflowDefinition,
): ValidatedWorkflowGraph {
  const declarationOrder = definition.tasks.map((task) => task.id);
  const tasksById = new Map<string, WorkflowTaskDefinition>();
  for (const task of definition.tasks) {
    if (tasksById.has(task.id)) fail(`Duplicate workflow task "${task.id}"`);
    tasksById.set(task.id, task);
  }

  const dependencies = new Map<string, ReadonlySet<string>>();
  for (const task of definition.tasks) {
    const values = new Set(task.needs ?? []);
    for (const dependencyId of values) {
      if (!tasksById.has(dependencyId)) {
        fail(`Task "${task.id}" depends on unknown task "${dependencyId}"`);
      }
      if (dependencyId === task.id) {
        fail(`Task "${task.id}" cannot depend on itself`);
      }
    }
    dependencies.set(task.id, values);
  }

  const cycle = findCycle(declarationOrder, dependencies);
  if (cycle) fail(`Workflow task dependency cycle: ${cycle.join(" -> ")}`);

  const dependants = new Map<string, Set<string>>();
  for (const id of declarationOrder) dependants.set(id, new Set());
  for (const [taskId, needs] of dependencies) {
    for (const dependencyId of needs) dependants.get(dependencyId)!.add(taskId);
  }

  const transitiveDependencies = new Map<string, ReadonlySet<string>>();
  for (const id of declarationOrder) {
    ancestorsOf(id, dependencies, transitiveDependencies);
  }

  for (const task of definition.tasks) {
    for (const consumedId of task.consumes ?? []) {
      if (consumedId === task.id) {
        fail(`Task "${task.id}" cannot consume itself`);
      }
      if (!tasksById.has(consumedId)) {
        fail(`Task "${task.id}" consumes unknown task "${consumedId}"`);
      }
      if (!transitiveDependencies.get(task.id)!.has(consumedId)) {
        fail(
          `Task "${task.id}" consumes "${consumedId}" without a dependency path`,
        );
      }
    }
  }

  const writers = definition.tasks.filter(
    (
      task,
    ): task is WorkflowTaskDefinition & {
      readonly owns: ReadonlyArray<string>;
    } => "owns" in task,
  );
  for (let leftIndex = 0; leftIndex < writers.length; leftIndex++) {
    const left = writers[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < writers.length;
      rightIndex++
    ) {
      const right = writers[rightIndex]!;
      if (!ownedPathsOverlap(left.owns, right.owns)) continue;
      const ordered =
        transitiveDependencies.get(left.id)!.has(right.id) ||
        transitiveDependencies.get(right.id)!.has(left.id);
      if (!ordered) {
        fail(
          `Tasks "${left.id}" and "${right.id}" have overlapping owned paths without dependency order`,
        );
      }
    }
  }

  const frozenDefinition = freezeDeep(definition);
  const immutableDependencies = immutableMap(
    [...dependencies].map(
      ([taskId, values]) => [taskId, immutableSet(values)] as const,
    ),
  );
  const immutableDependants = immutableMap(
    [...dependants].map(
      ([taskId, values]) => [taskId, immutableSet(values)] as const,
    ),
  );
  const immutableTransitiveDependencies = immutableMap(
    [...transitiveDependencies].map(
      ([taskId, values]) => [taskId, immutableSet(values)] as const,
    ),
  );
  return Object.freeze({
    definition: frozenDefinition,
    declarationOrder: Object.freeze([...declarationOrder]),
    tasksById: immutableMap(tasksById),
    dependencies: immutableDependencies,
    dependants: immutableDependants,
    transitiveDependencies: immutableTransitiveDependencies,
  });
}

/** Build a complete immutable graph; no caller may bypass graph invariants. */
export function buildWorkflowGraph(value: unknown): ValidatedWorkflowGraph {
  try {
    return validateGraph(normalizeDefinition(value));
  } catch (error) {
    if (error instanceof WorkflowGraphValidationError) throw error;
    throw new WorkflowGraphValidationError(
      `Workflow graph validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Validate and return the normalized definition used by drafts and managers. */
export function validateWorkflowDefinition(
  value: unknown,
): ValidatedWorkflowDefinition {
  return buildWorkflowGraph(value).definition;
}

/** Assertion-shaped alias for callers that only need the fail-closed boundary. */
export function assertWorkflowDefinition(
  value: unknown,
): ValidatedWorkflowDefinition {
  return validateWorkflowDefinition(value);
}

/** Return whether two tasks are ordered by a dependency path in either direction. */
export function areTasksOrdered(
  graph: ValidatedWorkflowGraph,
  leftTaskId: string,
  rightTaskId: string,
): boolean {
  assertPlainRecord(graph, "Workflow graph");
  const definition = ownProperty(graph, "definition", "Workflow graph");
  if (!definition.present) fail("Workflow graph.definition is required");
  const trustedGraph = buildWorkflowGraph(definition.value);
  return (
    trustedGraph.transitiveDependencies.get(leftTaskId)?.has(rightTaskId) ===
      true ||
    trustedGraph.transitiveDependencies.get(rightTaskId)?.has(leftTaskId) ===
      true
  );
}

export const validateWorkflowGraph = buildWorkflowGraph;
export const createWorkflowGraph = buildWorkflowGraph;
