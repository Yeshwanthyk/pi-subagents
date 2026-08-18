/**
 * Compatibility exports for the parent-linked result delivery module.
 *
 * Parent results are owned by `parent-mailbox.ts`; this module intentionally
 * contains no independent delivery state.
 */
export {
  createParentMailbox,
  DEFAULT_PARENT_MAILBOX_LIMITS,
  PARENT_RESULT_LIMITS,
  parentResultEnvelope,
  type ParentMailbox,
  type ParentMailboxLimits,
  type ParentResultEnvelope,
} from "./parent-mailbox.ts";
