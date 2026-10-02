import type { WorkflowDraft } from "./drafts.ts";
import type { WorkflowTaskDefinition } from "./domain.ts";
import { truncateUtf8, utf8Bytes } from "./events.ts";

export const MAX_WORKFLOW_DRAFT_MESSAGE_BYTES = 16 * 1024;
export const MAX_WORKFLOW_DRAFT_MESSAGE_TASK_ROWS = 32;
const TASK_PURPOSE_MAX_BYTES = 160;
const PREVIEW_MAX_BYTES = 320;
const NAME_MAX_BYTES = 160;
const WORKFLOW_DEFAULT_HARNESS =
  "workflow default (execution defaults to pi unless approval options override)";

function compactBoundedText(value: string, maxBytes: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (utf8Bytes(compact) <= maxBytes) return compact;
  const suffix = "...";
  return `${truncateUtf8(compact, Math.max(0, maxBytes - utf8Bytes(suffix))).trimEnd()}${suffix}`;
}
/** Keep task intent readable without echoing an unbounded prompt into review surfaces. */
export function workflowTaskPurpose(task: WorkflowTaskDefinition): string {
  const compact = compactBoundedText(task.prompt, TASK_PURPOSE_MAX_BYTES);
  const sentenceEnd = compact.search(/[.!?](?:\s|$)/);
  const firstSentence =
    sentenceEnd >= 0 ? compact.slice(0, sentenceEnd + 1) : compact;
  return compactBoundedText(firstSentence, TASK_PURPOSE_MAX_BYTES);
}
export function workflowTaskWiring(task: WorkflowTaskDefinition): string {
  return [
    `Needs: ${task.needs?.length ? task.needs.join(", ") : "none"}`,
    `Consumes: ${task.consumes?.length ? task.consumes.join(", ") : "none"}`,
  ].join(" · ");
}
export function workflowTaskScope(task: WorkflowTaskDefinition): string {
  return task.readOnly ? "read-only" : `owns ${task.owns.join(", ")}`;
}
function backendSessionDefault(task: WorkflowTaskDefinition): string {
  if (task.harness === "codex") return "codex backend/session default";
  if (task.harness === "pi") return "pi backend/session default";
  return "selected backend/session default";
}

function workflowTaskModel(task: WorkflowTaskDefinition) {
  const modelId = task.model;
  if (modelId === undefined || modelId.length === 0) {
    return {
      provider: "unspecified",
      model: `unspecified (${backendSessionDefault(task)})`,
    };
  }
  if (modelId.trim().length === 0) {
    return {
      provider: "not encoded in model ID",
      model: `configured whitespace-only value ${JSON.stringify(modelId)}`,
    };
  }
  if (task.harness === "codex") {
    return {
      provider: "selected by codex backend",
      model: modelId,
    };
  }
  const separator = modelId.indexOf("/");
  if (separator > 0 && separator < modelId.length - 1) {
    return {
      provider: modelId.slice(0, separator),
      model: modelId.slice(separator + 1),
    };
  }
  return { provider: "not encoded in model ID", model: modelId };
}
export function workflowTaskRuntime(task: WorkflowTaskDefinition): string {
  const model = workflowTaskModel(task);
  return [
    `Harness: ${task.harness ?? WORKFLOW_DEFAULT_HARNESS}`,
    `Provider: ${model.provider}`,
    `Model: ${model.model}`,
    `Thinking: ${task.effort ?? `unspecified (${backendSessionDefault(task)})`}`,
  ].join(" · ");
}

export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  preview:
    "Free-form review of the intended outcome, task ownership, dependencies, explicit handoffs, derived parallel lanes, proof, and deliberately excluded work.",
  source:
    "One static flow({ tasks: [...] }) workflow source. It is decoded without execution, validated as a complete graph, and saved as an immutable draft; preparation never starts a workflow or child agent.",
  spec: "A declarative workflow definition with tasks, needs, consumes, and exactly one readOnly:true or non-empty owns scope per task. Preparation never starts a workflow or child agent.",
  savedWorkflow:
    "Saved workflow name to discover and source-snapshot before review. Saved definitions never execute directly.",
  args: "Optional exact string input snapshotted with the draft; it cannot be overridden during approval.",
  background:
    "Whether the later approved workflow is intended for background execution. Defaults to true and cannot be overridden during approval.",
  draftId:
    "Exact immutable draft ID to approve on a later user response in the same session and project. No other execution input is accepted with approval.",
} as const;

export const WORKFLOW_TOOL_DESCRIPTION = [
  "Prepare or approve a workflow through a deterministic two-response boundary.",
  "Preparation accepts exactly one inline flow({ tasks: [...] }) source, declarative spec, or saved workflow name plus a review preview. A source is decoded as static data only; it is never executed. Complete graph validation happens before draft persistence or manager use, and preparation creates no workflow run or child agent.",
  "Every task declares id, label, kind, and prompt, plus exactly one scope: readOnly:true or a non-empty owns path list. needs expresses ordering. consumes explicitly selects completed dependency results for a bounded, labeled handoff; results are never inferred from arbitrary dependency transcripts.",
  "Readiness and safe parallelism are derived from completed needs and segment-aware ownership conflicts. Independent roots and disjoint writers may be selected together; overlapping writers require dependency order. The shared SubagentManager queue, not the workflow definition, owns execution capacity.",
  "Do not use concurrency, agent(), parallel(), or pipeline(); do not add imports, callbacks, identifiers, spreads, computed keys, templates, getters, filesystem/network/process/timer access, or imperative scheduling. The only source call is the outer flow(...).",
  "After preparation, write a normal assistant response outside the tool card that shows a bounded preview and, for every task, its concise purpose derived from the prompt, needs/consumes wiring, read-only or owned-path scope, and a clearly labeled requested/configured runtime row (harness, provider, model, and thinking effort). An unspecified harness is the workflow default: execution defaults to pi unless approval options override it. Unspecified model and effort use the selected backend/session default; an explicit codex harness uses codex backend/session defaults. Preserve explicit provider/model IDs without guessing. Include the execution digest and /workflow-draft command. Then wait for a newer explicit user response. Approval accepts only the exact draftId. It fails closed unless persisted and process-memory metadata agree and the session and project are unchanged.",
  "Saved definitions are discovered with project precedence and snapshotted at preparation. Later edits to the saved file never alter the reviewed draft.",
  "Approval registers the immutable graph, returns its run ID immediately, and starts detached background scheduling; child results stay in the workflow owner and are not delivered to the parent/client channels. Use workflow_check for read-only inspection and workflow_control for run/task authority controls.",
].join("\n");

export const WORKFLOW_CHECK_TOOL_DESCRIPTION =
  "Inspect one tracked workflow run by ID without blocking. Shows bounded task rows joined to authoritative child activity; opening a child continues through the existing /subagents transcript view.";

export const WORKFLOW_LIST_TOOL_DESCRIPTION =
  "List tracked workflow runs with bounded status and task counts; use workflow_check for one run's task rows and authoritative child activity.";

export const WORKFLOW_CONTROL_TOOL_DESCRIPTION = [
  "Control an approved workflow by its run ID: pause/resume scheduling, explicitly retry or skip a task and its descendants, or cancel the run.",
  "Controls append journal events and are idempotent at terminal/current states. Pause prevents new admissions while already-running children continue; retry creates a fresh bounded attempt identity; skip is deterministic; automatic retry is limited to configured provider_stall or backend_failure classifications.",
  "Do not target child IDs here. Workflow-child takeover remains read-only; use workflow_check and the existing child transcript view for observation.",
].join("\n");

export const WORKFLOW_CHECK_PARAMETER_DESCRIPTIONS = {
  runId: "Exact workflow run ID returned after approval",
} as const;

export const WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS = {
  action:
    "One workflow authority action: pause, resume, retry, skip, or cancel",
  runId: "Exact approved workflow run ID",
  taskId: "Exact workflow task ID; required for retry and skip",
  reason: "Optional bounded operator reason recorded in the workflow journal",
} as const;

export const WORKFLOW_PROMPT_SNIPPET =
  "Prepare an immutable flow({ tasks: [...] }) graph draft, then approve only its exact draft ID after user review; let dependencies and scopes derive parallelism";

export const WORKFLOW_PROMPT_GUIDELINES = [
  "Keep decomposition proportional. Give each task one bounded outcome, explicit needs/consumes edges, and exactly one readOnly:true or owned-path scope.",
  "Use flow() with one { tasks: [...] } literal as the only source surface. Do not author a runtime script or imperative scheduler.",
  "Use needs for real ordering and consumes only for dependency results the task truly requires. A consumes entry must be a transitive dependency and is available only after that dependency completes.",
  "Use parallel branches only for independent work with distinct ownership; derived scheduling admits disjoint writers and read-only work while blocking overlapping writers.",
  "Do not set a concurrency number or call agent(), parallel(), or pipeline(); the shared subagent manager owns capacity.",
  "During preparation, provide the preview before the source/spec and do not claim that any workflow or child has started.",
  "After preparation, render a concise normal assistant message with a bounded outcome and, for every task, purpose derived from its prompt, needs/consumes wiring, read-only or owned-path scope, and a requested/configured runtime row. Show the workflow default for an unspecified harness (execution defaults to pi unless approval options override it), selected backend/session defaults for unspecified model and effort, and codex backend/session defaults for explicit codex without those fields. Preserve explicit provider/model IDs without guessing, and include the execution digest plus /workflow-draft command. Never rely on the tool-result card or reduce the response to a bare draft ID.",
  "Never approve in the same response that prepared the draft. Wait for a newer explicit user response and pass only the exact draftId.",
  "Saved workflows still require preparation and review; never execute a saved definition directly.",
] as const;

export function buildWorkflowDraftMessage(options: {
  readonly draft: WorkflowDraft;
  readonly artifactPath: string;
}): string {
  const { draft } = options;
  const name = compactBoundedText(
    draft.definition.name ?? "workflow",
    NAME_MAX_BYTES,
  );
  const totalTasks = draft.definition.tasks.length;
  const taskLines = draft.definition.tasks.map((task, index) => [
    `${index + 1}. ${task.label} (${task.id})`,
    `   Purpose: ${workflowTaskPurpose(task)}`,
    `   ${workflowTaskWiring(task)}`,
    `   Scope: ${workflowTaskScope(task)}`,
    `   Requested/configured runtime: ${workflowTaskRuntime(task)}`,
  ]);
  const prefix = [
    `Draft prepared · ${name} · ${draft.draftId} · immutable · not started`,
    "",
    "Outcome",
    compactBoundedText(draft.preview, PREVIEW_MAX_BYTES),
    "",
    `Tasks (${totalTasks})`,
  ];
  const suffix = [
    `Digest: ${draft.executionSha256}`,
    `Review: /workflow-draft ${draft.draftId}`,
  ];
  const compose = (
    selected: ReadonlyArray<ReadonlyArray<string>>,
  ): string[] => {
    const omitted = totalTasks - selected.length;
    return [
      ...prefix,
      ...selected.flat(),
      ...(omitted > 0
        ? [`… ${omitted} task(s) omitted · total ${totalTasks}`]
        : []),
      "",
      ...suffix,
    ];
  };
  const selected: string[][] = [];
  const taskLimit = Math.min(totalTasks, MAX_WORKFLOW_DRAFT_MESSAGE_TASK_ROWS);
  for (let index = 0; index < taskLimit; index++) {
    const candidate = compose([...selected, taskLines[index]!]).join("\n");
    if (utf8Bytes(candidate) > MAX_WORKFLOW_DRAFT_MESSAGE_BYTES) break;
    selected.push(taskLines[index]!);
  }
  while (
    utf8Bytes(compose(selected).join("\n")) >
      MAX_WORKFLOW_DRAFT_MESSAGE_BYTES &&
    selected.length > 0
  ) {
    selected.pop();
  }
  return compose(selected).join("\n");
}

export function buildWorkflowApprovalMessage(options: {
  readonly draftId: string;
  readonly runId: string;
}): string {
  return [
    `Workflow draft ${options.draftId} approved as run ${options.runId}.`,
    "The immutable graph is registered and detached background execution has started. Child results stay with this workflow; use the run ID to inspect it in a later workflow surface.",
  ].join("\n");
}
