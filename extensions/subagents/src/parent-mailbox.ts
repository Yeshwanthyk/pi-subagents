import type { ParentRef, SubagentSnapshot, SubagentStatus } from "./domain.ts";
import { parentRefKey } from "./parent-ref.ts";

export interface ParentResultEnvelope {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly error?: string;
  readonly output: string;
  readonly parentRef: ParentRef;
}

export interface ParentMailboxLimits {
  readonly maxCount: number;
  readonly maxBytes: number;
}

export const DEFAULT_PARENT_MAILBOX_LIMITS: ParentMailboxLimits = {
  maxCount: 32,
  maxBytes: 128 * 1024,
};

export const PARENT_RESULT_LIMITS = {
  maxIdLength: 128,
  maxTitleLength: 160,
  maxErrorBytes: 4 * 1024,
  maxOutputBytes: 24 * 1024,
} as const;

interface MailboxEntry {
  readonly key: string;
  envelope: ParentResultEnvelope;
  bytes: number;
}

function boundedUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) {
    let result = "";
    for (const character of Array.from(text)) {
      const candidate = result + character;
      if (Buffer.byteLength(candidate, "utf8") > maxBytes) break;
      result = candidate;
    }
    return result;
  }

  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = characters.slice(0, middle).join("");
    if (Buffer.byteLength(prefix + marker, "utf8") <= maxBytes) {
      best = prefix;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best + marker;
}

function singleLine(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedTitle(text: string): string {
  const clean = singleLine(text);
  return Array.from(clean).length <= PARENT_RESULT_LIMITS.maxTitleLength
    ? clean
    : `${Array.from(clean)
        .slice(0, PARENT_RESULT_LIMITS.maxTitleLength - 1)
        .join("")}…`;
}

function terminalBytes(envelope: ParentResultEnvelope): number {
  return Buffer.byteLength(
    JSON.stringify({
      id: envelope.id,
      title: envelope.title,
      status: envelope.status,
      error: envelope.error,
      output: envelope.output,
    }),
    "utf8",
  );
}

function normalizeEnvelope(
  envelope: ParentResultEnvelope,
): ParentResultEnvelope {
  const error =
    envelope.error === undefined
      ? undefined
      : boundedUtf8(envelope.error, PARENT_RESULT_LIMITS.maxErrorBytes);
  return {
    id: boundedUtf8(singleLine(envelope.id), PARENT_RESULT_LIMITS.maxIdLength),
    title: boundedTitle(envelope.title),
    status: envelope.status,
    error,
    output: boundedUtf8(
      envelope.output || "(no output)",
      PARENT_RESULT_LIMITS.maxOutputBytes,
    ),
    parentRef: { ...envelope.parentRef },
  };
}

/**
 * Convert a settled snapshot into the only shape that may enter the parent
 * mailbox. It intentionally excludes cwd, model, session-file, and transcript
 * metadata; those stay in the child manager/read model.
 */
export function parentResultEnvelope(
  snapshot: SubagentSnapshot,
): ParentResultEnvelope | undefined {
  if (
    snapshot.parentRef === undefined ||
    snapshot.client !== undefined ||
    snapshot.resultDelivery !== "parent"
  )
    return undefined;
  const error = snapshot.errorText
    ? boundedUtf8(snapshot.errorText, PARENT_RESULT_LIMITS.maxErrorBytes)
    : undefined;
  const output = boundedUtf8(
    snapshot.finalText || "(no output)",
    PARENT_RESULT_LIMITS.maxOutputBytes,
  );
  const id = boundedUtf8(
    singleLine(snapshot.id),
    PARENT_RESULT_LIMITS.maxIdLength,
  );
  return normalizeEnvelope({
    id,
    title: boundedTitle(snapshot.title),
    status: snapshot.status,
    error,
    output,
    parentRef: { ...snapshot.parentRef },
  });
}

export interface ParentMailbox {
  readonly limits: ParentMailboxLimits;
  enqueue(envelope: ParentResultEnvelope): boolean;
  consume(ids: Iterable<string>, parentRef: ParentRef): void;
  drain(parentRef: ParentRef): ReadonlyArray<ParentResultEnvelope>;
  peekMatching(
    predicate: (envelope: ParentResultEnvelope) => boolean,
  ): ReadonlyArray<ParentResultEnvelope>;
  remove(envelopes: ReadonlyArray<ParentResultEnvelope>): void;
  list(): ReadonlyArray<ParentResultEnvelope>;
  clear(parentRef?: ParentRef): void;
  size(): number;
  byteSize(): number;
}

function normalizedLimit(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function createParentMailbox(
  limits: ParentMailboxLimits = DEFAULT_PARENT_MAILBOX_LIMITS,
): ParentMailbox {
  const effectiveLimits: ParentMailboxLimits = {
    maxCount: normalizedLimit(
      limits.maxCount,
      DEFAULT_PARENT_MAILBOX_LIMITS.maxCount,
    ),
    maxBytes: normalizedLimit(
      limits.maxBytes,
      DEFAULT_PARENT_MAILBOX_LIMITS.maxBytes,
    ),
  };
  const entries: MailboxEntry[] = [];
  const byKey = new Map<string, MailboxEntry>();
  let totalBytes = 0;

  const removeAt = (index: number) => {
    const [entry] = entries.splice(index, 1);
    if (entry === undefined) return;
    byKey.delete(entry.key);
    totalBytes -= entry.bytes;
  };

  const trim = () => {
    while (
      entries.length > effectiveLimits.maxCount ||
      totalBytes > effectiveLimits.maxBytes
    ) {
      removeAt(0);
    }
  };

  const enqueue = (input: ParentResultEnvelope): boolean => {
    const envelope = normalizeEnvelope(input);
    const key = `${parentRefKey(envelope.parentRef)}\u0000${envelope.id}`;
    const bytes = terminalBytes(envelope);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      totalBytes -= existing.bytes;
      existing.envelope = envelope;
      existing.bytes = bytes;
      totalBytes += bytes;
      trim();
      return byKey.has(key);
    }

    const entry: MailboxEntry = { key, envelope, bytes };
    entries.push(entry);
    byKey.set(key, entry);
    totalBytes += bytes;
    trim();
    return byKey.has(key);
  };

  const consume = (ids: Iterable<string>, parentRef: ParentRef) => {
    const keys = new Set<string>();
    const refKey = parentRefKey(parentRef);
    for (const id of ids) keys.add(`${refKey}\u0000${id}`);
    for (let index = entries.length - 1; index >= 0; index--) {
      if (keys.has(entries[index]!.key)) removeAt(index);
    }
  };

  const drain = (parentRef: ParentRef) => {
    const drained = entries
      .filter((entry) => entry.envelope.parentRef.epoch === parentRef.epoch)
      .filter(
        (entry) =>
          entry.envelope.parentRef.sessionFile === parentRef.sessionFile &&
          entry.envelope.parentRef.leafId === parentRef.leafId,
      )
      .map((entry) => entry.envelope);
    if (drained.length > 0) {
      const keys = new Set(
        drained.map(
          (envelope) =>
            `${parentRefKey(envelope.parentRef)}\u0000${envelope.id}`,
        ),
      );
      for (let index = entries.length - 1; index >= 0; index--) {
        if (keys.has(entries[index]!.key)) removeAt(index);
      }
    }
    return drained;
  };

  const peekMatching = (
    predicate: (envelope: ParentResultEnvelope) => boolean,
  ) =>
    entries
      .filter((entry) => predicate(entry.envelope))
      .map((entry) => entry.envelope);

  const remove = (envelopes: ReadonlyArray<ParentResultEnvelope>) => {
    const identities = new Set(envelopes);
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (identities.has(entry.envelope)) removeAt(index);
    }
  };

  const clear = (parentRef?: ParentRef) => {
    if (parentRef === undefined) {
      entries.length = 0;
      byKey.clear();
      totalBytes = 0;
      return;
    }
    const refKey = parentRefKey(parentRef);
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]!.key.startsWith(`${refKey}\u0000`)) removeAt(index);
    }
  };

  return {
    limits: effectiveLimits,
    enqueue,
    consume,
    drain,
    peekMatching,
    remove,
    list: () => entries.map((entry) => entry.envelope),
    clear,
    size: () => entries.length,
    byteSize: () => totalBytes,
  };
}
