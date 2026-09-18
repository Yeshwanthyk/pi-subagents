/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Pi validates the declarative TypeBox gate schema before it is adapted to the equivalent Jev domain contract. */

import { Buffer } from "node:buffer";
import { Type, type Static } from "typebox";
import type {
  SubagentAcceptanceRequest,
  SubagentAcceptanceResult,
  SubagentSnapshot,
} from "../domain.ts";
import {
  JEV_LIMITS,
  type JevAnswer,
  type JevEvaluator,
  type JevQuestions,
} from "../jev/domain.ts";
import { validateJevInput } from "../jev/validation.ts";

const gateChoiceQuestion = Type.Object(
  {
    type: Type.Literal("choice"),
    question: Type.String(),
    options: Type.Array(Type.String(), { minItems: 2, maxItems: 16 }),
  },
  { additionalProperties: false },
);
const gateScoreQuestion = Type.Object(
  {
    type: Type.Literal("score"),
    question: Type.String(),
    criteria: Type.Array(Type.String(), {
      minItems: 2,
      maxItems: JEV_LIMITS.maxScoreCriteria,
    }),
  },
  { additionalProperties: false },
);

export const STANDALONE_GATE_PARAMETERS = Type.Object(
  {
    evaluator: Type.Literal("jev"),
    questions: Type.Record(
      Type.String(),
      Type.Union([gateChoiceQuestion, gateScoreQuestion]),
    ),
    predicate: Type.Union([
      Type.Object(
        {
          type: Type.Literal("choice_equals"),
          question_id: Type.String(),
          value: Type.String(),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          type: Type.Literal("score_at_least"),
          question_id: Type.String(),
          value: Type.Number(),
        },
        { additionalProperties: false },
      ),
    ]),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
  },
  { additionalProperties: false },
);
export type StandaloneGateParams = Static<typeof STANDALONE_GATE_PARAMETERS>;

const MAX_GATE_EVIDENCE_BYTES = 24 * 1024;

function evidence(snapshot: SubagentSnapshot): string | undefined {
  if (snapshot.finalTextTruncated || snapshot.finalText.trim().length === 0) {
    return undefined;
  }
  const value = JSON.stringify({
    taskGoal: snapshot.prompt,
    report: snapshot.finalText,
    process: {
      status: snapshot.status,
      outcome: snapshot.outcome?._tag,
      error: snapshot.errorText,
    },
    completeness: { report: true, truncated: false },
  });
  return Buffer.byteLength(value, "utf8") <= MAX_GATE_EVIDENCE_BYTES
    ? value
    : undefined;
}

function validatePredicate(gate: StandaloneGateParams): string | undefined {
  const question = gate.questions[gate.predicate.question_id];
  if (!question) return "Gate predicate references an unknown question";
  if (gate.predicate.type === "choice_equals") {
    if (question.type !== "choice")
      return "Gate predicate type does not match its question";
    if (!question.options.includes(gate.predicate.value)) {
      return "Gate predicate choice is not an allowed option";
    }
    return undefined;
  }
  if (question.type !== "score")
    return "Gate predicate type does not match its question";
  if (question.criteria.length > JEV_LIMITS.maxScoreCriteria) {
    return `Gate score questions support at most ${JEV_LIMITS.maxScoreCriteria} criteria`;
  }
  if (
    !Number.isFinite(gate.predicate.value) ||
    gate.predicate.value < 0 ||
    gate.predicate.value > question.criteria.length - 1
  ) {
    return "Gate score threshold is outside the requested scale";
  }
  return undefined;
}

/** Convert reviewed declarative policy into the manager's internal callback seam. */
export function createStandaloneJevAcceptance(
  gate: StandaloneGateParams,
  evaluator: JevEvaluator,
): SubagentAcceptanceRequest {
  const invalid = validatePredicate(gate);
  if (invalid) throw new Error(invalid);
  // Preflight the complete remote question contract before expensive child work.
  validateJevInput(
    { state: "standalone gate preflight", questions: gate.questions },
    "jev-gate-preflight",
  );
  return {
    timeoutMs: gate.timeout_ms ?? 10_000,
    async evaluate(
      snapshot: SubagentSnapshot,
      signal: AbortSignal,
    ): Promise<SubagentAcceptanceResult> {
      const state = evidence(snapshot);
      if (!state) {
        return {
          status: "error",
          reason: "Gate evidence is missing or exceeds the completeness bound.",
        };
      }
      const result = await evaluator.evaluate(
        {
          state,
          questions: gate.questions as unknown as JevQuestions,
        },
        { signal },
      );
      if (!result.ok) {
        return {
          status: "error",
          reason: `Jev gate failed (${result.error.code}): ${result.error.message}`,
        };
      }
      const answer = result.answers[gate.predicate.question_id] as
        JevAnswer | undefined;
      let accepted: boolean;
      if (gate.predicate.type === "choice_equals") {
        accepted =
          answer?.type === "choice" && answer.value === gate.predicate.value;
      } else {
        accepted =
          answer?.type === "score" && answer.value >= gate.predicate.value;
      }
      return accepted
        ? { status: "pass" }
        : { status: "reject", reason: "Jev gate predicate was not satisfied." };
    },
  };
}
