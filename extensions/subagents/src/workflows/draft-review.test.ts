/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Rendering tests use deliberately partial Theme, TUI, and keybinding doubles. */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { WorkflowDraft } from "./drafts.ts";
import {
  WorkflowDraftReview,
  workflowDraftReviewText,
} from "./draft-review.ts";

const draft: WorkflowDraft = {
  version: 1,
  draftId: "draft_123456789abc",
  createdAt: 1,
  sessionId: "session",
  cwd: "/repo",
  preparedAtUserInput: 1,
  preview: "Inspect the repository, then produce one bounded report.",
  definition: {
    name: "review canary",
    tasks: [
      {
        id: "inspect",
        label: "Inspect",
        kind: "scout",
        prompt: "Inspect",
        readOnly: true,
        harness: "pi",
        model: "openai-codex/gpt-5.6-luna",
        effort: "high",
      },
      {
        id: "report",
        label: "Report",
        kind: "writer",
        prompt: "Report",
        needs: ["inspect"],
        consumes: ["inspect"],
        owns: ["report.md"],
      },
    ],
  },
  background: true,
  provenance: { kind: "inline-spec", sha256: "a".repeat(64) },
  executionSha256: "b".repeat(64),
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const keybindings = {
  matches: (data: string, action: string) =>
    data === "escape" && action === "tui.select.cancel",
} as unknown as KeybindingsManager;

function createReview(done: (action: string) => void) {
  const tui = {
    terminal: { rows: 24 },
    requestRender() {},
  } as unknown as TUI;
  return new WorkflowDraftReview(
    tui,
    theme,
    keybindings,
    draft,
    "/tmp/draft.json",
    done,
  );
}

test("draft review text presents outcome, task wiring, and exact spec without raw artifact JSON", () => {
  const text = workflowDraftReviewText(draft, "/tmp/draft.json");
  assert.match(text, /review canary/);
  assert.match(text, /Inspect \(inspect\)/);
  assert.match(text, /Report \(report\)/);
  assert.match(text, /owns report\.md after inspect/);
  assert.match(text, /Exact spec/);
  assert.doesNotMatch(text, /sessionId|preparedAtUserInput/);
});

test("draft inspector is bounded, split on wide screens, and tabbed on narrow screens", () => {
  const review = createReview(() => {});
  const wide = review.render(120);
  assert.ok(wide.some((line) => line.includes("Review")));
  assert.ok(wide.some((line) => line.includes("Exact spec")));
  assert.ok(wide.every((line) => visibleWidth(line) <= 120));

  const narrowReview = createReview(() => {});
  const narrow = narrowReview.render(56);
  assert.ok(
    narrow.some((line) => line.includes("Outcome") || line.includes("OUTCOME")),
  );
  assert.ok(narrow.every((line) => visibleWidth(line) <= 56));
  narrowReview.handleInput("l");
  const source = narrowReview.render(56);
  assert.ok(source.some((line) => line.includes("Exact spec")));
  assert.ok(source.every((line) => visibleWidth(line) <= 56));
});

test("draft inspector exposes explicit approve and close actions", () => {
  const actions: string[] = [];
  const review = createReview((action) => actions.push(action));
  review.handleInput("a");
  review.handleInput("escape");
  assert.deepEqual(actions, ["approve", "close"]);
});
