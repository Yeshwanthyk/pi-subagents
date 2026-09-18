/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Routing snapshots preserve exact optional JSON fields and are validated/frozen by the proposal store. */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { BackendName, ReasoningEffort } from "../domain.ts";
import {
  ROUTING_COMPLEXITIES,
  ROUTING_INTENTS,
  type ConcreteRuntimeSelection,
  type ModelLookup,
  type RoutingClassification,
  type SettingsSnapshot,
} from "../routing/domain.ts";
import {
  SessionBatchProposalStore,
  type BatchProposal,
} from "../routing/proposals.ts";
import { resolveRouting } from "../routing/resolver.ts";
import {
  STANDALONE_GATE_PARAMETERS,
  type StandaloneGateParams,
} from "./standalone-gate.ts";

export const ROUTING_CLASSIFICATION_PARAMETERS = Type.Object(
  {
    intent: Type.Optional(StringEnum(ROUTING_INTENTS)),
    complexity: Type.Optional(StringEnum(ROUTING_COMPLEXITIES)),
  },
  { additionalProperties: false },
);

export const ROUTED_SPAWN_TASK_PARAMETERS = Type.Object(
  {
    prompt: Type.String(),
    name: Type.String(),
    classification: ROUTING_CLASSIFICATION_PARAMETERS,
    gate: Type.Optional(STANDALONE_GATE_PARAMETERS),
    harness: Type.Optional(
      Type.Union([Type.Literal("pi"), Type.Literal("codex")]),
    ),
    working_dir: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    reasoning_effort: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type RoutedSpawnTaskParams = Static<typeof ROUTED_SPAWN_TASK_PARAMETERS>;

export interface BoundRoutedSpawnTask {
  readonly prompt: string;
  readonly name: string;
  readonly cwd: string;
  readonly classification: RoutingClassification;
  readonly gate?: StandaloneGateParams;
  readonly harness?: BackendName;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface RoutingPreparationContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly userInputRevision: number;
  readonly settings: SettingsSnapshot;
  readonly lookupModel: ModelLookup;
}

export interface RoutingApprovalContext extends RoutingPreparationContext {
  readonly proposalId: string;
  readonly bindingDigest: string;
}

export interface RoutedAdmissionResult {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly harness: BackendName;
  readonly model?: string;
}

export type AdmitRoutedSpawn = (
  task: BoundRoutedSpawnTask,
  runtime: ConcreteRuntimeSelection,
) => Promise<RoutedAdmissionResult>;

function explicitRuntime(task: BoundRoutedSpawnTask) {
  return {
    ...(task.harness === undefined ? {} : { harness: task.harness }),
    ...(task.model === undefined ? {} : { model: task.model }),
    ...(task.reasoningEffort === undefined
      ? {}
      : { effort: task.reasoningEffort }),
  };
}

export class StandaloneRoutingController {
  readonly #store: SessionBatchProposalStore;
  readonly #admissions = new Map<
    string,
    {
      readonly expiresAt: number;
      readonly promise: Promise<ReadonlyArray<RoutedAdmissionResult>>;
    }
  >();

  constructor(store = new SessionBatchProposalStore()) {
    this.#store = store;
  }

  prepare(
    tasks: ReadonlyArray<BoundRoutedSpawnTask>,
    context: RoutingPreparationContext,
  ): BatchProposal {
    const items = tasks.map((task) => {
      const explicit = explicitRuntime(task);
      const resolved = resolveRouting({
        classification: task.classification,
        classificationSource: "explicit",
        explicit,
        settings: context.settings,
        lookupModel: context.lookupModel,
      });
      const runtime =
        resolved.status === "resolved" && task.gate
          ? { ...resolved, requiresApproval: true }
          : resolved;
      if (runtime.status !== "resolved") {
        const reason =
          runtime.status === "unresolved"
            ? runtime.reason
            : "preference routing is disabled";
        throw new Error(`Cannot route ${task.name}: ${reason}`);
      }
      return {
        input: { task, projectCwd: context.cwd },
        runtime,
        settings: context.settings,
      };
    });
    return this.#store.create({
      sessionId: context.sessionId,
      preparedAtUserInput: context.userInputRevision,
      items,
    });
  }

  approveAndAdmit(
    context: RoutingApprovalContext,
    admit: AdmitRoutedSpawn,
  ): Promise<ReadonlyArray<RoutedAdmissionResult>> {
    const now = Date.now();
    for (const [id, entry] of this.#admissions) {
      if (entry.expiresAt <= now) this.#admissions.delete(id);
    }
    const approved = this.#store.approve(context.proposalId, {
      sessionId: context.sessionId,
      userInput: context.userInputRevision,
      bindingDigest: context.bindingDigest,
    });
    const exact = this.#store.requireApproved(
      approved.id,
      context.sessionId,
      context.bindingDigest,
    );
    for (const item of exact.items) {
      if (item.settingsDigest !== context.settings.digest) {
        throw new Error(
          "Routing settings changed after proposal; prepare a new proposal",
        );
      }
      const availability = context.lookupModel(item.runtime.effective);
      if (!availability.available) {
        throw new Error(
          `Approved runtime is no longer available: ${availability.reason}`,
        );
      }
      if (
        availability.effective.harness !== item.runtime.effective.harness ||
        availability.effective.model !== item.runtime.effective.model ||
        availability.effective.effort !== item.runtime.effective.effort
      ) {
        throw new Error("Runtime availability changed the reviewed runtime");
      }
      const bound = item.input as unknown as {
        readonly task: BoundRoutedSpawnTask;
        readonly projectCwd: string;
      };
      if (bound.projectCwd !== context.cwd) {
        throw new Error(
          "Routing proposal belongs to a different working directory",
        );
      }
    }
    const existing = this.#admissions.get(context.proposalId);
    if (existing) return existing.promise;
    const admission = Promise.allSettled(
      exact.items.map((item) => {
        const bound = item.input as unknown as {
          readonly task: BoundRoutedSpawnTask;
        };
        return admit(bound.task, item.runtime.effective);
      }),
    ).then((settled) => {
      const admitted = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failed = settled.length - admitted.length;
      if (failed > 0) {
        const admittedIds = admitted.map((result) => result.id).join(", ");
        throw new Error(
          `Routed batch admission partially failed (${failed}/${settled.length});` +
            ` admitted ids: ${admittedIds || "none"}. Repeating approval will not spawn duplicates.`,
        );
      }
      return admitted;
    });
    this.#admissions.set(context.proposalId, {
      expiresAt: exact.expiresAt,
      promise: admission,
    });
    return admission;
  }

  clear(): void {
    this.#store.clear();
    this.#admissions.clear();
  }
}
