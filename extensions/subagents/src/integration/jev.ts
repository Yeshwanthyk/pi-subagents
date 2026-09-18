/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Pi validates tool parameters with the declared TypeBox schema; adapters bridge equivalent owner-validated Jev/workflow contracts. */

import { Type, type Static } from "typebox";
import {
  JEV_LIMITS,
  type JevEvaluationResult,
  type JevEvaluator,
  type JevQuestions,
} from "../jev/domain.ts";
import type {
  WorkflowEvaluationRequest,
  WorkflowEvaluator,
} from "../workflows/evaluator.ts";
import {
  ASK_JEV_PARAMETER_DESCRIPTIONS,
  ASK_JEV_PROMPT_GUIDELINES,
  ASK_JEV_PROMPT_SNIPPET,
  ASK_JEV_TOOL_DESCRIPTION,
} from "../prompt.ts";

const choiceQuestion = Type.Object(
  {
    type: Type.Literal("choice"),
    question: Type.String(),
    options: Type.Array(Type.String(), { minItems: 2, maxItems: 16 }),
  },
  { additionalProperties: false },
);
const scoreQuestion = Type.Object(
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

export const ASK_JEV_PARAMETERS = Type.Object(
  {
    state: Type.String({ description: ASK_JEV_PARAMETER_DESCRIPTIONS.state }),
    questions: Type.Record(
      Type.String(),
      Type.Union([choiceQuestion, scoreQuestion]),
      { description: ASK_JEV_PARAMETER_DESCRIPTIONS.questions },
    ),
  },
  { additionalProperties: false },
);
export type AskJevParams = Static<typeof ASK_JEV_PARAMETERS>;

export interface AskJevToolDependencies {
  readonly getEvaluator: (context: {
    readonly cwd: string;
    readonly projectTrusted: boolean;
  }) => JevEvaluator | Promise<JevEvaluator>;
}

function resultText(result: JevEvaluationResult) {
  if (!result.ok)
    return `Jev unavailable (${result.error.code}): ${result.error.message}`;
  return JSON.stringify(
    { answers: result.answers, metadata: result.metadata },
    null,
    2,
  );
}

/** Parent-only public tool. The evaluator owns validation, budgets, and cancellation. */
export function createAskJevTool(dependencies: AskJevToolDependencies) {
  return {
    name: "ask_jev",
    label: "Ask Jev",
    description: ASK_JEV_TOOL_DESCRIPTION,
    promptSnippet: ASK_JEV_PROMPT_SNIPPET,
    promptGuidelines: [...ASK_JEV_PROMPT_GUIDELINES],
    parameters: ASK_JEV_PARAMETERS,
    async execute(
      _toolCallId: string,
      params: AskJevParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { readonly cwd: string; isProjectTrusted(): boolean },
    ) {
      let evaluator: JevEvaluator;
      try {
        evaluator = await dependencies.getEvaluator({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        });
      } catch {
        const result: JevEvaluationResult = {
          ok: false,
          error: {
            code: "not_configured",
            message: "Jev configuration is invalid or unreadable",
          },
        };
        return {
          content: [{ type: "text" as const, text: resultText(result) }],
          details: result,
        };
      }
      const result: JevEvaluationResult = await evaluator.evaluate(
        params as unknown as {
          readonly state: string;
          readonly questions: JevQuestions;
        },
        { signal },
      );
      return {
        content: [{ type: "text" as const, text: resultText(result) }],
        details: result,
      };
    },
  };
}

/** Adapt the shared Jev client to the workflow-owned evaluator interface. */
export function createJevWorkflowEvaluator(
  evaluator: JevEvaluator,
): WorkflowEvaluator {
  return {
    async evaluate(
      payload: WorkflowEvaluationRequest,
      context?: { readonly signal?: AbortSignal },
    ) {
      return evaluator.evaluate(
        { state: payload.state, questions: payload.questions as JevQuestions },
        { signal: context?.signal },
      );
    },
  };
}
