/**
 * The run journal: an append-only JSONL file per run. Every ask, world read
 * and deterministic effect is recorded so a resumed or amended run replays
 * settled work at zero cost instead of paying for it again.
 *
 * Cache matching follows ZCode's rules:
 * - asks match by named subagent, in-order index and byte-identical instructions;
 *   anonymous subagents never reuse cached work.
 * - world/files/git reads match by operation key (op + arguments).
 * - the cache stays open until the first live ask completes or a live
 *   world.run executes; from that moment everything runs live (conservative
 *   version of "until a live subagent makes its first write").
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { JournalRecord } from "./types.js";
import { WorkflowError } from "./types.js";

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Distributive Omit so union record variants keep their own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type JournalRecordInput = DistributiveOmit<JournalRecord, "seq" | "at"> & { at?: string };

export class Journal {
  private records: JournalRecord[] = [];
  private dirty = false;

  private constructor(
    readonly filePath: string,
    private readonly imported: JournalRecord[],
  ) {
    this.records = [...imported];
  }

  static async open(filePath: string): Promise<Journal> {
    let text = "";
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      text = "";
    }
    const records: JournalRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        // torn tail line after a crash: stop at the last complete record
        break;
      }
    }
    return new Journal(filePath, records);
  }

  static empty(): Journal {
    return new Journal("", []);
  }

  get all(): readonly JournalRecord[] {
    return this.records;
  }

  get importedCount(): number {
    return this.imported.length;
  }

  async append(record: JournalRecordInput): Promise<JournalRecord> {
    const full = {
      ...record,
      seq: this.records.length + 1,
      at: record.at ?? new Date().toISOString(),
    } as JournalRecord;
    this.records.push(full);
    this.dirty = true;
    if (this.filePath) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, JSON.stringify(full) + "\n", "utf8");
    }
    return full;
  }

  async flush(): Promise<void> {
    // journal is appended per record; nothing to flush, kept for symmetry
    this.dirty = false;
  }

  /** Reported items in journal order (both imported and new). */
  reportedItems(): { seq: number; at: string; item: unknown; artifactId?: string }[] {
    return this.records
      .filter((r): r is Extract<JournalRecord, { kind: "report" }> => r.kind === "report")
      .map((r) => ({ seq: r.seq, at: r.at, item: r.item, artifactId: r.artifactId }));
  }

  /** Logs in journal order. */
  logs(): { seq: number; at: string; message: string }[] {
    return this.records
      .filter((r): r is Extract<JournalRecord, { kind: "log" }> => r.kind === "log")
      .map((r) => ({ seq: r.seq, at: r.at, message: r.message }));
  }

  /** Ask cache lookup: named agent + in-order ask index + byte-identical instructions. */
  lookupAsk(agent: string | undefined, agentIndex: number, instructions: string): { result: unknown; escalated?: boolean } | undefined {
    if (!agent) return undefined;
    let seen = -1;
    for (const r of this.records) {
      if (r.kind !== "ask" || r.agent !== agent) continue;
      seen += 1;
      if (seen === agentIndex) {
        return r.instructions === instructions ? { result: r.result, escalated: r.escalated } : undefined;
      }
    }
    return undefined;
  }

  lookupWorld(key: string): { exitCode: number; stdout: string; stderr: string } | undefined {
    for (const r of this.records) {
      if (r.kind === "world" && r.key === key) return r.result;
    }
    return undefined;
  }

  lookupFiles(key: string): unknown {
    for (const r of this.records) {
      if (r.kind === "files" && r.key === key) return r.result;
    }
    return undefined;
  }

  lookupGit(key: string): unknown {
    for (const r of this.records) {
      if (r.kind === "git" && r.key === key) return r.result;
    }
    return undefined;
  }

  /** True when a report record with identical payload already exists (replay dedupe). */
  hasReport(item: unknown, artifactId?: string): boolean {
    const fingerprint = JSON.stringify({ item, artifactId });
    return this.records.some((r) => r.kind === "report" && JSON.stringify({ item: r.item, artifactId: r.artifactId }) === fingerprint);
  }

  hasLog(message: string): boolean {
    return this.records.some((r) => r.kind === "log" && r.message === message);
  }

  artifactVersion(id: string): number {
    let max = 0;
    for (const r of this.records) {
      if (r.kind === "artifact" && r.id === id) max = Math.max(max, r.version);
    }
    return max;
  }

  artifactSpec(id: string): { kindOf: string; spec?: unknown } | undefined {
    for (const r of this.records) {
      if (r.kind === "artifact" && r.id === id && (r.kindOf === "chart" || r.kindOf === "table" || r.kindOf === "metrics" || r.kindOf === "board")) {
        return { kindOf: r.kindOf, spec: r.spec };
      }
    }
    return undefined;
  }
}

export function stableKey(parts: unknown[]): string {
  return hash(JSON.stringify(parts));
}

export { WorkflowError };
