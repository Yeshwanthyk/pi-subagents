type Mutable<T> = { -readonly [K in keyof T]: T[K] };
import { Compile } from "typebox/compile";
import { Type, type Static } from "typebox";

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
type MutableToolSnapshot = Mutable<BrowserActivityToolSnapshot>;
type MutableThinkingItem = Mutable<
  Extract<BrowserActivityTranscriptItem, { kind: "thinking" }>
>;
type MutableToolItem = Mutable<
  Extract<BrowserActivityTranscriptItem, { kind: "tool" }>
>;
type MutableChildSnapshot = Mutable<BrowserActivityChildSnapshot>;
type MutableSnapshot = Mutable<BrowserActivitySnapshot>;
type MutableTerminalSnapshot = Mutable<BrowserActivityTerminalSnapshot>;
const Text = (maxLength: number) => Type.String({ maxLength });
const ToolSchema = Type.Object({
  name: Text(BROWSER_ACTIVITY_LIMITS.maxToolNameLength),
  args: Type.Optional(Text(BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)),
  output: Type.Optional(Text(BROWSER_ACTIVITY_LIMITS.maxToolOutputLength)),
  startedAt: Type.Number(),
  updatedAt: Type.Number(),
  isError: Type.Optional(Type.Boolean()),
});
const TranscriptSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("user"),
    text: Text(BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength),
  }),
  Type.Object({
    kind: Type.Literal("assistant"),
    text: Text(BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength),
  }),
  Type.Object({
    kind: Type.Literal("thinking"),
    text: Text(BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength),
    redacted: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    kind: Type.Literal("tool"),
    name: Text(BROWSER_ACTIVITY_LIMITS.maxToolNameLength),
    args: Type.Optional(Text(BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)),
    output: Type.Optional(Text(BROWSER_ACTIVITY_LIMITS.maxToolOutputLength)),
    isError: Type.Optional(Type.Boolean()),
  }),
]);
const QueuedSchema = Type.Object({
  kind: Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]),
  text: Text(BROWSER_ACTIVITY_LIMITS.maxQueuedTextLength),
});
const UsageSchema = Type.Object({
  tokens: Type.Optional(Type.Number({ minimum: 0 })),
  contextWindow: Type.Optional(Type.Number({ minimum: 0 })),
});
const ChildSchema = Type.Object({
  id: Type.String({ maxLength: BROWSER_ACTIVITY_LIMITS.maxChildIdLength }),
  backend: Type.Union([
    Type.Literal("pi"),
    Type.Literal("claude"),
    Type.Literal("codex"),
  ]),
  model: Type.Optional(Text(BROWSER_ACTIVITY_LIMITS.maxModelLength)),
  reasoningEffort: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ]),
  ),
  title: Text(BROWSER_ACTIVITY_LIMITS.maxTitleLength),
  status: Type.Literal("running"),
  prompt: Text(BROWSER_ACTIVITY_LIMITS.maxPromptLength),
  output: Text(BROWSER_ACTIVITY_LIMITS.maxOutputLength),
  failure: Type.Optional(Text(BROWSER_ACTIVITY_LIMITS.maxFailureLength)),
  transcript: Type.Array(TranscriptSchema, {
    maxItems: BROWSER_ACTIVITY_LIMITS.maxTranscriptItems,
  }),
  tools: Type.Array(ToolSchema, {
    maxItems: BROWSER_ACTIVITY_LIMITS.maxToolCount,
  }),
  queued: Type.Array(QueuedSchema, {
    maxItems: BROWSER_ACTIVITY_LIMITS.maxQueuedItems,
  }),
  startedAt: Type.Number(),
  lastActivityAt: Type.Number(),
  settledAt: Type.Optional(Type.Number()),
  usage: Type.Optional(UsageSchema),
});
const TerminalSchema = Type.Object({
  id: Type.String({ maxLength: BROWSER_ACTIVITY_LIMITS.maxChildIdLength }),
  title: Text(BROWSER_ACTIVITY_LIMITS.maxTitleLength),
  status: Type.Union([Type.Literal("done"), Type.Literal("error")]),
  output: Text(BROWSER_ACTIVITY_LIMITS.maxOutputLength),
  failure: Type.Optional(Text(BROWSER_ACTIVITY_LIMITS.maxFailureLength)),
  settledAt: Type.Number(),
});
const SnapshotSchema = Type.Object({
  version: Type.Literal(BROWSER_ACTIVITY_PROTOCOL_VERSION),
  revision: Type.Integer({ minimum: 0 }),
  generatedAt: Type.Number(),
  children: Type.Array(ChildSchema, {
    maxItems: BROWSER_ACTIVITY_LIMITS.maxRunningChildren,
  }),
  terminal: Type.Optional(TerminalSchema),
});
const SnapshotValidator = Compile(SnapshotSchema);
const BoundarySchema = Type.Union([
  Type.String(),
  Type.Array(Type.String()),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Partial(SnapshotSchema),
]);
export type BrowserActivityBoundary =
  | BrowserActivitySnapshot
  | ReadonlyArray<string>
  | string
  | number
  | boolean
  | null
  | Partial<BrowserActivitySnapshot>;
const BoundaryValidator = Compile(BoundarySchema);
type UsageContract = { tokens?: number; contextWindow?: number };
const StringValidator = Compile(Type.String());
const ArrayValidator = Compile(Type.Array(Type.String()));

function clean(text: string) {
  return Array.from(text)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        code <= 0x08 ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
      );
    })
    .join("");
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

function number(value: number | undefined, fallback = 0) {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function id(value: string): PublicChildId | undefined {
  const result = line(value, BROWSER_ACTIVITY_LIMITS.maxChildIdLength);
  return result.length > 0 &&
    result.length <= BROWSER_ACTIVITY_LIMITS.maxChildIdLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)
    ? result
    : undefined;
}

export function toPublicChildId(value: string): PublicChildId | undefined {
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
    if (!text) return undefined;
    const result: MutableThinkingItem = {
      kind: "thinking",
      text,
    };
    if (part.redacted !== undefined) result.redacted = part.redacted;
    return result;
  }
  const name = line(part.name, BROWSER_ACTIVITY_LIMITS.maxToolNameLength);
  if (!name) return undefined;
  const args = part.argsPreview
    ? bounded(part.argsPreview, BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)
    : undefined;
  const result: MutableToolItem = {
    kind: "tool",
    name,
  };
  if (args) result.args = args;
  return result;
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
  const result: MutableToolItem = {
    kind: "tool",
    name,
    isError: item.isError,
  };
  if (output) result.output = output;
  return [result];
}

function publicTool(tool: LiveToolState): BrowserActivityToolSnapshot {
  const args = tool.argsPreview
    ? bounded(tool.argsPreview, BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)
    : undefined;
  const output = tool.outputPreview
    ? bounded(tool.outputPreview, BROWSER_ACTIVITY_LIMITS.maxToolOutputLength)
    : undefined;
  const result: MutableToolSnapshot = {
    name: line(tool.name, BROWSER_ACTIVITY_LIMITS.maxToolNameLength),
    startedAt: number(tool.startedAt),
    updatedAt: number(tool.updatedAt),
  };
  if (args) result.args = args;
  if (output) result.output = output;
  if (tool.isError !== undefined) result.isError = tool.isError;
  return result;
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
  if (!tokens && !contextWindow) return undefined;
  const result: UsageContract = {};
  if (tokens) result.tokens = tokens;
  if (contextWindow) result.contextWindow = contextWindow;
  return result;
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
  const result: MutableChildSnapshot = {
    id: id(snapshot.id) ?? "unknown",
    backend: snapshot.backend,
    title: line(snapshot.title, BROWSER_ACTIVITY_LIMITS.maxTitleLength),
    status: "running",
    prompt: bounded(snapshot.prompt, BROWSER_ACTIVITY_LIMITS.maxPromptLength),
    output: bounded(output, BROWSER_ACTIVITY_LIMITS.maxOutputLength),
    transcript: snapshot.transcript
      .flatMap(transcriptItem)
      .slice(-BROWSER_ACTIVITY_LIMITS.maxTranscriptItems),
    tools: snapshot.liveTools
      .slice(0, BROWSER_ACTIVITY_LIMITS.maxToolCount)
      .map(publicTool),
    queued,
    startedAt: number(snapshot.createdAt),
    lastActivityAt: number(snapshot.lastActivityAt),
  };
  if (model) result.model = model;
  if (reasoningEffort) result.reasoningEffort = reasoningEffort;
  if (failure) result.failure = failure;
  if (snapshot.settledAt !== undefined)
    result.settledAt = number(snapshot.settledAt);
  if (childUsage) result.usage = childUsage;
  return result;
}

/** Project one terminal transition without exposing manager/session metadata. */
export function projectBrowserTerminal(
  snapshot: SubagentSnapshot,
): BrowserActivityTerminalSnapshot | undefined {
  if (snapshot.status === "running") return undefined;
  const childId = id(snapshot.id);
  if (!childId) return undefined;
  const failure = snapshot.errorText
    ? bounded(snapshot.errorText, BROWSER_ACTIVITY_LIMITS.maxFailureLength)
    : undefined;
  const result: MutableTerminalSnapshot = {
    id: childId,
    title: line(snapshot.title, BROWSER_ACTIVITY_LIMITS.maxTitleLength),
    status: snapshot.status,
    output: bounded(
      snapshot.finalText,
      BROWSER_ACTIVITY_LIMITS.maxOutputLength,
    ),
    settledAt: number(snapshot.settledAt ?? snapshot.lastActivityAt),
  };
  if (failure) result.failure = failure;
  return result;
}

/** Project live children; terminal history is passed separately once. */
export function projectBrowserActivity(
  snapshots: ReadonlyArray<SubagentSnapshot>,
  revision: number,
  terminal?: SubagentSnapshot,
  now = Date.now(),
): BrowserActivitySnapshot {
  const children = snapshots
    .filter(
      (snapshot) =>
        snapshot.status === "running" && id(snapshot.id) !== undefined,
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
  const result: MutableSnapshot = {
    version: BROWSER_ACTIVITY_PROTOCOL_VERSION,
    revision: number(revision),
    generatedAt: number(now),
    children,
  };
  if (terminalSnapshot) result.terminal = terminalSnapshot;
  return result;
}

export const projectBrowserSnapshot = projectBrowserActivity;

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
const TRANSCRIPT_USER_KEYS = ["kind", "text"] as const;
const TRANSCRIPT_ASSISTANT_KEYS = ["kind", "text"] as const;
const TRANSCRIPT_THINKING_KEYS = ["kind", "text", "redacted"] as const;
const TRANSCRIPT_TOOL_KEYS = [
  "kind",
  "name",
  "args",
  "output",
  "isError",
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
const SNAPSHOT_KEYS = [
  "version",
  "revision",
  "generatedAt",
  "children",
  "terminal",
] as const;
type ProtocolObject =
  | Static<typeof SnapshotSchema>
  | Static<typeof ChildSchema>
  | Static<typeof ToolSchema>
  | Static<typeof TerminalSchema>
  | Static<typeof TranscriptSchema>
  | Static<typeof QueuedSchema>
  | Static<typeof UsageSchema>;
function onlyKeys(value: ProtocolObject, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validText(value: string, maxLength: number) {
  return Array.from(value).length <= maxLength;
}

function validChild(value: Static<typeof ChildSchema>): boolean {
  return (
    onlyKeys(value, CHILD_KEYS) &&
    id(value.id) === value.id &&
    value.transcript.every(validTranscript) &&
    value.tools.every(validTool) &&
    value.queued.every(validQueued) &&
    Number.isFinite(value.startedAt) &&
    Number.isFinite(value.lastActivityAt) &&
    (value.settledAt === undefined || Number.isFinite(value.settledAt)) &&
    (value.usage === undefined || validUsage(value.usage))
  );
}

function validTool(value: Static<typeof ToolSchema>): boolean {
  return (
    onlyKeys(value, TOOL_KEYS) &&
    validText(value.name, BROWSER_ACTIVITY_LIMITS.maxToolNameLength) &&
    (value.args === undefined ||
      validText(value.args, BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)) &&
    (value.output === undefined ||
      validText(value.output, BROWSER_ACTIVITY_LIMITS.maxToolOutputLength)) &&
    Number.isFinite(value.startedAt) &&
    Number.isFinite(value.updatedAt)
  );
}

function validTranscript(value: Static<typeof TranscriptSchema>): boolean {
  if (value.kind === "user")
    return (
      onlyKeys(value, TRANSCRIPT_USER_KEYS) &&
      validText(value.text, BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength)
    );
  if (value.kind === "assistant")
    return (
      onlyKeys(value, TRANSCRIPT_ASSISTANT_KEYS) &&
      validText(value.text, BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength)
    );
  if (value.kind === "thinking")
    return (
      onlyKeys(value, TRANSCRIPT_THINKING_KEYS) &&
      validText(value.text, BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength)
    );
  return (
    onlyKeys(value, TRANSCRIPT_TOOL_KEYS) &&
    validText(value.name, BROWSER_ACTIVITY_LIMITS.maxToolNameLength) &&
    (value.args === undefined ||
      validText(value.args, BROWSER_ACTIVITY_LIMITS.maxToolArgsLength)) &&
    (value.output === undefined ||
      validText(value.output, BROWSER_ACTIVITY_LIMITS.maxToolOutputLength))
  );
}

function validUsage(value: Static<typeof UsageSchema>) {
  return (
    onlyKeys(value, ["tokens", "contextWindow"]) &&
    (value.tokens === undefined || Number.isFinite(value.tokens)) &&
    (value.contextWindow === undefined || Number.isFinite(value.contextWindow))
  );
}

function validQueued(value: Static<typeof QueuedSchema>) {
  return (
    onlyKeys(value, ["kind", "text"]) &&
    validText(value.text, BROWSER_ACTIVITY_LIMITS.maxQueuedTextLength)
  );
}

function withinSnapshotByteLimit(value: BrowserActivitySnapshot): boolean {
  const serialized = JSON.stringify(value);
  return (
    serialized !== undefined &&
    Buffer.byteLength(serialized, "utf8") <=
      BROWSER_ACTIVITY_LIMITS.maxSnapshotBytes
  );
}

function validTerminal(value: Static<typeof TerminalSchema>): boolean {
  return (
    onlyKeys(value, TERMINAL_KEYS) &&
    id(value.id) === value.id &&
    validText(value.title, BROWSER_ACTIVITY_LIMITS.maxTitleLength) &&
    validText(value.output, BROWSER_ACTIVITY_LIMITS.maxOutputLength) &&
    (value.failure === undefined ||
      validText(value.failure, BROWSER_ACTIVITY_LIMITS.maxFailureLength)) &&
    Number.isFinite(value.settledAt)
  );
}

/** Runtime validation for both locally-produced and widget-decoded values. */
function isBrowserActivitySnapshotValue(
  value: BrowserActivityBoundary,
  enforceByteLimit: boolean,
): value is BrowserActivitySnapshot {
  if (
    !BoundaryValidator.Check(value) ||
    !SnapshotValidator.Check(value) ||
    !onlyKeys(value, SNAPSHOT_KEYS)
  )
    return false;
  const snapshot = value;
  const ids = new Set(snapshot.children.map((child) => child.id));
  return (
    Number.isSafeInteger(snapshot.revision) &&
    snapshot.revision >= 0 &&
    (!enforceByteLimit || withinSnapshotByteLimit(snapshot)) &&
    ids.size === snapshot.children.length &&
    snapshot.children.every(validChild) &&
    (snapshot.terminal === undefined || validTerminal(snapshot.terminal))
  );
}

export function isBrowserActivitySnapshot(
  value: BrowserActivityBoundary,
): value is BrowserActivitySnapshot {
  return isBrowserActivitySnapshotValue(value, true);
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
  const compact: MutableSnapshot = {
    ...snapshot,
    children: snapshot.children.map((child) => {
      const result: MutableChildSnapshot = {
        ...child,
        model: child.model ? boundedUtf8(child.model, 256) : undefined,
        title: boundedUtf8(child.title, 256),
        prompt: "",
        output: boundedUtf8(child.output, 1_024),
        transcript: [],
        tools: [],
        queued: child.queued.slice(0, 1).map((message) => ({
          kind: message.kind,
          text: boundedUtf8(message.text, 128),
        })),
      };
      if (child.failure) result.failure = boundedUtf8(child.failure, 1_024);
      return result;
    }),
  };
  if (snapshot.terminal) {
    const terminal: MutableTerminalSnapshot = {
      ...snapshot.terminal,
      title: boundedUtf8(snapshot.terminal.title, 256),
      output: boundedUtf8(snapshot.terminal.output, 1_024),
    };
    if (snapshot.terminal.failure)
      terminal.failure = boundedUtf8(snapshot.terminal.failure, 1_024);
    compact.terminal = terminal;
  }
  if (
    Buffer.byteLength(JSON.stringify(compact), "utf8") <=
    BROWSER_ACTIVITY_LIMITS.maxSnapshotBytes
  ) {
    return compact;
  }

  return {
    ...compact,
    children: compact.children.map((child) => {
      const result: MutableChildSnapshot = {
        ...child,
        title: boundedUtf8(child.title, 128),
        model: child.model ? boundedUtf8(child.model, 128) : undefined,
        output: boundedUtf8(child.output, 256),
        queued:
          child.queued.length > 0
            ? [{ kind: child.queued[0]?.kind ?? "steer", text: "" }]
            : [],
      };
      if (child.failure) result.failure = boundedUtf8(child.failure, 256);
      return result;
    }),
  };
}
/** Encode one canonical JSON line for `ctx.ui.setWidget`. */
export function encodeBrowserActivitySnapshot(
  snapshot: BrowserActivitySnapshot,
): string {
  if (!isBrowserActivitySnapshotValue(snapshot, false)) {
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
  value: BrowserActivityBoundary,
): BrowserActivitySnapshot | undefined {
  let parsed: BrowserActivityBoundary = value;
  if (ArrayValidator.Check(value)) {
    if (value.length !== 1) return undefined;
    parsed = value[0] ?? null;
  }
  if (StringValidator.Check(parsed)) {
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
  value: BrowserActivityBoundary,
): string | undefined {
  const snapshot = decodeBrowserActivitySnapshot(value);
  return snapshot ? encodeBrowserActivitySnapshot(snapshot) : undefined;
}

export function nextBrowserActivityRevision(previous: number) {
  const revision =
    Number.isSafeInteger(previous) && previous >= 0 ? previous : 0;
  return revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1;
}
