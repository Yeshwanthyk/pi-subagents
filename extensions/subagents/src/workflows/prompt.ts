import * as os from "node:os";
import type { WorkflowDraft } from "./drafts.ts";

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
  "After showing the preview and exact immutable artifact to the user, wait for a newer explicit user response. Approval accepts only the exact draftId. It fails closed unless persisted and process-memory metadata agree and the session and project are unchanged.",
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
  "After preparation, surface the preview, digest, and review instructions. Never reduce the response to a bare draft ID.",
  "Never approve in the same response that prepared the draft. Wait for a newer explicit user response and pass only the exact draftId.",
  "Saved workflows still require preparation and review; never execute a saved definition directly.",
] as const;

function shortenHome(value: string): string {
  const home = os.homedir();
  return value === home || value.startsWith(`${home}/`)
    ? `~${value.slice(home.length)}`
    : value;
}

export function buildWorkflowDraftMessage(options: {
  readonly draft: WorkflowDraft;
  readonly artifactPath: string;
}): string {
  const { draft } = options;
  const name = draft.definition.name ?? "workflow";
  const lines = [
    `Draft prepared · ${name}`,
    `${draft.draftId} · ${draft.executionSha256.slice(0, 12)} · immutable · not started`,
    `Review: /workflow-draft ${draft.draftId}`,
    `Artifact: ${shortenHome(options.artifactPath)}`,
    `Approve later with only: ${draft.draftId}`,
  ];
  return lines.join("\n");
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
