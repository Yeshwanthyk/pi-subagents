/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Settings are an untrusted JSON boundary and are validated before use. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BACKEND_NAMES,
  REASONING_EFFORTS,
  type BackendName,
  type ReasoningEffort,
} from "../domain.ts";
import {
  ROUTING_INTENTS,
  type JevSettings,
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
  routing: {
    enabled: false,
    approval: "ask",
    ambiguous: "ask",
    unavailable: "ask",
    routes: {},
  },
  jev: {
    apiKeyEnv: "TYPESAFE_API_KEY",
    model: "jev-1.13.0",
    timeoutMs: 10_000,
    maxConcurrent: 2,
  },
});

interface ParsedSettings {
  readonly routing?: Partial<RoutingPolicy> & { readonly routes?: RouteTable };
  readonly jev?: Partial<JevSettings>;
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

function positiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value as number;
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

function parseFile(
  text: string,
  label: string,
  project: boolean,
): ParsedSettings {
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
  onlyKeys(input, ["version", "routing", "jev"], label);
  if (input.version !== 1) throw new Error(`${label} has unsupported version`);

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
              ["ask"] as const,
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

  let jev: ParsedSettings["jev"];
  if (input.jev !== undefined) {
    const raw = record(input.jev, `${label}.jev`);
    if (Object.hasOwn(raw, "enabled")) {
      throw new Error(
        `${label}.jev.enabled is obsolete; remove it because credential presence now controls Jev availability`,
      );
    }
    onlyKeys(
      raw,
      ["apiKeyEnv", "model", "timeoutMs", "maxConcurrent"],
      `${label}.jev`,
    );
    if (project && raw.apiKeyEnv !== undefined) {
      throw new Error(`${label}.jev cannot change credentials`);
    }
    jev = {
      ...(raw.apiKeyEnv === undefined
        ? {}
        : {
            apiKeyEnv: nonEmptyString(raw.apiKeyEnv, `${label}.jev.apiKeyEnv`),
          }),
      ...(raw.model === undefined
        ? {}
        : { model: nonEmptyString(raw.model, `${label}.jev.model`) }),
      ...(raw.timeoutMs === undefined
        ? {}
        : {
            timeoutMs: positiveInteger(
              raw.timeoutMs,
              `${label}.jev.timeoutMs`,
              120_000,
            ),
          }),
      ...(raw.maxConcurrent === undefined
        ? {}
        : {
            maxConcurrent: positiveInteger(
              raw.maxConcurrent,
              `${label}.jev.maxConcurrent`,
              32,
            ),
          }),
    };
  }
  return {
    ...(routing === undefined ? {} : { routing }),
    ...(jev === undefined ? {} : { jev }),
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
  let jev =
    overlay.jev === undefined ? base.jev : { ...base.jev, ...overlay.jev };
  if (project && overlay.jev !== undefined) {
    if (
      overlay.jev.timeoutMs !== undefined &&
      overlay.jev.timeoutMs > base.jev.timeoutMs
    ) {
      throw new Error("Project Jev timeout may only restrict the global limit");
    }
    if (
      overlay.jev.maxConcurrent !== undefined &&
      overlay.jev.maxConcurrent > base.jev.maxConcurrent
    ) {
      throw new Error(
        "Project Jev concurrency may only restrict the global limit",
      );
    }
    jev = { ...jev, apiKeyEnv: base.jev.apiKeyEnv };
  }
  return { version: 1, routing, jev };
}

function readOptional(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_SETTINGS_BYTES
    )
      throw new Error(`${file} is not a bounded regular settings file`);
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function settingsDigest(settings: SubagentSettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

/** Read, strictly validate, and atomically merge global and trusted-project settings. */
export function loadSubagentSettings(
  options: LoadSubagentSettingsOptions,
): SettingsSnapshot {
  const globalPath = path.resolve(
    options.globalPath ?? DEFAULT_GLOBAL_SUBAGENTS_PATH,
  );
  const projectPath = path.resolve(options.cwd, PROJECT_SUBAGENTS_PATH);
  const read = options.readFile ?? readOptional;
  const notices: string[] = [];
  const globalText = read(globalPath);
  let settings =
    globalText === undefined
      ? DEFAULT_SUBAGENT_SETTINGS
      : apply(
          DEFAULT_SUBAGENT_SETTINGS,
          parseFile(globalText, globalPath, false),
          false,
        );

  const projectText = read(projectPath);
  let projectApplied = false;
  if (projectText !== undefined) {
    if (!options.projectTrusted) {
      notices.push(`Ignored untrusted project settings at ${projectPath}`);
    } else {
      settings = apply(
        settings,
        parseFile(projectText, projectPath, true),
        true,
      );
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
