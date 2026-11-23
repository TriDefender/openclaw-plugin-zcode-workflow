/**
 * The workflow compiler: typechecks a script against the facade, enforces the
 * authoring rules ZCode's compiler holds (literal world.run commands, unique
 * subagent names, phase markers, hole placement, artifact ids), and produces
 * the executable form by splicing at exact source positions:
 *
 * - every `ask<T>(instr)` gains a second argument carrying the JSON schema
 *   derived from the script's own interface declarations;
 * - every unfilled `hole("name", prompt)` with a stored fill gains the fill's
 *   statements as an async arrow body.
 *
 * The walk happens on the original syntax tree, so diagnostics map 1:1 to the
 * script file the model edited.
 */
import ts from "typescript";
import { createRequire } from "node:module";
import path from "node:path";
import { FACADE_DTS, SNIPPET_FACADE_DTS } from "./facade.js";
import { buildAskSchema, UnsupportedTypeError } from "./schema.js";
import type { CompiledScript, ScriptMeta, WorkflowDiagnostic } from "./types.js";

const nodeRequire = createRequire(import.meta.url);
/** The TypeScript package's own lib directory, for the ES2022 standard library. */
const TS_LIB_DIR = path.join(path.dirname(nodeRequire.resolve("typescript/package.json")), "lib");

export interface CompileOptions {
  /** Name the diagnostics should cite (the draft file on disk). */
  scriptPath: string;
  /** The script source, statements only (top-level return allowed). */
  source: string;
  /** Hole fills by hole name: statement sources to splice as the hole body. */
  fills?: Record<string, string>;
  /** Compile against the snippet facade (no agent/phase/hole/report/artifact). */
  snippet?: boolean;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.None,
  moduleResolution: ts.ModuleResolutionKind.Classic,
  lib: ["lib.es2022.d.ts"],
  types: [],
  skipLibCheck: true,
  noResolve: true,
  allowNonTsExtensions: true,
};

const ARRAY_METHODS = new Set([
  "map",
  "forEach",
  "filter",
  "flatMap",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "reduce",
  "reduceRight",
  "sort",
]);

/** djb2 hex hash for hole site ids. */
export function siteHash(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(-8);
}

interface Splice {
  at: number;
  text: string;
}

export function compileWorkflow(opts: CompileOptions): CompiledScript {
  const facadeText = opts.snippet ? SNIPPET_FACADE_DTS : FACADE_DTS;
  const wrapperLineOffset = 1; // `async function __workflow__() {`
  const wrapperSource = `async function __workflow__() {\n${opts.source}\n}\n`;

  const facadeFile = ts.createSourceFile("facade.d.ts", facadeText, ts.ScriptTarget.ES2022, true);
  const wrapperFile = ts.createSourceFile("workflow.ts", wrapperSource, ts.ScriptTarget.ES2022, true);

  const libFileName = ts.getDefaultLibFileName({ target: COMPILER_OPTIONS.target! });
  const readHostFile = (fileName: string): string | undefined => {
    const abs = path.isAbsolute(fileName) ? fileName : path.join(TS_LIB_DIR, fileName);
    if (!abs.startsWith(TS_LIB_DIR)) return undefined;
    return ts.sys.readFile(abs);
  };
  const program = ts.createProgram({
    rootNames: ["workflow.ts", "facade.d.ts"],
    options: COMPILER_OPTIONS,
    host: {
      getSourceFile: (fileName, languageVersion) => {
        if (fileName === "workflow.ts") return wrapperFile;
        if (fileName === "facade.d.ts") return facadeFile;
        const text = readHostFile(fileName);
        return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion ?? ts.ScriptTarget.ES2022, true);
      },
      writeFile: () => undefined,
      getDefaultLibFileName: () => libFileName,
      useCaseSensitiveFileNames: () => true,
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => "/",
      getNewLine: () => "\n",
      fileExists: (f) => f === "workflow.ts" || f === "facade.d.ts" || readHostFile(f) !== undefined,
      readFile: (f) => (f === "workflow.ts" ? wrapperSource : f === "facade.d.ts" ? facadeText : readHostFile(f)),
    },
  });

  const diagnostics: WorkflowDiagnostic[] = [];
  const pushDiagnostic = (node: ts.Node, code: number, message: string) => {
    const { line, character } = wrapperFile.getLineAndCharacterOfPosition(node.getStart(wrapperFile));
    diagnostics.push({
      path: opts.scriptPath,
      line: Math.max(1, line + 1 - wrapperLineOffset),
      column: character + 1,
      message,
      code,
    });
  };

  for (const d of [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]) {
    if (d.file !== wrapperFile || d.start === undefined) continue;
    const { line, character } = wrapperFile.getLineAndCharacterOfPosition(d.start);
    diagnostics.push({
      path: opts.scriptPath,
      line: Math.max(1, line + 1 - wrapperLineOffset),
      column: character + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      code: 1000 + (d.code > 0 ? d.code % 8000 : 0),
    });
  }

  // ---- validate fills: each must parse as a statement list, no imports/exports ----
  const fillTexts = new Map<string, string>();
  for (const [name, fillSource] of Object.entries(opts.fills ?? {})) {
    const fillPath = `fills/${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.ts`;
    const sf = ts.createSourceFile(fillPath, fillSource, ts.ScriptTarget.ES2022, true);
    const bad = sf.statements.find((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s));
    const parseDiag = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (bad) {
      const { line, character } = sf.getLineAndCharacterOfPosition(bad.getStart(sf));
      diagnostics.push({ path: fillPath, line: line + 1, column: character + 1, message: "import/export statements are not allowed in a fill", code: 9016 });
      continue;
    }
    if (parseDiag.length > 0) {
      const first = parseDiag[0]!;
      const { line, character } = sf.getLineAndCharacterOfPosition(first.start ?? 0);
      diagnostics.push({
        path: fillPath,
        line: line + 1,
        column: character + 1,
        message: parseDiag.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; "),
        code: 9016,
      });
      continue;
    }
    fillTexts.set(name, fillSource.replace(/\s+$/, ""));
  }

  // ---- single walk: metadata, authoring rules, and splice positions ----
  const meta: ScriptMeta = {
    phases: [],
    agentNames: [],
    dynamicAgentNames: 0,
    commands: [],
    artifacts: [],
    reportTags: [],
    models: [],
    holes: [],
    notes: [],
    hasAskCalls: false,
    hasWorldRun: false,
  };
  const splices: Splice[] = [];
  const seenAgentNames = new Set<string>();
  const holeNames = new Set<string>();
  const artifactKinds = new Map<string, string>();

  // ---- const string bindings ----
  // 'const PY = "python3"' resolves wherever a compile-time literal is required,
  // so scripts stay DRY without widening what the user approves: resolution is
  // fully static (const + string-literal initializer only; let/var stay dynamic
  // and are rejected), and the runtime still membership-checks every executed
  // command against meta.commands, so the approved set can never be bypassed.
  const constStringLiterals = new Map<string, string>();
  const collectConstStrings = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) {
          constStringLiterals.set(decl.name.text, init.text);
        }
      }
    }
    ts.forEachChild(node, collectConstStrings);
  };
  collectConstStrings(wrapperFile);

  /** A string literal, a no-substitution template literal, or a const identifier bound to one. */
  const literalString = (expr: ts.Expression): string | undefined => {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isIdentifier(expr)) return constStringLiterals.get(expr.text);
    return undefined;
  };

  const insideArrayCallback = (chain: ts.Node[]): boolean => {
    for (let i = chain.length - 1; i > 0; i--) {
      const node = chain[i]!;
      const parent = chain[i - 1]!;
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isCallExpression(parent)) {
        const callee = parent.expression;
        if (ts.isPropertyAccessExpression(callee) && ARRAY_METHODS.has(callee.name.text)) return true;
      }
    }
    return false;
  };

  const walk = (node: ts.Node, chain: ts.Node[]) => {
    const currentChain = [...chain, node];

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      pushDiagnostic(node, 9010, "import/export statements are not allowed in a workflow script");
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // phase("name")
      if (ts.isIdentifier(callee) && callee.text === "phase") {
        const nameArg = node.arguments[0];
        const name = nameArg ? literalString(nameArg) : undefined;
        const standalone = ts.isExpressionStatement(node.parent);
        if (!nameArg || name === undefined || name.length === 0) {
          pushDiagnostic(node, 9004, "phase() needs a non-empty compile-time string literal name (a const string identifier is resolved)");
        } else if (!standalone) {
          pushDiagnostic(node, 9004, `phase("${name}") must be a standalone statement`);
        } else {
          meta.phases.push(name);
        }
      }

      // agent(name, persona)
      if (ts.isIdentifier(callee) && callee.text === "agent") {
        const nameArg = node.arguments[0];
        const agentName = nameArg ? literalString(nameArg) : undefined;
        if (nameArg && agentName !== undefined && agentName.length > 0) {
          if (seenAgentNames.has(agentName)) {
            pushDiagnostic(node, 9002, `duplicate subagent name "${agentName}": names are identities and must be unique within the run`);
          }
          seenAgentNames.add(agentName);
          meta.agentNames.push(agentName);
        } else if (nameArg) {
          meta.dynamicAgentNames += 1;
        }
        const personaArg = node.arguments[1];
        if (personaArg && !ts.isStringLiteral(personaArg) && !ts.isObjectLiteralExpression(personaArg) && !ts.isIdentifier(personaArg)) {
          pushDiagnostic(personaArg, 9014, "agent persona must be a string or an object literal");
        }
        if (personaArg && ts.isObjectLiteralExpression(personaArg)) {
          for (const prop of personaArg.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const propName = prop.name.getText(wrapperFile);
            if (propName === "model") {
              const modelId = literalString(prop.initializer);
              if (modelId !== undefined && !meta.models.includes(modelId)) meta.models.push(modelId);
            }
            if (propName === "budget") {
              meta.notes.push("persona.budget is recorded but not enforced by this host");
            }
          }
        }
      }

      // world.run(cmd, args)
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.name) &&
        callee.name.text === "run" &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "world"
      ) {
        meta.hasWorldRun = true;
        const cmdArg = node.arguments[0];
        const cmd = cmdArg ? literalString(cmdArg) : undefined;
        if (!cmdArg || cmd === undefined) {
          pushDiagnostic(node, 9003, "world.run's command must be a compile-time string literal (a const string identifier is resolved); interpolate runtime values into the args array");
        } else if (!meta.commands.includes(cmd)) {
          meta.commands.push(cmd);
        }
      }

      // any .ask call
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) && callee.name.text === "ask") {
        meta.hasAskCalls = true;

        // ask<T>(instr) → ask(instr, "<schema json>")
        const typeArg = node.typeArguments?.[0];
        const proseOnly =
          typeArg === undefined ||
          typeArg.kind === ts.SyntaxKind.StringKeyword ||
          typeArg.kind === ts.SyntaxKind.AnyKeyword ||
          typeArg.kind === ts.SyntaxKind.UnknownKeyword;
        if (typeArg && !proseOnly && node.arguments.length >= 1) {
          try {
            const { schema, source } = buildAskSchema(typeArg, wrapperFile);
            const metaJson = { typeName: typeArg.getText(wrapperFile), source, schema };
            // double stringify: a TS string literal carrying the JSON text
            splices.push({ at: node.end - 1, text: ", " + JSON.stringify(JSON.stringify(metaJson)) });
          } catch (err) {
            if (err instanceof UnsupportedTypeError) {
              pushDiagnostic(typeArg, 9015, `ask<${typeArg.getText(wrapperFile)}>: ${err.message}`);
            } else {
              pushDiagnostic(typeArg, 9015, `ask type argument could not be analyzed: ${(err as Error).message}`);
            }
          }
        }
      }

      // model("id")
      if (ts.isIdentifier(callee) && callee.text === "model") {
        const idArg = node.arguments[0];
        const modelId = idArg ? literalString(idArg) : undefined;
        if (idArg && modelId !== undefined) {
          if (!meta.models.includes(modelId)) meta.models.push(modelId);
        } else {
          pushDiagnostic(node, 9011, "model() needs a compile-time string literal model id (a const string identifier is resolved)");
        }
      }

      // artifact.X(id, ...)
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "artifact") {
        const kind = callee.name.text;
        if (["file", "markdown", "chart", "table", "metrics", "board"].includes(kind)) {
          const idArg = node.arguments[0];
          const artifactId = idArg ? literalString(idArg) : undefined;
          if (!idArg || artifactId === undefined || !/^[A-Za-z0-9_.-]{1,64}$/.test(artifactId)) {
            pushDiagnostic(node, 9005, `artifact.${kind}: id must be a compile-time literal of 1-64 characters from [A-Za-z0-9_.-] (a const string identifier is resolved)`);
          } else if (artifactKinds.has(artifactId) && artifactKinds.get(artifactId) !== kind) {
            pushDiagnostic(node, 9006, `artifact id "${artifactId}" is already used as ${artifactKinds.get(artifactId)}; one id belongs to one artifact kind`);
          } else {
            artifactKinds.set(artifactId, kind);
            if (!meta.artifacts.some((a) => a.id === artifactId)) {
              if (meta.artifacts.length >= 32) {
                pushDiagnostic(node, 9007, "a run may publish at most 32 artifact ids");
              } else {
                meta.artifacts.push({ id: artifactId, kind: kind as never });
              }
            }
          }
        }
      }

      // report(item, tag)
      if (ts.isIdentifier(callee) && callee.text === "report") {
        const tagArg = node.arguments[1];
        if (tagArg) {
          const tag = literalString(tagArg);
          if (tag === undefined) {
            pushDiagnostic(tagArg, 9008, "report()'s artifactId must be a compile-time string literal (a const string identifier is resolved)");
          } else if (!meta.reportTags.includes(tag)) {
            meta.reportTags.push(tag);
          }
        }
      }

      // hole(...)
      if (ts.isIdentifier(callee) && callee.text === "hole") {
        const nameArg = node.arguments[0];
        const typeArg = node.typeArguments?.[0];
        const hasBody =
          node.arguments.length >= 1 &&
          (ts.isArrowFunction(node.arguments[node.arguments.length - 1]!) || ts.isFunctionExpression(node.arguments[node.arguments.length - 1]!));
        const holeName = nameArg ? literalString(nameArg) : undefined;
        if (!nameArg || holeName === undefined || holeName.length === 0 || holeName.length > 128) {
          pushDiagnostic(node, 9012, "hole() needs a literal name of 1-128 characters (a const string identifier is resolved)");
        } else if (!typeArg) {
          pushDiagnostic(node, 9012, `hole("${holeName}"): the type argument T must be written out`);
        } else if (holeNames.has(holeName)) {
          pushDiagnostic(node, 9012, `duplicate hole name "${holeName}": names are unique among the script's holes and phases`);
        } else if (insideArrayCallback(currentChain)) {
          pushDiagnostic(node, 9012, `hole("${holeName}") may not sit inside an array-method fan-out callback (a for...of body is fine)`);
        } else {
          holeNames.add(holeName);
          const promptArg = node.arguments[1];
          meta.holes.push({
            name: holeName,
            typeName: typeArg.getText(wrapperFile),
            prompt: promptArg && ts.isStringLiteral(promptArg) ? promptArg.text : "",
            hasBody,
            id: `hole#${siteHash(holeName)}`,
          });
          // splice the fill as an async arrow body when one exists and no body is present
          if (!hasBody && fillTexts.has(holeName)) {
            splices.push({ at: node.end - 1, text: `, async () => {\n${fillTexts.get(holeName)}\n}` });
          }
        }
      }
    }

    ts.forEachChild(node, (child) => walk(child, currentChain));
  };
  walk(wrapperFile, [wrapperFile]);

  // phases are required whenever the script does orchestrated work
  if (!opts.snippet && meta.phases.length === 0 && (meta.hasAskCalls || meta.hasWorldRun)) {
    diagnostics.push({
      path: opts.scriptPath,
      line: 1,
      column: 1,
      message: 'phases are required: cover the script with phase("...") markers, one at the head of each stage (two markers with the same name are one phase)',
      code: 9009,
    });
  }
  if (meta.dynamicAgentNames > 0) {
    meta.notes.push(
      `${meta.dynamicAgentNames} agent() call(s) use computed names: a runtime duplicate fails the run; prefer one computed name per item, e.g. agent("judge-" + i.id)`,
    );
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // ---- emit: apply splices to the wrapper source, then transpile ----
  let spliced = wrapperSource;
  for (const splice of [...splices].sort((a, b) => b.at - a.at)) {
    spliced = spliced.slice(0, splice.at) + splice.text + spliced.slice(splice.at);
  }
  const firstNewline = spliced.indexOf("\n");
  const lastBrace = spliced.lastIndexOf("\n}");
  const effectiveSource = spliced.slice(firstNewline + 1, lastBrace === -1 ? undefined : lastBrace).replace(/^\n+|\n+$/g, "");

  const js = ts
    .transpileModule(`async function __workflow__() {\n${effectiveSource}\n}\n`, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    })
    .outputText;

  return { ok: true, diagnostics: [], js, meta, effectiveSource };
}
