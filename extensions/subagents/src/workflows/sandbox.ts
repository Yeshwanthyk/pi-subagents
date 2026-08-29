/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- Source is decoded from an Acorn AST into fresh data; it is never evaluated. */
import {
  parse,
  type ArrayExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  type Literal,
  type ObjectExpression,
  type Program,
  type Property,
} from "acorn";
import {
  buildWorkflowGraph,
  WorkflowGraphValidationError,
  type ValidatedWorkflowGraph,
} from "./graph.ts";
import type { ValidatedWorkflowDefinition } from "./domain.ts";

/** Source is bounded before parsing; the graph has its own aggregate bound. */
export const MAX_WORKFLOW_SOURCE_BYTES = 512 * 1024;
export const MAX_WORKFLOW_LITERAL_DEPTH = 16;

export class WorkflowSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSourceError";
  }
}

function isIdentifier(node: Expression, name?: string): node is Identifier {
  return (
    node.type === "Identifier" && (name === undefined || node.name === name)
  );
}

function propertyName(property: Property, label: string): string {
  if (
    property.computed ||
    property.kind !== "init" ||
    property.method ||
    property.shorthand
  ) {
    throw new WorkflowSourceError(
      `${label} must use plain, non-computed data properties`,
    );
  }
  if (isIdentifier(property.key)) return property.key.name;
  if (
    property.key.type === "Literal" &&
    typeof property.key.value === "string"
  ) {
    return property.key.value;
  }
  throw new WorkflowSourceError(`${label} has an invalid property key`);
}

function literalValue(node: Expression, label: string, depth = 0): unknown {
  if (depth > MAX_WORKFLOW_LITERAL_DEPTH) {
    throw new WorkflowSourceError("Workflow flow literal is nested too deeply");
  }
  if (node.type === "Literal") {
    const literal: Literal = node;
    if (
      literal.value === null ||
      typeof literal.value === "string" ||
      typeof literal.value === "number" ||
      typeof literal.value === "boolean"
    ) {
      if (
        typeof literal.value === "number" &&
        !Number.isFinite(literal.value)
      ) {
        throw new WorkflowSourceError(`${label} contains a non-finite number`);
      }
      return literal.value;
    }
    throw new WorkflowSourceError(
      `${label} must contain only primitive literals`,
    );
  }
  if (node.type === "ArrayExpression") {
    const arrayNode: ArrayExpression = node;
    const values: unknown[] = [];
    for (let index = 0; index < arrayNode.elements.length; index++) {
      const element = arrayNode.elements[index];
      if (element === null || element.type === "SpreadElement") {
        throw new WorkflowSourceError(
          `${label} cannot contain holes or spread elements`,
        );
      }
      values.push(literalValue(element, `${label}[${index}]`, depth + 1));
    }
    return values;
  }
  if (node.type === "ObjectExpression") {
    const objectNode: ObjectExpression = node;
    const value: Record<string, unknown> = Object.create(null);
    const seen = new Set<string>();
    for (const item of objectNode.properties) {
      if (item.type !== "Property") {
        throw new WorkflowSourceError(
          `${label} cannot contain spread elements or other properties`,
        );
      }
      const property: Property = item;
      const name = propertyName(property, `${label} property`);
      if (seen.has(name)) {
        throw new WorkflowSourceError(
          `${label} contains duplicate key "${name}"`,
        );
      }
      seen.add(name);
      value[name] = literalValue(property.value, `${label}.${name}`, depth + 1);
    }
    return value;
  }
  throw new WorkflowSourceError(
    `${label} must contain only plain object, array, and primitive literals`,
  );
}

function parseSingleFlow(source: string): unknown {
  let program: Program;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowSourceError(
      `Workflow source failed to parse: ${message}`,
    );
  }

  if (
    program.body.length !== 1 ||
    program.body[0]?.type !== "ExpressionStatement"
  ) {
    throw new WorkflowSourceError(
      "Workflow source must contain exactly one flow({ tasks: [...] }) expression",
    );
  }
  const statement = program.body[0];
  if (statement.type !== "ExpressionStatement") {
    throw new WorkflowSourceError(
      "Workflow source must contain exactly one flow({ tasks: [...] }) expression",
    );
  }
  const expression = statement.expression;
  if (expression.type !== "CallExpression") {
    throw new WorkflowSourceError(
      "Workflow source must call flow(...) as its only expression",
    );
  }
  const call: CallExpression = expression;
  if (
    call.callee.type !== "Identifier" ||
    call.callee.name !== "flow" ||
    call.arguments.length !== 1
  ) {
    throw new WorkflowSourceError(
      "Workflow source may only call flow once with one literal object",
    );
  }
  const argument = call.arguments[0];
  if (
    !argument ||
    argument.type === "SpreadElement" ||
    argument.type !== "ObjectExpression"
  ) {
    throw new WorkflowSourceError(
      "flow(...) requires one plain object literal",
    );
  }
  return literalValue(argument, "flow argument");
}

/**
 * Decode and validate the only supported workflow source surface. This is an
 * AST-to-data decoder, not a VM: no identifier, import, callback, call, getter,
 * filesystem/network/process/timer API, or imperative scheduling can run.
 */
export function decodeWorkflowSource(
  source: string,
): ValidatedWorkflowDefinition {
  if (typeof source !== "string") {
    throw new WorkflowSourceError("Workflow source must be a string");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new WorkflowSourceError(
      `Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} UTF-8 bytes`,
    );
  }
  const value = parseSingleFlow(source);
  try {
    return buildWorkflowGraph(value).definition;
  } catch (error) {
    if (error instanceof WorkflowGraphValidationError) throw error;
    throw new WorkflowSourceError(
      `Workflow source graph could not be validated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Same operation with the graph indexes available to callers that schedule it. */
export function decodeWorkflowGraph(source: string): ValidatedWorkflowGraph {
  if (typeof source !== "string") {
    throw new WorkflowSourceError("Workflow source must be a string");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new WorkflowSourceError(
      `Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} UTF-8 bytes`,
    );
  }
  const value = parseSingleFlow(source);
  return buildWorkflowGraph(value);
}

/** Compatibility-shaped names for source preparer callers. */
export const evaluateWorkflowSource = decodeWorkflowSource;
export const parseWorkflowSource = decodeWorkflowSource;

export const decodeFlowSource = decodeWorkflowSource;
export const evaluateFlowSource = decodeWorkflowSource;
