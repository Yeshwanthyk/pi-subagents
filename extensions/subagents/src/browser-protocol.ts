import type {
  BackendName,
  LiveToolState,
  QueuedMessage,
  ReasoningEffort,
  SubagentSnapshot,
  TranscriptItem,
  TranscriptPart,
} from "./domain.ts";

/** Exact widget key consumed by browser/RPC clients. */
export const BROWSER_ACTIVITY_WIDGET_KEY = "pi-subagents/activity/v1" as const;
export const BROWSER_ACTIVITY_PROTOCOL_VERSION = 1 as const;

/** Public limits. This widget is a bounded snapshot, not a transcript store. */
export const BROWSER_ACTIVITY_LIMITS = {
  maxRunningChildren: 4,
  maxSnapshotBytes: 15 * 1024,
  maxChildIdLength: 64,
  maxTitleLength: 160,
  maxPromptLength: 2_048,
  maxOutputLength: 4_096,
  maxFailureLength: 2_048,
  maxModelLength: 120,
  maxTranscriptItems: 16,
  maxTranscriptTextLength: 512,
  maxToolCount: 4,
  maxToolNameLength: 120,
  maxToolArgsLength: 512,
  maxToolOutputLength: 512,
  maxQueuedItems: 4,
  maxQueuedTextLength: 512,
} as const;

export const MAX_PUBLIC_RUNNING_SUBAGENTS =
  BROWSER_ACTIVITY_LIMITS.maxRunningChildren;
export const MAX_BROWSER_ACTIVITY_BYTES =
  BROWSER_ACTIVITY_LIMITS.maxSnapshotBytes;

export type PublicChildId = string;
export type BrowserActivityStatus = "running" | "done" | "error";

export interface BrowserActivityToolSnapshot {
  readonly name: string;
  readonly args?: string;
  readonly output?: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly isError?: boolean;
}

export interface BrowserActivityQueuedMessage {
  readonly kind: QueuedMessage["kind"];
  readonly text: string;
}

export type BrowserActivityTranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly args?: string;
      readonly output?: string;
      readonly isError?: boolean;
    };

/** Public projection of one standard subagent. */
export interface BrowserActivityChildSnapshot {
  readonly id: PublicChildId;
  readonly backend: BackendName;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly title: string;
  readonly status: "running";
  readonly prompt: string;
  readonly output: string;
  readonly failure?: string;
  readonly transcript: ReadonlyArray<BrowserActivityTranscriptItem>;
  readonly tools: ReadonlyArray<BrowserActivityToolSnapshot>;
  readonly queued: ReadonlyArray<BrowserActivityQueuedMessage>;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly settledAt?: number;
  readonly usage?: {
    readonly tokens?: number;
    readonly contextWindow?: number;
  };
}

/** One ephemeral terminal handoff; settled history is not retained here. */
export interface BrowserActivityTerminalSnapshot {
  readonly id: PublicChildId;
  readonly title: string;
  readonly status: "done" | "error";
  readonly output: string;
  readonly failure?: string;
  readonly settledAt: number;
}

export interface BrowserActivitySnapshot {
  readonly version: typeof BROWSER_ACTIVITY_PROTOCOL_VERSION;
  readonly revision: number;
  readonly generatedAt: number;
  readonly children: ReadonlyArray<BrowserActivityChildSnapshot>;
  readonly terminal?: BrowserActivityTerminalSnapshot;
}

export type PublicSubagentSnapshot = BrowserActivityChildSnapshot;
export type PublicSubagentToolSnapshot = BrowserActivityToolSnapshot;
export type PublicTranscriptItem = BrowserActivityTranscriptItem;
export type PublicActivitySnapshot = BrowserActivitySnapshot;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clean(text: string) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function bounded(text: string, maxLength: number) {
  const value = clean(text);
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  return maxLength <= 1
    ? chars.slice(0, maxLength).join("")
    : `${chars.slice(0, maxLength - 1).join("")}…`;
}

function boundedUtf8(text: string, maxBytes: number) {
  const value = clean(text);
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = chars.slice(0, middle).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return chars.slice(0, low).join("");
}
function line(text: string, maxLength: number) {
  return bounded(
    text
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    maxLength,
  );
}

function number(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function id(value: unknown): PublicChildId | undefined {
  if (typeof value !== "string") return undefined;
  const result = line(value, BROWSER_ACTIVITY_LIMITS.maxChildIdLength);
  return result.length > 0 &&
    result.length <= BROWSER_ACTIVITY_LIMITS.maxChildIdLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)
    ? result
    : undefined;
}

export function toPublicChildId(value: unknown): PublicChildId | undefined {
  return id(value);
}

function transcriptPart(
  part: TranscriptPart,
): BrowserActivityTranscriptItem | undefined {
  if (part.type === "text") {
    const text = bounded(
      part.text,
      BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength,
    );
    return text ? { kind: "assistant", text } : undefined;
  }
  if (part.type === "thinking") {
    const text = bounded(
      part.text,
      BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength,
    );
    return text
      ? {
          kind: "thinking",
          text,
          ...(part.redacted === undefined ? {} : { redacted: part.redacted }),
        }
      : undefined;
  }
  const name = line(part.name, BROWSER_ACTIVITY_LIMITS.maxToolNameLength);
  if (!name) return undefined;
  const args = part.argsPreview
    ? bounded(part.argsPreview, BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)
    : undefined;
  return { kind: "tool", name, ...(args ? { args } : {}) };
}

function transcriptItem(
  item: TranscriptItem,
): ReadonlyArray<BrowserActivityTranscriptItem> {
  if (item.kind === "user") {
    const text = bounded(
      item.text,
      BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength,
    );
    return text ? [{ kind: "user", text }] : [];
  }
  if (item.kind === "assistant") {
    return item.parts
      .map(transcriptPart)
      .filter((part): part is BrowserActivityTranscriptItem => !!part);
  }
  const name = line(item.name, BROWSER_ACTIVITY_LIMITS.maxToolNameLength);
  if (!name) return [];
  const output = item.outputPreview
    ? bounded(item.outputPreview, BROWSER_ACTIVITY_LIMITS.maxToolOutputLength)
    : undefined;
  return [
    {
      kind: "tool",
      name,
      ...(output ? { output } : {}),
      isError: item.isError,
    },
  ];
}

function publicTool(tool: LiveToolState): BrowserActivityToolSnapshot {
  const args = tool.argsPreview
    ? bounded(tool.argsPreview, BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)
    : undefined;
  const output = tool.outputPreview
    ? bounded(tool.outputPreview, BROWSER_ACTIVITY_LIMITS.maxToolOutputLength)
    : undefined;
  return {
    name: line(tool.name, BROWSER_ACTIVITY_LIMITS.maxToolNameLength),
    ...(args ? { args } : {}),
    ...(output ? { output } : {}),
    startedAt: number(tool.startedAt),
    updatedAt: number(tool.updatedAt),
    ...(tool.isError === undefined ? {} : { isError: tool.isError }),
  };
}

function publicQueued(snapshot: SubagentSnapshot) {
  return snapshot.queued
    .slice(0, BROWSER_ACTIVITY_LIMITS.maxQueuedItems)
    .map((message) => ({
      kind: message.kind,
      text: bounded(message.text, BROWSER_ACTIVITY_LIMITS.maxQueuedTextLength),
    }));
}

function usage(snapshot: SubagentSnapshot) {
  const tokens = number(snapshot.usage.tokens);
  const contextWindow = number(snapshot.usage.contextWindow);
  return tokens || contextWindow
    ? {
        ...(tokens ? { tokens } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      }
    : undefined;
}

function projectChild(
  snapshot: SubagentSnapshot,
): BrowserActivityChildSnapshot {
  const output = snapshot.liveAssistant?.text || snapshot.finalText || "";
  const failure = snapshot.errorText
    ? bounded(snapshot.errorText, BROWSER_ACTIVITY_LIMITS.maxFailureLength)
    : undefined;
  const model = snapshot.meta.modelLabel
    ? line(snapshot.meta.modelLabel, BROWSER_ACTIVITY_LIMITS.maxModelLength)
    : undefined;
  const reasoningEffort = snapshot.meta.reasoningEffort;
  const queued = publicQueued(snapshot);
  const childUsage = usage(snapshot);
  return {
    id: id(snapshot.id) ?? "unknown",
    backend: snapshot.backend,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    title: line(snapshot.title, BROWSER_ACTIVITY_LIMITS.maxTitleLength),
    status: "running",
    prompt: bounded(snapshot.prompt, BROWSER_ACTIVITY_LIMITS.maxPromptLength),
    output: bounded(output, BROWSER_ACTIVITY_LIMITS.maxOutputLength),
    ...(failure ? { failure } : {}),
    transcript: snapshot.transcript
      .flatMap(transcriptItem)
      .slice(-BROWSER_ACTIVITY_LIMITS.maxTranscriptItems),
    tools: snapshot.liveTools
      .slice(0, BROWSER_ACTIVITY_LIMITS.maxToolCount)
      .map(publicTool),
    queued,
    startedAt: number(snapshot.createdAt),
    lastActivityAt: number(snapshot.lastActivityAt),
    ...(snapshot.settledAt === undefined
      ? {}
      : { settledAt: number(snapshot.settledAt) }),
    ...(childUsage ? { usage: childUsage } : {}),
  };
}

/** Project one terminal transition without exposing manager/session metadata. */
export function projectBrowserTerminal(
  snapshot: SubagentSnapshot,
): BrowserActivityTerminalSnapshot | undefined {
  if (snapshot.visibility !== "standard" || snapshot.status === "running")
    return undefined;
  const childId = id(snapshot.id);
  if (!childId) return undefined;
  const failure = snapshot.errorText
    ? bounded(snapshot.errorText, BROWSER_ACTIVITY_LIMITS.maxFailureLength)
    : undefined;
  return {
    id: childId,
    title: line(snapshot.title, BROWSER_ACTIVITY_LIMITS.maxTitleLength),
    status: snapshot.status,
    output: bounded(
      snapshot.finalText,
      BROWSER_ACTIVITY_LIMITS.maxOutputLength,
    ),
    ...(failure ? { failure } : {}),
    settledAt: number(snapshot.settledAt ?? snapshot.lastActivityAt),
  };
}

/** Project live standard children; terminal history is passed separately once. */
export function projectBrowserActivity(
  snapshots: ReadonlyArray<SubagentSnapshot>,
  revision: number,
  terminal?: SubagentSnapshot,
  now = Date.now(),
): BrowserActivitySnapshot {
  const children = snapshots
    .filter(
      (snapshot) =>
        snapshot.visibility === "standard" &&
        snapshot.status === "running" &&
        id(snapshot.id) !== undefined,
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    )
    .slice(0, BROWSER_ACTIVITY_LIMITS.maxRunningChildren)
    .map(projectChild);
  const terminalSnapshot = terminal
    ? projectBrowserTerminal(terminal)
    : undefined;
  return {
    version: BROWSER_ACTIVITY_PROTOCOL_VERSION,
    revision: number(revision),
    generatedAt: number(now),
    children,
    ...(terminalSnapshot ? { terminal: terminalSnapshot } : {}),
  };
}

export const projectBrowserSnapshot = projectBrowserActivity;

const TOP_LEVEL_KEYS = [
  "version",
  "revision",
  "generatedAt",
  "children",
  "terminal",
] as const;
const CHILD_KEYS = [
  "id",
  "backend",
  "model",
  "reasoningEffort",
  "title",
  "status",
  "prompt",
  "output",
  "failure",
  "transcript",
  "tools",
  "queued",
  "startedAt",
  "lastActivityAt",
  "settledAt",
  "usage",
] as const;
const TOOL_KEYS = [
  "name",
  "args",
  "output",
  "startedAt",
  "updatedAt",
  "isError",
] as const;
const TERMINAL_KEYS = [
  "id",
  "title",
  "status",
  "output",
  "failure",
  "settledAt",
] as const;

function only(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" && Array.from(value).length <= maxLength;
}

function validTool(value: unknown): value is BrowserActivityToolSnapshot {
  return (
    isRecord(value) &&
    only(value, TOOL_KEYS) &&
    text(value.name, BROWSER_ACTIVITY_LIMITS.maxToolNameLength) &&
    (value.args === undefined ||
      text(value.args, BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)) &&
    (value.output === undefined ||
      text(value.output, BROWSER_ACTIVITY_LIMITS.maxToolOutputLength)) &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    (value.isError === undefined || typeof value.isError === "boolean")
  );
}

function validTranscript(
  value: unknown,
): value is BrowserActivityTranscriptItem {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "user" || value.kind === "assistant") {
    return (
      only(value, ["kind", "text"]) &&
      text(value.text, BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength)
    );
  }
  if (value.kind === "thinking") {
    return (
      only(value, ["kind", "text", "redacted"]) &&
      text(value.text, BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength) &&
      (value.redacted === undefined || typeof value.redacted === "boolean")
    );
  }
  return (
    value.kind === "tool" &&
    only(value, ["kind", "name", "args", "output", "isError"]) &&
    text(value.name, BROWSER_ACTIVITY_LIMITS.maxToolNameLength) &&
    (value.args === undefined ||
      text(value.args, BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)) &&
    (value.output === undefined ||
      text(value.output, BROWSER_ACTIVITY_LIMITS.maxToolOutputLength)) &&
    (value.isError === undefined || typeof value.isError === "boolean")
  );
}

function validUsage(value: unknown) {
  return (
    isRecord(value) &&
    only(value, ["tokens", "contextWindow"]) &&
    (value.tokens === undefined ||
      (typeof value.tokens === "number" &&
        Number.isFinite(value.tokens) &&
        value.tokens >= 0)) &&
    (value.contextWindow === undefined ||
      (typeof value.contextWindow === "number" &&
        Number.isFinite(value.contextWindow) &&
        value.contextWindow >= 0))
  );
}

function validQueued(value: unknown) {
  return (
    isRecord(value) &&
    only(value, ["kind", "text"]) &&
    (value.kind === "steer" || value.kind === "follow-up") &&
    text(value.text, BROWSER_ACTIVITY_LIMITS.maxQueuedTextLength)
  );
}

function validChild(value: unknown): value is BrowserActivityChildSnapshot {
  return (
    isRecord(value) &&
    only(value, CHILD_KEYS) &&
    id(value.id) === value.id &&
    (value.backend === "pi" ||
      value.backend === "claude" ||
      value.backend === "codex") &&
    (value.model === undefined ||
      text(value.model, BROWSER_ACTIVITY_LIMITS.maxModelLength)) &&
    (value.reasoningEffort === undefined ||
      value.reasoningEffort === "off" ||
      value.reasoningEffort === "minimal" ||
      value.reasoningEffort === "low" ||
      value.reasoningEffort === "medium" ||
      value.reasoningEffort === "high" ||
      value.reasoningEffort === "xhigh" ||
      value.reasoningEffort === "max") &&
    text(value.title, BROWSER_ACTIVITY_LIMITS.maxTitleLength) &&
    value.status === "running" &&
    text(value.prompt, BROWSER_ACTIVITY_LIMITS.maxPromptLength) &&
    text(value.output, BROWSER_ACTIVITY_LIMITS.maxOutputLength) &&
    (value.failure === undefined ||
      text(value.failure, BROWSER_ACTIVITY_LIMITS.maxFailureLength)) &&
    Array.isArray(value.transcript) &&
    value.transcript.length <= BROWSER_ACTIVITY_LIMITS.maxTranscriptItems &&
    value.transcript.every(validTranscript) &&
    Array.isArray(value.tools) &&
    value.tools.length <= BROWSER_ACTIVITY_LIMITS.maxToolCount &&
    value.tools.every(validTool) &&
    Array.isArray(value.queued) &&
    value.queued.length <= BROWSER_ACTIVITY_LIMITS.maxQueuedItems &&
    value.queued.every(validQueued) &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.lastActivityAt === "number" &&
    Number.isFinite(value.lastActivityAt) &&
    (value.settledAt === undefined ||
      (typeof value.settledAt === "number" &&
        Number.isFinite(value.settledAt))) &&
    (value.usage === undefined || validUsage(value.usage))
  );
}

function validTerminal(
  value: unknown,
): value is BrowserActivityTerminalSnapshot {
  return (
    isRecord(value) &&
    only(value, TERMINAL_KEYS) &&
    id(value.id) === value.id &&
    text(value.title, BROWSER_ACTIVITY_LIMITS.maxTitleLength) &&
    (value.status === "done" || value.status === "error") &&
    text(value.output, BROWSER_ACTIVITY_LIMITS.maxOutputLength) &&
    (value.failure === undefined ||
      text(value.failure, BROWSER_ACTIVITY_LIMITS.maxFailureLength)) &&
    typeof value.settledAt === "number" &&
    Number.isFinite(value.settledAt)
  );
}

/** Runtime validation for both locally-produced and widget-decoded values. */
export function isBrowserActivitySnapshot(
  value: unknown,
): value is BrowserActivitySnapshot {
  if (
    !isRecord(value) ||
    !only(value, TOP_LEVEL_KEYS) ||
    value.version !== BROWSER_ACTIVITY_PROTOCOL_VERSION ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.generatedAt !== "number" ||
    !Number.isFinite(value.generatedAt) ||
    !Array.isArray(value.children) ||
    value.children.length > BROWSER_ACTIVITY_LIMITS.maxRunningChildren ||
    !value.children.every(validChild)
  ) {
    return false;
  }
  const ids = new Set(value.children.map((child) => child.id));
  return (
    ids.size === value.children.length &&
    (value.terminal === undefined || validTerminal(value.terminal))
  );
}

export const isValidBrowserActivitySnapshot = isBrowserActivitySnapshot;
export const validateBrowserActivitySnapshot = isBrowserActivitySnapshot;

function boundedForTransport(
  snapshot: BrowserActivitySnapshot,
): BrowserActivitySnapshot {
  if (
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") <=
    BROWSER_ACTIVITY_LIMITS.maxSnapshotBytes
  ) {
    return snapshot;
  }
  // Preserve identity and terminal status/output first when an unusually
  // large, manually-created public value reaches the encoder. The extra UTF-8
  // bounds keep this below Pi/Scotty's generic 16 KiB widget-line limit.
  const compact = {
    ...snapshot,
    children: snapshot.children.map((child) => ({
      ...child,
      model: child.model ? boundedUtf8(child.model, 256) : undefined,
      title: boundedUtf8(child.title, 256),
      prompt: "",
      output: boundedUtf8(child.output, 1_024),
      ...(child.failure ? { failure: boundedUtf8(child.failure, 1_024) } : {}),
      transcript: [],
      tools: [],
      queued: child.queued.slice(0, 1).map((message) => ({
        kind: message.kind,
        text: boundedUtf8(message.text, 128),
      })),
    })),
    ...(snapshot.terminal
      ? {
          terminal: {
            ...snapshot.terminal,
            title: boundedUtf8(snapshot.terminal.title, 256),
            output: boundedUtf8(snapshot.terminal.output, 1_024),
            ...(snapshot.terminal.failure
              ? { failure: boundedUtf8(snapshot.terminal.failure, 1_024) }
              : {}),
          },
        }
      : {}),
  };
  if (
    Buffer.byteLength(JSON.stringify(compact), "utf8") <=
    BROWSER_ACTIVITY_LIMITS.maxSnapshotBytes
  ) {
    return compact;
  }

  return {
    ...compact,
    children: compact.children.map((child) => ({
      ...child,
      title: boundedUtf8(child.title, 128),
      model: child.model ? boundedUtf8(child.model, 128) : undefined,
      output: boundedUtf8(child.output, 256),
      ...(child.failure ? { failure: boundedUtf8(child.failure, 256) } : {}),
      queued:
        child.queued.length > 0
          ? [{ kind: child.queued[0]?.kind ?? "steer", text: "" }]
          : [],
    })),
    ...(compact.terminal
      ? {
          terminal: {
            ...compact.terminal,
            title: boundedUtf8(compact.terminal.title, 128),
            output: boundedUtf8(compact.terminal.output, 512),
            ...(compact.terminal.failure
              ? { failure: boundedUtf8(compact.terminal.failure, 512) }
              : {}),
          },
        }
      : {}),
  };
}
/** Encode one canonical JSON line for `ctx.ui.setWidget`. */
export function encodeBrowserActivitySnapshot(
  snapshot: BrowserActivitySnapshot,
): string {
  if (!isBrowserActivitySnapshot(snapshot)) {
    throw new TypeError("Invalid browser activity snapshot");
  }
  return JSON.stringify(boundedForTransport(snapshot));
}

export function encodeBrowserActivityWidget(
  snapshot: BrowserActivitySnapshot,
): [string] {
  return [encodeBrowserActivitySnapshot(snapshot)];
}

/** Decode one widget JSON line, rejecting malformed or unsafe public shapes. */
export function decodeBrowserActivitySnapshot(
  value: unknown,
): BrowserActivitySnapshot | undefined {
  let parsed: unknown = value;
  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== "string") return undefined;
    parsed = value[0];
  }
  if (typeof parsed === "string") {
    if (
      Buffer.byteLength(parsed, "utf8") >
      BROWSER_ACTIVITY_LIMITS.maxSnapshotBytes
    ) {
      return undefined;
    }
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  return isBrowserActivitySnapshot(parsed) ? parsed : undefined;
}

export const encodeBrowserActivity = encodeBrowserActivitySnapshot;
export const decodeBrowserActivity = decodeBrowserActivitySnapshot;

export function canonicalBrowserActivityJson(
  value: unknown,
): string | undefined {
  const snapshot = decodeBrowserActivitySnapshot(value);
  return snapshot ? encodeBrowserActivitySnapshot(snapshot) : undefined;
}

export function nextBrowserActivityRevision(previous: number) {
  const revision =
    Number.isSafeInteger(previous) && previous >= 0 ? previous : 0;
  return revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
}
