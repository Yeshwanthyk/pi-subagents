import * as path from "node:path";
import type {
  ValidatedWorkflowDefinition,
  WorkflowReadModel,
} from "./domain.ts";
import {
  assertWorkflowDraftApproved,
  assertWorkflowDraftArtifactMatches,
  createWorkflowDraft,
  loadWorkflowDraft,
  workflowDraftArtifactPath,
  type WorkflowDraft,
} from "./drafts.ts";
import type { WorkflowExecutionOptions, WorkflowManager } from "./manager.ts";
import { validateWorkflowDefinition } from "./graph.ts";
import { decodeWorkflowSource } from "./sandbox.ts";
import {
  buildWorkflowApprovalMessage,
  buildWorkflowDraftMessage,
} from "./prompt.ts";
import {
  listSavedWorkflows,
  loadSavedWorkflow,
  savedWorkflowProvenance,
  type SavedWorkflow,
} from "./saved-workflows.ts";

export interface WorkflowPreparationContext {
  readonly sessionId: string;
  readonly cwd: string;
  /** Monotonic count of non-extension user inputs in this live session. */
  readonly userInput: number;
}

/** Source preparation is static and graph validation is complete before any
 * draft persistence or manager call. Neither operation starts a child. */
export interface WorkflowDefinitionPreparer {
  prepareSource(source: string): ValidatedWorkflowDefinition;
  prepareSpec(spec: ValidatedWorkflowDefinition): ValidatedWorkflowDefinition;
}

/** Default Slice 4 preparer for the single static flow(...) source surface. */
export const staticWorkflowDefinitionPreparer: WorkflowDefinitionPreparer = {
  prepareSource: decodeWorkflowSource,
  prepareSpec: validateWorkflowDefinition,
};

interface PrepareCommon {
  readonly preview: string;
  readonly args?: string;
  readonly background?: boolean;
}

export type PrepareWorkflowRequest = PrepareCommon &
  (
    | {
        readonly source: string;
        readonly spec?: never;
        readonly savedWorkflow?: never;
      }
    | {
        readonly spec: ValidatedWorkflowDefinition;
        readonly source?: never;
        readonly savedWorkflow?: never;
      }
    | {
        readonly savedWorkflow: string;
        readonly source?: never;
        readonly spec?: never;
      }
  );

export interface PreparedWorkflowResult {
  readonly kind: "draft";
  readonly draft: WorkflowDraft;
  readonly artifactPath: string;
  readonly message: string;
}

export interface ApprovedWorkflowResult {
  readonly kind: "run";
  readonly draftId: string;
  readonly run: WorkflowReadModel;
  readonly message: string;
}

export interface WorkflowToolLifecycleOptions {
  readonly workflowsDir: string;
  readonly agentDir: string;
  readonly manager: WorkflowManager;
  readonly preparer: WorkflowDefinitionPreparer;
  readonly now?: () => number;
  readonly createDraftId?: () => string;
  /** Detached execution context captured by the extension at approval time. */
  readonly execution?: WorkflowExecutionOptions;
}

/** Tool-facing prepare/review/approve authority. It deliberately has no child executor. */
export class WorkflowToolLifecycle {
  private readonly pending = new Map<string, WorkflowDraft>();
  private readonly options: WorkflowToolLifecycleOptions;

  constructor(options: WorkflowToolLifecycleOptions) {
    this.options = options;
  }

  prepare(
    request: PrepareWorkflowRequest,
    context: WorkflowPreparationContext,
  ): PreparedWorkflowResult {
    let definition: ValidatedWorkflowDefinition;
    let source: string | undefined;
    let provenance: WorkflowDraft["provenance"] | undefined;

    if (request.savedWorkflow !== undefined) {
      const saved = loadSavedWorkflow(
        request.savedWorkflow,
        context.cwd,
        this.options.agentDir,
      );
      source = saved.source;
      definition = this.options.preparer.prepareSource(saved.source);
      provenance = savedWorkflowProvenance(saved);
    } else if (request.source !== undefined) {
      source = request.source;
      definition = this.options.preparer.prepareSource(request.source);
    } else {
      definition = this.options.preparer.prepareSpec(request.spec);
    }

    definition = validateWorkflowDefinition(definition);
    const draft = createWorkflowDraft(this.options.workflowsDir, {
      sessionId: context.sessionId,
      cwd: context.cwd,
      preparedAtUserInput: context.userInput,
      preview: request.preview,
      definition,
      source,
      args: request.args,
      background: request.background,
      provenance,
      now: this.options.now,
      createId: this.options.createDraftId,
    });
    this.pending.set(draft.draftId, draft);
    const artifactPath = workflowDraftArtifactPath(
      this.options.workflowsDir,
      draft.draftId,
    );
    return {
      kind: "draft",
      draft,
      artifactPath,
      message: buildWorkflowDraftMessage({ draft, artifactPath }),
    };
  }

  approve(
    draftId: string,
    context: WorkflowPreparationContext,
    execution?: WorkflowExecutionOptions,
  ): ApprovedWorkflowResult {
    const authoritative = this.pending.get(draftId);
    if (!authoritative) {
      throw new Error(
        `Workflow draft ${draftId} is not pending in this process; prepare it again`,
      );
    }
    const artifact = loadWorkflowDraft(this.options.workflowsDir, draftId);
    assertWorkflowDraftArtifactMatches(authoritative, artifact);
    assertWorkflowDraftApproved(authoritative, context);

    const created = this.options.manager.createRun(authoritative.definition);
    const run = this.options.manager.start(
      created.id,
      execution ?? this.options.execution,
    );
    this.pending.delete(draftId);
    return {
      kind: "run",
      draftId,
      run,
      message: buildWorkflowApprovalMessage({ draftId, runId: run.id }),
    };
  }

  discoverSaved(
    context: Pick<WorkflowPreparationContext, "cwd">,
  ): SavedWorkflow[] {
    return listSavedWorkflows(context.cwd, this.options.agentDir, (source) => {
      validateWorkflowDefinition(this.options.preparer.prepareSource(source));
    });
  }

  getPending(draftId: string): WorkflowDraft | undefined {
    return this.pending.get(draftId);
  }

  listPending(context?: {
    readonly sessionId: string;
    readonly cwd: string;
  }): ReadonlyArray<WorkflowDraft> {
    const drafts = [...this.pending.values()];
    if (!context) return drafts;
    return drafts.filter(
      (draft) =>
        draft.sessionId === context.sessionId &&
        draft.cwd === path.resolve(context.cwd),
    );
  }
}
