import { execFileSync } from "node:child_process";
import type { SubagentSnapshot } from "./domain.ts";

export type ExternalHost = "herdr" | "cmux" | "tmux";

export interface ExternalLaunch {
  host: ExternalHost;
  target: string;
  focusCommand: string;
}

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function currentExternalHost(
  env: NodeJS.ProcessEnv = process.env,
): ExternalHost | undefined {
  if (env.HERDR_ENV === "1" && env.HERDR_WORKSPACE_ID) return "herdr";
  if (env.CMUX_WORKSPACE_ID) return "cmux";
  if (env.TMUX) return "tmux";
  return undefined;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function compactTitle(value: string): string {
  const title =
    value
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "pi session";
  return title.slice(0, 80);
}

function piArgv(snapshot: SubagentSnapshot): string[] {
  const sessionFile = snapshot.meta.sessionFilePath;
  if (!sessionFile)
    throw new Error("Interactive session has no persisted session file.");
  const argv = ["pi", "--session", sessionFile];
  if (snapshot.tools && snapshot.tools.length > 0) {
    argv.push("--tools", snapshot.tools.join(","));
  }
  return argv;
}

export function launchInCurrentHost(
  snapshot: SubagentSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): ExternalLaunch | undefined {
  const host = currentExternalHost(env);
  if (!host) return undefined;

  const title = compactTitle(snapshot.title);
  const argv = piArgv(snapshot);

  if (host === "herdr") {
    const workspace = env.HERDR_WORKSPACE_ID!;
    const name = `${snapshot.owner}-${snapshot.id}`;
    execFileSync(
      "herdr",
      [
        "agent",
        "start",
        name,
        "--cwd",
        snapshot.cwd,
        "--workspace",
        workspace,
        "--no-focus",
        "--",
        ...argv,
      ],
      { stdio: "pipe" },
    );
    return {
      host,
      target: name,
      focusCommand: `herdr agent focus ${shellEscape(name)}`,
    };
  }

  if (host === "cmux") {
    const workspace = env.CMUX_WORKSPACE_ID!;
    const output = execFileSync(
      "cmux",
      [
        "new-surface",
        "--type",
        "terminal",
        "--workspace",
        workspace,
        "--focus",
        "false",
        "--id-format",
        "both",
      ],
      { encoding: "utf8" },
    );
    const surfaceLine = output
      .split("\n")
      .find((line) => line.trim().startsWith("surface:"));
    const surface = surfaceLine?.match(UUID_PATTERN)?.[0];
    if (!surface)
      throw new Error(`Unexpected cmux new-surface output: ${output.trim()}`);
    execFileSync("cmux", [
      "rename-tab",
      "--workspace",
      workspace,
      "--surface",
      surface,
      title,
    ]);
    execFileSync("cmux", [
      "send",
      "--workspace",
      workspace,
      "--surface",
      surface,
      `${argv.map(shellEscape).join(" ")}\n`,
    ]);
    return {
      host,
      target: surface,
      focusCommand: `cmux move-surface --surface ${shellEscape(surface)} --focus true`,
    };
  }

  const command = argv.map(shellEscape).join(" ");
  const window = execFileSync(
    "tmux",
    [
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-n",
      title,
      "-c",
      snapshot.cwd,
      command,
    ],
    { encoding: "utf8" },
  ).trim();
  if (!window.startsWith("@"))
    throw new Error(`Unexpected tmux new-window output: ${window}`);
  return {
    host,
    target: window,
    focusCommand: `tmux select-window -t ${shellEscape(window)}`,
  };
}
