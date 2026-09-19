import type { ParentQuestion } from "./domain.ts";
import type { ParentRef, SubagentSnapshot } from "./domain.ts";
import {
  createParentMailbox,
  createParentQuestionMailbox,
  parentResultEnvelope,
  type ParentMailbox,
  type ParentQuestionMailbox,
  type ParentResultEnvelope,
  type WorkflowResultEnvelope,
} from "./parent-mailbox.ts";
import {
  captureParentRef,
  isSafeParentRef,
  parentRefKey,
  type ParentSessionContext,
  type ParentSessionManager,
} from "./parent-ref.ts";

export interface ParentResultCoordinatorOptions {
  readonly mailbox?: ParentMailbox;
  readonly sendBatch: (batch: ReadonlyArray<ParentResultEnvelope>) => void;
  readonly questionMailbox?: ParentQuestionMailbox;
  readonly sendQuestionBatch?: (batch: ReadonlyArray<ParentQuestion>) => void;
}

export type ParentFlushContext = ParentSessionContext;

export type ParentResultOwner = Pick<
  SubagentSnapshot,
  "id" | "parentRef" | "resultDelivery"
> & { readonly client?: SubagentSnapshot["client"] };

interface CurrentParent {
  readonly epoch: number;
  readonly sessionManager: ParentSessionManager;
}

export interface ParentResultCoordinator {
  readonly mailbox: ParentMailbox;
  readonly questionMailbox: ParentQuestionMailbox;
  startSession(context: ParentFlushContext, epoch: number): void;
  capture(epoch: number, sessionManager: ParentSessionManager): ParentRef;
  onSettled(snapshot: SubagentSnapshot, consumed: boolean): void;
  onQuestion(question: ParentQuestion): void;
  consumeQuestions(questions: ReadonlyArray<ParentQuestion>): void;
  consumeQuestion(requestId: string, parentRef: ParentRef): void;
  /** Enqueue one aggregate workflow terminal result on the same parent rail. */
  onWorkflowSettled(envelope: WorkflowResultEnvelope, consumed: boolean): void;
  consume(owners: Iterable<ParentResultOwner>): void;
  consumeWorkflow(runId: string, parentRef: ParentRef): void;
  flush(context: ParentFlushContext): boolean;
  close(): void;
}

/**
 * Coordinates the runtime-only parent relationship around the bounded mailbox.
 * It is deliberately independent of Pi's ExtensionAPI so lifecycle behavior
 * can be tested with a minimal session-manager seam.
 */
export function createParentResultCoordinator(
  options: ParentResultCoordinatorOptions,
): ParentResultCoordinator {
  const mailbox = options.mailbox ?? createParentMailbox();
  const questionMailbox =
    options.questionMailbox ?? createParentQuestionMailbox();
  let current: CurrentParent | undefined;
  let closed = false;
  const deliveredWorkflowResults = new Set<string>();
  const workflowResultKey = (id: string, parentRef: ParentRef) =>
    `${parentRefKey(parentRef)}\u0000${id}`;

  const startSession = (context: ParentFlushContext, epoch: number) => {
    mailbox.clear();
    questionMailbox.clear();
    deliveredWorkflowResults.clear();
    current = { epoch, sessionManager: context.sessionManager };
    closed = false;
  };

  const onSettled = (snapshot: SubagentSnapshot, consumed: boolean) => {
    if (
      closed ||
      snapshot.resultDelivery !== "parent" ||
      snapshot.client !== undefined
    )
      return;
    if (snapshot.parentRef !== undefined) {
      questionMailbox.removeChild(snapshot.id, snapshot.parentRef);
    }
    const envelope = parentResultEnvelope(snapshot);
    if (envelope === undefined) return;
    if (consumed) {
      mailbox.consume([envelope.id], envelope.parentRef);
      return;
    }
    mailbox.enqueue(envelope);
  };

  const onQuestion = (question: ParentQuestion) => {
    if (!closed) questionMailbox.enqueue(question);
  };

  const consumeQuestions = (questions: ReadonlyArray<ParentQuestion>) => {
    if (!closed) questionMailbox.remove(questions);
  };

  const consumeQuestion = (requestId: string, parentRef: ParentRef) => {
    if (!closed) questionMailbox.consume([requestId], parentRef);
  };

  const onWorkflowSettled = (
    envelope: WorkflowResultEnvelope,
    consumed: boolean,
  ) => {
    if (closed) return;
    const key = workflowResultKey(envelope.id, envelope.parentRef);
    if (deliveredWorkflowResults.has(key)) return;
    if (consumed) {
      mailbox.consume([envelope.id], envelope.parentRef);
      deliveredWorkflowResults.add(key);
      return;
    }
    mailbox.enqueue(envelope);
  };
  const consume = (owners: Iterable<ParentResultOwner>) => {
    if (closed) return;
    for (const owner of owners) {
      if (
        owner.resultDelivery !== "parent" ||
        owner.client !== undefined ||
        owner.parentRef === undefined
      )
        continue;
      mailbox.consume([owner.id], owner.parentRef);
    }
  };

  const consumeWorkflow = (runId: string, parentRef: ParentRef) => {
    if (closed) return;
    mailbox.consume([runId], parentRef);
    deliveredWorkflowResults.add(workflowResultKey(runId, parentRef));
  };

  const flush = (context: ParentFlushContext): boolean => {
    if (closed || current === undefined || !context.isIdle()) return false;
    if (context.sessionManager !== current.sessionManager) return false;

    const currentParent = current;
    const safeContext: ParentSessionContext = {
      sessionManager: context.sessionManager,
      isIdle: () => true,
    };
    const questions = questionMailbox.peekMatching((question) =>
      isSafeParentRef(question.parentRef, safeContext, currentParent.epoch),
    );
    let delivered = false;
    if (questions.length > 0 && options.sendQuestionBatch !== undefined) {
      try {
        options.sendQuestionBatch(questions);
      } catch {
        return false;
      }
      questionMailbox.remove(questions);
      delivered = true;
    }

    const batch = mailbox.peekMatching((envelope) =>
      isSafeParentRef(envelope.parentRef, safeContext, currentParent.epoch),
    );
    if (batch.length === 0) return delivered;

    try {
      options.sendBatch(batch);
    } catch {
      // Keep the batch in the mailbox so a later idle/settled hook can retry.
      return delivered;
    }
    for (const envelope of batch) {
      if (envelope.kind === "workflow") {
        deliveredWorkflowResults.add(
          workflowResultKey(envelope.id, envelope.parentRef),
        );
      }
    }
    mailbox.remove(batch);
    return true;
  };

  const close = () => {
    closed = true;
    current = undefined;
    deliveredWorkflowResults.clear();
    mailbox.clear();
    questionMailbox.clear();
  };

  return {
    mailbox,
    questionMailbox,
    startSession,
    capture: captureParentRef,
    onSettled,
    onQuestion,
    consumeQuestions,
    consumeQuestion,
    onWorkflowSettled,
    consume,
    consumeWorkflow,
    flush,
    close,
  };
}
