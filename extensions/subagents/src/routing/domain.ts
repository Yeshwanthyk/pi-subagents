import type { BackendName, ReasoningEffort } from "../domain.ts";

export const ROUTING_INTENTS = [
  "scout",
  "small_slice",
  "lint",
  "implementation",
  "validation",
] as const;
export type RoutingIntent = (typeof ROUTING_INTENTS)[number];

export const ROUTING_COMPLEXITIES = ["simple", "normal", "hard"] as const;
export type RoutingComplexity = (typeof ROUTING_COMPLEXITIES)[number];

export interface RoutingClassification {
  readonly intent?: RoutingIntent;
  readonly complexity?: RoutingComplexity;
}

export type ClassificationSource = "explicit" | "workflow_kind";

export interface RuntimeSelection {
  readonly harness?: BackendName;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
}

export interface ConcreteRuntimeSelection extends RuntimeSelection {
  readonly harness: BackendName;
  readonly model: string;
}

export type RouteKey = RoutingIntent | "simple_validation" | "hard";
export type RouteTable = Readonly<Partial<Record<RouteKey, RuntimeSelection>>>;

export interface RoutingPolicy {
  readonly enabled: boolean;
  /** "auto" admits only runtimes that exactly equal the saved route; overrides still ask. */
  readonly approval: "ask" | "auto";
  readonly ambiguous: "ask";
  readonly unavailable: "ask";
  readonly routes: RouteTable;
}

export interface SubagentSettings {
  readonly version: 1;
  /** Global cap on concurrently running children. Applied at manager creation (reload to change). */
  readonly maxRunning: number;
  readonly routing: RoutingPolicy;
}

export interface SettingsSnapshot {
  readonly settings: SubagentSettings;
  readonly digest: string;
  readonly globalPath: string;
  readonly projectPath: string;
  readonly projectApplied: boolean;
  readonly notices: ReadonlyArray<string>;
}

export type RoutingUnresolvedCode =
  | "classification_required"
  | "route_missing"
  | "runtime_incomplete"
  | "model_lookup_required"
  | "runtime_unavailable";

export interface ModelLookupAvailable {
  readonly available: true;
  readonly effective: ConcreteRuntimeSelection;
}

export interface ModelLookupUnavailable {
  readonly available: false;
  readonly reason: string;
}

export type ModelLookupResult = ModelLookupAvailable | ModelLookupUnavailable;
export type ModelLookup = (
  requested: ConcreteRuntimeSelection,
) => ModelLookupResult;

interface RoutingProposalBase {
  readonly requested: RuntimeSelection;
  readonly classification?: RoutingClassification;
  readonly classificationSource?: ClassificationSource;
  readonly configDigest: string;
}

export interface LegacyRoutingProposal extends RoutingProposalBase {
  readonly status: "legacy";
  readonly effective: RuntimeSelection;
  readonly matchedRoute?: never;
}

export interface ResolvedRoutingProposal extends RoutingProposalBase {
  readonly status: "resolved";
  /** Saved route before caller-requested runtime overrides. */
  readonly preference?: RuntimeSelection;
  readonly effective: ConcreteRuntimeSelection;
  readonly matchedRoute?: RouteKey;
  readonly requiresApproval: boolean;
}

export interface UnresolvedRoutingProposal extends RoutingProposalBase {
  readonly status: "unresolved";
  readonly matchedRoute?: RouteKey;
  readonly code: RoutingUnresolvedCode;
  readonly reason: string;
}

export type RoutingProposal =
  LegacyRoutingProposal | ResolvedRoutingProposal | UnresolvedRoutingProposal;
