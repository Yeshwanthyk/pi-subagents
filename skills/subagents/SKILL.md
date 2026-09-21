---
name: subagents
description: Orchestrate subagents when the user asks to delegate work or use subagents.
---

# Subagents

Each child is headless, has separate context, cannot ask the user, and cannot spawn subagents or workflows.

1. Choose standalone delegation for bounded tasks or `workflow` for a reviewed dependency graph. Keep decomposition proportional and give every child a self-contained prompt with paths, constraints, scope, and expected report.
2. Classify the actual deliverable, not the child name or permissions. Use `validation` with `complexity: "simple"` for lightweight validation; this selects `simple_validation`. Use `complexity: "hard"` only for genuinely hard work.
3. Choose runtime explicitly when required. Explicit harness/model fields win. Otherwise use `subagent_route`, or classified `subagent_spawn`, as a preference recommendation: show the proposed runtime, wait for a newer user approval, then pass the exact proposal ID and binding digest to `subagent_approve`.
   Before passing user-supplied model shorthand, read `~/.pi/agent/subagents.json` and resolve it against the distinct saved provider/model IDs. Use a unique matching ID; repeated routes to the same model count as one match. Preserve explicitly requested harness and reasoning effort rather than copying those fields from a matching route. Ask only if the model is ambiguous, unresolved, or reported unavailable by the tool. Resolution leaves tool validation and approval requirements unchanged.
4. For a workflow, prepare the immutable draft with `workflow`, review the outcome and every task's purpose, wiring, scope, and requested runtime, then wait for a newer explicit user response before approving the exact draft ID.
5. Coordinate standalone children with `subagent_inspect`, `subagent_send`, `subagent_list`, `subagent_wait`, and `subagent_cancel`. A Pi child can pause on `ask_parent`; `subagent_wait` returns its bounded question, exact `requestId`, and deadline while the child keeps its execution slot. Answer with `subagent_send` using `mode: "reply"` and that exact request ID. `steer` cancels the pending question; `follow_up` queues work and is never an answer. Continue only outside delegated scope until a required result arrives.
6. Consider Jev on each request and while planning or delegating, without calling it automatically. Prefer it for bounded classification, scoring, or report judgments when it replaces a larger model call or avoids reading a long report. Batch related questions and send minimal selected evidence; Jev is advisory, not proof or authority.
7. When continuation depends on judging a child's result, add a Jev gate. Show planned gates before required approval, and put exact code checks and tests in the child task. Gated standalone delivery is compact acceptance by default; request its full report explicitly when needed. Workflow consumers that truly need a report retain its content—never strip dependency evidence.

Read [Jev and standalone routing usage](../../extensions/subagents/docs/jev-routing-usage.md) for gate schemas and workflow forms. Use effective settings for runtime preferences and registered tool schemas for arguments.
