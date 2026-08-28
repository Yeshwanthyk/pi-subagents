import * as os from "node:os";
import type { WorkflowDraft } from "./drafts.ts";

export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  preview:
    "Free-form review of the intended outcome, task ownership, dependencies, model choices, proof, and deliberately excluded work.",
  source:
    "Workflow definition source to validate and save as an immutable draft. Preparation never starts a workflow or child agent.",
  spec: "A declarative workflow definition to validate and save as an immutable draft. Preparation never starts a workflow or child agent.",
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
  "Preparation accepts exactly one inline source, declarative spec, or saved workflow name plus a review preview. It validates and persists an immutable snapshot with SHA-256 provenance, but creates no workflow run and starts no child agent.",
  "After showing the preview and exact immutable artifact to the user, wait for a newer explicit user response. Approval accepts only the exact draftId. It fails closed unless persisted and process-memory metadata agree and the session and project are unchanged.",
  "Saved definitions are discovered with project precedence and snapshotted at preparation. Later edits to the saved file never alter the reviewed draft.",
  "Approval only creates the Slice 2 workflow run. Task scheduling and child execution are separate later lifecycle stages.",
].join("\n");

export const WORKFLOW_PROMPT_SNIPPET =
  "Prepare an immutable workflow draft for review, then approve only its exact draft ID after a newer user response";

export const WORKFLOW_PROMPT_GUIDELINES = [
  "Keep workflow decomposition proportional. Give each task one bounded outcome and explicit read-only or owned-path scope.",
  "Use parallel branches only for independent work with distinct ownership; represent real ordering through dependencies.",
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
    "The immutable graph is registered; no child execution is implemented in this slice.",
  ].join("\n");
}
