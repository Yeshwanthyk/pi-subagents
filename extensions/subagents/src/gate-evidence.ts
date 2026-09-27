import { Buffer } from "node:buffer";
import type { TranscriptItem } from "./domain.ts";

export const MAX_GATE_OPERATIONS = 24;
const MAX_GATE_PREVIEW_CHARS = 400;

/** One child tool call paired with its result, as shown to a gate evaluator. */
export interface GateOperation {
  readonly tool: string;
  readonly args?: string;
  readonly ok: boolean;
  readonly output?: string;
}

/** Caller-owned evidence fields; each gate names its goal key for its own evaluator contract. */
export interface GateEvidenceFields {
  readonly taskGoal?: string;
  readonly goal?: string;
  readonly report: string;
  readonly process?: {
    readonly status: string;
    readonly outcome?: string;
    readonly error?: string;
  };
}

export interface GateOperations {
  readonly operations: ReadonlyArray<GateOperation>;
  readonly total: number;
}

function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > MAX_GATE_PREVIEW_CHARS
    ? `${text.slice(0, MAX_GATE_PREVIEW_CHARS)}…`
    : text;
}

/** Pair each tool result with its call so the evaluator sees what the child did, not only what it claims. */
export function gateOperations(
  transcript: ReadonlyArray<TranscriptItem>,
): GateOperations {
  const args = new Map<string, string | undefined>();
  const operations: GateOperation[] = [];
  for (const item of transcript) {
    if (item.kind === "assistant") {
      for (const part of item.parts) {
        if (part.type === "toolCall") args.set(part.toolId, part.argsPreview);
      }
    } else if (item.kind === "toolResult") {
      operations.push({
        tool: item.name,
        args: clip(args.get(item.toolId)),
        ok: !item.isError,
        output: clip(item.outputPreview),
      });
    }
  }
  return {
    operations: operations.slice(-MAX_GATE_OPERATIONS),
    total: operations.length,
  };
}

/**
 * Serialize gate evidence within a byte bound, dropping the oldest operations
 * first. The caller's fields (goal, report, …) are never trimmed; undefined
 * means they alone exceed the bound.
 */
export function boundedGateEvidence(
  fields: GateEvidenceFields,
  ops: GateOperations,
  maxBytes: number,
): string | undefined {
  for (let start = 0; start <= ops.operations.length; start++) {
    const kept = ops.operations.slice(start);
    const value = JSON.stringify({
      ...fields,
      operations: kept,
      completeness: {
        report: true,
        truncated: false,
        operationsOmitted: ops.total - kept.length,
      },
    });
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  }
  return undefined;
}
