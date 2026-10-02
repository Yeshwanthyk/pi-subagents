/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Optional workflow fields stay omitted rather than becoming explicit undefined. */

/**
 * Provider-safe parameter schemas for the workflow tools.
 *
 * Several providers (deepseek, opencode-go, and sometimes Anthropic) reject
 * tool schemas whose root is not a plain object or uses anyOf/oneOf. Each
 * tool therefore exposes one root object with optional fields, and the
 * variant rules a root union used to express are enforced here at execute
 * time with explicit errors.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { ValidatedWorkflowDefinition } from "../workflows/domain.ts";
import type { WorkflowControlRequest } from "../workflows/tools.ts";
import {
  WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
} from "../workflows/prompt.ts";

export const WORKFLOW_TOOL_PARAMS = Type.Object({
  preview: Type.Optional(
    Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.preview }),
  ),
  source: Type.Optional(
    Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.source }),
  ),
  spec: Type.Optional(
    Type.Any({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.spec }),
  ),
  savedWorkflow: Type.Optional(
    Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.savedWorkflow }),
  ),
  args: Type.Optional(
    Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.args }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.background }),
  ),
  draftId: Type.Optional(
    Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.draftId }),
  ),
});
export type WorkflowToolParams = Static<typeof WORKFLOW_TOOL_PARAMS>;

interface PrepareCommonInput {
  readonly preview: string;
  readonly args?: string;
  readonly background?: boolean;
}

export type WorkflowToolRequest =
  | { readonly kind: "approve"; readonly draftId: string }
  | ({ readonly kind: "prepare" } & PrepareCommonInput &
      (
        | { readonly source: string }
        /** Untrusted model JSON; the workflow preparer validates it fully. */
        | { readonly spec: ValidatedWorkflowDefinition }
        | { readonly savedWorkflow: string }
      ));

const DEFINITION_FIELDS = ["source", "spec", "savedWorkflow"] as const;

/** Enforce the four accepted workflow shapes: draftId approval, or preview plus exactly one definition. */
export function parseWorkflowToolRequest(
  params: WorkflowToolParams,
): WorkflowToolRequest {
  const definitions = DEFINITION_FIELDS.filter(
    (field) => params[field] !== undefined,
  );
  if (params.draftId !== undefined) {
    const extra = [
      ...definitions,
      ...(params.args === undefined ? [] : ["args"]),
      ...(params.background === undefined ? [] : ["background"]),
    ];
    if (extra.length > 0) {
      throw new Error(
        `workflow approval accepts only draftId; remove ${extra.join(", ")}. Execution inputs are fixed when the draft is prepared.`,
      );
    }
    return { kind: "approve", draftId: params.draftId };
  }
  if (definitions.length !== 1) {
    throw new Error(
      definitions.length === 0
        ? "workflow requires draftId to approve, or preview plus exactly one of source, spec, or savedWorkflow to prepare."
        : `workflow accepts exactly one of source, spec, or savedWorkflow; received ${definitions.join(", ")}.`,
    );
  }
  if (params.preview === undefined) {
    throw new Error(
      "workflow preparation requires preview alongside source, spec, or savedWorkflow.",
    );
  }
  const common: PrepareCommonInput = {
    preview: params.preview,
    ...(params.args === undefined ? {} : { args: params.args }),
    ...(params.background === undefined
      ? {}
      : { background: params.background }),
  };
  if (params.source !== undefined)
    return { kind: "prepare", ...common, source: params.source };
  if (params.savedWorkflow !== undefined)
    return { kind: "prepare", ...common, savedWorkflow: params.savedWorkflow };
  return { kind: "prepare", ...common, spec: params.spec };
}

export const WORKFLOW_CONTROL_ACTIONS = [
  "pause",
  "resume",
  "cancel",
  "retry",
  "skip",
] as const;

export const WORKFLOW_CONTROL_TOOL_PARAMS = Type.Object({
  action: StringEnum(WORKFLOW_CONTROL_ACTIONS, {
    description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.action,
  }),
  runId: Type.String({
    description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.runId,
  }),
  taskId: Type.Optional(
    Type.String({
      description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.taskId,
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: WORKFLOW_CONTROL_PARAMETER_DESCRIPTIONS.reason,
    }),
  ),
});
export type WorkflowControlToolParams = Static<
  typeof WORKFLOW_CONTROL_TOOL_PARAMS
>;

/** Enforce that retry/skip name a task and run-level actions do not. */
export function parseWorkflowControlRequest(
  params: WorkflowControlToolParams,
): WorkflowControlRequest {
  const reason = params.reason === undefined ? {} : { reason: params.reason };
  switch (params.action) {
    case "retry":
    case "skip":
      if (params.taskId === undefined || params.taskId.length === 0) {
        throw new Error(
          `workflow_control ${params.action} requires taskId naming the workflow task.`,
        );
      }
      return {
        action: params.action,
        runId: params.runId,
        taskId: params.taskId,
        ...reason,
      };
    case "pause":
    case "resume":
    case "cancel":
      if (params.taskId !== undefined) {
        throw new Error(
          `workflow_control ${params.action} applies to the whole run; remove taskId.`,
        );
      }
      return { action: params.action, runId: params.runId, ...reason };
    default:
      throw new Error(
        `workflow_control action must be one of ${WORKFLOW_CONTROL_ACTIONS.join(", ")}.`,
      );
  }
}
