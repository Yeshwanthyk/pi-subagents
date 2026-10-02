import { isWorkflowTerminal, type WorkflowStatus } from "./domain.ts";

/** The slice of the workflow owner that terminal waiting needs. */
export interface WorkflowTerminalSource {
  get(runId: string): { readonly status: WorkflowStatus } | undefined;
  subscribe(
    runId: string,
    listener: (next: { readonly status: WorkflowStatus }) => void,
  ): () => void;
}

/**
 * Resolve true once the run is terminal, false on timeout or abort.
 * Unknown runs resolve true so the caller's inspection reports the error.
 */
export function waitForWorkflowTerminal(
  source: WorkflowTerminalSource | undefined,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const current = source?.get(runId);
  if (!source || !current || isWorkflowTerminal(current.status)) {
    return Promise.resolve(true);
  }
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (terminal: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener("abort", onAbort);
      resolve(terminal);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = source.subscribe(runId, (next) => {
      if (isWorkflowTerminal(next.status)) finish(true);
    });
    if (settled) unsubscribe();
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the race between the initial read and subscription.
    const latest = source.get(runId);
    if (!latest || isWorkflowTerminal(latest.status)) finish(true);
  });
}
