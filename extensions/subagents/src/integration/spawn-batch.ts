/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Tool inputs are TypeBox-validated; conditional spreads preserve omission of optional runtime fields. */

/**
 * Batch-spawn input normalization and admission for subagent_spawn.
 *
 * subagent_spawn accepts either the single-task fields or a `tasks` array.
 * Both forms normalize to one list so validation, routing, admission, and
 * waiting share a single path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { BACKEND_NAMES, REASONING_EFFORTS } from "../domain.ts";
import { ROUTING_CLASSIFICATION_PARAMETERS } from "./routing.ts";

export const MAX_SPAWN_BATCH = 16;

/** Per-task fields shared by the single form and each `tasks` item. */
export const SPAWN_TASK_FIELDS = [
  "prompt",
  "name",
  "harness",
  "model",
  "reasoning_effort",
  "working_dir",
  "classification",
] as const;

export const SPAWN_BATCH_TASK_PARAMETERS = Type.Object(
  {
    prompt: Type.String(),
    name: Type.String(),
    classification: Type.Optional(ROUTING_CLASSIFICATION_PARAMETERS),
    harness: Type.Optional(StringEnum(BACKEND_NAMES)),
    working_dir: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    reasoning_effort: Type.Optional(StringEnum(REASONING_EFFORTS)),
  },
  { additionalProperties: false },
);
export type SpawnTaskInput = Static<typeof SPAWN_BATCH_TASK_PARAMETERS>;

export interface SpawnRequestParams extends Partial<SpawnTaskInput> {
  readonly tasks?: ReadonlyArray<SpawnTaskInput>;
}

export interface NormalizedSpawnRequest {
  /** True when the caller used the `tasks` array form. */
  readonly batch: boolean;
  readonly tasks: ReadonlyArray<SpawnTaskInput>;
}

/** Validate the single/batch forms and return one task list; with "tasks", top-level runtime fields are per-task defaults. */
export function normalizeSpawnRequest(
  params: SpawnRequestParams,
): NormalizedSpawnRequest {
  const singleFields = SPAWN_TASK_FIELDS.filter(
    (field) => params[field] !== undefined,
  );
  if (params.tasks !== undefined) {
    const perTaskOnly = singleFields.filter(
      (field) => field === "prompt" || field === "name",
    );
    if (perTaskOnly.length > 0) {
      throw new Error(
        `subagent_spawn with "tasks" takes prompt and name inside each task; remove top-level ${perTaskOnly.join(", ")}. No child started.`,
      );
    }
    if (params.tasks.length < 1 || params.tasks.length > MAX_SPAWN_BATCH) {
      throw new Error(
        `"tasks" must contain 1 to ${MAX_SPAWN_BATCH} items. No child started.`,
      );
    }
    // Top-level runtime fields are shared defaults; a task's own value wins.
    const defaults = sharedTaskDefaults(params);
    return {
      batch: true,
      tasks: params.tasks.map((task) => ({ ...defaults, ...task })),
    };
  }
  if (params.prompt === undefined || params.name === undefined) {
    throw new Error(
      'subagent_spawn requires "prompt" and "name", or a "tasks" array. No child started.',
    );
  }
  const task: SpawnTaskInput = {
    prompt: params.prompt,
    name: params.name,
    ...(params.classification === undefined
      ? {}
      : { classification: params.classification }),
    ...(params.harness === undefined ? {} : { harness: params.harness }),
    ...(params.working_dir === undefined
      ? {}
      : { working_dir: params.working_dir }),
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.reasoning_effort === undefined
      ? {}
      : { reasoning_effort: params.reasoning_effort }),
  };
  return { batch: false, tasks: [task] };
}

function sharedTaskDefaults(
  params: SpawnRequestParams,
): Partial<SpawnTaskInput> {
  return {
    ...(params.classification === undefined
      ? {}
      : { classification: params.classification }),
    ...(params.harness === undefined ? {} : { harness: params.harness }),
    ...(params.working_dir === undefined
      ? {}
      : { working_dir: params.working_dir }),
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.reasoning_effort === undefined
      ? {}
      : { reasoning_effort: params.reasoning_effort }),
  };
}

/** Resolve and validate one working_dir against the parent cwd. */
export function resolveWorkingDir(
  parentCwd: string,
  workingDir: string | undefined,
): string {
  const cwd = path.resolve(parentCwd, workingDir ?? ".");
  let directory = false;
  try {
    directory = fs.statSync(cwd).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) throw new Error(`working_dir is not a directory: ${cwd}`);
  return cwd;
}

/** Prefix a task-level error with its batch position and name. */
export function taskLabel(
  task: Pick<SpawnTaskInput, "name">,
  index: number,
  batch: boolean,
): string {
  return batch ? `tasks[${index}] "${task.name}"` : `"${task.name}"`;
}

export interface SpawnedTask {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly harness: string;
  readonly model?: string;
}

export type BatchSpawnOutcome =
  | ({
      readonly index: number;
      readonly name: string;
      readonly ok: true;
    } & SpawnedTask)
  | {
      readonly index: number;
      readonly name: string;
      readonly ok: false;
      readonly error: string;
    };

/** Pair settled admissions with their task position and name. */
export function batchOutcomes(
  tasks: ReadonlyArray<Pick<SpawnTaskInput, "name">>,
  settled: ReadonlyArray<PromiseSettledResult<SpawnedTask>>,
): BatchSpawnOutcome[] {
  return settled.map((result, index) => {
    const name = tasks[index]?.name ?? `task ${index}`;
    if (result.status === "fulfilled") {
      return { index, name, ok: true as const, ...result.value };
    }
    const reason: unknown = result.reason;
    return {
      index,
      name,
      ok: false as const,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  });
}

/** Admit every task concurrently; one failure never cancels its siblings. */
export async function admitBatch<T>(
  tasks: ReadonlyArray<T>,
  admit: (task: T, index: number) => Promise<SpawnedTask>,
): Promise<ReadonlyArray<PromiseSettledResult<SpawnedTask>>> {
  return Promise.allSettled(tasks.map((task, index) => admit(task, index)));
}

/** Model-facing summary for a batch spawn. */
export function formatBatchSpawnResult(
  outcomes: ReadonlyArray<BatchSpawnOutcome>,
): string {
  const started = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.length - started.length;
  const lines = outcomes.map((outcome) =>
    outcome.ok
      ? `- tasks[${outcome.index}] ${outcome.id} "${outcome.title}" (${outcome.harness}: ${outcome.model ?? "?"}, ${outcome.cwd})`
      : `- tasks[${outcome.index}] "${outcome.name}" failed: ${outcome.error}`,
  );
  const ids = started.map((outcome) => `"${outcome.id}"`).join(", ");
  return (
    `Spawned ${started.length}/${outcomes.length} subagent(s)${failed > 0 ? `; ${failed} failed` : ""}.\n` +
    `${lines.join("\n")}\n` +
    (started.length > 0
      ? `They run in the background and results are delivered automatically. Use subagent_wait(ids: [${ids}]) when your next step needs them, or mode "any" to handle each as it finishes.`
      : "No child started.")
  );
}
