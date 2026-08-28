import { createHash } from "node:crypto";
import type { ValidatedWorkflowDefinition } from "./domain.ts";

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type SavedWorkflowScope = "project-pi" | "project-agents" | "agent";

export type WorkflowDraftProvenance =
  | {
      readonly kind: "inline-source";
      readonly sha256: string;
    }
  | {
      readonly kind: "inline-spec";
      readonly sha256: string;
    }
  | {
      readonly kind: "saved";
      readonly name: string;
      readonly path: string;
      readonly scope: SavedWorkflowScope;
      readonly sha256: string;
    };

export type SavedWorkflowProvenance = Extract<
  WorkflowDraftProvenance,
  { readonly kind: "saved" }
>;

export interface WorkflowExecutionInputs {
  readonly definition: ValidatedWorkflowDefinition;
  readonly source?: string;
  readonly args?: string;
  readonly background: boolean;
}

interface WorkflowExecutionDigestPayload {
  version: 1;
  definition: ValidatedWorkflowDefinition;
  source?: string;
  args?: string;
  background: boolean;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const workflowSourceSha256 = sha256;

export function workflowDefinitionSha256(
  definition: ValidatedWorkflowDefinition,
): string {
  return sha256(JSON.stringify(definition));
}

/** Hash the exact immutable inputs that a later slice may execute. */
export function workflowExecutionSha256(
  inputs: WorkflowExecutionInputs,
): string {
  const payload: WorkflowExecutionDigestPayload = {
    version: 1,
    definition: inputs.definition,
    background: inputs.background,
  };
  if (inputs.source !== undefined) payload.source = inputs.source;
  if (inputs.args !== undefined) payload.args = inputs.args;
  return sha256(JSON.stringify(payload));
}

export function inlineWorkflowProvenance(options: {
  readonly definition: ValidatedWorkflowDefinition;
  readonly source?: string;
}): WorkflowDraftProvenance {
  return options.source === undefined
    ? {
        kind: "inline-spec",
        sha256: workflowDefinitionSha256(options.definition),
      }
    : { kind: "inline-source", sha256: workflowSourceSha256(options.source) };
}

export function assertWorkflowProvenance(
  provenance: WorkflowDraftProvenance,
  options: {
    readonly definition: ValidatedWorkflowDefinition;
    readonly source?: string;
  },
): void {
  if (!SHA256_PATTERN.test(provenance.sha256)) {
    throw new Error("Workflow draft has invalid provenance");
  }
  switch (provenance.kind) {
    case "inline-spec":
      if (
        options.source !== undefined ||
        provenance.sha256 !== workflowDefinitionSha256(options.definition)
      ) {
        throw new Error("Workflow draft has invalid inline-spec provenance");
      }
      return;
    case "inline-source":
      if (
        options.source === undefined ||
        provenance.sha256 !== workflowSourceSha256(options.source)
      ) {
        throw new Error("Workflow draft has invalid source provenance");
      }
      return;
    case "saved":
      if (
        options.source === undefined ||
        provenance.sha256 !== workflowSourceSha256(options.source) ||
        provenance.name.length === 0 ||
        provenance.path.length === 0 ||
        !["project-pi", "project-agents", "agent"].includes(provenance.scope)
      ) {
        throw new Error("Workflow draft has invalid saved-workflow provenance");
      }
      return;
    default:
      throw new Error("Workflow draft has invalid provenance kind");
  }
}
