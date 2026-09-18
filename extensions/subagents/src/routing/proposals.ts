/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-conditional-empty-object-spread -- Proposal inputs cross a generic tool boundary and are snapshotted as bounded JSON data. */
import { createHash, randomBytes } from "node:crypto";
import type {
  ResolvedRoutingProposal,
  SettingsSnapshot,
  SubagentSettings,
} from "./domain.ts";

const MAX_BATCH_ITEMS = 64;
const MAX_BINDING_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_INPUT_NODES = 10_000;
const DEFAULT_MAX_PROPOSALS = 128;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type ProposalInputValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<ProposalInputValue>
  | { readonly [key: string]: ProposalInputValue };

export interface BatchProposalItemInput {
  /** Complete caller-owned spawn/tool input, including task text, cwd and scope. */
  readonly input: unknown;
  readonly runtime: ResolvedRoutingProposal;
  readonly settings: SettingsSnapshot;
}

export interface BatchProposalItem {
  readonly input: ProposalInputValue;
  readonly runtime: ResolvedRoutingProposal;
  readonly settings: SubagentSettings;
  readonly settingsDigest: string;
}

export type BatchProposalStatus = "pending" | "approved";

export interface BatchProposal {
  readonly id: string;
  readonly sessionId: string;
  readonly preparedAtUserInput: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly bindingDigest: string;
  readonly status: BatchProposalStatus;
  readonly approvalSource?: "newer_user_response" | "explicit_runtime";
  readonly approvedAtUserInput?: number;
  readonly items: ReadonlyArray<BatchProposalItem>;
}

export interface CreateBatchProposalInput {
  readonly sessionId: string;
  readonly preparedAtUserInput: number;
  readonly items: ReadonlyArray<BatchProposalItemInput>;
  readonly ttlMs?: number;
}

export interface ApproveBatchProposalInput {
  readonly sessionId: string;
  readonly userInput: number;
  /** The digest displayed for review. Prevents approving changed caller inputs. */
  readonly bindingDigest: string;
}

export interface BatchProposalStoreOptions {
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly maxProposals?: number;
}

interface SnapshotBudget {
  depth: number;
  nodes: number;
  bytes: number;
  readonly ancestors: WeakSet<object>;
}

function newSnapshotBudget(): SnapshotBudget {
  return { depth: 0, nodes: 0, bytes: 0, ancestors: new WeakSet() };
}

function snapshotJson(
  value: unknown,
  budget: SnapshotBudget = newSnapshotBudget(),
): ProposalInputValue {
  budget.nodes++;
  if (budget.nodes > MAX_INPUT_NODES)
    throw new Error(`Proposal input exceeds ${MAX_INPUT_NODES} values`);
  const addBytes = (text: string): void => {
    budget.bytes += Buffer.byteLength(text, "utf8");
    if (budget.bytes > MAX_BINDING_BYTES)
      throw new Error(`Proposal input exceeds ${MAX_BINDING_BYTES} bytes`);
  };
  if (budget.depth > MAX_DEPTH)
    throw new Error(`Proposal input exceeds maximum depth ${MAX_DEPTH}`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    addBytes(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Proposal input contains a non-finite number");
    return value;
  }
  if (typeof value !== "object")
    throw new Error("Proposal input must contain only JSON values");
  if (budget.ancestors.has(value))
    throw new Error("Proposal input cannot contain cycles");
  budget.ancestors.add(value);
  budget.depth++;
  if (Array.isArray(value)) {
    const result = Object.freeze(
      value.map((item) => snapshotJson(item, budget)),
    );
    budget.depth--;
    budget.ancestors.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Proposal input must contain only plain objects");
  const output: Record<string, ProposalInputValue> = {};
  for (const key of Object.keys(value)) {
    addBytes(key);
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`Proposal input contains unsafe key "${key}"`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      throw new Error("Proposal input cannot contain accessors");
    output[key] = snapshotJson(descriptor.value, budget);
  }
  budget.depth--;
  budget.ancestors.delete(value);
  return Object.freeze(output);
}

function stableJson(value: ProposalInputValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as { readonly [key: string]: ProposalInputValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key]!)}`)
    .join(",")}}`;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      freeze(child);
  }
  return value;
}

function digest(items: ReadonlyArray<BatchProposalItem>): string {
  const serializable = snapshotJson(items);
  const encoded = stableJson(serializable);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BINDING_BYTES) {
    throw new Error(
      `Batch proposal binding exceeds ${MAX_BINDING_BYTES} bytes`,
    );
  }
  return createHash("sha256").update(encoded).digest("hex");
}

/** Session-memory approval authority. It deliberately has no spawn callback. */
export class SessionBatchProposalStore {
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #maxProposals: number;
  readonly #proposals = new Map<string, BatchProposal>();

  constructor(options: BatchProposalStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId =
      options.createId ?? (() => `route_${randomBytes(8).toString("hex")}`);
    this.#maxProposals = options.maxProposals ?? DEFAULT_MAX_PROPOSALS;
    if (!Number.isSafeInteger(this.#maxProposals) || this.#maxProposals < 1)
      throw new Error("Batch proposal capacity must be a positive integer");
  }

  create(input: CreateBatchProposalInput): BatchProposal {
    this.#pruneExpired();
    if (this.#proposals.size >= this.#maxProposals)
      throw new Error(`Batch proposal capacity ${this.#maxProposals} is full`);
    if (!input.sessionId)
      throw new Error("Batch proposal requires a session ID");
    if (
      !Number.isSafeInteger(input.preparedAtUserInput) ||
      input.preparedAtUserInput < 0
    ) {
      throw new Error("Batch proposal requires a valid user-input boundary");
    }
    if (input.items.length < 1 || input.items.length > MAX_BATCH_ITEMS) {
      throw new Error(`Batch proposal requires 1 to ${MAX_BATCH_ITEMS} items`);
    }
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new Error("Batch proposal TTL must be a positive integer");
    const snapshotBudget = newSnapshotBudget();
    const items = input.items.map((item): BatchProposalItem => {
      if (item.runtime.status !== "resolved")
        throw new Error("Only resolved runtimes can be proposed");
      if (item.runtime.configDigest !== item.settings.digest) {
        throw new Error(
          "Runtime proposal and settings snapshot digests do not match",
        );
      }
      return freeze({
        input: snapshotJson(item.input, snapshotBudget),
        runtime: snapshotJson(
          item.runtime,
          snapshotBudget,
        ) as unknown as ResolvedRoutingProposal,
        settings: snapshotJson(
          item.settings.settings,
          snapshotBudget,
        ) as unknown as SubagentSettings,
        settingsDigest: item.settings.digest,
      });
    });
    const bindingDigest = digest(items);
    const createdAt = this.#now();
    const requiresApproval = items.some(
      (item) => item.runtime.requiresApproval,
    );
    const id = this.#createId();
    if (!id || this.#proposals.has(id))
      throw new Error("Batch proposal ID must be unique");
    const proposal = freeze({
      id,
      sessionId: input.sessionId,
      preparedAtUserInput: input.preparedAtUserInput,
      createdAt,
      expiresAt: createdAt + ttlMs,
      bindingDigest,
      status: requiresApproval ? ("pending" as const) : ("approved" as const),
      ...(requiresApproval
        ? {}
        : {
            approvalSource: "explicit_runtime" as const,
            approvedAtUserInput: input.preparedAtUserInput,
          }),
      items: Object.freeze(items),
    });
    this.#proposals.set(id, proposal);
    return proposal;
  }

  get(id: string): BatchProposal | undefined {
    const proposal = this.#proposals.get(id);
    if (proposal !== undefined && this.#now() >= proposal.expiresAt) {
      this.#proposals.delete(id);
      return undefined;
    }
    return proposal;
  }

  approve(id: string, input: ApproveBatchProposalInput): BatchProposal {
    const proposal = this.#proposals.get(id);
    if (proposal === undefined)
      throw new Error(`Unknown batch proposal "${id}"`);
    if (this.#now() >= proposal.expiresAt) {
      this.#proposals.delete(id);
      throw new Error(`Batch proposal "${id}" has expired`);
    }
    if (proposal.sessionId !== input.sessionId)
      throw new Error("Batch proposal belongs to a different session");
    if (proposal.bindingDigest !== input.bindingDigest)
      throw new Error(
        "Batch proposal inputs do not match the reviewed binding",
      );
    if (proposal.status === "approved") return proposal;
    if (
      !Number.isSafeInteger(input.userInput) ||
      input.userInput <= proposal.preparedAtUserInput
    ) {
      throw new Error(
        "Batch proposal requires a newer user response before approval",
      );
    }
    const approved = freeze({
      ...proposal,
      status: "approved" as const,
      approvalSource: "newer_user_response" as const,
      approvedAtUserInput: input.userInput,
    });
    this.#proposals.set(id, approved);
    return approved;
  }

  /** Returns the exact approved snapshot for later admission; never starts work. */
  requireApproved(
    id: string,
    sessionId: string,
    bindingDigest: string,
  ): BatchProposal {
    const proposal = this.get(id);
    if (proposal === undefined)
      throw new Error(`Batch proposal "${id}" is missing or expired`);
    if (proposal.sessionId !== sessionId)
      throw new Error("Batch proposal belongs to a different session");
    if (proposal.bindingDigest !== bindingDigest)
      throw new Error(
        "Batch proposal inputs do not match the reviewed binding",
      );
    if (proposal.status !== "approved")
      throw new Error("Batch proposal has not been approved");
    return proposal;
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [id, proposal] of this.#proposals) {
      if (now >= proposal.expiresAt) this.#proposals.delete(id);
    }
  }

  clear(): void {
    this.#proposals.clear();
  }
}
