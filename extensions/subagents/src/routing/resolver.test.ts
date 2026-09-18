/* oxlint-disable anti-slop/no-unknown-parameters -- Test fixtures intentionally exercise unknown JSON input. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConcreteRuntimeSelection, ModelLookup } from "./domain.ts";
import {
  classificationForWorkflowKind,
  resolveRouting,
  validateRoutingClassification,
} from "./resolver.ts";
import { loadSubagentSettings } from "./settings.ts";

function settings(value?: unknown) {
  return loadSubagentSettings({
    cwd: "/workspace",
    projectTrusted: true,
    globalPath: "/global.json",
    readFile: (file) =>
      file === "/global.json" && value !== undefined
        ? JSON.stringify(value)
        : undefined,
  });
}

const available: ModelLookup = (requested) => ({
  available: true,
  effective: requested,
});

test("disabled routing preserves legacy runtime and performs no lookup", () => {
  let lookups = 0;
  const proposal = resolveRouting({
    settings: settings(),
    classification: { intent: "scout" },
    explicit: { model: "bare-model" },
    lookupModel: (runtime) => {
      lookups++;
      return { available: true, effective: runtime };
    },
  });
  assert.equal(proposal.status, "legacy");
  assert.deepEqual(proposal.effective, { model: "bare-model" });
  assert.equal(lookups, 0);
});

test("hard route wins and explicit fields win over route fields", () => {
  const snapshot = settings({
    version: 1,
    routing: {
      enabled: true,
      routes: {
        implementation: { harness: "pi", model: "ordinary", effort: "medium" },
        hard: { harness: "pi", model: "hard-model", effort: "high" },
      },
    },
  });
  const proposal = resolveRouting({
    settings: snapshot,
    classification: { intent: "implementation", complexity: "hard" },
    classificationSource: "explicit",
    explicit: { effort: "max" },
    lookupModel: available,
  });
  assert.equal(proposal.status, "resolved");
  assert.equal(proposal.matchedRoute, "hard");
  assert.deepEqual(proposal.requested, {
    harness: "pi",
    model: "hard-model",
    effort: "max",
  });
});

test("simple validation selects only the configured simple-validation route", () => {
  const snapshot = settings({
    version: 1,
    routing: {
      enabled: true,
      routes: {
        simple_validation: {
          harness: "pi",
          model: "opencode-go/deepseek-v4-flash",
          effort: "medium",
        },
        validation: { harness: "pi", model: "large-validation-model" },
      },
    },
  });
  const proposal = resolveRouting({
    settings: snapshot,
    classification: { intent: "validation", complexity: "simple" },
    lookupModel: available,
  });
  assert.equal(proposal.status, "resolved");
  assert.equal(proposal.matchedRoute, "simple_validation");
  assert.equal(proposal.effective.model, "opencode-go/deepseek-v4-flash");
});

test("simple validation does not fall through to a stronger validation route", () => {
  const snapshot = settings({
    version: 1,
    routing: {
      enabled: true,
      routes: {
        validation: { harness: "pi", model: "large-validation-model" },
        hard: { harness: "pi", model: "hard-model" },
      },
    },
  });
  const proposal = resolveRouting({
    settings: snapshot,
    classification: { intent: "validation", complexity: "simple" },
    lookupModel: available,
  });
  assert.equal(proposal.status, "unresolved");
  assert.equal(proposal.matchedRoute, "simple_validation");
  assert.equal(proposal.code, "route_missing");
  assert.match(proposal.reason, /simple_validation/);
});

test("hard complexity alone selects the hard route", () => {
  const proposal = resolveRouting({
    settings: settings({
      version: 1,
      routing: {
        enabled: true,
        routes: { hard: { harness: "pi", model: "hard-only" } },
      },
    }),
    classification: { complexity: "hard" },
    lookupModel: available,
  });
  assert.equal(proposal.status, "resolved");
  assert.equal(proposal.matchedRoute, "hard");
});

test("fully explicit runtime does not require classification or preference approval", () => {
  const proposal = resolveRouting({
    settings: settings({ version: 1, routing: { enabled: true } }),
    explicit: { harness: "codex", model: "specified", effort: "high" },
    lookupModel: available,
  });
  assert.equal(proposal.status, "resolved");
  assert.equal(proposal.matchedRoute, undefined);
  assert.equal(proposal.requiresApproval, false);
});

test("enabled unresolved cases fail clearly instead of inheriting defaults", () => {
  const snapshot = settings({
    version: 1,
    routing: { enabled: true, routes: {} },
  });
  assert.deepEqual(
    resolveRouting({ settings: snapshot, lookupModel: available }),
    {
      status: "unresolved",
      requested: {},
      configDigest: snapshot.digest,
      code: "classification_required",
      reason: "Routing is enabled but no assignment intent was supplied",
    },
  );
  const missing = resolveRouting({
    settings: snapshot,
    classification: { intent: "lint" },
    lookupModel: available,
  });
  assert.equal(missing.status, "unresolved");
  assert.equal(missing.code, "route_missing");
  assert.match(missing.reason, /lint/);
});

test("lookup is injectable and preserves requested versus negotiated runtime", () => {
  const snapshot = settings({
    version: 1,
    routing: {
      enabled: true,
      routes: {
        scout: { harness: "pi", model: "provider/model", effort: "max" },
      },
    },
  });
  const seen: ConcreteRuntimeSelection[] = [];
  const proposal = resolveRouting({
    settings: snapshot,
    classification: { intent: "scout" },
    lookupModel: (runtime) => {
      seen.push(runtime);
      return {
        available: true,
        effective: { ...runtime, effort: "xhigh" },
      };
    },
  });
  assert.deepEqual(seen, [
    { harness: "pi", model: "provider/model", effort: "max" },
  ]);
  assert.equal(proposal.status, "resolved");
  assert.equal(proposal.requested.effort, "max");
  assert.equal(proposal.effective.effort, "xhigh");
  assert.equal(proposal.requiresApproval, true);

  const noLookup = resolveRouting({
    settings: snapshot,
    classification: { intent: "scout" },
  });
  assert.equal(noLookup.status, "unresolved");
  assert.equal(noLookup.code, "model_lookup_required");
});

test("workflow kind defaults are safe and repair remains ambiguous", () => {
  assert.deepEqual(classificationForWorkflowKind("scout"), {
    intent: "scout",
    complexity: "normal",
  });
  assert.deepEqual(classificationForWorkflowKind("writer"), {
    intent: "implementation",
    complexity: "normal",
  });
  assert.deepEqual(classificationForWorkflowKind("proof"), {
    intent: "validation",
    complexity: "normal",
  });
  assert.deepEqual(classificationForWorkflowKind("review"), {
    intent: "validation",
    complexity: "normal",
  });
  assert.equal(classificationForWorkflowKind("repair"), undefined);
});

test("classification validation accepts simple complexity", () => {
  assert.deepEqual(
    validateRoutingClassification({
      intent: "validation",
      complexity: "simple",
    }),
    { intent: "validation", complexity: "simple" },
  );
});

test("classification validation rejects unknown fields and values", () => {
  assert.throws(
    () => validateRoutingClassification({ intent: "scout", extra: true }),
    /unsupported field "extra"/,
  );
  assert.throws(
    () => validateRoutingClassification({ intent: "guess" }),
    /Invalid routing intent/,
  );
});
