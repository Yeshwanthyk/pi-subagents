export const JEV_SCHEMA_VERSION = 1 as const;
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone" as const;
export const DEFAULT_JEV_MODEL = "jev-1.13.0" as const;

export const JEV_LIMITS = {
  maxInputBytes: 32 * 1024,
  maxQuestions: 16,
  maxChoices: 16,
  maxScoreCriteria: 10,
  maxResponseBytes: 16 * 1024,
  maxConcurrent: 2,
  maxQueue: 32,
  timeoutMs: 10_000,
} as const;

export interface JevChoiceQuestion {
  readonly type: "choice";
  readonly question: string;
  readonly options: readonly [string, string, ...string[]];
}

export interface JevScoreQuestion {
  readonly type: "score";
  readonly question: string;
  readonly criteria: readonly [string, string, ...string[]];
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion;
export type JevQuestions = Readonly<Record<string, JevQuestion>>;

export interface JevEvaluationInput<
  Questions extends JevQuestions = JevQuestions,
> {
  readonly state: string;
  readonly questions: Questions;
}

export interface JevChoiceAnswer<Value extends string = string> {
  readonly type: "choice";
  readonly value: Value;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<Value, number>>;
}

export interface JevScoreAnswer {
  readonly type: "score";
  readonly value: number;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer;

export type JevAnswers<Questions extends JevQuestions> = {
  readonly [Name in keyof Questions]: Questions[Name] extends JevChoiceQuestion
    ? JevChoiceAnswer<Questions[Name]["options"][number]>
    : JevScoreAnswer;
};

export interface JevUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface JevEvaluationMetadata {
  readonly schemaVersion: typeof JEV_SCHEMA_VERSION;
  readonly requestedModel: string;
  readonly actualModel: string;
  readonly durationMs: number;
  readonly inputDigest: string;
  readonly usage: JevUsage;
}

export type JevErrorCode =
  | "not_configured"
  | "invalid_input"
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "overloaded"
  | "transport_error"
  | "invalid_response";

export interface JevError {
  readonly code: JevErrorCode;
  readonly message: string;
  readonly status?: number;
}

export type JevEvaluationResult<Questions extends JevQuestions = JevQuestions> =
  | {
      readonly ok: true;
      readonly answers: JevAnswers<Questions>;
      readonly metadata: JevEvaluationMetadata;
    }
  | { readonly ok: false; readonly error: JevError };

export interface JevClientOptions {
  readonly apiKeyEnv?: string;
  readonly credentialsPath?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly maxQueue?: number;
  readonly transport?: JevTransport;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface JevEvaluateOptions {
  readonly signal?: AbortSignal;
}

export type JevTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface JevEvaluator {
  evaluate<const Questions extends JevQuestions>(
    input: JevEvaluationInput<Questions>,
    options?: JevEvaluateOptions,
  ): Promise<JevEvaluationResult<Questions>>;
}
