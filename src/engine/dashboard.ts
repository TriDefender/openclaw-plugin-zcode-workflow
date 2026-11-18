/**
 * Live run snapshots for the /workflow status dashboard widget.
 *
 * The gateway method `zcode-workflow.dashboard` (declared as a dashboard data
 * binding, granted to pinned widgets as `zcode-workflow.runs`) reads meta.json
 * plus the journal tail straight from disk, so the widget reflects the truth
 * with no in-memory coupling to a runner.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { RunStore } from "./store.js";
import { Journal } from "./journal.js";

export interface RunSnapshot {
  id: string;
  name: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
  elapsedMs?: number;
  phasesDeclared: string[];
  phasesSeen: string[];
  currentPhase?: string;
  agentNames: string[];
  commands: string[];
  askCount: number;
  worldRunCount: number;
  reportedCount: number;
  artifacts: { id: string; kind: string; version: number }[];
  recentLogs: string[];
  recentReports: { at: string; artifactId?: string; item: unknown }[];
  pendingHole?: { id: string; name: string; typeName: string; prompt: string };
  pendingQuestions: { id: string; agent: string; question: string }[];
  error?: string;
  result?: unknown;
  scriptPath?: string;
}

export interface RunsSummary {
  id: string;
  name: string;
  state: string;
  updatedAt?: string;
  currentPhase?: string;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function elapsedBetween(startIso: unknown, endIso: unknown): number | undefined {
  if (typeof startIso !== "string" || typeof endIso !== "string") return undefined;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

export async function readRunSnapshot(workspaceDir: string, runId: string): Promise<RunSnapshot | undefined> {
  const store = new RunStore(workspaceDir);
  const meta = await store.loadMeta(runId);
  if (!meta) return undefined;
  const journal = await Journal.open(path.join(store.runDir(runId), "journal.jsonl"));

  const phasesSeen: string[] = [];
  let askCount = 0;
  let worldRunCount = 0;
  let reportedCount = 0;
  const recentLogs: string[] = [];
  const recentReports: { at: string; artifactId?: string; item: unknown }[] = [];
  const artifacts = new Map<string, { id: string; kind: string; version: number }>();

  for (const record of journal.all) {
    switch (record.kind) {
      case "phase":
        if (!phasesSeen.includes(record.name)) phasesSeen.push(record.name);
        break;
      case "ask":
        askCount += 1;
        break;
      case "world":
        worldRunCount += 1;
        break;
      case "report":
        reportedCount += 1;
        recentReports.push({ at: record.at, artifactId: record.artifactId, item: record.item });
        break;
      case "log":
        recentLogs.push(record.message);
        break;
      case "artifact":
        if (record.kindOf !== "file" && record.kindOf !== "markdown") break;
        artifacts.set(record.id, { id: record.id, kind: record.kindOf, version: record.version });
        break;
      default:
        break;
    }
  }

  const startedAt = journal.all.find((r) => r.kind === "status" && r.state === "running")?.at;
  return {
    id: meta.id,
    name: meta.name,
    state: meta.state,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    elapsedMs: elapsedBetween(startedAt ?? meta.createdAt, meta.updatedAt),
    phasesDeclared: meta.phases,
    phasesSeen,
    currentPhase: phasesSeen[phasesSeen.length - 1],
    agentNames: meta.agentNames,
    commands: meta.commands,
    askCount,
    worldRunCount,
    reportedCount,
    artifacts: [...artifacts.values()],
    recentLogs: recentLogs.slice(-8),
    recentReports: recentReports.slice(-6),
    pendingHole: meta.pendingHole
      ? { id: meta.pendingHole.id, name: meta.pendingHole.name, typeName: meta.pendingHole.typeName, prompt: meta.pendingHole.prompt }
      : undefined,
    pendingQuestions: meta.pendingQuestions.map((q) => ({ id: q.id, agent: `${q.agentName ?? "anonymous"}#${q.agentOrdinal}`, question: q.question })),
    error: meta.error,
    result: meta.result,
    scriptPath: meta.scriptPath,
  };
}

export async function listRunSummaries(workspaceDir: string, limit = 10): Promise<RunsSummary[]> {
  const store = new RunStore(workspaceDir);
  const metas = (await store.listRuns()).slice(0, limit);
  return metas.map((m) => ({
    id: m.id,
    name: m.name,
    state: m.state,
    updatedAt: m.updatedAt,
    currentPhase: m.phases[m.phases.length - 1],
  }));
}
