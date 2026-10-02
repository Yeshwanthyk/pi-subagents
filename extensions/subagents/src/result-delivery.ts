import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "./domain.ts";

/**
 * Compatibility exports for the parent-linked result delivery module.
 *
 * Parent results are owned by `parent-mailbox.ts`; this module intentionally
 * contains no independent delivery state.
 */
export {
  createParentMailbox,
  DEFAULT_PARENT_MAILBOX_LIMITS,
  PARENT_RESULT_LIMITS,
  parentResultEnvelope,
  type ParentMailbox,
  type ParentMailboxLimits,
  type ParentResultEnvelope,
  type WorkflowResultEnvelope,
  type ParentResultKind,
} from "./parent-mailbox.ts";

const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = WAIT_PER_AGENT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

export interface WaitResultInput {
  readonly id: string;
  readonly snapshot?: SubagentSnapshot;
}

export interface SubagentWaitResult {
  readonly text: string;
  readonly details: {
    readonly results: ReadonlyArray<{
      readonly id: string;
      readonly title?: string;
      readonly status?: SubagentSnapshot["status"];
    }>;
  };
}

/** Build settled wait output within the per-child and total byte budgets. */
export function buildSubagentWaitResult(
  inputs: ReadonlyArray<WaitResultInput>,
): SubagentWaitResult {
  const sections: string[] = [];
  let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
  for (const input of inputs) {
    const snap = input.snapshot;
    if (!snap) {
      sections.push(`## ${input.id}\n\n(no longer tracked)`);
      continue;
    }

    const verb = snap.status === "error" ? "failed" : "finished";
    let section = `## ${snap.id} "${snap.title}" ${verb}`;
    if (snap.errorText) section += `\nError: ${snap.errorText}`;
    const headerBytes = Buffer.byteLength(section, "utf8") + 2;
    const outputBudget = Math.max(
      512,
      Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
    );
    section += `\n\n${truncatedOutput(snap, outputBudget)}`;

    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (sectionBytes > remainingBytes) {
      sections.push(
        `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
      );
      break;
    }
    sections.push(section);
    remainingBytes -= sectionBytes;
  }

  const combined = sections.join("\n\n---\n\n");
  const bounded = truncateHead(combined, {
    maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
    maxLines: DEFAULT_MAX_LINES,
  });
  const text = bounded.truncated
    ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
    : bounded.content;
  return {
    text,
    details: {
      results: inputs.map(({ id, snapshot }) => ({
        id,
        title: snapshot?.title,
        status: snapshot?.status,
      })),
    },
  };
}

export type WaitMode = "all" | "any";

export interface WaitPartition {
  /** Terminal ids whose results this wait call returns and consumes. */
  readonly returned: ReadonlyArray<string>;
  /** Terminal ids skipped by an "any" wait because they already reached the parent. */
  readonly alreadyDelivered: ReadonlyArray<string>;
  /** Requested ids that are still queued or running. */
  readonly pending: ReadonlyArray<string>;
}

/**
 * Split one wait outcome by delivery state. "all" returns every terminal id,
 * as an explicit collection always has. "any" returns only results that have
 * not already reached the parent, so a result is never handed over twice by
 * successive "any" waits or by automatic delivery.
 */
export function partitionWaitResult(input: {
  readonly mode: WaitMode;
  readonly requestedIds: ReadonlyArray<string>;
  readonly settledIds: ReadonlyArray<string>;
  readonly delivered: (id: string) => boolean;
}): WaitPartition {
  const settled = new Set(input.settledIds);
  const terminal = input.requestedIds.filter((id) => settled.has(id));
  const pending = input.requestedIds.filter((id) => !settled.has(id));
  if (input.mode === "all") {
    return { returned: terminal, alreadyDelivered: [], pending };
  }
  return {
    returned: terminal.filter((id) => !input.delivered(id)),
    alreadyDelivered: terminal.filter((id) => input.delivered(id)),
    pending,
  };
}

/** Footer naming ids the parent should wait on next, and ids skipped as already delivered. */
export function formatWaitRemainder(partition: WaitPartition): string {
  const lines: string[] = [];
  if (partition.alreadyDelivered.length > 0) {
    lines.push(
      `Already delivered earlier (not repeated): ${partition.alreadyDelivered.join(", ")}.`,
    );
  }
  if (partition.pending.length > 0) {
    const ids = partition.pending.map((id) => `"${id}"`).join(", ");
    lines.push(
      `Still running: ${partition.pending.join(", ")}. Call subagent_wait(ids: [${ids}], mode: "any") for the next result.`,
    );
  }
  return lines.join("\n");
}
