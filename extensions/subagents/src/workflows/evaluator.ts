/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- This module is the untrusted evaluator input/output boundary and validates descriptor-safe bounded JSON before ownership transfer. */
import { isProxy } from "node:util/types";
import { truncateUtf8, utf8Bytes } from "./events.ts";

export const WORKFLOW_EVALUATION_VERSION = 1 as const;
export const MAX_EVALUATION_STATE_BYTES = 32 * 1024;
export const MAX_EVALUATION_QUESTIONS = 16;
export const MAX_EVALUATION_CHOICES = 16;
export const MAX_EVALUATION_SCORE_CRITERIA = 10;
export const MAX_EVALUATION_TEXT_BYTES = 4 * 1024;
export const MAX_EVALUATION_RESULT_BYTES = 16 * 1024;

export type WorkflowEvaluationQuestion =
  | {
      readonly type: "choice";
      readonly question: string;
      readonly options: readonly [string, string, ...string[]];
    }
  | {
      readonly type: "score";
      readonly question: string;
      readonly criteria: readonly [string, string, ...string[]];
    };

export interface WorkflowEvaluationPayload {
  readonly state: string;
  readonly questions: Readonly<Record<string, WorkflowEvaluationQuestion>>;
}

export type WorkflowEvaluationRequest = WorkflowEvaluationPayload;

export type WorkflowEvaluationAnswer =
  | {
      readonly type: "choice";
      readonly value: string;
      readonly confidence?: number;
    }
  | {
      readonly type: "score";
      readonly value: number;
      readonly confidence?: number;
    };

export interface WorkflowEvaluationResult {
  readonly version: typeof WORKFLOW_EVALUATION_VERSION;
  readonly answers: Readonly<Record<string, WorkflowEvaluationAnswer>>;
}

export type WorkflowGatePredicate =
  | {
      readonly type: "choice_equals";
      readonly questionId: string;
      readonly value: string;
    }
  | {
      readonly type: "score_at_least";
      readonly questionId: string;
      readonly value: number;
    };

export interface WorkflowGateDefinition {
  readonly questions: Readonly<Record<string, WorkflowEvaluationQuestion>>;
  readonly predicate: WorkflowGatePredicate;
}

export interface WorkflowEvaluator {
  evaluate(
    payload: WorkflowEvaluationRequest,
    context?: { readonly signal?: AbortSignal },
  ): Promise<
    | {
        readonly ok: true;
        readonly answers: Readonly<Record<string, WorkflowEvaluationAnswer>>;
      }
    | {
        readonly ok: false;
        readonly error: { readonly code: string; readonly message: string };
      }
  >;
}

export class WorkflowEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowEvaluationError";
  }
}

type Data = Record<string, unknown>;

function fail(message: string): never {
  throw new WorkflowEvaluationError(message);
}
function record(value: unknown, label: string): Data {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value)
  )
    fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    fail(`${label} cannot contain symbol keys`);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor))
      fail(`${label}.${key} cannot be an accessor`);
  }
  return value as Data;
}
function keys(value: Data, allowed: readonly string[], label: string): void {
  for (const key of Object.getOwnPropertyNames(value))
    if (!allowed.includes(key))
      fail(`${label} contains unsupported field "${key}"`);
}
function containsUnsafeControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    )
      return true;
  }
  return false;
}

function text(
  value: unknown,
  label: string,
  max = MAX_EVALUATION_TEXT_BYTES,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Bytes(value) > max ||
    containsUnsafeControl(value)
  )
    fail(`${label} must be bounded non-empty text`);
  return value;
}
function stringArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string[] {
  if (
    !Array.isArray(value) ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  )
    fail(`${label} must contain ${minimum}-${maximum} items`);
  const names = new Set(Object.getOwnPropertyNames(value));
  names.delete("length");
  const output: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor))
      fail(`${label} cannot contain holes or accessors`);
    names.delete(String(index));
    output.push(text(descriptor.value, `${label}[${index}]`));
  }
  if (names.size > 0 || Object.getOwnPropertySymbols(value).length > 0)
    fail(`${label} cannot contain custom properties`);
  return output;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${label} must be finite`);
  return value;
}
function probability(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const normalized = finite(value, label);
  if (normalized < 0 || normalized > 1)
    fail(`${label} must be between 0 and 1`);
  return normalized;
}

export function validateWorkflowQuestions(
  value: unknown,
  label = "evaluation.questions",
): Readonly<Record<string, WorkflowEvaluationQuestion>> {
  const source = record(value, label);
  const ids = Object.getOwnPropertyNames(source);
  if (ids.length === 0 || ids.length > MAX_EVALUATION_QUESTIONS)
    fail(`${label} must contain 1-${MAX_EVALUATION_QUESTIONS} questions`);
  const output: Record<string, WorkflowEvaluationQuestion> =
    Object.create(null);
  for (const id of ids) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(id) ||
      id === "__proto__" ||
      id === "constructor" ||
      id === "prototype"
    )
      fail(`${label} contains an invalid question id`);
    const item = record(source[id], `${label}.${id}`);
    const type = item.type;
    if (type === "choice") {
      keys(item, ["type", "question", "options"], `${label}.${id}`);
      const options = stringArray(
        item.options,
        `${label}.${id}.options`,
        2,
        MAX_EVALUATION_CHOICES,
      );
      if (new Set(options).size !== options.length)
        fail(`${label}.${id}.options must be unique`);
      output[id] = {
        type,
        question: text(item.question, `${label}.${id}.question`),
        options: options as [string, string, ...string[]],
      };
    } else if (type === "score") {
      keys(item, ["type", "question", "criteria"], `${label}.${id}`);
      const criteria = stringArray(
        item.criteria,
        `${label}.${id}.criteria`,
        2,
        MAX_EVALUATION_SCORE_CRITERIA,
      );
      if (new Set(criteria).size !== criteria.length)
        fail(`${label}.${id}.criteria must be unique`);
      output[id] = {
        type,
        question: text(item.question, `${label}.${id}.question`),
        criteria: criteria as [string, string, ...string[]],
      };
    } else fail(`${label}.${id}.type is invalid`);
  }
  return Object.freeze(output);
}

export function validateWorkflowEvaluationPayload(
  value: unknown,
  label = "evaluation",
): WorkflowEvaluationPayload {
  const source = record(value, label);
  keys(source, ["state", "questions"], label);
  return Object.freeze({
    state: text(source.state, `${label}.state`, MAX_EVALUATION_STATE_BYTES),
    questions: validateWorkflowQuestions(
      source.questions,
      `${label}.questions`,
    ),
  });
}

export function validateWorkflowGate(
  value: unknown,
  label = "gate",
): WorkflowGateDefinition {
  const source = record(value, label);
  keys(source, ["questions", "predicate"], label);
  const questions = validateWorkflowQuestions(
    source.questions,
    `${label}.questions`,
  );
  const raw = record(source.predicate, `${label}.predicate`);
  const type = raw.type;
  if (type !== "choice_equals" && type !== "score_at_least")
    fail(`${label}.predicate.type is invalid`);
  keys(raw, ["type", "questionId", "value"], `${label}.predicate`);
  const questionId = text(raw.questionId, `${label}.predicate.questionId`, 128);
  const question = questions[questionId];
  if (!question) fail(`${label}.predicate references an unknown question`);
  if (type === "choice_equals") {
    if (question.type !== "choice")
      fail(`${label}.predicate requires a choice question`);
    const valueText = text(raw.value, `${label}.predicate.value`);
    if (!question.options.includes(valueText))
      fail(`${label}.predicate.value is not an allowed choice`);
    return Object.freeze({
      questions,
      predicate: {
        type: "choice_equals" as const,
        questionId,
        value: valueText,
      },
    });
  }
  if (question.type !== "score")
    fail(`${label}.predicate requires a score question`);
  const valueNumber = finite(raw.value, `${label}.predicate.value`);
  if (valueNumber < 0 || valueNumber > question.criteria.length - 1)
    fail(`${label}.predicate.value is outside the score range`);
  return Object.freeze({
    questions,
    predicate: {
      type: "score_at_least" as const,
      questionId,
      value: valueNumber,
    },
  });
}

export function validateWorkflowEvaluationResult(
  value: unknown,
  questions: Readonly<Record<string, WorkflowEvaluationQuestion>>,
): WorkflowEvaluationResult {
  const response = record(value, "evaluation response");
  if (response.ok === false) {
    const evaluatorError = record(response.error, "evaluation response.error");
    fail(
      `evaluator ${text(evaluatorError.code, "evaluation response.error.code", 128)}: ${text(evaluatorError.message, "evaluation response.error.message")}`,
    );
  }
  if (response.ok !== true) fail("evaluation response has an invalid outcome");
  const answersSource = record(response.answers, "evaluation response.answers");
  const expected = Object.keys(questions);
  if (Object.keys(answersSource).length !== expected.length)
    fail("evaluation result must answer every question exactly once");
  const answers: Record<string, WorkflowEvaluationAnswer> = Object.create(null);
  for (const id of expected) {
    if (!Object.hasOwn(answersSource, id))
      fail(`evaluation result is missing answer "${id}"`);
    const raw = record(answersSource[id], `evaluation result.answers.${id}`);
    keys(
      raw,
      ["type", "value", "confidence", "probabilities"],
      `evaluation result.answers.${id}`,
    );
    const question = questions[id]!;
    const confidence = probability(
      raw.confidence,
      `evaluation result.answers.${id}.confidence`,
    );
    if (question.type === "choice") {
      if (
        raw.type !== "choice" ||
        typeof raw.value !== "string" ||
        !question.options.includes(raw.value)
      )
        fail(`evaluation result answer "${id}" is not an allowed choice`);
      answers[id] = Object.freeze({
        type: "choice",
        value: raw.value,
        ...(confidence === undefined ? {} : { confidence }),
      });
    } else {
      const valueNumber = finite(
        raw.value,
        `evaluation result.answers.${id}.value`,
      );
      if (
        raw.type !== "score" ||
        valueNumber < 0 ||
        valueNumber > question.criteria.length - 1
      )
        fail(`evaluation result answer "${id}" is outside its score range`);
      answers[id] = Object.freeze({
        type: "score",
        value: valueNumber,
        ...(confidence === undefined ? {} : { confidence }),
      });
    }
  }
  const result = Object.freeze({
    version: WORKFLOW_EVALUATION_VERSION,
    answers: Object.freeze(answers),
  });
  if (utf8Bytes(JSON.stringify(result)) > MAX_EVALUATION_RESULT_BYTES)
    fail("evaluation result exceeds its byte bound");
  return result;
}

export function validatePersistedWorkflowEvaluationResult(
  value: unknown,
): WorkflowEvaluationResult {
  const source = record(value, "evaluation result");
  keys(source, ["version", "answers"], "evaluation result");
  if (source.version !== WORKFLOW_EVALUATION_VERSION)
    fail("evaluation result has an unsupported version");
  const rawAnswers = record(source.answers, "evaluation result.answers");
  const ids = Object.keys(rawAnswers);
  if (ids.length === 0 || ids.length > MAX_EVALUATION_QUESTIONS)
    fail("evaluation result has an invalid answer count");
  const answers: Record<string, WorkflowEvaluationAnswer> = Object.create(null);
  for (const id of ids) {
    text(id, "evaluation result answer id", 128);
    const raw = record(rawAnswers[id], `evaluation result.answers.${id}`);
    keys(
      raw,
      ["type", "value", "confidence"],
      `evaluation result.answers.${id}`,
    );
    const confidence = probability(
      raw.confidence,
      `evaluation result.answers.${id}.confidence`,
    );
    if (raw.type === "choice") {
      answers[id] = Object.freeze({
        type: "choice",
        value: text(raw.value, `evaluation result.answers.${id}.value`),
        ...(confidence === undefined ? {} : { confidence }),
      });
    } else if (raw.type === "score") {
      answers[id] = Object.freeze({
        type: "score",
        value: finite(raw.value, `evaluation result.answers.${id}.value`),
        ...(confidence === undefined ? {} : { confidence }),
      });
    } else fail(`evaluation result answer "${id}" has an invalid type`);
  }
  const result = Object.freeze({
    version: WORKFLOW_EVALUATION_VERSION,
    answers: Object.freeze(answers),
  });
  if (utf8Bytes(JSON.stringify(result)) > MAX_EVALUATION_RESULT_BYTES)
    fail("evaluation result exceeds its byte bound");
  return result;
}

export function gateAccepted(
  gate: WorkflowGateDefinition,
  result: WorkflowEvaluationResult,
): boolean {
  const answer = result.answers[gate.predicate.questionId];
  return gate.predicate.type === "choice_equals"
    ? answer?.type === "choice" && answer.value === gate.predicate.value
    : answer?.type === "score" && answer.value >= gate.predicate.value;
}

export function evaluationPreview(result: WorkflowEvaluationResult): string {
  return truncateUtf8(JSON.stringify(result), 4 * 1024);
}
