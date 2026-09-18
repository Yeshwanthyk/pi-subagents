/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- Credential files are an untrusted filesystem and JSON boundary. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024;
const MAX_API_KEY_BYTES = 8 * 1024;

export const DEFAULT_JEV_CREDENTIALS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "jev-credentials.json",
);

export interface JevCredentialOptions {
  readonly apiKeyEnv: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly credentialsPath?: string;
}

export class JevCredentialError extends Error {
  constructor() {
    super("Saved Jev credential file is invalid");
    this.name = "JevCredentialError";
  }
}

function invalidCredential(): never {
  throw new JevCredentialError();
}

function parseCredential(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidCredential();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidCredential();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes("version") ||
    !keys.includes("apiKey") ||
    record.version !== 1 ||
    typeof record.apiKey !== "string"
  ) {
    return invalidCredential();
  }
  const apiKey = record.apiKey.trim();
  if (
    apiKey.length === 0 ||
    Buffer.byteLength(apiKey, "utf8") > MAX_API_KEY_BYTES
  ) {
    return invalidCredential();
  }
  return apiKey;
}

export function loadSavedJevApiKey(
  credentialsPath = DEFAULT_JEV_CREDENTIALS_PATH,
): string | undefined {
  const file = path.resolve(credentialsPath);
  let descriptor: number | undefined;
  try {
    const initial = fs.lstatSync(file);
    if (initial.isSymbolicLink() || !initial.isFile())
      return invalidCredential();
    if (initial.size > MAX_CREDENTIAL_FILE_BYTES) return invalidCredential();
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_CREDENTIAL_FILE_BYTES) {
      return invalidCredential();
    }
    const text = fs.readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_CREDENTIAL_FILE_BYTES) {
      return invalidCredential();
    }
    return parseCredential(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof JevCredentialError) throw error;
    throw new JevCredentialError();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function resolveJevApiKey(
  options: JevCredentialOptions,
): string | undefined {
  const environmentKey = (options.env ?? process.env)[
    options.apiKeyEnv
  ]?.trim();
  if (environmentKey) return environmentKey;
  return loadSavedJevApiKey(
    options.credentialsPath ?? DEFAULT_JEV_CREDENTIALS_PATH,
  );
}

export function hasJevCredential(options: JevCredentialOptions): boolean {
  try {
    return resolveJevApiKey(options) !== undefined;
  } catch {
    return false;
  }
}

export function saveJevApiKey(
  apiKey: string,
  credentialsPath = DEFAULT_JEV_CREDENTIALS_PATH,
): void {
  const normalized = apiKey.trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > MAX_API_KEY_BYTES
  ) {
    throw new Error("Jev API key must be non-empty and at most 8192 bytes");
  }

  const file = path.resolve(credentialsPath);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) invalidCredential();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const body = `${JSON.stringify({ version: 1, apiKey: normalized }, null, 2)}\n`;
  try {
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, body, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup after either a successful rename or failed write.
    }
  }
}
