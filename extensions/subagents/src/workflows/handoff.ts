/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread -- Handoffs are an explicit allowlisted projection of untrusted child results; transcript and native-session fields are never copied. */
import { isProxy } from "node:util/types";
import { truncateUtf8, utf8Bytes } from "./events.ts";

/**
 * Handoff policy: four UTF-8 bytes count as one conservative estimated token.
 * There is intentionally no model-specific tokenizer in this boundary, so the
 * same input always receives the same byte/token decision on every backend.
 */
export const MAX_HANDOFF_BYTES = 16 * 1024;
export const MAX_HANDOFF_TOKENS = 4 * 1024;
export const MAX_HANDOFF_TOTAL_BYTES = 1 * 1024 * 1024;
export const MAX_HANDOFF_TOTAL_TOKENS = Math.ceil(MAX_HANDOFF_TOTAL_BYTES / 4);
export const MAX_HANDOFF_LABEL_BYTES = 512;
export const MAX_HANDOFF_TASK_ID_BYTES = 128;
export const MAX_HANDOFF_CONSUMED_RESULTS = 128;
export const MAX_HANDOFF_SANITIZE_DEPTH = 8;
export const MAX_HANDOFF_SANITIZE_NODES = 1_024;
export const MAX_HANDOFF_SANITIZE_ARRAY_ITEMS = 1_024;
export const MAX_HANDOFF_SANITIZE_PROPERTIES = 4_096;
export const MAX_HANDOFF_SANITIZE_STRING_BYTES = 64 * 1_024;
export const MAX_HANDOFF_SANITIZE_OUTPUT_BYTES = 64 * 1_024;

export const WORKFLOW_HANDOFF_BEGIN = "<workflow-handoff>";
export const WORKFLOW_HANDOFF_END = "</workflow-handoff>";
export const HANDOFF_BEGIN = WORKFLOW_HANDOFF_BEGIN;
export const HANDOFF_END = WORKFLOW_HANDOFF_END;

export class WorkflowHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowHandoffError";
  }
}

export interface HandoffTask {
  readonly id: string;
  readonly label?: string;
  readonly consumes?: ReadonlyArray<string>;
}

export type HandoffTaskStatus =
  | "declared"
  | "blocked"
  | "ready"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

/** Only these fields can cross the task boundary. `transcript` is ignored. */
export interface CompletedHandoffResult {
  readonly status: HandoffTaskStatus;
  readonly output?: unknown;
  readonly result?: unknown;
  readonly label?: string;
  /** Opaque references are identifiers, never native filesystem paths. */
  readonly artifactRef?: string;
  readonly sessionRef?: string;
  readonly artifactId?: string;
  readonly sessionId?: string;
  readonly transcript?: unknown;
  readonly sessionFilePath?: unknown;
  readonly artifactPath?: unknown;
  readonly nativePath?: unknown;
}

export type HandoffResultMap =
  | ReadonlyMap<string, CompletedHandoffResult>
  | Readonly<Record<string, CompletedHandoffResult>>;

export interface WorkflowHandoffOptions {
  /** Per-consumed-result UTF-8 bound, including its labeled JSON envelope. */
  readonly maxBytes?: number;
  /** Per-consumed-result conservative token bound. */
  readonly maxTokens?: number;
  /** Aggregate bound for the complete delimited prompt-data block. */
  readonly maxTotalBytes?: number;
  readonly maxTotalTokens?: number;
}

export interface WorkflowHandoffEntry {
  readonly taskId: string;
  readonly label: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly reference?: string;
  readonly bytes: number;
  readonly tokens: number;
}

export interface WorkflowHandoff {
  readonly text: string;
  readonly entries: ReadonlyArray<WorkflowHandoffEntry>;
  readonly bytes: number;
  readonly tokens: number;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

interface PresentValue {
  readonly present: boolean;
  readonly value: unknown;
}

function ownDataProperty(
  value: object,
  key: string,
  label: string,
): PresentValue {
  if (isProxy(value)) {
    throw new WorkflowHandoffError(`${label} cannot be a proxy`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new WorkflowHandoffError(`${label}.${key} cannot be inspected`);
  }
  if (descriptor === undefined) return { present: false, value: undefined };
  if (!("value" in descriptor)) {
    throw new WorkflowHandoffError(
      `${label}.${key} cannot be a getter or setter`,
    );
  }
  return { present: true, value: descriptor.value };
}

function optionalStringProperty(
  value: object,
  key: string,
  label: string,
): string | undefined {
  const property = ownDataProperty(value, key, label);
  if (!property.present || property.value === undefined) return undefined;
  return typeof property.value === "string" ? property.value : undefined;
}

interface NormalizedHandoffTask {
  readonly id: string;
  readonly label?: string;
  readonly consumes: ReadonlyArray<string>;
}

function boundedText(value: string, maxBytes: number): boolean {
  return value.length <= maxBytes && utf8Bytes(value) <= maxBytes;
}

function normalizeHandoffTask(task: HandoffTask): NormalizedHandoffTask {
  if (!isObject(task)) {
    throw new WorkflowHandoffError("Handoff task must be an object");
  }
  const idProperty = ownDataProperty(task, "id", "Handoff task");
  if (
    typeof idProperty.value !== "string" ||
    idProperty.value.length === 0 ||
    !boundedText(idProperty.value, MAX_HANDOFF_TASK_ID_BYTES)
  ) {
    throw new WorkflowHandoffError(
      "Handoff task requires a bounded non-empty id",
    );
  }
  const rawLabel = optionalStringProperty(task, "label", "Handoff task");
  const label =
    rawLabel !== undefined && boundedText(rawLabel, MAX_HANDOFF_LABEL_BYTES)
      ? rawLabel
      : undefined;
  const consumesProperty = ownDataProperty(task, "consumes", "Handoff task");
  const consumesValue = consumesProperty.present ? consumesProperty.value : [];
  if (
    !Array.isArray(consumesValue) ||
    isProxy(consumesValue) ||
    consumesValue.length > MAX_HANDOFF_CONSUMED_RESULTS ||
    Object.getPrototypeOf(consumesValue) !== Array.prototype
  ) {
    throw new WorkflowHandoffError(
      `Task "${idProperty.value}" consumes must be a bounded plain array`,
    );
  }
  const consumes: string[] = [];
  for (let index = 0; index < consumesValue.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(
      consumesValue,
      String(index),
    );
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new WorkflowHandoffError(
        `Task "${idProperty.value}" consumes cannot contain holes or accessors`,
      );
    }
    const dependencyId = descriptor.value;
    if (
      typeof dependencyId !== "string" ||
      dependencyId.length === 0 ||
      !boundedText(dependencyId, MAX_HANDOFF_TASK_ID_BYTES)
    ) {
      throw new WorkflowHandoffError(
        `Task "${idProperty.value}" has an invalid consumes entry`,
      );
    }
    consumes.push(dependencyId);
  }
  if (new Set(consumes).size !== consumes.length) {
    throw new WorkflowHandoffError(
      `Task "${idProperty.value}" has duplicate consumes entries`,
    );
  }
  if (consumes.includes(idProperty.value)) {
    throw new WorkflowHandoffError(
      `Task "${idProperty.value}" cannot consume itself`,
    );
  }
  return {
    id: idProperty.value,
    ...(label === undefined ? {} : { label }),
    consumes,
  };
}

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[\s-]+/gu, "_")
    .toLowerCase();
}

function isSecretKey(key: string): boolean {
  const compact = normalizedKey(key).replaceAll("_", "");
  return /(?:apikey|accesstoken|auth|authorization|cookie|credentials?|password|passwd|pwd|privatekey|client(?:secret|key)|refreshtoken|sessiontoken|idtoken|secret|token)/u.test(
    compact,
  );
}

function isNativePathKey(key: string): boolean {
  return /^(?:artifactPath|filePath|nativePath|rolloutPath|sessionFile|sessionFilePath|sessionPath|cwd)$/iu.test(
    key,
  );
}

function isTranscriptKey(key: string): boolean {
  return /^(?:conversation|history|liveAssistant|liveTools|messages|parts|queued|toolCalls|toolResults|transcript)$/iu.test(
    key,
  );
}

type SecretValueKind = "authorization" | "cookie" | "generic";

const AUTHORIZATION_ASSIGNMENT =
  /\b(?:proxy-authorization|authorization)\b["']?([ \t]*[:=][ \t]*)/giu;
const COOKIE_ASSIGNMENT = /\b(?:cookie|set-cookie)\b["']?([ \t]*[:=][ \t]*)/giu;
const GENERIC_SECRET_ASSIGNMENT =
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credentials?|password|passwd|pwd|private[_-]?key|client[_-]?(?:secret|key)|refresh[_-]?token|session[_-]?token|id[_-]?token|secret|token)\b["']?([ \t]*[:=][ \t]*)/giu;

function lineEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\r" || text[index] === "\n") return index;
  }
  return text.length;
}

function quotedValueEnd(text: string, start: number): number | undefined {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return undefined;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index + 1;
    if (text[index] === "\r" || text[index] === "\n") {
      return lineEnd(text, start);
    }
  }
  return text.length;
}

function balancedValueEnd(text: string, start: number): number | undefined {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") return undefined;
  const closings: string[] = [opening === "{" ? "}" : "]"];
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index];
    if (character === '"' || character === "'") {
      const end = quotedValueEnd(text, index);
      if (end === undefined) return undefined;
      index = end - 1;
      continue;
    }
    if (character === "{" || character === "[") {
      closings.push(character === "{" ? "}" : "]");
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    if (closings.at(-1) !== character) return lineEnd(text, start);
    closings.pop();
    if (closings.length === 0) return index + 1;
  }
  return text.length;
}

function authorizationValueEnd(text: string, start: number): number {
  const scheme = /^(?:basic|bearer)\b/iu.exec(text.slice(start));
  if (scheme !== null) {
    let credentialStart = start + scheme[0].length;
    while (text[credentialStart] === " " || text[credentialStart] === "\t") {
      credentialStart += 1;
    }
    const quotedEnd = quotedValueEnd(text, credentialStart);
    if (quotedEnd !== undefined) return quotedEnd;
    const balancedEnd = balancedValueEnd(text, credentialStart);
    if (balancedEnd !== undefined) return balancedEnd;
  }
  return lineEnd(text, start);
}

function secretValueEnd(
  text: string,
  start: number,
  kind: SecretValueKind,
): number {
  if (kind === "authorization") return authorizationValueEnd(text, start);
  const quotedEnd = quotedValueEnd(text, start);
  if (quotedEnd !== undefined) return quotedEnd;
  if (kind === "cookie") return lineEnd(text, start);
  const balancedEnd = balancedValueEnd(text, start);
  if (balancedEnd !== undefined) return balancedEnd;
  const end = lineEnd(text, start);
  for (let index = start; index < end; index++) {
    if (text[index] === "," || text[index] === ";") return index;
  }
  return end;
}

function redactAssignments(
  text: string,
  pattern: RegExp,
  kind: SecretValueKind,
  replacement: string,
): string {
  let output = "";
  let cursor = 0;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const valueStart = pattern.lastIndex;
    const valueEnd = secretValueEnd(text, valueStart, kind);
    output += text.slice(cursor, match.index) + match[1] + replacement;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
    if (valueEnd === valueStart) pattern.lastIndex = valueStart + 1;
  }
  return output + text.slice(cursor);
}

function redactStandaloneAuthorization(text: string): string {
  const pattern = /\b(?:basic|bearer)\b[ \t]+/giu;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const valueStart = pattern.lastIndex;
    const valueEnd = secretValueEnd(text, valueStart, "authorization");
    output += text.slice(cursor, match.index) + "<redacted-authorization>";
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
    if (valueEnd === valueStart) pattern.lastIndex = valueStart + 1;
  }
  return output + text.slice(cursor);
}

function redactSecrets(text: string): string {
  let redacted = text;
  redacted = redacted.replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu,
    "<redacted-private-key>",
  );
  // Header values are structured: a Basic/Bearer credential may contain
  // spaces, and a cookie header continues through semicolon-delimited pairs.
  redacted = redactAssignments(
    redacted,
    AUTHORIZATION_ASSIGNMENT,
    "authorization",
    "<redacted>",
  );
  redacted = redactAssignments(
    redacted,
    COOKIE_ASSIGNMENT,
    "cookie",
    "<redacted-cookie>",
  );
  redacted = redactAssignments(
    redacted,
    GENERIC_SECRET_ASSIGNMENT,
    "generic",
    "<redacted>",
  );
  // Also catch standalone schemes in text that was not formatted as a header.
  redacted = redactStandaloneAuthorization(redacted);
  redacted = redacted.replace(
    /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]+)\b/g,
    "<redacted-secret>",
  );
  // JWT-like values are credentials even when a producer omitted a key name.
  redacted = redacted.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "<redacted-jwt>",
  );
  // Native paths belong to the child/session owner. Relative project paths in
  // a result remain useful; any absolute POSIX, drive-qualified, or UNC path
  // is removed rather than relying on a host-specific home-directory list.
  redacted = redacted.replace(
    /(?<![A-Za-z0-9:])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]+|\b[A-Za-z]:[\\/][^\s"'<>]+|\\\\[^\s"'<>]+/g,
    "<native-path-omitted>",
  );
  return redacted
    .replaceAll(WORKFLOW_HANDOFF_BEGIN, "<handoff-marker-omitted>")
    .replaceAll(WORKFLOW_HANDOFF_END, "<handoff-end-marker-omitted>");
}
const UNSAFE_REFERENCE_CREDENTIAL =
  /(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/u;

function safeReference(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    UNSAFE_REFERENCE_CREDENTIAL.test(value) ||
    !/^(?:artifact|session):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    return undefined;
  }
  const identifier = value.slice(value.indexOf(":") + 1);
  if (isSecretKey(identifier)) return undefined;
  return value;
}

function prefixedReference(
  scheme: "artifact" | "session",
  identifier: string | undefined,
): string | undefined {
  if (identifier === undefined || identifier.length > 128 - scheme.length - 1) {
    return undefined;
  }
  return safeReference(`${scheme}:${identifier}`);
}

function resultReference(result: CompletedHandoffResult): string {
  if (!isObject(result)) return "artifact:unavailable";
  const artifactRef = optionalStringProperty(
    result,
    "artifactRef",
    "Handoff result",
  );
  const sessionRef = optionalStringProperty(
    result,
    "sessionRef",
    "Handoff result",
  );
  const artifactId = optionalStringProperty(
    result,
    "artifactId",
    "Handoff result",
  );
  const sessionId = optionalStringProperty(
    result,
    "sessionId",
    "Handoff result",
  );
  return (
    safeReference(artifactRef) ??
    safeReference(sessionRef) ??
    prefixedReference("artifact", artifactId) ??
    prefixedReference("session", sessionId) ??
    "artifact:unavailable"
  );
}

interface SanitizationBudget {
  nodesRemaining: number;
  propertiesRemaining: number;
  stringBytesRemaining: number;
}

function newSanitizationBudget(): SanitizationBudget {
  return {
    nodesRemaining: MAX_HANDOFF_SANITIZE_NODES,
    propertiesRemaining: MAX_HANDOFF_SANITIZE_PROPERTIES,
    stringBytesRemaining: MAX_HANDOFF_SANITIZE_OUTPUT_BYTES,
  };
}

function reserveProperties(budget: SanitizationBudget, count: number): boolean {
  if (count > budget.propertiesRemaining) return false;
  budget.propertiesRemaining -= count;
  return true;
}

function containerKind(value: object): "array" | "record" | undefined {
  if (isProxy(value)) return undefined;
  try {
    if (Array.isArray(value)) {
      return Object.getPrototypeOf(value) === Array.prototype
        ? "array"
        : undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? "record"
      : undefined;
  } catch {
    return undefined;
  }
}

function redactBoundedString(
  value: string,
  budget: SanitizationBudget,
): string | undefined {
  // Check the cheap UTF-16 bound first; byte measurement and redaction then
  // operate only on a bounded string.
  if (!boundedText(value, MAX_HANDOFF_SANITIZE_STRING_BYTES)) return undefined;
  const redacted = redactSecrets(value);
  const bytes = utf8Bytes(redacted);
  if (bytes > budget.stringBytesRemaining) return undefined;
  budget.stringBytesRemaining -= bytes;
  return redacted;
}

function safeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: SanitizationBudget,
): unknown | undefined {
  if (depth > MAX_HANDOFF_SANITIZE_DEPTH || budget.nodesRemaining === 0) {
    return undefined;
  }
  budget.nodesRemaining -= 1;
  if (value === null) return null;
  if (typeof value === "string") return redactBoundedString(value, budget);
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "[non-finite number]";
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return "[bigint]";
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function" || typeof value === "symbol") {
    return "[unsupported value]";
  }
  if (!isObject(value)) return "[unsupported value]";

  const kind = containerKind(value);
  if (kind === undefined || seen.has(value)) {
    return kind === undefined ? undefined : "[circular]";
  }
  seen.add(value);

  if (kind === "array") {
    if (!Array.isArray(value)) return undefined;
    let length: number;
    try {
      length = value.length;
    } catch {
      return undefined;
    }
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_HANDOFF_SANITIZE_ARRAY_ITEMS ||
      !reserveProperties(budget, length)
    ) {
      return undefined;
    }
    const items: unknown[] = [];
    for (let index = 0; index < length; index++) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        return undefined;
      }
      if (descriptor === undefined) {
        items.push("[omitted accessor]");
        continue;
      }
      if (!("value" in descriptor)) return undefined;
      const item = safeValue(descriptor.value, depth + 1, seen, budget);
      if (item === undefined) return undefined;
      items.push(item);
    }
    return items;
  }

  // Reserve the traversal itself before obtaining the record shape. The
  // record is then accepted only when its own-name representation fits the
  // remaining bounded property budget. Proxies were rejected by
  // containerKind, so descriptor reads below cannot invoke proxy traps or
  // accessors.
  if (!reserveProperties(budget, 1)) return undefined;
  let keys: string[];
  try {
    keys = Object.getOwnPropertyNames(value);
  } catch {
    return undefined;
  }
  if (!reserveProperties(budget, keys.length)) return undefined;
  for (const key of keys) {
    if (!boundedText(key, MAX_HANDOFF_SANITIZE_STRING_BYTES)) return undefined;
  }
  keys.sort();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (isTranscriptKey(key)) continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return undefined;
    }
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const safeKey = isSecretKey(key)
      ? redactBoundedString("[redacted-key]", budget)
      : redactBoundedString(key, budget);
    if (safeKey === undefined) return undefined;
    if (isNativePathKey(key)) {
      output[safeKey] = "[native path omitted]";
    } else if (isSecretKey(key)) {
      output[safeKey] = "[redacted]";
    } else {
      const child = safeValue(descriptor.value, depth + 1, seen, budget);
      if (child === undefined) return undefined;
      output[safeKey] = child;
    }
  }
  return output;
}
function stableStringify(value: unknown): string | undefined {
  try {
    const serialized =
      typeof value === "string"
        ? value
        : (JSON.stringify(value) ?? "[undefined]");
    if (!boundedText(serialized, MAX_HANDOFF_SANITIZE_OUTPUT_BYTES)) {
      return undefined;
    }
    return redactSecrets(serialized);
  } catch {
    return undefined;
  }
}

interface HandoffDetails {
  readonly text: string;
  readonly opaque: boolean;
}

function opaqueDetails(reference: string): HandoffDetails {
  return {
    text: `[opaque reference: ${reference}]`,
    opaque: true,
  };
}

function assertCompletedResult(
  result: unknown,
  taskId: string,
): asserts result is CompletedHandoffResult {
  if (!isObject(result)) {
    throw new WorkflowHandoffError(
      `Handoff result for "${taskId}" must be an object`,
    );
  }
  const status = ownDataProperty(result, "status", "Handoff result");
  if (!status.present || status.value !== "completed") {
    throw new WorkflowHandoffError(
      `Task consumes only completed dependency "${taskId}"`,
    );
  }
}

function resultDetails(
  result: CompletedHandoffResult,
  reference: string,
): HandoffDetails {
  if (!isObject(result)) {
    return { text: "(no explicit result output)", opaque: false };
  }
  const output = ownDataProperty(result, "output", "Handoff result");
  const fallback = ownDataProperty(result, "result", "Handoff result");
  const value =
    output.present && output.value !== undefined
      ? output.value
      : fallback.present
        ? fallback.value
        : undefined;
  if (value === undefined) {
    return { text: "(no explicit result output)", opaque: false };
  }
  const safe = safeValue(
    value,
    0,
    new WeakSet<object>(),
    newSanitizationBudget(),
  );
  if (safe === undefined) return opaqueDetails(reference);
  const text = stableStringify(safe);
  return text === undefined
    ? opaqueDetails(reference)
    : { text, opaque: false };
}

function mapResult(
  results: HandoffResultMap,
  taskId: string,
): CompletedHandoffResult | undefined {
  if (!isObject(results)) {
    throw new WorkflowHandoffError("Handoff results must be a map or object");
  }
  if (isProxy(results)) {
    throw new WorkflowHandoffError("Handoff results cannot be a proxy");
  }
  if (results instanceof Map) {
    try {
      return Map.prototype.get.call(results, taskId);
    } catch {
      throw new WorkflowHandoffError("Handoff results map cannot be inspected");
    }
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(results, taskId);
  } catch {
    throw new WorkflowHandoffError(
      `Handoff result "${taskId}" cannot be inspected`,
    );
  }
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    throw new WorkflowHandoffError(
      `Handoff result "${taskId}" cannot be a getter`,
    );
  }
  return descriptor.value;
}

function labelFor(
  taskLabel: string | undefined,
  result: CompletedHandoffResult,
  taskId: string,
): string {
  const rawResultLabel = isObject(result)
    ? optionalStringProperty(result, "label", "Handoff result")
    : undefined;
  const resultLabel =
    rawResultLabel !== undefined &&
    boundedText(rawResultLabel, MAX_HANDOFF_LABEL_BYTES)
      ? rawResultLabel
      : undefined;
  const candidate = resultLabel ?? taskLabel ?? taskId;
  if (isSecretKey(candidate)) return "[redacted-label]";
  const label = redactSecrets(
    boundedText(candidate, MAX_HANDOFF_LABEL_BYTES) ? candidate : taskId,
  );
  if (utf8Bytes(label) <= MAX_HANDOFF_LABEL_BYTES) return label;
  return truncateUtf8(label, MAX_HANDOFF_LABEL_BYTES);
}

function estimateTokens(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(utf8Bytes(value) / 4);
}

export function estimateHandoffTokens(value: string): number {
  return estimateTokens(value);
}

function fits(value: string, maxBytes: number, maxTokens: number): boolean {
  return utf8Bytes(value) <= maxBytes && estimateTokens(value) <= maxTokens;
}

function entryText(
  taskId: string,
  label: string,
  details: string,
  truncated: boolean,
  reference: string | undefined,
): string {
  const safeTaskId = redactSecrets(taskId);
  const safeLabel = redactSecrets(label);
  const payload = {
    taskId: safeTaskId,
    label: safeLabel,
    details,
    ...(truncated ? { truncated: true, reference } : {}),
  };
  return `${WORKFLOW_HANDOFF_BEGIN}\n${JSON.stringify(payload)}\n${WORKFLOW_HANDOFF_END}`;
}

function boundedEntry(
  taskId: string,
  label: string,
  details: string,
  reference: string,
  maxBytes: number,
  maxTokens: number,
  opaque: boolean,
): {
  readonly text: string;
  readonly truncated: boolean;
  readonly reference?: string;
} {
  const complete = entryText(
    taskId,
    label,
    details,
    opaque,
    opaque ? reference : undefined,
  );
  if (opaque) {
    if (!fits(complete, maxBytes, maxTokens)) {
      throw new WorkflowHandoffError(
        `Handoff for "${taskId}" is too small for its required labeled envelope`,
      );
    }
    return { text: complete, truncated: true, reference };
  }
  if (fits(complete, maxBytes, maxTokens)) {
    return { text: complete, truncated: false };
  }

  const marker = `[details truncated; opaque reference: ${reference}]`;
  const candidate = (prefix: string) =>
    entryText(taskId, label, `${prefix}\n${marker}`, true, reference);
  let low = 0;
  let high = details.length;
  let best = candidate("");
  if (!fits(best, maxBytes, maxTokens)) {
    throw new WorkflowHandoffError(
      `Handoff for "${taskId}" is too small for its required labeled envelope`,
    );
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const attempt = candidate(truncateUtf8(details, middle));
    if (fits(attempt, maxBytes, maxTokens)) {
      best = attempt;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { text: best, truncated: true, reference };
}

function validateLimit(
  value: number | undefined,
  label: string,
  maximum: number,
): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new WorkflowHandoffError(
      `${label} must be a safe integer from 1 to ${maximum}`,
    );
  }
  return resolved;
}

/**
 * Assemble only the task's explicit `consumes` results. Missing, non-terminal,
 * or failed dependencies fail closed instead of silently injecting stale data.
 */
export function buildTaskHandoff(
  task: HandoffTask,
  results: HandoffResultMap,
  options: WorkflowHandoffOptions = {},
): WorkflowHandoff {
  const normalizedTask = normalizeHandoffTask(task);
  const taskId = normalizedTask.id;
  const consumes = normalizedTask.consumes;
  const maxBytes = validateLimit(
    options.maxBytes,
    "Handoff maxBytes",
    MAX_HANDOFF_BYTES,
  );
  const maxTokens = validateLimit(
    options.maxTokens,
    "Handoff maxTokens",
    MAX_HANDOFF_TOKENS,
  );
  const maxTotalBytes = validateLimit(
    options.maxTotalBytes,
    "Handoff maxTotalBytes",
    MAX_HANDOFF_TOTAL_BYTES,
  );
  const maxTotalTokens = validateLimit(
    options.maxTotalTokens,
    "Handoff maxTotalTokens",
    MAX_HANDOFF_TOTAL_TOKENS,
  );

  const entries: WorkflowHandoffEntry[] = [];
  for (const dependencyId of consumes) {
    const dependency = mapResult(results, dependencyId);
    if (dependency === undefined) {
      throw new WorkflowHandoffError(
        `Task "${taskId}" consumes "${dependencyId}", but no result was provided`,
      );
    }
    assertCompletedResult(dependency, dependencyId);
    const reference = resultReference(dependency);
    const label = labelFor(normalizedTask.label, dependency, dependencyId);
    const details = resultDetails(dependency, reference);
    const bounded = boundedEntry(
      dependencyId,
      label,
      details.text,
      reference,
      maxBytes,
      maxTokens,
      details.opaque,
    );
    entries.push({
      taskId: dependencyId,
      label,
      text: bounded.text,
      truncated: bounded.truncated,
      ...(bounded.reference === undefined
        ? {}
        : { reference: bounded.reference }),
      bytes: utf8Bytes(bounded.text),
      tokens: estimateTokens(bounded.text),
    });
  }

  const text = `${WORKFLOW_HANDOFF_BEGIN}\n${entries
    .map((entry) => entry.text)
    .join("\n")}\n${WORKFLOW_HANDOFF_END}`;
  if (!fits(text, maxTotalBytes, maxTotalTokens)) {
    throw new WorkflowHandoffError(
      `Workflow handoff exceeds ${maxTotalBytes} UTF-8 bytes or ${maxTotalTokens} estimated tokens`,
    );
  }
  return {
    text,
    entries: Object.freeze(entries),
    bytes: utf8Bytes(text),
    tokens: estimateTokens(text),
  };
}

export const assembleWorkflowHandoff = buildTaskHandoff;
export const buildWorkflowHandoff = buildTaskHandoff;

export const assembleHandoff = buildTaskHandoff;
export const buildHandoff = buildTaskHandoff;
