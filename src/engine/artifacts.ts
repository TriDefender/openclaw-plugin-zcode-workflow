/**
 * Artifact publishing: content artifacts (file, markdown) copy bytes into
 * `.zcode-workflow/artifacts/<runId>/`, versioned per id; preset artifacts
 * (chart, table, metrics, board) are declarations fed by report(item, id) —
 * the tagged items are recorded as a data file plus a small markdown
 * rendering (this host has no card UI, so the data is the deliverable).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { FILE_ARTIFACT_BYTES_CAP, MARKDOWN_ARTIFACT_BYTES_CAP, WorldCapError, resolveInside } from "./world.js";
import { WorkflowError } from "./types.js";
import type { RunMeta } from "./types.js";
import type { Journal } from "./journal.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export interface ArtifactSpecs {
  /** id → declared spec (presets) */
  presets: Map<string, { kind: string; spec: Record<string, unknown> }>;
  primary: string | undefined;
}

export class ArtifactPublisher {
  private specs = new Map<string, { kind: string; spec: Record<string, unknown> }>();
  private primary: string | undefined;

  constructor(
    private readonly artifactsDir: string,
    private readonly workspaceDir: string,
    private readonly journal: Journal,
  ) {}

  /** Restore declarations from the journal (replay after resume). */
  restoreFromJournal(): void {
    for (const record of this.journal.all) {
      if (record.kind !== "artifact") continue;
      if (record.kindOf === "chart" || record.kindOf === "table" || record.kindOf === "metrics" || record.kindOf === "board") {
        this.specs.set(record.id, { kind: record.kindOf, spec: (record.spec ?? {}) as Record<string, unknown> });
      }
    }
  }

  isPreset(id: string): boolean {
    return this.specs.has(id);
  }

  /** report(item, "id") routing: the tag must name a preset declared by now. */
  routeReport(item: unknown, artifactId: string | undefined): void {
    if (artifactId === undefined) return;
    if (!this.specs.has(artifactId)) {
      throw new WorkflowError(
        `report(item, "${artifactId}"): no such preset artifact (declare it with artifact.chart/table/metrics/board before tagging items)`,
        "bad_tag",
      );
    }
  }

  declarePreset(id: string, kind: string, spec: Record<string, unknown>): void {
    const existing = this.specs.get(id);
    const normalized = JSON.stringify(spec);
    if (existing) {
      if (existing.kind !== kind || JSON.stringify(existing.spec) !== normalized) {
        throw new WorkflowError(`artifact "${id}" re-declared with a different spec; declarations must stay identical`, "bad_artifact");
      }
      return; // identical re-declaration is a no-op
    }
    this.specs.set(id, { kind, spec });
  }

  markPrimary(meta: RunMeta, id: string, opts: { primary?: boolean }): void {
    if (!opts.primary) return;
    if (this.primary && this.primary !== id) {
      throw new WorkflowError(`at most one artifact may be primary (already "${this.primary}")`, "bad_artifact");
    }
    this.primary = id;
    meta.primaryArtifact = id;
  }

  async publishFile(id: string, relPath: string, opts: { title?: string; description?: string; primary?: boolean; contentType?: string }): Promise<{ id: string; version: number }> {
    const abs = resolveInside(this.workspaceDir, relPath);
    const stat = await fs.stat(abs).catch(() => {
      throw new WorldCapError(`artifact source missing: ${relPath}`);
    });
    if (!stat.isFile()) throw new WorldCapError(`artifact source is not a file: ${relPath}`);
    if (stat.size > FILE_ARTIFACT_BYTES_CAP) {
      throw new WorldCapError(`artifact source ${relPath} is over the ${FILE_ARTIFACT_BYTES_CAP}-byte cap`);
    }
    this.assertCardText(opts);
    const version = this.journal.artifactVersion(id) + 1;
    if (version > 16) throw new WorldCapError(`artifact "${id}" already has 16 versions`);
    const ext = path.extname(relPath) || ".bin";
    const target = path.join(this.artifactsDir, `${id}.v${version}${ext}`);
    await fs.mkdir(this.artifactsDir, { recursive: true });
    await fs.copyFile(abs, target);
    await fs.writeFile(
      path.join(this.artifactsDir, `${id}.index.json`),
      JSON.stringify({ id, kind: "file", version, source: relPath, contentType: opts.contentType ?? CONTENT_TYPES[ext] ?? "application/octet-stream", title: opts.title, primary: opts.primary ?? false, at: new Date().toISOString() }, null, 2),
      "utf8",
    );
    return { id, version };
  }

  async publishMarkdown(id: string, content: string, opts: { title?: string; description?: string; primary?: boolean }): Promise<{ id: string; version: number }> {
    if (content.length > MARKDOWN_ARTIFACT_BYTES_CAP) {
      throw new WorldCapError(`markdown artifact "${id}" is over the ${MARKDOWN_ARTIFACT_BYTES_CAP}-byte cap`);
    }
    this.assertCardText(opts);
    const version = this.journal.artifactVersion(id) + 1;
    if (version > 16) throw new WorldCapError(`artifact "${id}" already has 16 versions`);
    const target = path.join(this.artifactsDir, `${id}.v${version}.md`);
    await fs.mkdir(this.artifactsDir, { recursive: true });
    await fs.writeFile(target, content, "utf8");
    await fs.writeFile(
      path.join(this.artifactsDir, `${id}.index.json`),
      JSON.stringify({ id, kind: "markdown", version, title: opts.title, description: opts.description, primary: opts.primary ?? false, at: new Date().toISOString() }, null, 2),
      "utf8",
    );
    return { id, version };
  }

  /** A report item tagged with a preset id: append to the data file and refresh the rendering. */
  async recordPresetItem(id: string, item: unknown): Promise<void> {
    const entry = this.specs.get(id);
    if (!entry) return;
    const dataFile = path.join(this.artifactsDir, `${id}.data.json`);
    await fs.mkdir(this.artifactsDir, { recursive: true });
    let items: unknown[] = [];
    try {
      items = JSON.parse(await fs.readFile(dataFile, "utf8")) as unknown[];
    } catch {
      items = [];
    }
    items.push(item);
    await fs.writeFile(dataFile, JSON.stringify(items, null, 2), "utf8");
    await fs.writeFile(path.join(this.artifactsDir, `${id}.md`), renderPresetMarkdown(id, entry, items), "utf8");
  }

  private assertCardText(opts: { title?: string; description?: string }): void {
    if (opts.title && opts.title.length > 120) throw new WorkflowError(`artifact title over 120 characters`, "bad_artifact");
    if (opts.description && opts.description.length > 500) throw new WorkflowError(`artifact description over 500 characters`, "bad_artifact");
  }
}

/** Render preset data as simple markdown (no card UI on this host). */
function renderPresetMarkdown(id: string, entry: { kind: string; spec: Record<string, unknown> }, items: unknown[]): string {
  const title = (entry.spec.title as string | undefined) ?? id;
  const lines: string[] = [`# ${title}`, "", `_${entry.kind} fed by ${items.length} reported item(s)._`, ""];
  const fields = (key: string): string[] => {
    const value = entry.spec[key];
    if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : String((v as Record<string, unknown>)?.field ?? "")));
    if (value && typeof value === "object" && "field" in (value as Record<string, unknown>)) return [String((value as Record<string, unknown>).field)];
    return [];
  };
  const pick = (item: unknown, field: string): unknown =>
    field.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), item);

  if (entry.kind === "table" || entry.kind === "metrics" || entry.kind === "chart" || entry.kind === "board") {
    const columns = fields("columns").length > 0 ? fields("columns") : fields("metrics").length > 0 ? fields("metrics") : [...fields("x"), ...fields("y")];
    const cols = columns.length > 0 ? columns : inferKeys(items);
    lines.push(`| ${cols.join(" | ")} |`);
    lines.push(`| ${cols.map(() => "---").join(" | ")} |`);
    for (const item of items.slice(-200)) {
      lines.push(`| ${cols.map((c) => fmt(pick(item, c))).join(" | ")} |`);
    }
  }
  return lines.join("\n") + "\n";
}

function inferKeys(items: unknown[]): string[] {
  for (const item of items) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.keys(item as Record<string, unknown>).slice(0, 8);
    }
  }
  return ["value"];
}

function fmt(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value).slice(0, 80);
  return String(value);
}
