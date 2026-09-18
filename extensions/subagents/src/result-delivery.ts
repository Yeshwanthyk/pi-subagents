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
export const COMPACT_ACCEPTANCE_REASON_MAX_BYTES = 512;

function boundedUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "…";
  const characters = Array.from(text);
  while (
    characters.length > 0 &&
    Buffer.byteLength(characters.join("") + marker, "utf8") > maxBytes
  ) {
    characters.pop();
  }
  return characters.join("") + marker;
}

function singleLine(text: string): string {
  return text
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function compactAcceptanceReason(reason: string): string {
  return boundedUtf8(singleLine(reason), COMPACT_ACCEPTANCE_REASON_MAX_BYTES);
}

/** The report remains manager-owned; routine gated delivery carries only the verdict. */
export function compactGatedReportNotice(id: string): string {
  return `Full report retained; retrieve it with subagent_inspect({ id: ${JSON.stringify(id)} }).`;
}

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

function gatedVerdict(snapshot: SubagentSnapshot): string | undefined {
  switch (snapshot.acceptance?.status) {
    case "pass":
      return "passed acceptance";
    case "reject":
      return "was rejected by acceptance";
    case "error":
      return "acceptance failed";
    default:
      return undefined;
  }
}

function compactAcceptanceDetails(
  acceptance: SubagentSnapshot["acceptance"],
): SubagentSnapshot["acceptance"] {
  if (
    acceptance === undefined ||
    !("reason" in acceptance) ||
    acceptance.reason === undefined
  ) {
    return acceptance;
  }
  return {
    status: acceptance.status,
    reason: compactAcceptanceReason(acceptance.reason),
  };
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
      readonly acceptance?: SubagentSnapshot["acceptance"];
    }>;
  };
}

/**
 * Build settled wait output. Ungated children retain the established report
 * delivery; gated children default to a compact verdict and explicit retrieval
 * pointer so the evaluated report is not duplicated into routine context.
 */
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

    const verdict = gatedVerdict(snap);
    let section: string;
    if (verdict !== undefined) {
      section = `## ${snap.id} "${snap.title}" ${verdict}`;
      if (snap.errorText) {
        section += `\nError: ${compactAcceptanceReason(snap.errorText)}`;
      }
      if (
        snap.acceptance &&
        "reason" in snap.acceptance &&
        snap.acceptance.reason
      ) {
        section += `\nAcceptance: ${snap.acceptance.status} — ${compactAcceptanceReason(snap.acceptance.reason)}`;
      }
      section += `\n\n${compactGatedReportNotice(snap.id)}`;
    } else {
      const verb =
        snap.status === "error"
          ? "failed"
          : snap.acceptance?.status === "pending"
            ? "finished process; acceptance pending"
            : "finished";
      section = `## ${snap.id} "${snap.title}" ${verb}`;
      if (snap.errorText) section += `\nError: ${snap.errorText}`;
      const headerBytes = Buffer.byteLength(section, "utf8") + 2;
      const outputBudget = Math.max(
        512,
        Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
      );
      section += `\n\n${truncatedOutput(snap, outputBudget)}`;
    }

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
      results: inputs.map(({ id, snapshot }) => {
        const detail = {
          id,
          title: snapshot?.title,
          status: snapshot?.status,
        };
        const acceptance = compactAcceptanceDetails(snapshot?.acceptance);
        return acceptance === undefined ? detail : { ...detail, acceptance };
      }),
    },
  };
}
