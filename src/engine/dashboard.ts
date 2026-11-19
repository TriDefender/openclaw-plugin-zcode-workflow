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
import type { JournalRecord } from "./types.js";

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
  phaseBoard: PhaseBoardEntry[];
}

export interface PhaseBoardItem {
  label: string;
  count: number;
  unit: "个任务" | "次执行";
  failed: number;
}

export interface PhaseBoardEntry {
  name: string;
  status: "pending" | "current" | "done";
  progress: string;
  items: PhaseBoardItem[];
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

interface PhaseBucket {
  scripts: number;
  scriptFails: number;
  agents: Map<string, number>;
}

/** Collapse the journal into one row per declared phase, ZCode-style. */
export function buildPhaseBoard(declared: string[], state: string, records: readonly JournalRecord[]): PhaseBoardEntry[] {
  const buckets = new Map<string, PhaseBucket>();
  const seen: string[] = [];
  let current: string | undefined;
  const bucket = (name: string): PhaseBucket => {
    let found = buckets.get(name);
    if (!found) {
      found = { scripts: 0, scriptFails: 0, agents: new Map() };
      buckets.set(name, found);
    }
    return found;
  };
  for (const record of records) {
    if (record.kind === "phase") {
      current = record.name;
      bucket(current);
      if (!seen.includes(current)) seen.push(current);
      continue;
    }
    if (record.kind !== "ask" && record.kind !== "world") continue;
    const name = current ?? "启动";
    const target = bucket(name);
    if (name === "启动" && !seen.includes(name)) seen.unshift(name);
    if (record.kind === "ask") {
      target.agents.set(record.agent, (target.agents.get(record.agent) ?? 0) + 1);
    } else {
      target.scripts += 1;
      if (record.result.exitCode !== 0) target.scriptFails += 1;
    }
  }
  const names = [...declared];
  for (const name of seen) if (!names.includes(name) && name !== "启动") names.push(name);
  if (seen.includes("启动")) names.unshift("启动");
  const last = [...seen].reverse().find((name) => name !== "启动");
  const live = state === "running" || state === "waiting_hole" || state === "waiting_question";
  const interrupted = state === "stopped" || state === "errored";
  return names.map((name) => {
    const work = buckets.get(name);
    const entered = seen.includes(name);
    const status: PhaseBoardEntry["status"] = !entered ? "pending" : name === last && (live || interrupted) ? "current" : "done";
    let steps = work?.scripts ?? 0;
    for (const count of work?.agents.values() ?? []) steps += count;
    const progress = status === "pending" ? "—" : status === "done" ? `${steps}/${steps}` : steps === 0 ? "0" : `${steps}/…`;
    const items: PhaseBoardItem[] = [];
    if (work && work.scripts > 0) items.push({ label: "脚本", count: work.scripts, unit: "次执行", failed: work.scriptFails });
    for (const [label, count] of work?.agents ?? []) items.push({ label, count, unit: "个任务", failed: 0 });
    return { name, status, progress, items };
  });
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
    phaseBoard: buildPhaseBoard(meta.phases, meta.state, journal.all),
  };
}

export const snapshotRun = readRunSnapshot;

const STATE_LABELS: Record<string, string> = {
  running: "运行中",
  completed: "已完成",
  errored: "已出错",
  stopped: "已停止",
  waiting_hole: "等待填充 hole",
  waiting_question: "等待回答提问",
  superseded: "已被修订取代",
};

function phaseStatusLabel(status: PhaseBoardEntry["status"], state: string): string {
  if (status === "pending") return "未开始";
  if (status === "done") return "完成";
  if (state === "waiting_hole" || state === "waiting_question") return "等待";
  if (state === "stopped" || state === "errored") return "停在这";
  return "进行中";
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}分${sec < 10 ? "0" : ""}${sec}秒` : `${sec}秒`;
}

/** Native session:report props. Blocks only, under the 8KB widget cap. */
export function workflowReportProps(run: RunSnapshot): { blocks: Record<string, unknown>[] } {
  const stateLabel = STATE_LABELS[run.state] ?? run.state;
  const declared = run.phasesDeclared.length || run.phaseBoard.length;
  const started = run.phaseBoard.filter((phase) => phase.status !== "pending").length;
  const steps = run.askCount + run.worldRunCount;
  const summary = [
    `${stateLabel} · 阶段 ${started}/${declared} · 子代理 ${run.askCount} · 步 ${steps}`,
    run.agentNames.length > 0 ? `预定子代理：${run.agentNames.join("、")}` : "",
    run.elapsedMs !== undefined && run.elapsedMs > 0 ? `耗时 ${fmtDuration(run.elapsedMs)}` : "",
    run.state === "running" && run.phasesSeen.length === 0 ? "日志里只有启动，下面这些阶段都还没开始。" : "",
  ].filter((line) => line.length > 0).join("\n");
  const blocks: Record<string, unknown>[] = [
    { type: "text", title: run.name.slice(0, 80), text: summary.slice(0, 4000) },
  ];
  if (run.phaseBoard.length > 0) {
    const rows: string[][] = [];
    for (const phase of run.phaseBoard) {
      if (rows.length >= 40) break;
      rows.push([phase.name.slice(0, 80), phase.progress, phaseStatusLabel(phase.status, run.state)]);
      for (const item of phase.items) {
        if (rows.length >= 40) break;
        const mark = item.failed > 0 ? `${item.failed} 次失败` : phase.status === "current" ? "进行中" : "✓";
        rows.push([`· ${item.label}`.slice(0, 80), `${item.count} ${item.unit}`, mark]);
      }
    }
    blocks.push({ type: "table", title: "阶段", columns: ["阶段", "进度", "状态"], rows });
  }
  if (run.pendingHole) {
    blocks.push({
      type: "text",
      title: `等待 hole：${run.pendingHole.name}`.slice(0, 80),
      text: `${run.pendingHole.id}\n${run.pendingHole.prompt}`.slice(0, 4000).trim() || "（无提示）",
    });
  }
  if (run.pendingQuestions.length > 0) {
    blocks.push({
      type: "text",
      title: "子代理提问",
      text: run.pendingQuestions.map((q) => `${q.agent}（${q.id}）：${q.question}`).join("\n").slice(0, 4000),
    });
  }
  const logs = run.recentLogs.filter((line) => line.trim().length > 0).slice(-5);
  if (logs.length > 0) blocks.push({ type: "text", title: "最近日志", text: logs.map((line) => `· ${line}`).join("\n").slice(0, 4000) });
  if (run.state === "completed" && run.result != null) {
    const result = run.result as Record<string, unknown>;
    const conclusion = typeof result.conclusion === "string" ? result.conclusion : JSON.stringify(run.result).slice(0, 2000);
    blocks.push({ type: "text", title: "结论", text: conclusion.slice(0, 4000) });
  }
  if ((run.state === "errored" || run.state === "stopped") && run.error) {
    blocks.push({ type: "text", title: "错误", text: run.error.slice(0, 4000) });
  }
  let kept = blocks.slice(0, 24);
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify({ blocks: kept }), "utf8") > 7500) kept = kept.slice(0, -1);
  return { blocks: kept };
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
