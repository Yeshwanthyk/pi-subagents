import type { ParentQuestion } from "./domain.ts";
import type { TerminalSubagentStatus } from "./domain.ts";
import type { ParentResultEnvelope } from "./parent-mailbox.ts";
import {
  buildSubagentResultBatchMessage,
  type SubagentResultCard,
} from "./prompt.ts";
import { compactGatedReportNotice } from "./result-delivery.ts";

export interface ParentResultBatchDetails {
  readonly results: ReadonlyArray<{
    readonly kind?: "workflow";
    readonly id: string;
    readonly title: string;
    readonly status: TerminalSubagentStatus;
    readonly acceptance?: ParentResultEnvelope["acceptance"];
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
    output:
      result.acceptance === undefined
        ? result.output
        : compactGatedReportNotice(result.id),
    acceptance: result.acceptance,
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
  if (result.kind === undefined && result.acceptance === undefined)
    return detail;
  if (result.kind === undefined) {
    return { ...detail, acceptance: result.acceptance };
  }
  if (result.acceptance === undefined) return { ...detail, kind: result.kind };
  return {
    ...detail,
    kind: result.kind,
    acceptance: result.acceptance,
  };
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

export interface ParentQuestionBatchDetails {
  readonly questions: ReadonlyArray<{
    readonly childId: string;
    readonly requestId: string;
    readonly question: string;
    readonly context?: string;
    readonly deadlineAt: number;
  }>;
}

export interface ParentQuestionBatchMessage {
  readonly customType: "subagent-question-batch";
  readonly content: string;
  readonly display: true;
  readonly details: ParentQuestionBatchDetails;
}

export const PARENT_QUESTION_BATCH_OPTIONS = {
  deliverAs: "followUp",
  triggerTurn: true,
} as const;

/** Build a bounded public notification without carrying runtime ParentRef data. */
export function buildParentQuestionBatchMessage(
  batch: ReadonlyArray<ParentQuestion>,
): ParentQuestionBatchMessage {
  const questions = batch.map((question) => {
    const deadline = new Date(question.deadlineAt).toISOString();
    const context =
      question.context === undefined ? "" : `\nContext: ${question.context}`;
    return `Child ${question.childId} asks (request ${question.requestId}, deadline ${deadline}): ${question.question}${context}\nReply with subagent_send using mode=reply and the exact requestId. Steering cancels this question; follow_up does not answer it.`;
  });
  return {
    customType: "subagent-question-batch",
    content: questions.join("\n\n"),
    display: true,
    details: {
      questions: batch.map(({ childId, requestId, question, context, deadlineAt }) =>
        context === undefined
          ? { childId, requestId, question, deadlineAt }
          : { childId, requestId, question, context, deadlineAt },
      ),
    },
  };
}
