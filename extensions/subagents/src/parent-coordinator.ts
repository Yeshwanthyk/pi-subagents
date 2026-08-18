import type { ParentRef, SubagentSnapshot } from "./domain.ts";
import {
  createParentMailbox,
  parentResultEnvelope,
  type ParentMailbox,
  type ParentResultEnvelope,
} from "./parent-mailbox.ts";
import {
  captureParentRef,
  isSafeParentRef,
  type ParentSessionContext,
  type ParentSessionManager,
} from "./parent-ref.ts";

export interface ParentResultCoordinatorOptions {
  readonly mailbox?: ParentMailbox;
  readonly sendBatch: (batch: ReadonlyArray<ParentResultEnvelope>) => void;
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
  startSession(context: ParentFlushContext, epoch: number): void;
  capture(epoch: number, sessionManager: ParentSessionManager): ParentRef;
  onSettled(snapshot: SubagentSnapshot, consumed: boolean): void;
  consume(owners: Iterable<ParentResultOwner>): void;
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
  let current: CurrentParent | undefined;
  let closed = false;

  const startSession = (context: ParentFlushContext, epoch: number) => {
    mailbox.clear();
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
    const envelope = parentResultEnvelope(snapshot);
    if (envelope === undefined) return;
    if (consumed) {
      mailbox.consume([envelope.id], envelope.parentRef);
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

  const flush = (context: ParentFlushContext): boolean => {
    if (closed || current === undefined || !context.isIdle()) return false;
    if (context.sessionManager !== current.sessionManager) return false;

    const currentParent = current;
    const safeContext: ParentSessionContext = {
      sessionManager: context.sessionManager,
      isIdle: () => true,
    };
    const batch = mailbox.peekMatching((envelope) =>
      isSafeParentRef(envelope.parentRef, safeContext, currentParent.epoch),
    );
    if (batch.length === 0) return false;

    try {
      options.sendBatch(batch);
    } catch {
      // Keep the batch in the mailbox so a later idle/settled hook can retry.
      return false;
    }
    mailbox.remove(batch);
    return true;
  };

  const close = () => {
    closed = true;
    current = undefined;
    mailbox.clear();
  };

  return {
    mailbox,
    startSession,
    capture: captureParentRef,
    onSettled,
    consume,
    flush,
    close,
  };
}
