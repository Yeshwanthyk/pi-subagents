import type { TerminalSubagentStatus } from "./domain.ts";
import type { ParentResultEnvelope } from "./parent-mailbox.ts";
import {
  buildSubagentResultBatchMessage,
  type SubagentResultCard,
} from "./prompt.ts";

export interface ParentResultBatchDetails {
  readonly results: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: TerminalSubagentStatus;
  }>;
}

export interface ParentResultBatchMessage {
  readonly customType: "subagent-result-batch";
  readonly content: string;
  readonly display: true;
  readonly details: ParentResultBatchDetails;
}

export const PARENT_RESULT_BATCH_OPTIONS = {
  deliverAs: "followUp",
  triggerTurn: true,
} as const;

/** Build the public parent message without carrying runtime ParentRef data. */
export function buildParentResultBatchMessage(
  batch: ReadonlyArray<ParentResultEnvelope>,
): ParentResultBatchMessage {
  const cards: ReadonlyArray<SubagentResultCard> = batch.map((result) => ({
    id: result.id,
    title: result.title,
    status: result.status,
    error: result.error,
    output: result.output,
  }));
  return {
    customType: "subagent-result-batch",
    content: buildSubagentResultBatchMessage(cards),
    display: true,
    details: {
      results: batch.map((result) => ({
        id: result.id,
        title: result.title,
        status: result.status,
      })),
    },
  };
}
