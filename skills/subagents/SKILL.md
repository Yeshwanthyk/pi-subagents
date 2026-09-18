---
name: subagents
description: Orchestrate subagents when the user asks to delegate work or use subagents.
---

# Subagents

Each child is headless, has separate context, cannot ask the user, and cannot spawn subagents or workflows.

1. Choose standalone delegation for bounded tasks or `workflow` for a reviewed dependency graph. Keep decomposition proportional and give every child a self-contained prompt with paths, constraints, scope, and expected report.
2. Classify the actual deliverable, not the child name or permissions. Use `validation` with `complexity: "simple"` for lightweight validation; this selects `simple_validation`. Use `complexity: "hard"` only for genuinely hard work.
3. Choose runtime explicitly when required. Explicit harness/model fields win. Otherwise use `subagent_route`, or classified `subagent_spawn`, as a preference recommendation: show the proposed runtime, wait for a newer user approval, then pass the exact proposal ID and binding digest to `subagent_approve`.
4. For a workflow, prepare the immutable draft with `workflow`, review the outcome and every task's purpose, wiring, scope, and requested runtime, then wait for a newer explicit user response before approving the exact draft ID.
5. Coordinate standalone children with `subagent_inspect`, `subagent_send`, `subagent_list`, `subagent_wait`, and `subagent_cancel`. Continue only outside delegated scope until a required result arrives.
6. Consider Jev on each request and while planning or delegating, without calling it automatically. Prefer it for bounded classification, scoring, or report judgments when it replaces a larger model call or avoids reading a long report. Batch related questions and send minimal selected evidence; Jev is advisory, not proof or authority.
7. When continuation depends on judging a child's result, add a Jev gate. Show planned gates before required approval, and put exact code checks and tests in the child task. Gated standalone delivery is compact acceptance by default; request its full report explicitly when needed. Workflow consumers that truly need a report retain its content—never strip dependency evidence.

Read [Jev and standalone routing usage](../../extensions/subagents/docs/jev-routing-usage.md) for gate schemas and workflow forms. Use effective settings for runtime preferences and registered tool schemas for arguments.
