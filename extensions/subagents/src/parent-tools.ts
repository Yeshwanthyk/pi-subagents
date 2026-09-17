import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Effect } from "effect";
import {
  latestText,
  type SubagentSendMode,
  type SubagentSnapshot,
} from "./domain.ts";
import { parentSubagentView, type SubagentManagerApi } from "./manager.ts";
import {
  SUBAGENT_INSPECT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_INSPECT_TOOL_DESCRIPTION,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
} from "./prompt.ts";

const INSPECT_MAX_TOOLS = 4;
const INSPECT_MAX_QUEUED = 4;
const INSPECT_PREVIEW_MAX_LENGTH = 512;
const INSPECT_OUTPUT_MAX_BYTES = 2_048;

function singleLine(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function truncateCharacters(text: string, maxLength: number) {
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function boundedPreview(text: string | undefined) {
  return text === undefined
    ? undefined
    : truncateCharacters(singleLine(text), INSPECT_PREVIEW_MAX_LENGTH);
}

function latestInspectionOutput(snap: SubagentSnapshot) {
  const current = latestText(snap);
  if (current) return current;
  for (let index = snap.transcript.length - 1; index >= 0; index--) {
    const item = snap.transcript[index];
    if (item?.kind !== "assistant") continue;
    const text = item.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Bounded, read-only projection shared by the canonical tool and its alias. */
export function projectSubagentInspection(snap: SubagentSnapshot) {
  const currentTools = snap.liveTools
    .slice(0, INSPECT_MAX_TOOLS)
    .map((tool) => ({
      name: boundedPreview(tool.name) ?? "tool",
      args: boundedPreview(tool.argsPreview),
      output: boundedPreview(tool.outputPreview),
      startedAt: tool.startedAt,
      updatedAt: tool.updatedAt,
    }));
  const queuedInstructions = snap.queued
    .slice(0, INSPECT_MAX_QUEUED)
    .map((message) => ({
      kind: message.kind,
      text: boundedPreview(message.text) ?? "",
    }));
  const output = latestInspectionOutput(snap);
  const latestOutput = output
    ? truncateHead(output, {
        maxBytes: INSPECT_OUTPUT_MAX_BYTES,
        maxLines: 20,
      })
    : undefined;
  const lastCompletedOperation = snap.lastCompletedOperation
    ? {
        name: boundedPreview(snap.lastCompletedOperation.name) ?? "tool",
        isError: snap.lastCompletedOperation.isError,
        output: boundedPreview(snap.lastCompletedOperation.outputPreview),
        finishedAt: snap.lastCompletedOperation.finishedAt,
      }
    : undefined;

  return {
    currentTools,
    omittedCurrentTools: Math.max(
      0,
      snap.liveTools.length - currentTools.length,
    ),
    lastActivityAt: snap.lastActivityAt,
    queuedInstructions,
    omittedQueuedInstructions: Math.max(
      0,
      snap.queued.length - queuedInstructions.length,
    ),
    completedOperations: snap.completedOperations,
    lastCompletedOperation,
    latestOutput: latestOutput?.content,
    latestOutputTruncated: latestOutput?.truncated ?? false,
    capabilities: snap.capabilities ?? {
      steering: false,
      modelSelection: false,
      reasoningEffort: false,
    },
  };
}

function describeInspection(snap: SubagentSnapshot) {
  const projection = projectSubagentInspection(snap);
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    snap.meta.reasoningEffort
      ? `think:${snap.meta.reasoningEffort}`
      : undefined,
  ].filter(Boolean);
  let text = `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
  text += `\nTurns: ${snap.turns}`;
  text += `\nLast activity: ${new Date(projection.lastActivityAt).toISOString()}`;
  text +=
    `\nCapabilities: steering=${projection.capabilities.steering ? "yes" : "no"},` +
    ` model_selection=${projection.capabilities.modelSelection ? "yes" : "no"},` +
    ` reasoning_effort=${projection.capabilities.reasoningEffort ? "yes" : "no"}`;
  if (snap.errorText) text += `\nError: ${snap.errorText}`;

  if (projection.currentTools.length > 0) {
    text += "\n\nCurrent tools:";
    for (const tool of projection.currentTools) {
      const suffix = [tool.args, tool.output].filter(Boolean).join(" · ");
      text += `\n- ${tool.name}${suffix ? `: ${suffix}` : ""}`;
    }
    if (projection.omittedCurrentTools > 0) {
      text += `\n- [... ${projection.omittedCurrentTools} more]`;
    }
  }
  if (projection.queuedInstructions.length > 0) {
    text += "\n\nQueued instructions:";
    for (const instruction of projection.queuedInstructions) {
      text += `\n- ${instruction.kind}: ${instruction.text}`;
    }
    if (projection.omittedQueuedInstructions > 0) {
      text += `\n- [... ${projection.omittedQueuedInstructions} more]`;
    }
  }
  text += `\n\nCompleted operations: ${projection.completedOperations}`;
  if (projection.lastCompletedOperation) {
    const operation = projection.lastCompletedOperation;
    text += `\nLast completed: ${operation.name} (${operation.isError ? "error" : "ok"})`;
    if (operation.output) text += `: ${operation.output}`;
  }

  if (projection.latestOutput) {
    text += `\n\nLatest output:\n${projection.latestOutput}`;
    if (projection.latestOutputTruncated) text += "\n[...]";
  } else if (snap.status === "queued") {
    text += "\n\n(waiting for an execution slot)";
  } else if (snap.status === "running") {
    text += "\n\n(no text output yet)";
  }

  return { text, details: projection };
}

export interface ParentToolDependencies {
  readonly getManager: () => Promise<SubagentManagerApi>;
  readonly runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

/** Build parent-only send and inspection tools over the filtered manager view. */
export function createSubagentParentTools(
  dependencies: ParentToolDependencies,
) {
  const send = {
    name: "subagent_send",
    label: "Send to Subagent",
    description: SUBAGENT_SEND_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id,
      }),
      message: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.message,
      }),
      mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("auto"),
            Type.Literal("steer"),
            Type.Literal("follow_up"),
          ],
          { description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.mode },
        ),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string; message: string; mode?: SubagentSendMode },
    ) {
      const manager = await dependencies.getManager();
      const view = parentSubagentView(manager.view);
      const snap = view.get(params.id);
      if (!snap) {
        const known = view.list().map((item) => item.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }
      const message = params.message.trim();
      if (message.length === 0) throw new Error("message is required.");

      const requestedMode = params.mode ?? "auto";
      const result = await dependencies.runEffect(
        manager.send(snap.id, message, requestedMode),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Sent instruction to ${snap.id} using effective mode "${result.mode}".`,
          },
        ],
        details: {
          id: result.id,
          requestedMode,
          effectiveMode: result.mode,
        },
      };
    },
  };

  const parameters = Type.Object({
    id: Type.String({
      description: SUBAGENT_INSPECT_PARAMETER_DESCRIPTIONS.id,
    }),
  });
  const executeInspection = async (
    _toolCallId: string,
    params: { id: string },
  ) => {
    const manager = await dependencies.getManager();
    const view = parentSubagentView(manager.view);
    const snap = view.get(params.id);
    if (!snap) {
      const known = view.list().map((item) => item.id);
      throw new Error(
        `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
      );
    }

    const report = describeInspection(snap);
    return {
      content: [{ type: "text" as const, text: report.text }],
      details: {
        id: snap.id,
        status: snap.status,
        turns: snap.turns,
        ...report.details,
      },
    };
  };
  const sharedInspectionTool = {
    label: "Inspect Subagent",
    description: SUBAGENT_INSPECT_TOOL_DESCRIPTION,
    parameters,
    execute: executeInspection,
  };

  const inspect = { name: "subagent_inspect", ...sharedInspectionTool };
  const check = { name: "subagent_check", ...sharedInspectionTool };
  return { send, inspect, check };
}

/** Register the definitions built above on Pi's public tool surface. */
export function registerSubagentParentTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  dependencies: ParentToolDependencies,
) {
  const tools = createSubagentParentTools(dependencies);
  pi.registerTool(tools.send);
  pi.registerTool(tools.inspect);
  pi.registerTool(tools.check);
}
