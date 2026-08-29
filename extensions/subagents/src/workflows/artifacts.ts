/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This module is the untrusted, bounded JSON/file boundary for workflow journals. */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertSafeWorkflowRunId,
  boundWorkflowEvent,
  MAX_WORKFLOW_ARTIFACT_BYTES,
  MAX_WORKFLOW_EVENTS,
  type WorkflowEvent,
  utf8Bytes,
} from "./events.ts";
import { foldWorkflowEvents } from "./reducer.ts";
export const WORKFLOW_RUNS_NAMESPACE = "runs";
export const WORKFLOW_RUN_JOURNAL_FILE = "journal.json";
export const WORKFLOW_RUN_DIRECTORY_MODE = 0o700;
export const WORKFLOW_RUN_FILE_MODE = 0o600;
export const MAX_WORKFLOW_ARTIFACT_FAILURES = 64;
export const MAX_WORKFLOW_ARTIFACT_FAILURE_BYTES = 2 * 1024;
export const MAX_WORKFLOW_SCANNED_ENTRIES = 256;

export interface WorkflowArtifactStoreOptions {
  /** The workflow-owned directory; drafts remain in its separate drafts tree. */
  readonly workflowsDir?: string;
  /** Project whose runs this store is allowed to read or write. */
  readonly cwd?: string;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
  /** Bounds directory iteration before any artifact parsing or recovery work. */
  readonly maxScanEntries?: number;
  /** Test seam for forcing a deterministic temporary-file name. */
  readonly createTempId?: () => string;
}

export interface WorkflowArtifactDescriptor {
  readonly runId: string;
  readonly path: string;
}

export interface WorkflowArtifactScanFailure {
  readonly runId?: string;
  readonly path: string;
  readonly message: string;
}

export interface WorkflowArtifactScan {
  readonly artifacts: ReadonlyArray<WorkflowArtifactDescriptor>;
  readonly failures: ReadonlyArray<WorkflowArtifactScanFailure>;
}

export class WorkflowArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowArtifactError";
  }
}

export class WorkflowArtifactBoundsError extends WorkflowArtifactError {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowArtifactBoundsError";
  }
}

export class WorkflowArtifactPathError extends WorkflowArtifactError {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowArtifactPathError";
  }
}
export interface WorkflowRunArtifactStore {
  readonly workflowsDir: string;
  readonly cwd: string;
  readonly runsDir: string;
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly matchesCwd?: (cwd: string) => boolean;
  journalPath(runId: string): string;
  create(runId: string, events: ReadonlyArray<WorkflowEvent>): void;
  replace(runId: string, events: ReadonlyArray<WorkflowEvent>): void;
  load(runId: string): ReadonlyArray<WorkflowEvent>;
  scan(): WorkflowArtifactScan;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateFailure(message);
}

function truncateFailure(message: string): string {
  const clean = message.replace(/[\r\n]+/gu, " ").trim();
  return clean.length > MAX_WORKFLOW_ARTIFACT_FAILURE_BYTES
    ? `${clean.slice(0, MAX_WORKFLOW_ARTIFACT_FAILURE_BYTES - 1)}…`
    : clean;
}

function absoluteDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved)) {
    throw new WorkflowArtifactPathError(`${label} must be absolute.`);
  }
  return resolved;
}
/** Canonicalize an existing parent so platform aliases such as /var do not
 * make an otherwise private namespace unusable, while rejecting a symlink at
 * the configured directory itself. */
function canonicalDirectoryTarget(value: string, label: string): string {
  const resolved = absoluteDirectory(value, label);
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkflowArtifactPathError(
        `${label} must be a non-symlink directory.`,
      );
    }
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  const missing: string[] = [];
  let existing = resolved;
  while (true) {
    try {
      const stat = fs.lstatSync(existing);
      if (!stat.isDirectory()) {
        throw new WorkflowArtifactPathError(
          `${label} parent is not a directory: ${existing}`,
        );
      }
      const canonical = fs.realpathSync.native(existing);
      return path.join(canonical, ...missing);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new WorkflowArtifactPathError(
          `Could not find a parent for ${label}.`,
        );
      }
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function canonicalProjectCwd(value: string): string {
  const resolved = absoluteDirectory(value, "Workflow cwd");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw new WorkflowArtifactPathError(
      `Workflow cwd is not available: ${failureMessage(error)}`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorkflowArtifactPathError(
      "Workflow cwd must be a non-symlink directory.",
    );
  }
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    throw new WorkflowArtifactPathError(
      `Workflow cwd cannot be canonicalized: ${failureMessage(error)}`,
    );
  }
}

function pathSegments(absolute: string): ReadonlyArray<string> {
  const parsed = path.parse(absolute);
  const segments: string[] = [];
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    segments.push(current);
  }
  return segments;
}

/** Check every existing component instead of allowing a symlinked namespace. */
function checkDirectoryTree(
  directory: string,
  create: boolean,
  label: string,
): boolean {
  const absolute = absoluteDirectory(directory, label);
  for (const current of pathSegments(absolute)) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!isErrno(error, "ENOENT") || !create) {
        if (isErrno(error, "ENOENT") && !create) return false;
        throw new WorkflowArtifactPathError(
          `Could not inspect ${label}: ${failureMessage(error)}`,
        );
      }
      try {
        fs.mkdirSync(current, { mode: WORKFLOW_RUN_DIRECTORY_MODE });
        stat = fs.lstatSync(current);
      } catch (mkdirError) {
        throw new WorkflowArtifactPathError(
          `Could not create ${label}: ${failureMessage(mkdirError)}`,
        );
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkflowArtifactPathError(
        `${label} contains a non-directory or symlink: ${current}`,
      );
    }
    if (create && current === absolute) {
      try {
        fs.chmodSync(current, WORKFLOW_RUN_DIRECTORY_MODE);
      } catch (error) {
        throw new WorkflowArtifactPathError(
          `Could not set ${label} permissions: ${failureMessage(error)}`,
        );
      }
    }
  }
  return true;
}

function assertPrivateFile(stat: fs.Stats, file: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WorkflowArtifactPathError(
      `Workflow journal is not a regular file: ${file}`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new WorkflowArtifactPathError(
      `Workflow journal has non-private permissions: ${file}`,
    );
  }
}

function safeRunId(runId: string): string {
  try {
    assertSafeWorkflowRunId(runId);
  } catch (error) {
    throw new WorkflowArtifactPathError(
      `Invalid workflow run id: ${failureMessage(error)}`,
    );
  }
  return runId;
}

function projectKey(cwd: string): string {
  return `project-${createHash("sha256").update(cwd, "utf8").digest("hex")}`;
}

function projectDirectory(workflowsDir: string, cwd: string): string {
  return path.join(
    absoluteDirectory(workflowsDir, "Workflow directory"),
    WORKFLOW_RUNS_NAMESPACE,
    projectKey(cwd),
  );
}

function workflowRunsDirectory(workflowsDir: string): string {
  return path.join(
    absoluteDirectory(workflowsDir, "Workflow directory"),
    WORKFLOW_RUNS_NAMESPACE,
  );
}

/**
 * Return the new namespaced path. The project hash prevents collisions between
 * projects and the `runs` segment stays separate from old workflow artifacts.
 */
function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowArtifactBoundsError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkflowArtifactBoundsError(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowedSet.has(key)) {
      throw new WorkflowArtifactBoundsError(
        `${label} contains unsupported field "${key}".`,
      );
    }
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string") {
    throw new WorkflowArtifactBoundsError(`${label}.${key} must be a string.`);
  }
  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return requiredString(value, key, label);
}

function requiredNumber(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const candidate = value[key];
  if (
    typeof candidate !== "number" ||
    !Number.isFinite(candidate) ||
    candidate < 0
  ) {
    throw new WorkflowArtifactBoundsError(
      `${label}.${key} must be a finite non-negative number.`,
    );
  }
  return candidate;
}

function optionalField(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** Validate the JSON shape before invoking the typed event bounder. */
function parseEvent(value: unknown, index: number): WorkflowEvent {
  const record = assertRecord(value, `Workflow event ${index + 1}`);
  const label = `Workflow event ${index + 1}`;
  const tag = requiredString(record, "_tag", label);
  const runId = requiredString(record, "runId", label);
  assertSafeWorkflowRunId(runId);
  const at = requiredNumber(record, "at", label);
  switch (tag) {
    case "WorkflowCreated":
      assertKeys(record, ["_tag", "runId", "at", "definition"], label);
      return boundWorkflowEvent({
        _tag: "WorkflowCreated",
        runId,
        at,
        // SAFETY: the record is immediately validated by boundWorkflowEvent and foldWorkflowEvents.
        definition: optionalField(record, "definition") as never,
      });
    case "WorkflowStarted":
      assertKeys(record, ["_tag", "runId", "at"], label);
      return boundWorkflowEvent({ _tag: "WorkflowStarted", runId, at });
    case "WorkflowPaused":
      assertKeys(record, ["_tag", "runId", "at", "reason"], label);
      return boundWorkflowEvent({
        _tag: "WorkflowPaused",
        runId,
        at,
        reason: optionalString(record, "reason", label),
      });
    case "WorkflowResumed":
      assertKeys(record, ["_tag", "runId", "at"], label);
      return boundWorkflowEvent({ _tag: "WorkflowResumed", runId, at });
    case "TaskQueued":
      assertKeys(
        record,
        ["_tag", "runId", "at", "taskId", "childId", "attemptId"],
        label,
      );
      return boundWorkflowEvent({
        _tag: "TaskQueued",
        runId,
        at,
        taskId: requiredString(record, "taskId", label),
        childId: requiredString(record, "childId", label),
        attemptId: optionalString(record, "attemptId", label),
      });
    case "TaskStarted":
      assertKeys(record, ["_tag", "runId", "at", "taskId", "attemptId"], label);
      return boundWorkflowEvent({
        _tag: "TaskStarted",
        runId,
        at,
        taskId: requiredString(record, "taskId", label),
        attemptId: optionalString(record, "attemptId", label),
      });
    case "TaskCompleted":
      assertKeys(
        record,
        ["_tag", "runId", "at", "taskId", "resultPreview", "attemptId"],
        label,
      );
      return boundWorkflowEvent({
        _tag: "TaskCompleted",
        runId,
        at,
        taskId: requiredString(record, "taskId", label),
        resultPreview: optionalString(record, "resultPreview", label),
        attemptId: optionalString(record, "attemptId", label),
      });
    case "TaskFailed":
      assertKeys(
        record,
        ["_tag", "runId", "at", "taskId", "error", "failureKind", "attemptId"],
        label,
      );
      return boundWorkflowEvent({
        _tag: "TaskFailed",
        runId,
        at,
        taskId: requiredString(record, "taskId", label),
        error: requiredString(record, "error", label),
        failureKind: optionalField(record, "failureKind") as
          "provider_stall" | "backend_failure" | undefined,
        attemptId: optionalString(record, "attemptId", label),
      });
    case "TaskCancelled":
      assertKeys(
        record,
        ["_tag", "runId", "at", "taskId", "reason", "attemptId"],
        label,
      );
      return boundWorkflowEvent({
        _tag: "TaskCancelled",
        runId,
        at,
        taskId: requiredString(record, "taskId", label),
        reason: requiredString(record, "reason", label),
        attemptId: optionalString(record, "attemptId", label),
      });
    case "TaskRetryRequested":
      assertKeys(
        record,
        [
          "_tag",
          "runId",
          "at",
          "taskId",
          "attemptId",
          "previousAttemptId",
          "mode",
          "failureKind",
          "reason",
        ],
        label,
      );
      return boundWorkflowEvent({
        _tag: "TaskRetryRequested",
        runId,
        at,
        taskId: requiredString(record, "taskId", label),
        attemptId: optionalString(record, "attemptId", label),
        previousAttemptId: optionalString(record, "previousAttemptId", label),
        mode: optionalField(record, "mode") as
          "explicit" | "automatic" | undefined,
        failureKind: optionalField(record, "failureKind") as
          "provider_stall" | "backend_failure" | undefined,
        reason: optionalString(record, "reason", label),
      });
    case "TaskSkipped":
      assertKeys(
        record,
        [
          "_tag",
          "runId",
          "at",
          "taskId",
          "reason",
          "attemptId",
          "skippedByTaskId",
        ],
        label,
      );
      return boundWorkflowEvent({
        _tag: "TaskSkipped",
        runId,
        at,
        taskId: requiredString(record, "taskId", label),
        reason: requiredString(record, "reason", label),
        attemptId: optionalString(record, "attemptId", label),
        skippedByTaskId: optionalString(record, "skippedByTaskId", label),
      });
    case "WorkflowCompleted":
      assertKeys(record, ["_tag", "runId", "at", "summary"], label);
      return boundWorkflowEvent({
        _tag: "WorkflowCompleted",
        runId,
        at,
        summary: optionalString(record, "summary", label),
      });
    case "WorkflowFailed":
      assertKeys(record, ["_tag", "runId", "at", "error", "recovery"], label);
      return boundWorkflowEvent({
        _tag: "WorkflowFailed",
        runId,
        at,
        error: requiredString(record, "error", label),
        recovery: optionalField(record, "recovery") as
          "orphaned" | "interrupted" | undefined,
      });
    case "WorkflowCancelled":
      assertKeys(record, ["_tag", "runId", "at", "reason"], label);
      return boundWorkflowEvent({
        _tag: "WorkflowCancelled",
        runId,
        at,
        reason: requiredString(record, "reason", label),
      });
    case "WorkflowLogAdded":
      assertKeys(record, ["_tag", "runId", "at", "level", "message"], label);
      return boundWorkflowEvent({
        _tag: "WorkflowLogAdded",
        runId,
        at,
        level: optionalField(record, "level") as "info" | "warning" | "error",
        message: requiredString(record, "message", label),
      });
    default:
      throw new WorkflowArtifactBoundsError(
        `Workflow event ${index + 1} has an unknown tag.`,
      );
  }
}

export interface WorkflowJournalSerializationOptions {
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

export function serializeWorkflowJournal(
  events: ReadonlyArray<WorkflowEvent>,
  options: WorkflowJournalSerializationOptions = {},
): string {
  const maxEvents = options.maxEvents ?? MAX_WORKFLOW_EVENTS;
  const maxBytes = options.maxBytes ?? MAX_WORKFLOW_ARTIFACT_BYTES;
  if (
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1 ||
    maxEvents > MAX_WORKFLOW_EVENTS
  ) {
    throw new WorkflowArtifactBoundsError(
      "Invalid workflow journal event bound.",
    );
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_WORKFLOW_ARTIFACT_BYTES
  ) {
    throw new WorkflowArtifactBoundsError(
      "Invalid workflow journal byte bound.",
    );
  }
  if (events.length === 0) {
    throw new WorkflowArtifactBoundsError("Workflow journal cannot be empty.");
  }
  if (events.length > maxEvents) {
    throw new WorkflowArtifactBoundsError(
      `Workflow journal is limited to ${maxEvents} events.`,
    );
  }
  const bounded: WorkflowEvent[] = [];
  for (const event of events) {
    const normalized = boundWorkflowEvent(event);
    safeRunId(normalized.runId);
    bounded.push(normalized);
  }
  try {
    foldWorkflowEvents(bounded);
  } catch (error) {
    throw new WorkflowArtifactBoundsError(
      `Workflow journal contains invalid state: ${failureMessage(error)}`,
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(bounded);
  } catch (error) {
    throw new WorkflowArtifactBoundsError(
      `Workflow journal is not JSON serializable: ${failureMessage(error)}`,
    );
  }
  if (utf8Bytes(serialized) > maxBytes) {
    throw new WorkflowArtifactBoundsError(
      `Workflow journal exceeds ${maxBytes} UTF-8 bytes.`,
    );
  }
  return serialized;
}

export interface WorkflowJournalParseOptions {
  readonly expectedRunId?: string;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

export function parseWorkflowJournal(
  serialized: string,
  options: WorkflowJournalParseOptions = {},
): ReadonlyArray<WorkflowEvent> {
  const maxEvents = options.maxEvents ?? MAX_WORKFLOW_EVENTS;
  const maxBytes = options.maxBytes ?? MAX_WORKFLOW_ARTIFACT_BYTES;
  if (typeof serialized !== "string") {
    throw new WorkflowArtifactBoundsError(
      "Workflow journal must be UTF-8 text.",
    );
  }
  if (utf8Bytes(serialized) > maxBytes) {
    throw new WorkflowArtifactBoundsError(
      `Workflow journal exceeds ${maxBytes} UTF-8 bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new WorkflowArtifactBoundsError(
      `Workflow journal is not valid JSON: ${failureMessage(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new WorkflowArtifactBoundsError("Workflow journal must be an array.");
  }
  if (parsed.length === 0 || parsed.length > maxEvents) {
    throw new WorkflowArtifactBoundsError(
      `Workflow journal must contain between 1 and ${maxEvents} events.`,
    );
  }
  const events = parsed.map((value, index) => parseEvent(value, index));
  const state = foldWorkflowEvents(events);
  if (options.expectedRunId !== undefined) {
    safeRunId(options.expectedRunId);
    if (state.id !== options.expectedRunId) {
      throw new WorkflowArtifactPathError(
        "Workflow journal ID does not match its artifact path.",
      );
    }
  }
  return Object.freeze(events);
}

function directoryModeIsPrivate(directory: string): boolean {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  return (stat.mode & 0o077) === 0;
}

function readJournalFile(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const noFollow =
      (fs.constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    assertPrivateFile(stat, file);
    // Read one byte beyond the contract instead of trusting a racy stat size.
    // This bounds both the allocation and the bytes consumed if the file is
    // replaced or grows after open.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (read === 0) break;
      offset += read;
    }
    if (offset > maxBytes) {
      throw new WorkflowArtifactBoundsError(
        `Workflow journal exceeds ${maxBytes} bytes.`,
      );
    }
    return buffer.subarray(0, offset).toString("utf8");
  } catch (error) {
    if (error instanceof WorkflowArtifactError) throw error;
    throw new WorkflowArtifactError(
      `Could not read workflow journal ${file}: ${failureMessage(error)}`,
    );
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original read/parse error and never mutate the journal.
      }
    }
  }
}

export class WorkflowArtifactStore implements WorkflowRunArtifactStore {
  readonly workflowsDir: string;
  readonly cwd: string;
  readonly runsDir: string;
  readonly maxEvents: number;
  readonly maxBytes: number;
  private readonly projectDir: string;
  private readonly createTempId: () => string;
  private readonly maxScanEntries: number;

  constructor(options: WorkflowArtifactStoreOptions) {
    const root = options.workflowsDir;
    if (root === undefined) {
      throw new WorkflowArtifactPathError(
        "Workflow artifact store requires workflowsDir.",
      );
    }
    this.workflowsDir = canonicalDirectoryTarget(root, "Workflow directory");
    this.cwd = canonicalProjectCwd(options.cwd ?? process.cwd());
    this.runsDir = workflowRunsDirectory(this.workflowsDir);
    this.projectDir = projectDirectory(this.workflowsDir, this.cwd);
    this.maxEvents = options.maxEvents ?? MAX_WORKFLOW_EVENTS;
    this.maxBytes = options.maxBytes ?? MAX_WORKFLOW_ARTIFACT_BYTES;
    this.maxScanEntries =
      options.maxScanEntries ?? MAX_WORKFLOW_SCANNED_ENTRIES;
    if (
      !Number.isSafeInteger(this.maxEvents) ||
      this.maxEvents < 1 ||
      this.maxEvents > MAX_WORKFLOW_EVENTS
    ) {
      throw new WorkflowArtifactBoundsError(
        "Invalid workflow artifact event bound.",
      );
    }
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > MAX_WORKFLOW_ARTIFACT_BYTES
    ) {
      throw new WorkflowArtifactBoundsError(
        "Invalid workflow artifact byte bound.",
      );
    }
    if (
      !Number.isSafeInteger(this.maxScanEntries) ||
      this.maxScanEntries < 1 ||
      this.maxScanEntries > MAX_WORKFLOW_SCANNED_ENTRIES
    ) {
      throw new WorkflowArtifactBoundsError(
        "Invalid workflow artifact scan entry bound.",
      );
    }
    this.createTempId = options.createTempId ?? randomUUID;
  }

  matchesCwd(cwd: string): boolean {
    try {
      return canonicalProjectCwd(cwd) === this.cwd;
    } catch {
      return false;
    }
  }

  journalPath(runId: string): string {
    safeRunId(runId);
    return path.join(this.projectDir, runId, WORKFLOW_RUN_JOURNAL_FILE);
  }

  create(runId: string, events: ReadonlyArray<WorkflowEvent>): void {
    this.write(runId, events, true);
  }

  replace(runId: string, events: ReadonlyArray<WorkflowEvent>): void {
    this.write(runId, events, false);
  }

  load(runId: string): ReadonlyArray<WorkflowEvent> {
    const file = this.journalPath(runId);
    try {
      checkDirectoryTree(this.workflowsDir, false, "Workflow directory");
      checkDirectoryTree(this.runsDir, false, "Workflow runs namespace");
      checkDirectoryTree(this.projectDir, false, "Workflow project namespace");
      const runDir = path.dirname(file);
      if (!checkDirectoryTree(runDir, false, "Workflow run directory")) {
        throw new WorkflowArtifactPathError(
          `Workflow run artifact does not exist: ${runId}`,
        );
      }
      const stat = fs.lstatSync(file);
      assertPrivateFile(stat, file);
      const text = readJournalFile(file, this.maxBytes);
      return parseWorkflowJournal(text, {
        expectedRunId: runId,
        maxEvents: this.maxEvents,
        maxBytes: this.maxBytes,
      });
    } catch (error) {
      if (error instanceof WorkflowArtifactError) throw error;
      throw new WorkflowArtifactError(
        `Could not load workflow run ${runId}: ${failureMessage(error)}`,
      );
    }
  }

  scan(): WorkflowArtifactScan {
    const artifacts: WorkflowArtifactDescriptor[] = [];
    const failures: WorkflowArtifactScanFailure[] = [];
    const addFailure = (file: string, error: unknown, runId?: string): void => {
      if (failures.length >= MAX_WORKFLOW_ARTIFACT_FAILURES) return;
      failures.push({ runId, path: file, message: failureMessage(error) });
    };
    try {
      if (!checkDirectoryTree(this.workflowsDir, false, "Workflow directory")) {
        return { artifacts, failures };
      }
      if (!directoryModeIsPrivate(this.workflowsDir)) {
        addFailure(
          this.workflowsDir,
          new WorkflowArtifactPathError("directory is not private"),
        );
        return { artifacts, failures };
      }
      if (!checkDirectoryTree(this.runsDir, false, "Workflow runs namespace")) {
        return { artifacts, failures };
      }
      if (!directoryModeIsPrivate(this.runsDir)) {
        addFailure(
          this.runsDir,
          new WorkflowArtifactPathError("directory is not private"),
        );
        return { artifacts, failures };
      }
      if (
        !checkDirectoryTree(
          this.projectDir,
          false,
          "Workflow project namespace",
        )
      ) {
        return { artifacts, failures };
      }
      if (!directoryModeIsPrivate(this.projectDir)) {
        addFailure(
          this.projectDir,
          new WorkflowArtifactPathError("directory is not private"),
        );
        return { artifacts, failures };
      }
      const entries: fs.Dirent[] = [];
      const directory = fs.opendirSync(this.projectDir);
      let scanTruncated = false;
      try {
        for (let index = 0; index < this.maxScanEntries; index++) {
          const entry = directory.readSync();
          if (entry === null) break;
          entries.push(entry);
        }
        scanTruncated = directory.readSync() !== null;
      } finally {
        directory.closeSync();
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const runPath = path.join(this.projectDir, entry.name);
        try {
          safeRunId(entry.name);
          const runStat = fs.lstatSync(runPath);
          if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
            throw new WorkflowArtifactPathError("run entry is not a directory");
          }
          if ((runStat.mode & 0o077) !== 0) {
            throw new WorkflowArtifactPathError("run directory is not private");
          }
          const journal = path.join(runPath, WORKFLOW_RUN_JOURNAL_FILE);
          const journalStat = fs.lstatSync(journal);
          assertPrivateFile(journalStat, journal);
          artifacts.push({ runId: entry.name, path: journal });
        } catch (error) {
          addFailure(runPath, error, entry.name);
        }
      }
      if (scanTruncated) {
        addFailure(
          this.projectDir,
          new WorkflowArtifactBoundsError(
            `Workflow artifact scan is limited to ${this.maxScanEntries} entries.`,
          ),
        );
      }
    } catch (error) {
      addFailure(this.projectDir, error);
    }
    artifacts.sort((left, right) => left.runId.localeCompare(right.runId));
    return {
      artifacts: Object.freeze(artifacts),
      failures: Object.freeze(failures),
    };
  }

  private write(
    runId: string,
    events: ReadonlyArray<WorkflowEvent>,
    exclusive: boolean,
  ): void {
    const file = this.journalPath(runId);
    const serialized = serializeWorkflowJournal(events, {
      maxEvents: this.maxEvents,
      maxBytes: this.maxBytes,
    });
    const runDir = path.dirname(file);
    checkDirectoryTree(this.workflowsDir, true, "Workflow directory");
    checkDirectoryTree(this.runsDir, true, "Workflow runs namespace");
    checkDirectoryTree(this.projectDir, true, "Workflow project namespace");
    checkDirectoryTree(runDir, true, "Workflow run directory");

    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(file);
      assertPrivateFile(existing, file);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (exclusive && existing !== undefined) {
      throw new WorkflowArtifactPathError(
        `Workflow run artifact already exists: ${runId}`,
      );
    }
    if (!exclusive && existing === undefined) {
      throw new WorkflowArtifactPathError(
        `Workflow run artifact does not exist: ${runId}`,
      );
    }

    const temp = path.join(
      runDir,
      `.${WORKFLOW_RUN_JOURNAL_FILE}.${this.createTempId()}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        temp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        WORKFLOW_RUN_FILE_MODE,
      );
      fs.writeFileSync(fd, serialized, { encoding: "utf8" });
      fs.chmodSync(temp, WORKFLOW_RUN_FILE_MODE);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      // Recheck immediately before rename so a symlink cannot be replaced by
      // following it. Rename replaces the directory entry, never its target.
      let current: fs.Stats | undefined;
      try {
        current = fs.lstatSync(file);
        assertPrivateFile(current, file);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
      if (exclusive && current !== undefined) {
        throw new WorkflowArtifactPathError(
          `Workflow run artifact already exists: ${runId}`,
        );
      }
      if (!exclusive && current === undefined) {
        throw new WorkflowArtifactPathError(
          `Workflow run artifact disappeared: ${runId}`,
        );
      }
      fs.renameSync(temp, file);
      try {
        const directoryFd = fs.openSync(runDir, fs.constants.O_RDONLY);
        try {
          fs.fsyncSync(directoryFd);
        } finally {
          fs.closeSync(directoryFd);
        }
      } catch {
        // The file replacement is already atomic and private. Directory fsync
        // is best effort on platforms that do not permit opening directories.
      }
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Preserve the write failure.
        }
      }
      try {
        fs.unlinkSync(temp);
      } catch {
        // A failed write must never remove the prior destination.
      }
      if (error instanceof WorkflowArtifactError) throw error;
      throw new WorkflowArtifactError(
        `Could not atomically write workflow run ${runId}: ${failureMessage(error)}`,
      );
    }
  }
}
