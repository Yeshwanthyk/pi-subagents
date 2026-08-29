/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-conditional-empty-object-spread -- This module is the persisted JSON boundary and validates every draft field before ownership transfer. */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidatedWorkflowDefinition } from "./domain.ts";
import { validateWorkflowDefinition } from "./graph.ts";
import { utf8Bytes } from "./events.ts";
import {
  assertWorkflowProvenance,
  inlineWorkflowProvenance,
  workflowExecutionSha256,
  type WorkflowDraftProvenance,
} from "./provenance.ts";

const DRAFT_ID_PATTERN = /^draft_[a-f0-9]{12}$/;
const DRAFT_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_MAX_BYTES = 64 * 1024;
const SOURCE_MAX_BYTES = 512 * 1024;
const ARGS_MAX_BYTES = 512 * 1024;

export interface WorkflowDraft {
  readonly version: 1;
  readonly draftId: string;
  readonly createdAt: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly preparedAtUserInput: number;
  readonly preview: string;
  readonly definition: ValidatedWorkflowDefinition;
  readonly source?: string;
  readonly args?: string;
  readonly background: boolean;
  readonly provenance: WorkflowDraftProvenance;
  readonly executionSha256: string;
}

export interface CreateWorkflowDraftInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly preparedAtUserInput: number;
  readonly preview: string;
  readonly definition: unknown;
  readonly source?: string;
  readonly args?: string;
  readonly background?: boolean;
  readonly provenance?: WorkflowDraftProvenance;
  readonly now?: () => number;
  readonly createId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new Error(`${label} contains unsupported field "${unexpected}"`);
  }
}

function assertString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Workflow draft has an invalid ${label}`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
  }
  return value;
}

/** Validate and snapshot the complete graph before it reaches persistence. */
export function snapshotWorkflowDefinition(
  value: unknown,
): ValidatedWorkflowDefinition {
  return validateWorkflowDefinition(value);
}

function draftsDir(workflowsDir: string): string {
  return path.join(workflowsDir, "drafts");
}

function draftDirectory(workflowsDir: string, draftId: string): string {
  if (!DRAFT_ID_PATTERN.test(draftId)) {
    throw new Error(`Invalid workflow draft ID "${draftId}"`);
  }
  return path.join(draftsDir(workflowsDir), draftId);
}

export function workflowDraftArtifactPath(
  workflowsDir: string,
  draftId: string,
): string {
  return path.join(draftDirectory(workflowsDir, draftId), "draft.json");
}

function validateDraft(value: unknown, expectedDraftId: string): WorkflowDraft {
  if (!isRecord(value)) throw new Error("Workflow draft is not an object");
  assertOnlyKeys(
    value,
    [
      "version",
      "draftId",
      "createdAt",
      "sessionId",
      "cwd",
      "preparedAtUserInput",
      "preview",
      "definition",
      "source",
      "args",
      "background",
      "provenance",
      "executionSha256",
    ],
    "Workflow draft",
  );
  if (value.version !== 1)
    throw new Error("Unsupported workflow draft version");
  if (value.draftId !== expectedDraftId) {
    throw new Error("Workflow draft ID does not match its artifact path");
  }
  if (
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0
  ) {
    throw new Error("Workflow draft has an invalid creation time");
  }
  const sessionId = assertString(value.sessionId, "sessionId");
  const cwd = assertString(value.cwd, "cwd");
  const preview = assertString(value.preview, "preview");
  if (utf8Bytes(preview) > PREVIEW_MAX_BYTES) {
    throw new Error(`Workflow preview exceeds ${PREVIEW_MAX_BYTES} bytes`);
  }
  if (
    !Number.isSafeInteger(value.preparedAtUserInput) ||
    (value.preparedAtUserInput as number) < 0
  ) {
    throw new Error("Workflow draft has an invalid approval boundary");
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    throw new Error("Workflow draft has an invalid source");
  }
  if (
    typeof value.source === "string" &&
    utf8Bytes(value.source) > SOURCE_MAX_BYTES
  ) {
    throw new Error(`Workflow source exceeds ${SOURCE_MAX_BYTES} bytes`);
  }
  if (value.args !== undefined && typeof value.args !== "string") {
    throw new Error("Workflow draft has invalid args");
  }
  if (
    typeof value.args === "string" &&
    utf8Bytes(value.args) > ARGS_MAX_BYTES
  ) {
    throw new Error(`Workflow args exceed ${ARGS_MAX_BYTES} bytes`);
  }
  if (typeof value.background !== "boolean") {
    throw new Error("Workflow draft has an invalid background setting");
  }
  const definition = snapshotWorkflowDefinition(value.definition);
  if (
    !isRecord(value.provenance) ||
    typeof value.provenance.kind !== "string"
  ) {
    throw new Error("Workflow draft has invalid provenance");
  }
  let provenance: WorkflowDraftProvenance;
  if (value.provenance.kind === "inline-source") {
    assertOnlyKeys(value.provenance, ["kind", "sha256"], "Workflow provenance");
    provenance = {
      kind: "inline-source",
      sha256: assertString(value.provenance.sha256, "provenance digest"),
    };
  } else if (value.provenance.kind === "inline-spec") {
    assertOnlyKeys(value.provenance, ["kind", "sha256"], "Workflow provenance");
    provenance = {
      kind: "inline-spec",
      sha256: assertString(value.provenance.sha256, "provenance digest"),
    };
  } else if (value.provenance.kind === "saved") {
    assertOnlyKeys(
      value.provenance,
      ["kind", "name", "path", "scope", "sha256"],
      "Workflow provenance",
    );
    const scope = value.provenance.scope;
    if (
      scope !== "project-pi" &&
      scope !== "project-agents" &&
      scope !== "agent"
    ) {
      throw new Error("Workflow draft has invalid saved-workflow provenance");
    }
    provenance = {
      kind: "saved",
      name: assertString(value.provenance.name, "saved workflow name"),
      path: assertString(value.provenance.path, "saved workflow path"),
      scope,
      sha256: assertString(value.provenance.sha256, "provenance digest"),
    };
  } else {
    throw new Error("Workflow draft has invalid provenance kind");
  }
  assertWorkflowProvenance(provenance, {
    definition,
    source: value.source as string | undefined,
  });
  const executionSha256 = assertString(
    value.executionSha256,
    "execution digest",
  );
  const expectedDigest = workflowExecutionSha256({
    definition,
    source: value.source as string | undefined,
    args: value.args as string | undefined,
    background: value.background,
  });
  if (executionSha256 !== expectedDigest) {
    throw new Error(
      "Workflow draft execution inputs do not match their digest",
    );
  }

  return deepFreeze({
    version: 1,
    draftId: expectedDraftId,
    createdAt: value.createdAt,
    sessionId,
    cwd,
    preparedAtUserInput: value.preparedAtUserInput as number,
    preview,
    definition,
    ...(value.source === undefined ? {} : { source: value.source as string }),
    ...(value.args === undefined ? {} : { args: value.args as string }),
    background: value.background,
    provenance,
    executionSha256,
  });
}

/** Persist a new immutable draft in an exclusive, owner-only directory. */
export function createWorkflowDraft(
  workflowsDir: string,
  input: CreateWorkflowDraftInput,
): WorkflowDraft {
  const definition = snapshotWorkflowDefinition(input.definition);
  if (
    !Number.isSafeInteger(input.preparedAtUserInput) ||
    input.preparedAtUserInput < 0
  ) {
    throw new Error("Workflow draft requires a valid user-input boundary");
  }
  if (!input.sessionId) throw new Error("Workflow draft requires a session ID");
  if (!input.preview.trim())
    throw new Error("Workflow preview cannot be empty");
  const background = input.background ?? true;
  const provenance =
    input.provenance ??
    inlineWorkflowProvenance({ definition, source: input.source });
  assertWorkflowProvenance(provenance, {
    definition,
    source: input.source,
  });
  const draftId =
    input.createId?.() ?? `draft_${randomBytes(6).toString("hex")}`;
  if (!DRAFT_ID_PATTERN.test(draftId)) {
    throw new Error(`Invalid workflow draft ID "${draftId}"`);
  }
  const createdAt = (input.now ?? Date.now)();
  const candidate = {
    version: 1 as const,
    draftId,
    createdAt,
    sessionId: input.sessionId,
    cwd: path.resolve(input.cwd),
    preparedAtUserInput: input.preparedAtUserInput,
    preview: input.preview,
    definition,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.args === undefined ? {} : { args: input.args }),
    background,
    provenance,
    executionSha256: workflowExecutionSha256({
      definition,
      source: input.source,
      args: input.args,
      background,
    }),
  };
  const draft = validateDraft(candidate, draftId);

  fs.mkdirSync(draftsDir(workflowsDir), { recursive: true, mode: 0o700 });
  const directory = draftDirectory(workflowsDir, draftId);
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    fs.writeFileSync(
      workflowDraftArtifactPath(workflowsDir, draftId),
      JSON.stringify(draft, null, 2),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return draft;
}

/** Load and strictly validate the inspectable persisted copy. */
export function loadWorkflowDraft(
  workflowsDir: string,
  draftId: string,
): WorkflowDraft {
  const file = workflowDraftArtifactPath(workflowsDir, draftId);
  let parsed: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > DRAFT_MAX_BYTES
    ) {
      throw new Error("artifact is not a bounded regular file");
    }
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not load workflow draft ${draftId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateDraft(parsed, draftId);
}

/** Persisted and process-memory authorities must agree exactly. */
export function assertWorkflowDraftArtifactMatches(
  authoritative: WorkflowDraft,
  artifact: WorkflowDraft,
): void {
  if (JSON.stringify(authoritative) !== JSON.stringify(artifact)) {
    throw new Error("Workflow draft artifact changed after preparation");
  }
}

/** Enforce the exact later-response, same-session, same-project boundary. */
export function assertWorkflowDraftApproved(
  draft: WorkflowDraft,
  context: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly userInput: number;
  },
): void {
  if (context.sessionId !== draft.sessionId) {
    throw new Error("Workflow draft belongs to a different session");
  }
  if (path.resolve(context.cwd) !== draft.cwd) {
    throw new Error("Workflow draft belongs to a different project");
  }
  if (
    !Number.isSafeInteger(context.userInput) ||
    context.userInput <= draft.preparedAtUserInput
  ) {
    throw new Error(
      "Workflow draft requires a newer user response before approval",
    );
  }
}
