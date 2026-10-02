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
}

function routeDefinition(
  definition: ValidatedWorkflowDefinition,
  context: WorkflowRoutingPreparationContext,
): ValidatedWorkflowDefinition {
  if (!context.settings.settings.routing.enabled) return definition;
  const tasks = definition.tasks.map((task): WorkflowTaskDefinition => {
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
      return routeDefinition(base.prepareSpec(spec), getContext());
    },
  };
}
