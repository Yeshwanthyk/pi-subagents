import type { TerminalSubagentStatus } from "./domain.ts";
import type { ParentResultEnvelope } from "./parent-mailbox.ts";
import {
  buildSubagentResultBatchMessage,
  type SubagentResultCard,
} from "./prompt.ts";

export interface ParentResultBatchDetails {
  readonly results: ReadonlyArray<{
    readonly kind?: "workflow";
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

function resultCard(result: ParentResultEnvelope): SubagentResultCard {
  const card: SubagentResultCard = {
    id: result.id,
    title: result.title,
    status: result.status,
    error: result.error,
    output: result.output,
  };
  if (result.kind === undefined) return card;
  return { ...card, kind: result.kind };
}

function resultDetail(
  result: ParentResultEnvelope,
): ParentResultBatchDetails["results"][number] {
  const detail = {
    id: result.id,
    title: result.title,
    status: result.status,
  };
  if (result.kind === undefined) return detail;
  return { ...detail, kind: result.kind };
}

/** Build the public parent message without carrying runtime ParentRef data. */
export function buildParentResultBatchMessage(
  batch: ReadonlyArray<ParentResultEnvelope>,
): ParentResultBatchMessage {
  const cards: ReadonlyArray<SubagentResultCard> = batch.map(resultCard);
  return {
    customType: "subagent-result-batch",
    content: buildSubagentResultBatchMessage(cards),
    display: true,
    details: {
      results: batch.map(resultDetail),
    },
  };
}
