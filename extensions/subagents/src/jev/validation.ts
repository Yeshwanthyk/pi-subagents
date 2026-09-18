/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- This module validates unknown JSON at the remote service boundary before narrowing it. */
import { Buffer } from "node:buffer";
import type {
  JevAnswer,
  JevEvaluationInput,
  JevQuestions,
  JevUsage,
} from "./domain.ts";
import { JEV_LIMITS } from "./domain.ts";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const QUESTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const allowedInputKeys = new Set(["state", "questions"]);
const allowedChoiceKeys = new Set(["type", "question", "options"]);
const allowedScoreKeys = new Set(["type", "question", "criteria"]);

export class JevBoundaryError extends Error {}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JevBoundaryError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new JevBoundaryError(
        `${label} contains unknown field ${JSON.stringify(key)}`,
      );
    }
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new JevBoundaryError(`${label} must be a non-empty string`);
  }
  return value;
}

function stringList(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > maximum) {
    throw new JevBoundaryError(
      `${label} must contain between 2 and ${maximum} strings`,
    );
  }
  const values = value.map((entry, index) =>
    nonEmptyString(entry, `${label}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    throw new JevBoundaryError(`${label} must not contain duplicates`);
  }
  return values;
}

export interface ValidatedJevInput {
  readonly state: string;
  readonly questions: JevQuestions;
  readonly wireQuestions: Readonly<Record<string, unknown>>;
  readonly encodedBytes: number;
}

export function validateJevInput(
  input: unknown,
  model: string,
): ValidatedJevInput {
  const value = record(input, "input");
  exactKeys(value, allowedInputKeys, "input");
  const state = nonEmptyString(value.state, "state");
  const questionsValue = record(value.questions, "questions");
  const entries = Object.entries(questionsValue);
  if (entries.length < 1 || entries.length > JEV_LIMITS.maxQuestions) {
    throw new JevBoundaryError(
      `questions must contain between 1 and ${JEV_LIMITS.maxQuestions} entries`,
    );
  }

  const questions: Record<string, JevQuestions[string]> = Object.create(
    null,
  ) as Record<string, JevQuestions[string]>;
  const wireQuestions: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [name, rawQuestion] of entries) {
    if (!QUESTION_NAME.test(name) || FORBIDDEN_KEYS.has(name)) {
      throw new JevBoundaryError(
        `invalid question name ${JSON.stringify(name)}`,
      );
    }
    const question = record(rawQuestion, `question ${JSON.stringify(name)}`);
    const type = question.type;
    if (type === "choice") {
      exactKeys(
        question,
        allowedChoiceKeys,
        `question ${JSON.stringify(name)}`,
      );
      const prompt = nonEmptyString(question.question, `${name}.question`);
      const options = stringList(
        question.options,
        `${name}.options`,
        JEV_LIMITS.maxChoices,
      );
      if (options.some((option) => FORBIDDEN_KEYS.has(option))) {
        throw new JevBoundaryError(
          `${name}.options contains a forbidden label`,
        );
      }
      questions[name] = {
        type,
        question: prompt,
        options,
      } as JevQuestions[string];
      wireQuestions[name] = {
        type,
        instructions: prompt,
        criteria: Object.fromEntries(options.map((option) => [option, null])),
      };
    } else if (type === "score") {
      exactKeys(question, allowedScoreKeys, `question ${JSON.stringify(name)}`);
      const prompt = nonEmptyString(question.question, `${name}.question`);
      const criteria = stringList(
        question.criteria,
        `${name}.criteria`,
        JEV_LIMITS.maxScoreCriteria,
      );
      questions[name] = {
        type,
        question: prompt,
        criteria,
      } as JevQuestions[string];
      wireQuestions[name] = { type, instructions: prompt, criteria };
    } else {
      throw new JevBoundaryError(`${name}.type must be "choice" or "score"`);
    }
  }

  const encodedBytes = Buffer.byteLength(
    JSON.stringify({ state, model, questions: wireQuestions }),
    "utf8",
  );
  if (encodedBytes > JEV_LIMITS.maxInputBytes) {
    throw new JevBoundaryError(
      `encoded input exceeds ${JEV_LIMITS.maxInputBytes} bytes`,
    );
  }
  return { state, questions, wireQuestions, encodedBytes };
}

function finiteProbability(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new JevBoundaryError(
      `${label} must be a finite number between 0 and 1`,
    );
  }
  return value;
}

function validateLegend(
  raw: unknown,
  criteria: readonly string[],
  label: string,
): void {
  const value = record(raw, label);
  const expectedKeys = criteria.map((_, index) => String(index));
  if (Object.keys(value).length !== expectedKeys.length) {
    throw new JevBoundaryError(
      `${label} must contain exactly the requested scale`,
    );
  }
  for (const [index, criterion] of criteria.entries()) {
    if (value[String(index)] !== criterion) {
      throw new JevBoundaryError(`${label} does not match the requested scale`);
    }
  }
}

function requiredConfidence(
  value: Record<string, unknown>,
  label: string,
): number {
  return finiteProbability(value.confidence, `${label}.confidence`);
}

function probabilities(
  raw: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, number>> {
  const value = record(raw, label);
  if (Object.keys(value).length !== expectedKeys.length) {
    throw new JevBoundaryError(
      `${label} must contain exactly the requested outcomes`,
    );
  }
  const result: Record<string, number> = {};
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new JevBoundaryError(
        `${label} is missing outcome ${JSON.stringify(key)}`,
      );
    }
    result[key] = finiteProbability(value[key], `${label}.${key}`);
  }
  return result;
}

export interface ParsedJevResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: JevUsage;
}

export function parseJevResponse(
  raw: unknown,
  questions: JevQuestions,
): ParsedJevResponse {
  const response = record(raw, "response");
  exactKeys(response, new Set(["model", "answers", "usage"]), "response");
  const model = nonEmptyString(response.model, "response.model");
  const rawAnswers = record(response.answers, "response.answers");
  const names = Object.keys(questions);
  if (
    Object.keys(rawAnswers).length !== names.length ||
    names.some((name) => !Object.hasOwn(rawAnswers, name))
  ) {
    throw new JevBoundaryError(
      "response.answers must exactly match the requested questions",
    );
  }

  const answers: Record<string, JevAnswer> = Object.create(null) as Record<
    string,
    JevAnswer
  >;
  for (const name of names) {
    const question = questions[name];
    if (!question) throw new JevBoundaryError(`missing question ${name}`);
    const answer = record(rawAnswers[name], `response.answers.${name}`);
    if (question.type === "choice") {
      exactKeys(
        answer,
        new Set(["type", "choice", "confidence", "probabilities"]),
        `response.answers.${name}`,
      );
      if (answer.type !== "choice" || typeof answer.choice !== "string") {
        throw new JevBoundaryError(`${name} is not a choice answer`);
      }
      if (!question.options.includes(answer.choice)) {
        throw new JevBoundaryError(`${name}.choice is not a requested option`);
      }
      const confidence = requiredConfidence(answer, name);
      answers[name] = {
        type: "choice",
        value: answer.choice,
        confidence,
        probabilities: probabilities(
          answer.probabilities,
          question.options,
          `${name}.probabilities`,
        ),
      };
    } else {
      exactKeys(
        answer,
        new Set(["type", "score", "confidence", "probabilities", "legend"]),
        `response.answers.${name}`,
      );
      if (
        answer.type !== "score" ||
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1
      ) {
        throw new JevBoundaryError(
          `${name}.score must be finite and within the requested scale`,
        );
      }
      validateLegend(answer.legend, question.criteria, `${name}.legend`);
      const expected = question.criteria.map((_, index) => String(index));
      const confidence = requiredConfidence(answer, name);
      answers[name] = {
        type: "score",
        value: answer.score,
        confidence,
        probabilities: probabilities(
          answer.probabilities,
          expected,
          `${name}.probabilities`,
        ),
      };
    }
  }

  const rawUsage = record(response.usage, "response.usage");
  exactKeys(
    rawUsage,
    new Set(["input_tokens", "output_tokens"]),
    "response.usage",
  );
  if (
    !Number.isSafeInteger(rawUsage.input_tokens) ||
    (rawUsage.input_tokens as number) < 0 ||
    !Number.isSafeInteger(rawUsage.output_tokens) ||
    (rawUsage.output_tokens as number) < 0
  ) {
    throw new JevBoundaryError(
      "response.usage token counts must be non-negative integers",
    );
  }
  const usage: JevUsage = {
    inputTokens: rawUsage.input_tokens as number,
    outputTokens: rawUsage.output_tokens as number,
  };
  return { model, answers, usage };
}

export function assertTypedInput<const Questions extends JevQuestions>(
  input: JevEvaluationInput<Questions>,
): JevEvaluationInput<Questions> {
  return input;
}
