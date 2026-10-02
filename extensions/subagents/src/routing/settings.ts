/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Settings are an untrusted JSON boundary and are validated before use. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BACKEND_NAMES,
  MAX_RUNNING_LIMITS,
  REASONING_EFFORTS,
  type BackendName,
  type ReasoningEffort,
} from "../domain.ts";
import {
  ROUTING_INTENTS,
  type RouteKey,
  type RouteTable,
  type RoutingPolicy,
  type RuntimeSelection,
  type SettingsSnapshot,
  type SubagentSettings,
} from "./domain.ts";

const MAX_SETTINGS_BYTES = 256 * 1024;

export const DEFAULT_GLOBAL_SUBAGENTS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "subagents.json",
);
export const PROJECT_SUBAGENTS_PATH = path.join(".pi", "subagents.json");

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = deepFreeze({
  version: 1,
  maxRunning: MAX_RUNNING_LIMITS.default,
  routing: {
    enabled: false,
    approval: "ask",
    ambiguous: "ask",
    unavailable: "ask",
    routes: {},
  },
});

interface ParsedSettings {
  readonly maxRunning?: number;
  readonly routing?: Partial<RoutingPolicy> & { readonly routes?: RouteTable };
}

export interface LoadSubagentSettingsOptions {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly globalPath?: string;
  readonly readFile?: (file: string) => string | undefined;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown)
    throw new Error(`${label} contains unsupported field "${unknown}"`);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseRuntime(value: unknown, label: string): RuntimeSelection {
  const input = record(value, label);
  onlyKeys(input, ["harness", "model", "effort"], label);
  const harness =
    input.harness === undefined
      ? undefined
      : oneOf(input.harness, BACKEND_NAMES, `${label}.harness`);
  const model =
    input.model === undefined
      ? undefined
      : nonEmptyString(input.model, `${label}.model`);
  const effort =
    input.effort === undefined
      ? undefined
      : oneOf(input.effort, REASONING_EFFORTS, `${label}.effort`);
  if (harness === undefined || model === undefined) {
    throw new Error(`${label} must specify harness and model together`);
  }
  return {
    ...(harness === undefined ? {} : { harness: harness as BackendName }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort: effort as ReasoningEffort }),
  };
}

function parseRoutes(value: unknown, label: string): RouteTable {
  const input = record(value, label);
  const keys: readonly RouteKey[] = [
    ...ROUTING_INTENTS,
    "simple_validation",
    "hard",
  ];
  onlyKeys(input, keys, label);
  const output: Partial<Record<RouteKey, RuntimeSelection>> = {};
  for (const key of keys) {
    if (input[key] !== undefined)
      output[key] = parseRuntime(input[key], `${label}.${key}`);
  }
  return output;
}

function parseFile(text: string, label: string): ParsedSettings {
  if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES)
    throw new Error(`${label} exceeds ${MAX_SETTINGS_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const input = record(value, label);
  onlyKeys(input, ["version", "maxRunning", "routing"], label);
  if (input.version !== 1) throw new Error(`${label} has unsupported version`);
  let maxRunning: number | undefined;
  if (input.maxRunning !== undefined) {
    if (
      typeof input.maxRunning !== "number" ||
      !Number.isInteger(input.maxRunning) ||
      input.maxRunning < MAX_RUNNING_LIMITS.min ||
      input.maxRunning > MAX_RUNNING_LIMITS.max
    ) {
      throw new Error(
        `${label}.maxRunning must be an integer from ${MAX_RUNNING_LIMITS.min} through ${MAX_RUNNING_LIMITS.max}`,
      );
    }
    maxRunning = input.maxRunning;
  }

  let routing: ParsedSettings["routing"];
  if (input.routing !== undefined) {
    const raw = record(input.routing, `${label}.routing`);
    onlyKeys(
      raw,
      ["enabled", "approval", "ambiguous", "unavailable", "routes"],
      `${label}.routing`,
    );
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
      throw new Error(`${label}.routing.enabled must be boolean`);
    routing = {
      ...(raw.enabled === undefined ? {} : { enabled: raw.enabled }),
      ...(raw.approval === undefined
        ? {}
        : {
            approval: oneOf(
              raw.approval,
              ["ask", "auto"] as const,
              `${label}.routing.approval`,
            ),
          }),
      ...(raw.ambiguous === undefined
        ? {}
        : {
            ambiguous: oneOf(
              raw.ambiguous,
              ["ask"] as const,
              `${label}.routing.ambiguous`,
            ),
          }),
      ...(raw.unavailable === undefined
        ? {}
        : {
            unavailable: oneOf(
              raw.unavailable,
              ["ask"] as const,
              `${label}.routing.unavailable`,
            ),
          }),
      ...(raw.routes === undefined
        ? {}
        : { routes: parseRoutes(raw.routes, `${label}.routing.routes`) }),
    };
  }

  return {
    ...(maxRunning === undefined ? {} : { maxRunning }),
    ...(routing === undefined ? {} : { routing }),
  };
}

function apply(
  base: SubagentSettings,
  overlay: ParsedSettings,
  project: boolean,
): SubagentSettings {
  const routing =
    overlay.routing === undefined
      ? base.routing
      : {
          ...base.routing,
          ...overlay.routing,
          routes:
            overlay.routing.routes === undefined
              ? base.routing.routes
              : { ...base.routing.routes, ...overlay.routing.routes },
        };
  if (
    project &&
    overlay.routing?.approval === "auto" &&
    base.routing.approval !== "auto"
  ) {
    throw new Error(
      "Project routing approval may only restrict the global policy",
    );
  }
  if (
    project &&
    overlay.maxRunning !== undefined &&
    overlay.maxRunning > base.maxRunning
  ) {
    throw new Error(
      `Project maxRunning may only lower the global cap (${base.maxRunning})`,
    );
  }
  return {
    version: 1,
    maxRunning: overlay.maxRunning ?? base.maxRunning,
    routing,
  };
}

/** Stat signature: absent files key as "-", present files by identity, mtime, and size. */
function statSignature(file: string): string {
  try {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_SETTINGS_BYTES
    )
      throw new Error(`${file} is not a bounded regular settings file`);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "-";
    throw error;
  }
}

function readOptional(file: string): string | undefined {
  if (statSignature(file) === "-") return undefined;
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const SNAPSHOT_CACHE_LIMIT = 16;
/** Merged snapshots keyed by both files' (path, inode, mtimeMs, size) and trust. */
const snapshotCache = new Map<string, SettingsSnapshot>();

/** Test hook: drop cached settings snapshots. */
export function clearSubagentSettingsCache(): void {
  snapshotCache.clear();
}

export function settingsDigest(settings: SubagentSettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

/**
 * Read, strictly validate, and atomically merge global and trusted-project
 * settings. Filesystem reads are cached by each file's stat signature, so an
 * unchanged pair of files costs two lstat calls; any change reloads both.
 */
export function loadSubagentSettings(
  options: LoadSubagentSettingsOptions,
): SettingsSnapshot {
  const globalPath = path.resolve(
    options.globalPath ?? DEFAULT_GLOBAL_SUBAGENTS_PATH,
  );
  const projectPath = path.resolve(options.cwd, PROJECT_SUBAGENTS_PATH);
  if (options.readFile !== undefined) {
    return buildSnapshot(options, globalPath, projectPath, options.readFile);
  }
  const key = [
    globalPath,
    statSignature(globalPath),
    projectPath,
    statSignature(projectPath),
    options.projectTrusted ? "trusted" : "untrusted",
  ].join("\0");
  const cached = snapshotCache.get(key);
  if (cached !== undefined) return cached;
  const snapshot = buildSnapshot(
    options,
    globalPath,
    projectPath,
    readOptional,
  );
  // Only successful loads are cached; invalid files keep failing on each call.
  if (snapshotCache.size >= SNAPSHOT_CACHE_LIMIT) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
  snapshotCache.set(key, snapshot);
  return snapshot;
}

function buildSnapshot(
  options: LoadSubagentSettingsOptions,
  globalPath: string,
  projectPath: string,
  read: (file: string) => string | undefined,
): SettingsSnapshot {
  const notices: string[] = [];
  const globalText = read(globalPath);
  let settings =
    globalText === undefined
      ? DEFAULT_SUBAGENT_SETTINGS
      : apply(
          DEFAULT_SUBAGENT_SETTINGS,
          parseFile(globalText, globalPath),
          false,
        );

  const projectText = read(projectPath);
  let projectApplied = false;
  if (projectText !== undefined) {
    if (!options.projectTrusted) {
      notices.push(`Ignored untrusted project settings at ${projectPath}`);
    } else {
      settings = apply(settings, parseFile(projectText, projectPath), true);
      projectApplied = true;
    }
  }
  const frozen = deepFreeze(settings);
  return deepFreeze({
    settings: frozen,
    digest: settingsDigest(frozen),
    globalPath,
    projectPath,
    projectApplied,
    notices,
  });
}
