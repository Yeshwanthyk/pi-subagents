/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- Workflow definitions are immutable snapshots; conditional spreads preserve omitted optional fields. */

import type { ModelLookup, SettingsSnapshot } from "../routing/domain.ts";
import {
  classificationForWorkflowKind,
  resolveRouting,
} from "../routing/resolver.ts";
import type {
  ValidatedWorkflowDefinition,
  WorkflowTaskDefinition,
} from "../workflows/domain.ts";
import type { WorkflowDefinitionPreparer } from "../workflows/tools.ts";

export interface WorkflowRoutingPreparationContext {
  readonly settings: SettingsSnapshot;
  readonly lookupModel: ModelLookup;
  readonly jevCredentialPresent: boolean;
}

function effectiveEvaluationPolicy(context: WorkflowRoutingPreparationContext) {
  const jev = context.settings.settings.jev;
  return {
    provider: "jev" as const,
    apiKeyEnv: jev.apiKeyEnv,
    model: jev.model,
    timeoutMs: jev.timeoutMs,
    maxConcurrent: jev.maxConcurrent,
  };
}

function routeDefinition(
  definition: ValidatedWorkflowDefinition,
  context: WorkflowRoutingPreparationContext,
): ValidatedWorkflowDefinition {
  const requiresJev = definition.tasks.some(
    (task) => task.execution?.type === "evaluation" || task.gate !== undefined,
  );
  if (requiresJev && !context.jevCredentialPresent) {
    throw new Error(
      "Workflow requests Jev evaluation or a gate, but the configured Jev credential is missing.",
    );
  }
  if (
    requiresJev &&
    JSON.stringify(definition.evaluationPolicy) !==
      JSON.stringify(effectiveEvaluationPolicy(context))
  ) {
    throw new Error(
      "Workflow evaluation policy does not match the current validated Jev settings.",
    );
  }
  if (!context.settings.settings.routing.enabled) return definition;
  const tasks = definition.tasks.map((task): WorkflowTaskDefinition => {
    if (task.execution?.type === "evaluation") return task;
    const classification =
      task.classification ?? classificationForWorkflowKind(task.kind);
    const proposal = resolveRouting({
      classification,
      classificationSource: task.classification ? "explicit" : "workflow_kind",
      explicit: {
        ...(task.harness === undefined ? {} : { harness: task.harness }),
        ...(task.model === undefined ? {} : { model: task.model }),
        ...(task.effort === undefined ? {} : { effort: task.effort }),
      },
      settings: context.settings,
      lookupModel: context.lookupModel,
    });
    if (proposal.status !== "resolved") {
      const reason =
        proposal.status === "unresolved"
          ? proposal.reason
          : "preference routing is disabled";
      throw new Error(
        `Workflow task "${task.id}" has no executable route: ${reason}`,
      );
    }
    return {
      ...task,
      harness: proposal.effective.harness,
      model: proposal.effective.model,
      ...(proposal.effective.effort === undefined
        ? {}
        : { effort: proposal.effective.effort }),
    };
  });
  return { ...definition, tasks };
}

/** Resolve concrete runtimes synchronously before WorkflowToolLifecycle persists a draft. */
export function createWorkflowRoutingPreparer(
  base: WorkflowDefinitionPreparer,
  getContext: () => WorkflowRoutingPreparationContext,
): WorkflowDefinitionPreparer {
  return {
    prepareSource(source) {
      return routeDefinition(base.prepareSource(source), getContext());
    },
    prepareSpec(spec) {
      const context = getContext();
      const requiresJev = spec.tasks.some(
        (task) =>
          task.execution?.type === "evaluation" || task.gate !== undefined,
      );
      const prepared =
        requiresJev && spec.evaluationPolicy === undefined
          ? { ...spec, evaluationPolicy: effectiveEvaluationPolicy(context) }
          : spec;
      return routeDefinition(base.prepareSpec(prepared), context);
    },
  };
}
