/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent and return immediately with an id. The child is fully autonomous with its own context window and runs on pi (in-process) or codex (Codex CLI). Its final output is delivered automatically when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Max 4 subagents run at once across all harnesses; excess work waits in the shared FIFO queue.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Delegate a clearly scoped, self-contained task to a Pi or Codex subagent running in the background";

/** Guides the parent model to delegate scoped work and coordinate with results. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn for self-contained work with a clear scope, purpose, and expected output. Parallel delegation is appropriate when scopes can proceed independently, whether separate or complementary.",
  "Pick the subagent harness deliberately: pi unless there is a reason to prefer Codex.",
  "Coordinate by scope: while a child runs, continue parent work outside its delegated scope. When its result arrives, use it as the basis for synthesis, validation, integration, or follow-up in that scope.",
  "Use subagent_wait when the next parent step requires a child's result, such as synthesis or integration that includes its work, review of its findings, or a dependent decision.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  harness:
    'Harness to run the subagent on: "pi" (in-process pi session; inherits this environment) or "codex" (Codex CLI). Choose deliberately per task.',
  workingDir: "Working directory (default: current working directory)",
  model:
    'Model hint, interpreted by the chosen harness (pi: "provider/model-id" or model id; codex: model slug). Omit for the harness default (pi inherits the current model).',
  reasoningEffort:
    "Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level or codex reasoning effort). Omit for the harness default (pi inherits the current level).",
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background, and its result will be delivered automatically. ` +
    `Use subagent_wait(ids: ["${options.id}"]) when your next step requires that result; otherwise continue outside its delegated scope. ` +
    `Use subagent_cancel to stop it, subagent_check to peek, and subagent_list to see all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed parent-owned subagents have settled, then return their final outputs. Use this when the next parent step requires those outputs.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Parent-owned subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more queued or running parent-owned subagents. Queued work is removed without starting a backend session; active work preserves its partial session transcript on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Parent-owned subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a parent-owned subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Parent-owned subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all parent-owned subagents (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}

export interface SubagentResultCard {
  readonly kind?: "workflow";
  readonly id: string;
  readonly title: string;
  readonly status: "done" | "error";
  readonly error?: string;
  readonly output: string;
}

function resultCardText(card: SubagentResultCard) {
  const verb = card.status === "error" ? "failed" : "finished";
  const subject = card.kind === "workflow" ? "Workflow" : "Subagent";
  let text = `${subject} ${card.id} "${card.title}" ${verb}.`;
  if (card.error) text += `\nError: ${card.error}`;
  return `${text}\n\n${card.output}`;
}

/** Builds one parent-facing message containing all settled results in order. */
export function buildSubagentResultBatchMessage(
  cards: ReadonlyArray<SubagentResultCard>,
) {
  return cards.map(resultCardText).join("\n\n---\n\n");
}
