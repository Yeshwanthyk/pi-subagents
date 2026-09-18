/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- Untrusted classifications are checked against closed domain constants before normalization. */
import {
  BACKEND_NAMES,
  REASONING_EFFORTS,
  type BackendName,
  type ReasoningEffort,
} from "../domain.ts";
import {
  ROUTING_COMPLEXITIES,
  ROUTING_INTENTS,
  type ClassificationSource,
  type ConcreteRuntimeSelection,
  type ModelLookup,
  type RouteKey,
  type RoutingClassification,
  type RoutingComplexity,
  type RoutingIntent,
  type RoutingProposal,
  type RuntimeSelection,
  type SettingsSnapshot,
} from "./domain.ts";

export type ExistingWorkflowTaskKind =
  "scout" | "writer" | "proof" | "review" | "repair";

export interface ResolveRoutingInput {
  readonly classification?: RoutingClassification;
  readonly classificationSource?: ClassificationSource;
  readonly explicit?: RuntimeSelection;
  readonly settings: SettingsSnapshot;
  readonly lookupModel?: ModelLookup;
  /** Compatibility marker for callers that recorded explicit user runtime authorization. */
  readonly explicitRuntimeAuthorized?: boolean;
}

export function validateRoutingClassification(
  value: unknown,
): RoutingClassification {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Routing classification must be an object");
  const classification = value as Record<string, unknown>;
  const unsupported = Object.keys(classification).find(
    (key) => key !== "intent" && key !== "complexity",
  );
  if (unsupported !== undefined)
    throw new Error(
      `Routing classification contains unsupported field "${unsupported}"`,
    );
  const intent = classification.intent;
  const complexity = classification.complexity;
  if (
    intent !== undefined &&
    (typeof intent !== "string" ||
      !ROUTING_INTENTS.includes(intent as RoutingIntent))
  ) {
    throw new Error(`Invalid routing intent "${String(intent)}"`);
  }
  if (
    complexity !== undefined &&
    (typeof complexity !== "string" ||
      !ROUTING_COMPLEXITIES.includes(complexity as RoutingComplexity))
  ) {
    throw new Error(`Invalid routing complexity "${String(complexity)}"`);
  }
  return Object.freeze({
    ...(intent === undefined ? {} : { intent: intent as RoutingIntent }),
    ...(complexity === undefined
      ? {}
      : { complexity: complexity as RoutingComplexity }),
  });
}

export function classificationForWorkflowKind(
  kind: ExistingWorkflowTaskKind,
): RoutingClassification | undefined {
  switch (kind) {
    case "scout":
      return { intent: "scout", complexity: "normal" };
    case "writer":
      return { intent: "implementation", complexity: "normal" };
    case "proof":
    case "review":
      return { intent: "validation", complexity: "normal" };
    case "repair":
      return undefined;
  }
}

function validatedRuntime(
  value: RuntimeSelection | undefined,
): RuntimeSelection {
  if (value === undefined) return {};
  if (value.harness !== undefined && !BACKEND_NAMES.includes(value.harness)) {
    throw new Error(`Invalid explicit harness "${String(value.harness)}"`);
  }
  if (value.model !== undefined && value.model.trim().length === 0) {
    throw new Error("Explicit model cannot be empty");
  }
  if (value.effort !== undefined && !REASONING_EFFORTS.includes(value.effort)) {
    throw new Error(`Invalid explicit effort "${String(value.effort)}"`);
  }
  return {
    ...(value.harness === undefined
      ? {}
      : { harness: value.harness as BackendName }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.effort === undefined
      ? {}
      : { effort: value.effort as ReasoningEffort }),
  };
}

function combine(
  route: RuntimeSelection | undefined,
  explicit: RuntimeSelection,
): RuntimeSelection {
  return {
    ...(route?.harness === undefined ? {} : { harness: route.harness }),
    ...(route?.model === undefined ? {} : { model: route.model }),
    ...(route?.effort === undefined ? {} : { effort: route.effort }),
    ...explicit,
  };
}

/** Pure deterministic routing. Availability is supplied by the caller; no provider is guessed. */
export function resolveRouting(input: ResolveRoutingInput): RoutingProposal {
  const explicit = validatedRuntime(input.explicit);
  const classification =
    input.classification === undefined
      ? undefined
      : validateRoutingClassification(input.classification);
  const base = {
    requested: explicit,
    ...(classification === undefined ? {} : { classification }),
    ...(input.classificationSource === undefined
      ? {}
      : { classificationSource: input.classificationSource }),
    configDigest: input.settings.digest,
  };
  if (!input.settings.settings.routing.enabled) {
    return { ...base, status: "legacy", effective: explicit };
  }

  const explicitIsConcrete =
    explicit.harness !== undefined && explicit.model !== undefined;
  let matchedRoute: RouteKey | undefined;
  let route: RuntimeSelection | undefined;
  if (!explicitIsConcrete) {
    if (classification?.complexity === "hard") matchedRoute = "hard";
    else if (
      classification?.intent === "validation" &&
      classification.complexity === "simple"
    )
      matchedRoute = "simple_validation";
    else if (classification?.intent !== undefined)
      matchedRoute = classification.intent;
    if (matchedRoute !== undefined)
      route = input.settings.settings.routing.routes[matchedRoute];
  }

  if (!explicitIsConcrete && matchedRoute === undefined) {
    return {
      ...base,
      status: "unresolved",
      code: "classification_required",
      reason: "Routing is enabled but no assignment intent was supplied",
    };
  }
  if (!explicitIsConcrete && route === undefined) {
    return {
      ...base,
      status: "unresolved",
      ...(matchedRoute === undefined ? {} : { matchedRoute }),
      code: "route_missing",
      reason:
        matchedRoute === undefined
          ? "Routing is enabled but no applicable route was found"
          : `Routing is enabled but route "${matchedRoute}" is not configured`,
    };
  }

  const requested = combine(route, explicit);
  const proposalBase = {
    ...base,
    requested,
    ...(matchedRoute === undefined || route === undefined
      ? {}
      : { matchedRoute }),
  };
  if (requested.harness === undefined || requested.model === undefined) {
    return {
      ...proposalBase,
      status: "unresolved",
      code: "runtime_incomplete",
      reason:
        "The selected route does not provide a concrete harness and model",
    };
  }
  const concrete: ConcreteRuntimeSelection = {
    harness: requested.harness,
    model: requested.model,
    ...(requested.effort === undefined ? {} : { effort: requested.effort }),
  };
  if (input.lookupModel === undefined) {
    return {
      ...proposalBase,
      status: "unresolved",
      code: "model_lookup_required",
      reason:
        "A model catalog lookup is required before this runtime can be approved",
    };
  }
  const availability = input.lookupModel(concrete);
  if (!availability.available) {
    return {
      ...proposalBase,
      status: "unresolved",
      code: "runtime_unavailable",
      reason: availability.reason,
    };
  }
  return {
    ...proposalBase,
    status: "resolved",
    effective: availability.effective,
    requiresApproval: route !== undefined,
  };
}
