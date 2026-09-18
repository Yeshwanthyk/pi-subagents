/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Promise rejection values and parsed generic answer maps are narrowed at the owning boundary. */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  DEFAULT_JEV_MODEL,
  JEV_ENDPOINT,
  JEV_LIMITS,
  JEV_SCHEMA_VERSION,
  type JevClientOptions,
  type JevEvaluationInput,
  type JevEvaluationResult,
  type JevEvaluator,
  type JevEvaluateOptions,
  type JevQuestions,
  type JevTransport,
} from "./domain.ts";
import {
  JevBoundaryError,
  parseJevResponse,
  validateJevInput,
} from "./validation.ts";
import {
  DEFAULT_JEV_CREDENTIALS_PATH,
  resolveJevApiKey,
} from "./credentials.ts";

interface QueueEntry<T> {
  readonly signal: AbortSignal;
  readonly task: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onAbort: () => void;
}

class AdmissionQueue {
  readonly #maxConcurrent: number;
  readonly #maxQueue: number;
  #active = 0;
  readonly #pending: QueueEntry<unknown>[] = [];

  constructor(maxConcurrent: number, maxQueue: number) {
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueue = maxQueue;
  }

  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#active < this.#maxConcurrent) return this.#start(task);
    if (this.#pending.length >= this.#maxQueue) {
      return Promise.reject(new QueueOverloadedError());
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        signal,
        task,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#pending.indexOf(entry as QueueEntry<unknown>);
          if (index >= 0) this.#pending.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.#pending.push(entry as QueueEntry<unknown>);
    });
  }

  #start<T>(task: () => Promise<T>): Promise<T> {
    this.#active += 1;
    return task().finally(() => {
      this.#active -= 1;
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrent) {
      const entry = this.#pending.shift();
      if (!entry) return;
      entry.signal.removeEventListener("abort", entry.onAbort);
      if (entry.signal.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      void this.#start(entry.task).then(entry.resolve, entry.reject);
    }
  }
}

class QueueOverloadedError extends Error {}
class DeadlineError extends Error {}
class CallerCancelledError extends Error {}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function configString(value: string, label: string): string {
  if (value.trim().length === 0)
    throw new TypeError(`${label} must not be empty`);
  return value;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function cancelBodyBestEffort(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // A locked or already-disposed body needs no further cleanup.
  }
}

function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // A closed reader needs no further cleanup.
  }
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (
      !Number.isFinite(bytes) ||
      bytes < 0 ||
      bytes > JEV_LIMITS.maxResponseBytes
    ) {
      throw new JevBoundaryError(
        `response exceeds ${JEV_LIMITS.maxResponseBytes} bytes`,
      );
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = (): void =>
    cancelReaderBestEffort(reader, signal.reason);
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    if (signal.aborted) {
      cancelOnAbort();
      throw signal.reason;
    }
    while (true) {
      const next = await withAbort(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > JEV_LIMITS.maxResponseBytes) {
        cancelReaderBestEffort(reader);
        throw new JevBoundaryError(
          `response exceeds ${JEV_LIMITS.maxResponseBytes} bytes`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation is best-effort; a transport may retain a pending read.
    }
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function fetchTransport(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init);
}

export class JevClient implements JevEvaluator {
  readonly #apiKeyEnv: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #transport: JevTransport;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #credentialsPath: string;
  readonly #queue: AdmissionQueue;

  constructor(options: JevClientOptions = {}) {
    if (Object.hasOwn(options, "enabled")) {
      throw new TypeError(
        'Jev client option "enabled" is obsolete; remove it and use an environment credential',
      );
    }
    this.#apiKeyEnv = configString(
      options.apiKeyEnv ?? "TYPESAFE_API_KEY",
      "apiKeyEnv",
    );
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.#apiKeyEnv)) {
      throw new TypeError("apiKeyEnv must be an environment variable name");
    }
    this.#model = configString(options.model ?? DEFAULT_JEV_MODEL, "model");
    this.#timeoutMs = positiveInteger(
      options.timeoutMs ?? JEV_LIMITS.timeoutMs,
      "timeoutMs",
    );
    const maxConcurrent = positiveInteger(
      options.maxConcurrent ?? JEV_LIMITS.maxConcurrent,
      "maxConcurrent",
    );
    const maxQueue = nonNegativeInteger(
      options.maxQueue ?? JEV_LIMITS.maxQueue,
      "maxQueue",
    );
    this.#transport = options.transport ?? fetchTransport;
    this.#env = options.env ?? process.env;
    this.#credentialsPath =
      options.credentialsPath ?? DEFAULT_JEV_CREDENTIALS_PATH;
    this.#queue = new AdmissionQueue(maxConcurrent, maxQueue);
  }

  async evaluate<const Questions extends JevQuestions>(
    input: JevEvaluationInput<Questions>,
    options: JevEvaluateOptions = {},
  ): Promise<JevEvaluationResult<Questions>> {
    let apiKey: string | undefined;
    try {
      apiKey = resolveJevApiKey({
        apiKeyEnv: this.#apiKeyEnv,
        env: this.#env,
        credentialsPath: this.#credentialsPath,
      });
    } catch {
      return {
        ok: false,
        error: {
          code: "not_configured",
          message: `Jev credential is unavailable; set ${this.#apiKeyEnv} or replace the saved fallback with /subagents-settings set-jev-key`,
        },
      };
    }
    if (!apiKey) {
      return {
        ok: false,
        error: {
          code: "not_configured",
          message: `Jev credential is not configured; set ${this.#apiKeyEnv} or configure the saved fallback with /subagents-settings set-jev-key`,
        },
      };
    }

    let validated: ReturnType<typeof validateJevInput>;
    try {
      validated = validateJevInput(input, this.#model);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: error instanceof Error ? error.message : "Invalid Jev input",
        },
      };
    }

    const started = Date.now();
    const controller = new AbortController();
    let deadlineReached = false;
    let callerCancelled = options.signal?.aborted === true;
    const cancelFromCaller = (): void => {
      callerCancelled = true;
      controller.abort(new CallerCancelledError());
    };
    options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
    if (callerCancelled) controller.abort(new CallerCancelledError());
    const timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort(new DeadlineError());
    }, this.#timeoutMs);

    try {
      return await this.#queue.run(controller.signal, async () => {
        let response: Response;
        try {
          response = await withAbort(
            this.#transport(JEV_ENDPOINT, {
              method: "POST",
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                state: validated.state,
                model: this.#model,
                questions: validated.wireQuestions,
              }),
              signal: controller.signal,
            }),
            controller.signal,
          );
        } catch {
          if (controller.signal.aborted) throw controller.signal.reason;
          return {
            ok: false,
            error: {
              code: "transport_error",
              message: "Jev request failed",
            },
          } as JevEvaluationResult<Questions>;
        }

        if (!response.ok) {
          cancelBodyBestEffort(response.body);
          if (response.status === 401 || response.status === 403) {
            return {
              ok: false,
              error: {
                code: "unauthorized",
                message: "Jev rejected the configured credential",
                status: response.status,
              },
            };
          }
          if (response.status === 429) {
            return {
              ok: false,
              error: {
                code: "rate_limited",
                message: "Jev rate limit reached",
                status: 429,
              },
            };
          }
          if (response.status === 400 || response.status === 422) {
            return {
              ok: false,
              error: {
                code: "invalid_input",
                message: "Jev rejected the request",
                status: response.status,
              },
            };
          }
          return {
            ok: false,
            error: {
              code: "transport_error",
              message: "Jev service returned an error",
              status: response.status,
            },
          };
        }

        try {
          const text = await readBoundedResponse(response, controller.signal);
          const raw: unknown = JSON.parse(text);
          const parsed = parseJevResponse(raw, validated.questions);
          const digest = createHash("sha256")
            .update(
              JSON.stringify({
                state: validated.state,
                questions: validated.wireQuestions,
              }),
            )
            .digest("hex");
          return {
            ok: true,
            answers: parsed.answers as JevEvaluationResult<Questions> extends {
              ok: true;
              answers: infer Answers;
            }
              ? Answers
              : never,
            metadata: {
              schemaVersion: JEV_SCHEMA_VERSION,
              requestedModel: this.#model,
              actualModel: parsed.model,
              durationMs: Math.max(0, Date.now() - started),
              inputDigest: digest,
              usage: parsed.usage,
            },
          };
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          return {
            ok: false,
            error: {
              code: "invalid_response",
              message:
                error instanceof JevBoundaryError
                  ? error.message
                  : "Jev returned invalid JSON",
            },
          };
        }
      });
    } catch (error) {
      if (error instanceof QueueOverloadedError) {
        return {
          ok: false,
          error: { code: "overloaded", message: "Jev request queue is full" },
        };
      }
      if (callerCancelled || error instanceof CallerCancelledError) {
        return {
          ok: false,
          error: { code: "cancelled", message: "Jev evaluation was cancelled" },
        };
      }
      if (deadlineReached || error instanceof DeadlineError) {
        return {
          ok: false,
          error: { code: "timeout", message: "Jev evaluation timed out" },
        };
      }
      return {
        ok: false,
        error: { code: "transport_error", message: "Jev request failed" },
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancelFromCaller);
    }
  }
}

export function createJevClient(options: JevClientOptions = {}): JevClient {
  return new JevClient(options);
}

export function evaluateJev<const Questions extends JevQuestions>(
  evaluator: JevEvaluator,
  input: JevEvaluationInput<Questions>,
  options?: JevEvaluateOptions,
): Promise<JevEvaluationResult<Questions>> {
  return evaluator.evaluate(input, options);
}
