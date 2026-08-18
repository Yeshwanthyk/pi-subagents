import * as path from "node:path";
import type { ParentRef } from "./domain.ts";

/** Minimal session-manager surface needed for parent-link capture and checks. */
export interface ParentSessionManager {
  getSessionFile(): string | null | undefined;
  getLeafId(): string | null;
  getBranch(): ReadonlyArray<{ readonly id: string }>;
}

/** Minimal current parent context used by the safe mailbox flush. */
export interface ParentSessionContext {
  readonly sessionManager: ParentSessionManager;
  isIdle(): boolean;
}

/** Normalize persisted paths without inventing a file for an in-memory session. */
export function normalizeParentSessionFile(
  sessionFile: string | null | undefined,
): string | undefined {
  if (
    sessionFile === undefined ||
    sessionFile === null ||
    sessionFile.length === 0
  )
    return undefined;
  return path.normalize(sessionFile);
}

/**
 * Capture the parent relationship exactly once at the spawn boundary.
 * In-memory sessions have no session file and are identified by epoch/branch.
 */
export function captureParentRef(
  epoch: number,
  sessionManager: ParentSessionManager,
): ParentRef {
  const sessionFile = normalizeParentSessionFile(
    sessionManager.getSessionFile(),
  );
  const leafId = sessionManager.getLeafId();
  const ref: ParentRef = { epoch, leafId: leafId ?? null };
  if (sessionFile !== undefined) return { ...ref, sessionFile };
  return ref;
}

export function sameParentRef(left: ParentRef, right: ParentRef): boolean {
  return (
    left.epoch === right.epoch &&
    left.sessionFile === right.sessionFile &&
    left.leafId === right.leafId
  );
}

/** Stable internal key; the parent reference is deliberately part of identity. */
export function parentRefKey(ref: ParentRef): string {
  return JSON.stringify([ref.epoch, ref.sessionFile ?? null, ref.leafId]);
}

/**
 * A result may be flushed only into the current parent branch. A null capture
 * leaf is conservatively valid only while the current session is also at its
 * root; a non-null capture remains valid at that leaf and its descendants.
 */
export function isSafeParentRef(
  ref: ParentRef,
  current: ParentSessionContext,
  currentEpoch: number,
): boolean {
  if (ref.epoch !== currentEpoch) return false;

  try {
    const currentSessionFile = normalizeParentSessionFile(
      current.sessionManager.getSessionFile(),
    );
    if (ref.sessionFile !== currentSessionFile) return false;

    const currentLeafId = current.sessionManager.getLeafId();
    if (ref.leafId === null) return currentLeafId === null;
    if (currentLeafId === ref.leafId) return true;

    return current.sessionManager
      .getBranch()
      .some((entry) => entry.id === ref.leafId);
  } catch {
    // A session manager that cannot prove its branch cannot safely receive a
    // result captured at a different leaf.
    return false;
  }
}
