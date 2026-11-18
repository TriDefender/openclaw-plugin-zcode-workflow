/**
 * Type-argument → JSON schema derivation and reply validation.
 *
 * The schema is built from the script's own interface/type-alias declarations
 * (AST walk, not checker types) so JSDoc descriptions and string-literal
 * unions survive into the prompt and the validator.
 */
import ts from "typescript";
import type { JsonSchema, WorkflowDiagnostic } from "./types.js";

export class UnsupportedTypeError extends Error {}

interface TypeEnv {
  /** interface/type-alias declarations visible at top level of the script. */
  declarations: Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>;
  diagnostics: WorkflowDiagnostic[];
  path: string;
}

function jsDocText(node: ts.Node): string | undefined {
  const jsDocGetter = ts.getJSDocCommentsAndTags as unknown as
    | undefined
    | ((n: ts.Node) => readonly (ts.JSDoc | ts.JSDocTag)[]);
  const docs = jsDocGetter?.(node) ?? [];
  for (const doc of docs) {
    if (!ts.isJSDoc(doc)) continue;
    const comment = doc.comment;
    if (typeof comment === "string") return comment.trim();
    if (comment && typeof comment === "object" && "length" in comment) {
      return comment
        .map((part) => part.text)
        .join("")
        .trim();
    }
  }
  return undefined;
}

function schemaFromTypeNode(node: ts.TypeNode, env: TypeEnv, depth: number): JsonSchema {
  if (depth > 8) throw new UnsupportedTypeError("result types nest deeper than 8 levels");
  if (ts.isParenthesizedTypeNode(node)) return schemaFromTypeNode(node.type, env, depth);

  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if (name === "Array" && node.typeArguments?.length === 1) {
      return { type: "array", items: schemaFromTypeNode(node.typeArguments[0]!, env, depth + 1) };
    }
    if (name === "Record" && node.typeArguments?.length === 2) {
      const value = schemaFromTypeNode(node.typeArguments[1]!, env, depth + 1);
      return { type: "object", properties: {}, required: [], additionalProperties: value };
    }
    const decl = env.declarations.get(name);
    if (!decl) throw new UnsupportedTypeError(`type "${name}" is not declared in this script`);
    if (ts.isTypeAliasDeclaration(decl)) {
      return schemaFromTypeNode(decl.type, env, depth + 1);
    }
    return schemaFromMembers(decl.members, env, depth);
  }

  if (ts.isArrayTypeNode(node)) {
    return { type: "array", items: schemaFromTypeNode(node.elementType, env, depth + 1) };
  }

  if (ts.isUnionTypeNode(node)) {
    // Union of string literals → enum; anything else unsupported.
    const options: string[] = [];
    for (const t of node.types) {
      if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) options.push(t.literal.text);
      else if (t.kind === ts.SyntaxKind.NullKeyword) continue;
      else throw new UnsupportedTypeError("only unions of string literals (plus null) are supported in result types");
    }
    return { type: "string", enum: options.length > 0 ? options : undefined };
  }

  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return { type: "string", enum: [node.literal.text] };
    if (node.literal.kind === ts.SyntaxKind.TrueKeyword || node.literal.kind === ts.SyntaxKind.FalseKeyword) return { type: "boolean" };
    throw new UnsupportedTypeError("unsupported literal type in result type");
  }

  if (ts.isTypeLiteralNode(node)) {
    return schemaFromMembers(node.members, env, depth);
  }

  const kind = node.getText();
  if (kind === "string") return { type: "string" };
  if (kind === "number") return { type: "number" };
  if (kind === "boolean") return { type: "boolean" };
  if (kind === "any" || kind === "unknown") return { type: "any" };

  throw new UnsupportedTypeError(`unsupported result type syntax: ${node.getText()}`);
}

function schemaFromMembers(members: ts.NodeArray<ts.TypeElement>, env: TypeEnv, depth: number): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const name = member.name.getText().replace(/^["']|["']$/g, "");
    const description = jsDocText(member);
    let schema: JsonSchema;
    if (member.questionToken) {
      schema = schemaFromTypeNode(member.type, env, depth + 1);
      if (member.type.kind === ts.SyntaxKind.UndefinedKeyword || ts.isUnionTypeNode(member.type)) {
        // optional union with undefined — re-derive ignoring undefined members
        if (ts.isUnionTypeNode(member.type)) {
          const nonUndefined = member.type.types.filter((t) => t.kind !== ts.SyntaxKind.UndefinedKeyword);
          if (nonUndefined.length === 1) schema = schemaFromTypeNode(nonUndefined[0]!, env, depth + 1);
        }
      }
    } else {
      schema = schemaFromTypeNode(member.type, env, depth + 1);
      required.push(name);
    }
    if (description) schema = { ...schema, description };
    properties[name] = schema;
  }
  return { type: "object", properties, required };
}

/** Build an AskMeta schema from an ask<T> type argument node. Throws UnsupportedTypeError. */
export function buildAskSchema(typeArg: ts.TypeNode, scriptFile: ts.SourceFile): { schema: JsonSchema; source: string } {
  const declarations = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  const collect = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      if (!declarations.has(name)) declarations.set(name, node);
    }
    ts.forEachChild(node, collect);
  };
  collect(scriptFile);

  const env: TypeEnv = { declarations, diagnostics: [], path: scriptFile.fileName };
  const target = ts.isTypeReferenceNode(typeArg) ? typeArg : typeArg;
  const schema = schemaFromTypeNode(target, env, 0);

  // Source text (with JSDoc) for the prompt: prefer the referenced declaration.
  let source = "";
  if (ts.isTypeReferenceNode(typeArg)) {
    const decl = declarations.get(typeArg.typeName.getText());
    if (decl) {
      source = scriptFile.text.slice(decl.getFullStart(), decl.end).trim();
    }
  }
  if (!source) source = typeArg.getText();
  return { schema, source };
}

/** Validate a parsed JSON value against a derived schema; returns error strings. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  switch (schema.type) {
    case "any":
      return errors;
    case "string": {
      if (typeof value !== "string") errors.push(`${path}: expected string, got ${describe(value)}`);
      else if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: "${value}" is not one of ${schema.enum.map((e) => `"${e}"`).join(" | ")}`);
      return errors;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path}: expected number, got ${describe(value)}`);
      return errors;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean, got ${describe(value)}`);
      return errors;
    case "null":
      if (value !== null) errors.push(`${path}: expected null, got ${describe(value)}`);
      return errors;
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${describe(value)}`);
        return errors;
      }
      value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`)));
      return errors;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${describe(value)}`);
        return errors;
      }
      for (const key of schema.required) {
        if (!(key in (value as Record<string, unknown>))) errors.push(`${path}.${key}: required field missing`);
      }
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) continue;
        errors.push(...validateAgainstSchema(v, propSchema, `${path}.${key}`));
      }
      return errors;
    }
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Extract a JSON value from a subagent reply: direct parse, fenced ```json block,
 * fenced block, or first balanced JSON value.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  const attempts: string[] = [trimmed];
  const fence = /```(?:json|jsonc|ts)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) attempts.push(m[1]!.trim());
  // First balanced {...} or [...]
  const start = trimmed.search(/[{[]/);
  if (start >= 0) {
    const open = trimmed[start]!;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        if (inString) escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          attempts.push(trimmed.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return { ok: true, value: JSON.parse(attempt) };
    } catch {
      // try next
    }
  }
  return { ok: false, error: "no JSON value found in the reply" };
}
