/**
 * On-disk layout, workspace-relative under `.zcode-workflow/`:
 *
 *   runs/<runId>/meta.json        run metadata (state, phases, commands, ...)
 *   runs/<runId>/script.ts        the effective script (hole bodies spliced in)
 *   runs/<runId>/journal.jsonl    append-only journal
 *   runs/<runId>/fills/<name>.ts  hole fills applied to this run
 *   drafts/<name>.<n>.ts          inline submissions land here
 *   saved/<name>.dwf.ts           saved workflow definitions
 *   artifacts/<runId>/...         published artifacts
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RunMeta, SavedWorkflow, SavedWorkflowDeclaration } from "./types.js";
import { WorkflowError } from "./types.js";

export const WORKFLOW_DIR = ".zcode-workflow";

/**
 * Validate model/script-supplied identifiers that are used as path segments
 * (run ids, artifact ids, saved workflow names). Rejects path separators and
 * traversal segments so every on-disk path stays inside the workflow store.
 */
export function assertSafeId(label: string, value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("..")) {
    throw new WorkflowError(
      `${label} "${String(value).slice(0, 64)}" is not a safe identifier (letters, digits, dot, dash, underscore only; no "..")`,
      "bad_name",
    );
  }
  return value;
}

export class RunStore {
  constructor(readonly workspaceDir: string) {}

  private root(...parts: string[]): string {
    return path.join(this.workspaceDir, WORKFLOW_DIR, ...parts);
  }

  runsDir(): string {
    return this.root("runs");
  }

  runDir(runId: string): string {
    return this.root("runs", assertSafeId("runId", runId));
  }

  artifactsDir(runId: string): string {
    return this.root("artifacts", assertSafeId("runId", runId));
  }

  draftsDir(): string {
    return this.root("drafts");
  }

  savedDir(scope: "project"): string {
    return this.root("saved");
  }

  newRunId(): string {
    return `dwf-${crypto.randomBytes(6).toString("hex")}`;
  }

  async saveMeta(meta: RunMeta): Promise<void> {
    const dir = this.runDir(meta.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  }

  async loadMeta(runId: string): Promise<RunMeta | undefined> {
    try {
      const text = await fs.readFile(path.join(this.runDir(runId), "meta.json"), "utf8");
      return JSON.parse(text) as RunMeta;
    } catch {
      return undefined;
    }
  }

  async listRuns(): Promise<RunMeta[]> {
    const dir = this.runsDir();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const metas: RunMeta[] = [];
    for (const entry of entries) {
      const meta = await this.loadMeta(entry);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return metas;
  }

  async readScript(runId: string): Promise<string> {
    return fs.readFile(path.join(this.runDir(runId), "script.ts"), "utf8");
  }

  async writeScript(runId: string, source: string): Promise<void> {
    await fs.mkdir(this.runDir(runId), { recursive: true });
    await fs.writeFile(path.join(this.runDir(runId), "script.ts"), source, "utf8");
  }

  async saveFill(runId: string, holeName: string, source: string): Promise<void> {
    await fs.mkdir(path.join(this.runDir(runId), "fills"), { recursive: true });
    await fs.writeFile(path.join(this.runDir(runId), "fills", `${holeName.replace(/[^A-Za-z0-9_.-]/g, "_")}.ts`), source, "utf8");
  }

  async writeDraft(name: string, source: string): Promise<string> {
    const dir = this.draftsDir();
    await fs.mkdir(dir, { recursive: true });
    const slug = name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
    let n = 1;
    let file = path.join(dir, `${slug}.${n}.ts`);
    while (await fileExists(file)) {
      n += 1;
      file = path.join(dir, `${slug}.${n}.ts`);
    }
    await fs.writeFile(file, source, { encoding: "utf8", flag: "wx" });
    return path.relative(this.workspaceDir, file);
  }

  async readFillFile(runId: string, relPath: string): Promise<string> {
    const runDirAbs = path.resolve(this.runDir(runId));
    const abs = path.resolve(runDirAbs, relPath);
    if (abs !== runDirAbs && !abs.startsWith(runDirAbs + path.sep)) throw new WorkflowError("fill path escapes the run directory", "bad_path");
    return fs.readFile(abs, "utf8");
  }

  // ---- saved workflows ----

  async saveWorkflow(decl: SavedWorkflowDeclaration, script: string): Promise<string> {
    const dir = this.savedDir("project");
    await fs.mkdir(dir, { recursive: true });
    assertSafeId("saved workflow name", decl.name);
    const meta = [
      "/* zcode-workflow",
      `name: ${decl.name}`,
      `description: ${decl.description.replace(/\n/g, " ")}`,
      ...(decl.whenToUse ? [`whenToUse: ${decl.whenToUse.replace(/\n/g, " ")}`] : []),
      `scope: ${decl.scope}`,
      ...(decl.args && decl.args.length > 0
        ? [
            "args:",
            ...decl.args.map(
              (a) =>
                `  - name: ${a.name}\n    type: ${a.type}${a.description ? `\n    description: ${a.description.replace(/\n/g, " ")}` : ""}${a.required ? "\n    required: true" : ""}${a.default !== undefined ? `\n    default: ${JSON.stringify(a.default)}` : ""}`,
            ),
          ]
        : []),
      "*/",
    ].join("\n");
    const file = path.join(dir, `${decl.name}.dwf.ts`);
    await fs.writeFile(file, `${meta}\n${script}\n`, "utf8");
    return path.relative(this.workspaceDir, file);
  }

  async listSaved(): Promise<SavedWorkflow[]> {
    const dir = this.savedDir("project");
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: SavedWorkflow[] = [];
    for (const entry of entries.filter((f) => f.endsWith(".dwf.ts"))) {
      try {
        const abs = path.join(dir, entry);
        const text = await fs.readFile(abs, "utf8");
        out.push(parseSavedWorkflow(text, path.relative(this.workspaceDir, abs)));
      } catch {
        // skip unreadable entries
      }
    }
    return out.sort((a, b) => a.decl.name.localeCompare(b.decl.name));
  }

  async loadSaved(name: string): Promise<SavedWorkflow> {
    const saved = await this.listSaved();
    const found = saved.find((s) => s.decl.name === name);
    if (!found) {
      throw new WorkflowError(`no saved workflow named "${name}" (workflow_list_saved lists them)`, "not_found");
    }
    return found;
  }
}

/** Parse a saved .dwf.ts file: YAML-ish metadata block, then the script body. */
export function parseSavedWorkflow(text: string, filePath: string): SavedWorkflow {
  const match = /^\/\* zcode-workflow([\s\S]*?)\*\/\s*([\s\S]*)$/.exec(text);
  if (!match) {
    return { decl: { name: path.basename(filePath, ".dwf.ts"), description: "(no metadata block)", scope: "project" }, script: text, path: filePath };
  }
  const block = match[1]!;
  const script = match[2]!;
  const decl: SavedWorkflowDeclaration = {
    name: pickField(block, "name") ?? path.basename(filePath, ".dwf.ts"),
    description: pickField(block, "description") ?? "",
    whenToUse: pickField(block, "whenToUse") ?? pickField(block, "when_to_use"),
    scope: (pickField(block, "scope") as "project" | "global") ?? "project",
  };
  const args: SavedWorkflowDeclaration["args"] = [];
  const argBlocks = block.split(/(?:^|\n)\s*-\s*name:\s*/).slice(1);
  for (const argBlock of argBlocks) {
    const name = (argBlock.trim().match(/^(\S+)/) ?? [])[1];
    if (!name) continue;
    args.push({
      name,
      type: (pickField(argBlock, "type") as "string" | "number" | "boolean" | "json") ?? "string",
      description: pickField(argBlock, "description"),
      required: /required:\s*true/.test(argBlock),
      default: (() => {
        const raw = pickField(argBlock, "default");
        if (raw === undefined) return undefined;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return raw;
        }
      })(),
    });
  }
  if (args.length > 0) decl.args = args;
  return { decl, script, path: filePath };
}

function pickField(block: string, field: string): string | undefined {
  const m = new RegExp(`^\\s*${field}:\\s*(.+)$`, "m").exec(block);
  return m?.[1]?.trim().replace(/^["']|["']$/g, "");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Validate args against a saved workflow declaration, filling defaults. */
export function validateSavedArgs(decl: SavedWorkflowDeclaration, provided: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const specs = decl.args ?? [];
  for (const spec of specs) {
    const value = provided?.[spec.name] ?? spec.default;
    if (value === undefined) {
      if (spec.required) {
        throw new WorkflowError(`saved workflow "${decl.name}" requires argument "${spec.name}" (${spec.type})`, "bad_args");
      }
      continue;
    }
    switch (spec.type) {
      case "string":
        if (typeof value !== "string") throw new WorkflowError(`argument "${spec.name}" must be a string`, "bad_args");
        break;
      case "number":
        if (typeof value !== "number") throw new WorkflowError(`argument "${spec.name}" must be a number`, "bad_args");
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new WorkflowError(`argument "${spec.name}" must be a boolean`, "bad_args");
        break;
      case "json":
        break;
    }
    out[spec.name] = value;
  }
  for (const key of Object.keys(provided ?? {})) {
    if (!specs.some((s) => s.name === key)) {
      throw new WorkflowError(`argument "${key}" is not declared by saved workflow "${decl.name}"`, "bad_args");
    }
  }
  return out;
}
