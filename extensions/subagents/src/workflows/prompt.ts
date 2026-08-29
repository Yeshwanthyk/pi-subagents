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
  "Approval only creates the Slice 2 workflow run. Child scheduling and execution are separate later lifecycle stages.",
].join("\n");

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
  const lines = [
    `Workflow draft ${draft.definition.name ? `"${draft.definition.name}"` : draft.draftId} prepared — no workflow run or child agent started.`,
    `Draft: ${draft.draftId}`,
    `Execution digest: ${draft.executionSha256}`,
    `Artifact: ${shortenHome(options.artifactPath)}`,
    "Review the preview and exact immutable source/spec in that artifact.",
    "",
    "Preview:",
    draft.preview,
    "",
    "Approve only after reviewing it. Approval requires a newer explicit user response in this same session and project, using only the exact draftId.",
  ];
  return lines.join("\n");
}

export function buildWorkflowApprovalMessage(options: {
  readonly draftId: string;
  readonly runId: string;
}): string {
  return [
    `Workflow draft ${options.draftId} approved as run ${options.runId}.`,
    "The immutable graph is registered; child execution is not implemented in this slice.",
  ].join("\n");
}
