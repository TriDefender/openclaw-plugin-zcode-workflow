/**
 * The run executor: compiles the effective script, sandboxes it in a vm
 * context whose only globals are the facade, journals every settled effect,
 * and drives the run lifecycle (running → completed | errored | stopped |
 * waiting_hole | waiting_question). Resume, amend and hole fills all work the
 * same way: re-execute the script while the journal serves every settled
 * effect at zero cost.
 */
import crypto from "node:crypto";
import vm from "node:vm";
import path from "node:path";
import fs from "node:fs/promises";
import { compileWorkflow } from "./compile.js";
import { Journal, stableKey } from "./journal.js";
import { RunStore } from "./store.js";
import { Semaphore, SubagentPool, type SubagentRuntime, type TaskDoneInfo } from "./agents.js";
import { resolveAskConcurrency } from "./scope.js";
import { ArtifactPublisher } from "./artifacts.js";
import { extractJson, validateAgainstSchema } from "./schema.js";
import type { AskMeta, PendingQuestion, RunMeta } from "./types.js";
import { WorkflowError } from "./types.js";
import * as worldOps from "./world.js";

export interface RunnerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

class HoleSignal extends Error {
  constructor(
    readonly holeName: string,
    readonly prompt: string,
  ) {
    super(`hole waiting: ${holeName}`);
  }
}

class EscalationSignal extends Error {
  constructor(readonly question: PendingQuestion) {
    super(`subagent escalated: ${question.question.slice(0, 120)}`);
  }
}

class StopSignal extends Error {
  constructor(readonly reason: "user" | "model") {
    super(`run stopped (${reason})`);
  }
}

class ChannelDeadlockError extends Error {
  constructor(channels: string[]) {
    super(`ChannelDeadlock: nobody can send to ${channels.join(", ")} any more — close the producing channel in a finally block`);
  }
}

const CHANNEL_PRELUDE = `
function __wf_makeChannel(name) {
  const items = [];
  const waiters = [];
  let closed = false;
  const ch = {
    send(item) {
      if (closed) { const e = new Error("ChannelClosed: " + name); e.name = "ChannelClosed"; throw e; }
      items.push(item);
      const w = waiters.shift();
      if (w) w();
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) waiters.shift()();
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          for (;;) {
            if (items.length > 0) return { value: items.shift(), done: false };
            if (closed) return { value: undefined, done: true };
            await new Promise((resolve) => waiters.push(resolve));
          }
        },
        async return() { return { value: undefined, done: true }; },
      };
    },
  };
  return { ch, name, items, waiters, isClosed: () => closed };
}
globalThis.__wf_channels = [];
globalThis.channel = function channel(name) {
  const made = __wf_makeChannel(name);
  globalThis.__wf_channels.push(made);
  return made.ch;
};
globalThis.future = function future(body) { return body(); };
`;

const VM_GLOBALS = { JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, Map, Set, RegExp, Error, isNaN, parseInt, parseFloat, structuredClone };

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Captured origin-session target for session-event notifications (in-memory only: the
 *  handle contains function-valued authority fields and cannot be persisted; after a
 *  gateway restart a matching session can re-capture it via workflow_resume/amend). */
export interface NotifyTarget {
  agentId: string;
  sessionKey: string;
  expectedTarget?: unknown;
}

/** Minimal slice of api.runtime.system used for push notifications. */
export interface NotifySystem {
  enqueueSessionEvent?: (
    text: string,
    opts: { agentId: string; sessionKey: string; expectedTarget?: unknown },
  ) => {
    accepted: Promise<{ ok: boolean; error?: string }>;
    settled: Promise<{ status: string; error?: string }>;
    cancel: () => void;
  };
}

export class WorkflowRunner {
  private live = new Map<string, { abort: (reason: "user" | "model") => void; settle: () => void }>();
  private notifyTargets = new Map<string, NotifyTarget>();
  private notifyBuffers = new Map<string, { lines: string[]; timer: ReturnType<typeof setTimeout> | undefined }>();

  constructor(
    private readonly store: RunStore,
    private readonly subagents: SubagentRuntime,
    private readonly workspaceDir: string,
    private readonly logger: RunnerLogger,
    private readonly readConfig: () => unknown,
    /**
     * Runs the detached execution outside the starting turn's async context.
     * Wired to api.lifecycle.runInBackgroundContext when the host provides it:
     * background work must not retain the tool-call authority of the turn that
     * launched it, or the next subagent dispatch after that turn ends fails
     * with 'agent tool caller authority is no longer active'.
     */
    private readonly runInBackground: (run: () => Promise<void>) => Promise<void> = (run) => run(),
    /** api.runtime.system slice — enables per-task session-event notifications. */
    private readonly notifySystem?: NotifySystem,
  ) {}

  /** Register the originating session as the notify target for a run. */
  rememberNotifyTarget(runId: string, target: NotifyTarget): void {
    this.notifyTargets.set(runId, target);
  }

  notifyTargetFor(runId: string): NotifyTarget | undefined {
    return this.notifyTargets.get(runId);
  }

  private poolFor(meta: RunMeta): SubagentPool {
    const agentId = meta.agentId;
    if (!agentId) {
      throw new WorkflowError(`run ${meta.id} has no owning agent`, "no_agent");
    }
    const limit = resolveAskConcurrency(this.readConfig(), agentId, meta.maxConcurrency);
    return new SubagentPool(
      this.subagents,
      meta.id,
      agentId,
      this.workspaceDir,
      meta.subagentModel,
      new Semaphore(limit),
      this.logger,
      (info) => this.onTaskDone(meta, info),
    );
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }

  // ---- session-event notifications (per-task + settle pushes) ----

  private static readonly NOTIFY_FLUSH_MS = 1_500;

  private onTaskDone(meta: RunMeta, info: TaskDoneInfo): void {
    if (!this.notifyTargets.has(meta.id) || !this.notifySystem?.enqueueSessionEvent) return;
    const label = info.name ?? `#${info.ordinal}`;
    const summary = (info.summary ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
    const line = info.ok
      ? `任务 ${label} 完成${summary ? `：${summary}` : ""}`
      : `任务 ${label} 失败：${summary || "unknown error"}`;
    let buffer = this.notifyBuffers.get(meta.id);
    if (!buffer) {
      buffer = { lines: [], timer: undefined };
      this.notifyBuffers.set(meta.id, buffer);
    }
    buffer.lines.push(line);
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => void this.flushNotify(meta), WorkflowRunner.NOTIFY_FLUSH_MS);
    // Never let a pending timer keep the process alive or the run unsettled.
    buffer.timer.unref?.();
  }

  private flushNotify(meta: RunMeta): void {
    const buffer = this.notifyBuffers.get(meta.id);
    if (!buffer || buffer.lines.length === 0) return;
    const lines = buffer.lines.splice(0, buffer.lines.length);
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }
    const body = lines.map((l) => `- ${l}`).join("\n");
    const text = [
      `[zcode-workflow] run ${meta.id}（${meta.name}）进度：`,
      body,
      `请刷新状态卡：workflow_dashboard {run_id:"${meta.id}"} 并把返回 JSON 传给 dashboard 工具（同名刷新）；回复不超过一行。`,
    ].join("\n");
    this.enqueueNotify(meta, text);
  }

  private notifySettled(meta: RunMeta, detail: string): void {
    if (!this.notifyTargets.has(meta.id) || !this.notifySystem?.enqueueSessionEvent) return;
    // Flush any pending task lines first so ordering stays natural.
    this.flushNotify(meta);
    const stateLabel: Record<string, string> = {
      completed: "已完成",
      errored: "已出错",
      stopped: "已停止",
      waiting_hole: "等待填洞",
      waiting_question: "等待回答问题",
    };
    const text = [
      `[zcode-workflow] run ${meta.id}（${meta.name}）${stateLabel[meta.state] ?? meta.state}。${detail}`.trim(),
      `请刷新终态卡：workflow_dashboard {run_id:"${meta.id}"} → dashboard（同名刷新）；回复不超过一行。`,
    ].join("\n");
    this.enqueueNotify(meta, text);
  }

  private enqueueNotify(meta: RunMeta, text: string): void {
    const target = this.notifyTargets.get(meta.id);
    const enqueue = this.notifySystem?.enqueueSessionEvent;
    if (!target || !enqueue) return;
    try {
      const receipt = enqueue(text, {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        ...(target.expectedTarget !== undefined ? { expectedTarget: target.expectedTarget } : {}),
      });
      void receipt.accepted
        .then((admission) => {
          if (admission.ok) this.logger.info(`workflow run ${meta.id}: session event admitted to ${target.sessionKey}`);
          else this.logger.warn(`workflow run ${meta.id}: session event rejected (${admission.error ?? "unknown"})`);
        })
        .catch((err) => this.logger.warn(`workflow run ${meta.id}: session event admission failed: ${(err as Error).message}`));
      void receipt.settled.catch(() => {});
    } catch (err) {
      this.logger.warn(`workflow run ${meta.id}: session event enqueue failed: ${(err as Error).message}`);
    }
  }

  liveIds(): string[] {
    return [...this.live.keys()];
  }

  stop(runId: string, reason: "user" | "model"): boolean {
    const entry = this.live.get(runId);
    if (!entry) return false;
    entry.abort(reason);
    return true;
  }

  /** Kick off (or resume) a run in the background. */
  start(meta: RunMeta): void {
    if (this.live.has(meta.id)) return;
    const state = { abortReason: undefined as "user" | "model" | undefined };
    let onAbort: (() => void) | undefined;
    const execution: { abort: (reason: "user" | "model") => void; settle: () => void } = {
      abort: (reason) => {
        state.abortReason = reason;
        onAbort?.();
      },
      settle: () => {
        this.live.delete(meta.id);
      },
    };
    this.live.set(meta.id, execution);
    // Detach from the invoking turn: runInBackgroundContext strips the turn's
    // tool-caller identity and request scope while keeping the plugin instance's
    // Gateway binding, so subagent dispatches stay admitted after the turn ends.
    const launched = this.runInBackground(() => this.execute(meta, state, (fn) => (onAbort = fn)));
    void Promise.resolve(launched)
      .catch((err) => this.logger.error(`workflow run ${meta.id} crashed: ${(err as Error).stack ?? err}`))
      .finally(() => execution.settle());
  }

  /**
   * Answer a pending escalation in place: the answer continues the subagent's
   * session, and the reply is journaled as that ask's result. The caller then
   * resumes the run.
   */
  async resolveQuestion(meta: RunMeta, question: PendingQuestion, answer: string): Promise<void> {
    const journal = await Journal.open(path.join(this.store.runDir(meta.id), "journal.jsonl"));
    const pool = this.poolFor(meta);
    const typed = question.askMeta;
    const continuation =
      `The requester answered your question:\n\n${answer}\n\n` +
      `Continue your original task with this answer.` +
      (typed ? ` Reply again with a single JSON value matching the interface from before (no prose).` : "");
    let reply: string;
    try {
      reply = await pool.continueAsk(question.agentName || undefined, question.agentOrdinal, { tools: question.personaTools }, continuation);
    } catch (err) {
      throw new WorkflowError(`answering the escalation failed: ${(err as Error).message}`, "ask_failed");
    }
    let result: unknown = reply;
    if (typed) {
      const parsed = extractJson(reply);
      if (!parsed.ok) throw new WorkflowError(`the resolved answer was not valid JSON: ${parsed.error}`, "ask_invalid");
      const errors = validateAgainstSchema(parsed.value, typed.schema);
      if (errors.length > 0) throw new WorkflowError(`the resolved answer failed validation: ${errors.join("; ")}`, "ask_invalid");
      result = parsed.value;
    }
    await journal.append({
      kind: "ask",
      agent: question.agentName ?? `#${question.agentOrdinal}`,
      agentIndex: question.agentIndex,
      instructions: question.instructions,
      result,
      typed: Boolean(typed),
      resumedAnswer: true,
    });
    meta.pendingQuestions = meta.pendingQuestions.filter((q) => q.id !== question.id);
    if (meta.pendingQuestions.length === 0 && meta.state === "waiting_question") {
      meta.state = "stopped";
      meta.stop = { reason: "interrupted", detail: "question resolved; resume to continue", at: new Date().toISOString() };
    }
    await this.store.saveMeta(meta);
  }

  // ---- execution ----

  private async execute(
    meta: RunMeta,
    abortState: { abortReason?: "user" | "model" },
    registerAbort: (fn: () => void) => void,
  ): Promise<void> {
    const journalFile = path.join(this.store.runDir(meta.id), "journal.jsonl");
    const journal = await Journal.open(journalFile);
    const publisher = new ArtifactPublisher(this.store.artifactsDir(meta.id), this.workspaceDir, journal);
    publisher.restoreFromJournal();

    const scriptSource = await this.store.readScript(meta.id);
    const compiled = compileWorkflow({
      scriptPath: path.join(this.store.runDir(meta.id), "script.ts"),
      source: scriptSource,
      fills: meta.fills,
    });
    if (!compiled.ok || !compiled.js || !compiled.meta) {
      meta.state = "errored";
      meta.error = `script no longer compiles:\n${compiled.diagnostics.map((d) => `${d.path}:L${d.line}:C${d.column} ${d.message}`).join("\n")}`;
      meta.updatedAt = new Date().toISOString();
      await this.store.saveMeta(meta);
      return;
    }

    meta.state = "running";
    meta.pendingHole = undefined;
    meta.error = undefined;
    meta.phases = compiled.meta.phases;
    meta.commands = compiled.meta.commands;
    meta.agentNames = compiled.meta.agentNames;
    meta.holes = compiled.meta.holes;
    meta.updatedAt = new Date().toISOString();
    await this.store.saveMeta(meta);
    await journal.append({ kind: "status", state: "running" });

    let cacheOpen = journal.importedCount > 0;
    let activeAsks = 0;
    let activeWorld = 0;
    let stalledSince: number | undefined;
    registerAbort(() => undefined);

    const guard = () => {
      if (abortState.abortReason) throw new StopSignal(abortState.abortReason);
    };

    const pool = this.poolFor(meta);
    let agentOrdinal = 0;
    const holeMetaByName = new Map(compiled.meta.holes.map((h) => [h.name, h]));

    const wrapGit = async (op: string, argsList: unknown[]): Promise<unknown> => {
      guard();
      const key = stableKey([`git.${op}`, ...argsList]);
      if (cacheOpen) {
        const cached = journal.lookupGit(key);
        if (cached !== undefined) return cached;
      }
      const runners: Record<string, () => Promise<unknown>> = {
        changedFiles: () => worldOps.gitChangedFiles(this.workspaceDir, argsList[0] as string | undefined),
        diff: () => worldOps.gitDiff(this.workspaceDir, argsList[0] as string | undefined, argsList[1] as string | undefined),
        status: () => worldOps.gitStatus(this.workspaceDir),
        log: () => worldOps.gitLog(this.workspaceDir, argsList[0] as number | undefined),
      };
      const result = await runners[op]!();
      await journal.append({ kind: "git", key, result });
      return result;
    };

    // ---- facade ----
    const facade: Record<string, unknown> = {
      agent: (name?: string, persona?: unknown) => {
        const personaObj: {
          system?: string;
          model?: string;
          budget?: { webSearch?: number };
          tools?: "none" | "submit";
          replySchema?: unknown;
        } = {};
        if (typeof persona === "string") personaObj.system = persona;
        else if (persona && typeof persona === "object") {
          const p = persona as {
            system?: string;
            model?: string | { __modelRef?: string };
            budget?: { webSearch?: number };
            tools?: "none" | "submit";
            replySchema?: unknown;
          };
          personaObj.system = p.system;
          personaObj.model =
            typeof p.model === "string" ? p.model : p.model && typeof p.model === "object" && "__modelRef" in p.model ? String(p.model.__modelRef) : undefined;
          personaObj.budget = p.budget;
          personaObj.tools = p.tools === "none" || p.tools === "submit" ? p.tools : undefined;
          personaObj.replySchema = p.replySchema;
        }
        pool.registerName(name);
        const ordinal = agentOrdinal++;
        return {
          ask: async (instructions: string, metaJson?: string) => {
            guard();
            const askMeta =
              metaJson !== undefined
                ? (JSON.parse(metaJson) as AskMeta)
                : personaObj.replySchema !== undefined && personaObj.replySchema !== null
                  ? ({ typeName: "persona replySchema", source: "persona.replySchema", schema: personaObj.replySchema } as AskMeta)
                  : undefined;
            const agentIndex = pool.nextAskIndex(name, ordinal);
            if (cacheOpen) {
              const cached = journal.lookupAsk(name, agentIndex, instructions);
              if (cached) return cached.result;
            }
            activeAsks += 1;
            stalledSince = undefined;
            let text: string;
            try {
              text = await pool.ask(name, ordinal, personaObj, composeAskMessage(instructions, askMeta));
            } finally {
              activeAsks -= 1;
            }
            cacheOpen = false;

            if (askMeta) {
              let parsed = await parseAndValidate(text, askMeta);
              if (!parsed.ok) {
                const retryText = await pool.ask(
                  name,
                  ordinal,
                  personaObj,
                  composeRetryMessage(instructions, askMeta, parsed.errors),
                );
                parsed = await parseAndValidate(retryText, askMeta);
                if (!parsed.ok) {
                  throw new WorkflowError(
                    `subagent ${name ?? "(anonymous)"}'s answer failed validation twice for: ${instructions.slice(0, 80)}… — ${parsed.errors.join("; ")}`,
                    "ask_invalid",
                  );
                }
              }
              const escalation = asEscalation(parsed.value);
              if (escalation) {
                throw new EscalationSignal(makeQuestion(meta, name, ordinal, agentIndex, instructions, askMeta, escalation, personaObj.tools));
              }
              await journal.append({ kind: "ask", agent: name ?? `#${ordinal}`, agentIndex, instructions, result: parsed.value, typed: true });
              return parsed.value;
            }
            const escalation = detectUntypedEscalation(text);
            if (escalation) {
              throw new EscalationSignal(makeQuestion(meta, name, ordinal, agentIndex, instructions, undefined, escalation, personaObj.tools));
            }
            await journal.append({ kind: "ask", agent: name ?? `#${ordinal}`, agentIndex, instructions, result: text, typed: false });
            return text;
          },
        };
      },
      phase: (name: string) => {
        if (!journal.all.some((r) => r.kind === "phase" && r.name === name)) void journal.append({ kind: "phase", name });
      },
      hole: async (name: string, a?: unknown, b?: unknown) => {
        guard();
        const body = (typeof b === "function" ? b : typeof a === "function" ? a : undefined) as (() => Promise<unknown>) | undefined;
        if (body) return await body();
        const prompt = typeof a === "string" ? a : "";
        const info = holeMetaByName.get(name);
        meta.pendingHole = {
          id: info?.id ?? `hole#${sha256(name)}`,
          name,
          typeName: info?.typeName ?? "unknown",
          prompt,
          waitingSince: new Date().toISOString(),
        };
        meta.state = "waiting_hole";
        meta.updatedAt = new Date().toISOString();
        await this.store.saveMeta(meta);
        throw new HoleSignal(name, prompt);
      },
      log: (message: string) => {
        if (!journal.hasLog(message)) void journal.append({ kind: "log", message });
      },
      report: (item: unknown, artifactId?: string) => {
        guard();
        publisher.routeReport(item, artifactId);
        if (!journal.hasReport(item, artifactId)) {
          void journal.append({ kind: "report", item, artifactId });
          if (artifactId) void publisher.recordPresetItem(artifactId, item);
        }
      },
      artifact: {
        file: async (id: string, relPath: string, opts: { title?: string; description?: string; primary?: boolean; contentType?: string } = {}) => {
          guard();
          publisher.markPrimary(meta, id, opts);
          const abs = path.resolve(this.workspaceDir, relPath);
          const stat = await fs.stat(abs).catch(() => undefined);
          const fingerprint = `${relPath}|${stat?.size ?? -1}`;
          const replay = findReplayedArtifact(journal, id, "file", fingerprint);
          if (replay) return replay;
          const ref = await publisher.publishFile(id, relPath, opts);
          await journal.append({ kind: "artifact", id, kindOf: "file", version: ref.version, path: fingerprint });
          return ref;
        },
        markdown: async (id: string, content: string, opts: { title?: string; description?: string; primary?: boolean } = {}) => {
          guard();
          publisher.markPrimary(meta, id, opts);
          const fingerprint = `sha256:${sha256(content)}`;
          const replay = findReplayedArtifact(journal, id, "markdown", fingerprint);
          if (replay) return replay;
          const ref = await publisher.publishMarkdown(id, content, opts);
          await journal.append({ kind: "artifact", id, kindOf: "markdown", version: ref.version, path: fingerprint });
          return ref;
        },
        chart: (id: string, spec: Record<string, unknown>) => declarePreset(journal, publisher, id, "chart", spec),
        table: (id: string, spec: Record<string, unknown>) => declarePreset(journal, publisher, id, "table", spec),
        metrics: (id: string, spec: Record<string, unknown>) => declarePreset(journal, publisher, id, "metrics", spec),
        board: (id: string, spec: Record<string, unknown>) => declarePreset(journal, publisher, id, "board", spec),
      },
      files: {
        glob: async (pattern: string) => {
          guard();
          const key = stableKey(["files.glob", pattern]);
          if (cacheOpen) {
            const cached = journal.lookupFiles(key);
            if (cached !== undefined) return cached;
          }
          const result = await worldOps.filesGlob(this.workspaceDir, pattern);
          await journal.append({ kind: "files", key, result });
          return result;
        },
        read: async (relPath: string) => {
          guard();
          const key = stableKey(["files.read", relPath]);
          if (cacheOpen) {
            const cached = journal.lookupFiles(key);
            if (cached !== undefined) return cached;
          }
          const result = await worldOps.filesRead(this.workspaceDir, relPath);
          await journal.append({ kind: "files", key, result });
          return result;
        },
        grep: async (pattern: string, glob?: string) => {
          guard();
          const key = stableKey(["files.grep", pattern, glob]);
          if (cacheOpen) {
            const cached = journal.lookupFiles(key);
            if (cached !== undefined) return cached;
          }
          const result = await worldOps.filesGrep(this.workspaceDir, pattern, glob);
          await journal.append({ kind: "files", key, result });
          return result;
        },
      },
      git: {
        changedFiles: async (base?: string) => wrapGit("changedFiles", [base]),
        diff: async (base?: string, relPath?: string) => wrapGit("diff", [base, relPath]),
        status: async () => wrapGit("status", []),
        log: async (count?: number) => wrapGit("log", [count]),
      },
      world: {
        run: async (cmd: string, args: string[] = [], opts: worldOps.WorldRunOptions = {}) => {
          guard();
          if (!meta.commands.includes(cmd)) {
            throw new WorkflowError(
              `world.run("${cmd}") is not in this run's approved command set (${meta.commands.join(", ") || "none"}); the command must be a compile-time literal present in the compiled script`,
              "bad_command",
            );
          }
          const key = stableKey(["world.run", cmd, args, opts]);
          if (cacheOpen) {
            const cached = journal.lookupWorld(key);
            if (cached) return cached;
          }
          activeWorld += 1;
          stalledSince = undefined;
          let result: { exitCode: number; stdout: string; stderr: string };
          try {
            result = await worldOps.worldRun(this.workspaceDir, cmd, args, opts);
          } finally {
            activeWorld -= 1;
          }
          cacheOpen = false;
          await journal.append({ kind: "world", key, result });
          return result;
        },
      },
      model: (id: string) => ({ __modelRef: id }),
      run: { id: meta.id, ...(meta.supersededFrom ? { resumedFrom: meta.supersededFrom } : {}) },
      args: meta.savedFrom?.args ?? {},
    };

    // ---- sandbox ----
    const context = vm.createContext({ ...facade, ...VM_GLOBALS });
    vm.runInContext(CHANNEL_PRELUDE, context);
    vm.runInContext(compiled.js, context, { filename: `workflow-${meta.id}.js` });
    const workflowFn = vm.runInContext("__workflow__", context) as () => Promise<unknown>;
    if (typeof workflowFn !== "function") {
      throw new Error("compiled script did not define __workflow__");
    }

    // watchdog: an unsettled script with no facade work in flight is stalled
    let stalled = false;
    const stallWaiters: (() => void)[] = [];
    const stallNow = () => {
      if (stalled) return;
      stalled = true;
      while (stallWaiters.length > 0) stallWaiters.shift()!();
    };
    const watchdog = setInterval(() => {
      if (abortState.abortReason) {
        stallNow();
        return;
      }
      const idle = activeAsks === 0 && activeWorld === 0;
      if (idle) {
        stalledSince ??= Date.now();
        if (Date.now() - stalledSince > 120_000) stallNow();
      } else {
        stalledSince = undefined;
      }
    }, 15_000);

    let outcome: { kind: "ok"; value: unknown } | { kind: "error"; error: unknown };
    try {
      outcome = await Promise.race([
        Promise.resolve(workflowFn.call(context)).then(
          (v: unknown) => ({ kind: "ok" as const, value: v }),
          (e: unknown) => ({ kind: "error" as const, error: e }),
        ),
        new Promise<{ kind: "error"; error: unknown }>((resolve) => {
          stallWaiters.push(() => {
            const channels = vm.runInContext(
              `globalThis.__wf_channels.filter(c => !c.isClosed() && c.waiters.length > 0).map(c => c.name)`,
              context,
            ) as string[];
            const error =
              channels.length > 0
                ? new ChannelDeadlockError(channels)
                : new Error("ScriptStalled: the script made no progress for 120s with no work in flight (an unresolved promise can never settle)");
            resolve({ kind: "error", error });
          });
        }),
      ]);
    } finally {
      clearInterval(watchdog);
    }

    // orphaned channel receivers after settle are a deadlock
    if (outcome.kind === "ok") {
      const deadlocked = vm.runInContext(
        `globalThis.__wf_channels.filter(c => !c.isClosed() && c.waiters.length > 0).map(c => c.name)`,
        context,
      ) as string[];
      if (deadlocked.length > 0) {
        outcome = { kind: "error", error: new ChannelDeadlockError(deadlocked) };
      }
    }

    // ---- settle ----
    meta.updatedAt = new Date().toISOString();
    if (outcome.kind === "ok") {
      meta.state = "completed";
      meta.result = outcome.value;
      meta.pendingHole = undefined;
      await journal.append({ kind: "status", state: "completed" });
      await this.store.saveMeta(meta);
      this.logger.info(`workflow run ${meta.id} ("${meta.name}") completed`);
      const resultText = (() => {
        try {
          const s = JSON.stringify(meta.result);
          return s ? `结果：${s.slice(0, 200)}` : "";
        } catch {
          return "";
        }
      })();
      this.notifySettled(meta, resultText);
      return;
    }

    const err = outcome.error;
    if (err instanceof HoleSignal) {
      meta.state = "waiting_hole";
      await journal.append({ kind: "status", state: "waiting_hole", detail: err.holeName });
      await this.store.saveMeta(meta);
      this.logger.info(`workflow run ${meta.id} waiting at hole "${err.holeName}"`);
      this.notifySettled(meta, `等待填洞 ${err.holeName}（workflow_fill_hole）。`);
      return;
    }
    if (err instanceof EscalationSignal) {
      meta.state = "waiting_question";
      meta.pendingQuestions = [...meta.pendingQuestions.filter((q) => q.id !== err.question.id), err.question];
      await journal.append({ kind: "status", state: "waiting_question", detail: err.question.id });
      await this.store.saveMeta(meta);
      this.logger.warn(`workflow run ${meta.id}: subagent "${err.question.agentName ?? "anonymous"}" escalated a question`);
      this.notifySettled(meta, `子代理 ${err.question.agentName ?? "anonymous"} 提出了问题（workflow_resolve_question）。`);
      return;
    }
    if (err instanceof StopSignal) {
      meta.state = "stopped";
      meta.stop = { reason: err.reason, at: new Date().toISOString() };
      await journal.append({ kind: "status", state: "stopped", detail: err.reason });
      await this.store.saveMeta(meta);
      this.logger.info(`workflow run ${meta.id} stopped (${err.reason})`);
      this.notifySettled(meta, `停止原因：${err.reason}。`);
      return;
    }
    meta.state = "errored";
    meta.pendingHole = undefined;
    meta.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await journal.append({ kind: "status", state: "errored", detail: meta.error });
    await this.store.saveMeta(meta);
    this.logger.error(`workflow run ${meta.id} errored: ${meta.error}`);
    this.notifySettled(meta, `错误：${meta.error.slice(0, 200)}`);
  }

  // ---- snippet evaluation (synchronous, nothing persisted) ----

  async evalSnippet(source: string, scriptPath: string, timeoutMs: number): Promise<{ logs: string[]; result: unknown }> {
    const compiled = compileWorkflow({ scriptPath, source, snippet: true });
    if (!compiled.ok || !compiled.js) {
      throw new WorkflowError(
        `snippet diagnostics (nothing ran):\n${compiled.diagnostics.map((d) => `${d.path}:L${d.line}:C${d.column} ${d.message}`).join("\n")}`,
        "diagnostics",
      );
    }
    const logs: string[] = [];
    const facade: Record<string, unknown> = {
      log: (message: string) => logs.push(message),
      files: {
        glob: async (pattern: string) => worldOps.filesGlob(this.workspaceDir, pattern),
        read: async (p: string) => worldOps.filesRead(this.workspaceDir, p),
        grep: async (pattern: string, glob?: string) => worldOps.filesGrep(this.workspaceDir, pattern, glob),
      },
      git: {
        changedFiles: async (base?: string) => worldOps.gitChangedFiles(this.workspaceDir, base),
        diff: async (base?: string, p?: string) => worldOps.gitDiff(this.workspaceDir, base, p),
        status: async () => worldOps.gitStatus(this.workspaceDir),
        log: async (count?: number) => worldOps.gitLog(this.workspaceDir, count),
      },
      world: {
        run: async (cmd: string, args: string[] = [], opts: worldOps.WorldRunOptions = {}) => worldOps.worldRun(this.workspaceDir, cmd, args, opts),
      },
      run: { id: `dwfeval-${Date.now().toString(36)}` },
      args: {},
      model: (id: string) => ({ __modelRef: id }),
    };
    const context = vm.createContext({ ...facade, ...VM_GLOBALS });
    vm.runInContext(CHANNEL_PRELUDE, context);
    vm.runInContext(compiled.js, context, { filename: "workflow-eval.js" });
    const fn = vm.runInContext("__workflow__", context) as () => Promise<unknown>;
    const result = await Promise.race([
      Promise.resolve(fn.call(context)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`snippet exceeded ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return { logs, result };
  }
}

// ---- ask helpers ----

function composeAskMessage(instructions: string, askMeta?: AskMeta): string {
  const escalationClause =
    'If you are blocked by something outside your control — a gate you cannot pass, contradictory instructions, or a fact only the requester knows — answer exactly {"escalated": true, "question": "<your question>", "evidence": "<what you tried>"} instead of fabricating a result.';
  if (!askMeta) {
    return `${instructions}\n\n---\n${escalationClause}`;
  }
  const schema = askMeta.schema as { type: string; required?: string[] };
  const required = schema.type === "object" && schema.required ? ` Required fields: ${schema.required.join(", ")}.` : "";
  return [
    instructions,
    "",
    "---",
    "",
    "Answer with a single JSON value matching this TypeScript interface exactly (no prose, no commentary):",
    "```ts",
    askMeta.source,
    "```",
    required,
    "",
    escalationClause,
  ].join("\n");
}

function composeRetryMessage(instructions: string, askMeta: AskMeta, errors: string[]): string {
  return [
    "Your previous answer failed validation:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Answer again with a single corrected JSON value matching this interface (no prose):",
    "```ts",
    askMeta.source,
    "```",
  ].join("\n");
}

async function parseAndValidate(text: string, askMeta: AskMeta): Promise<{ ok: true; value: unknown } | { ok: false; errors: string[] }> {
  const parsed = extractJson(text);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const errors = validateAgainstSchema(parsed.value, askMeta.schema);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: parsed.value };
}

function asEscalation(value: unknown): { question: string; evidence: string | undefined } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.escalated === true && typeof v.question === "string" && v.question.length > 0) {
    return { question: v.question, evidence: typeof v.evidence === "string" ? v.evidence : undefined };
  }
  return undefined;
}

function detectUntypedEscalation(text: string): { question: string; evidence: string | undefined } | undefined {
  const parsed = extractJson(text);
  if (!parsed.ok) return undefined;
  return asEscalation(parsed.value);
}

function makeQuestion(
  meta: RunMeta,
  agentName: string | undefined,
  ordinal: number,
  agentIndex: number,
  instructions: string,
  askMeta: AskMeta | undefined,
  escalation: { question: string; evidence: string | undefined },
  personaTools?: "none" | "submit",
): PendingQuestion {
  return {
    id: `dwfq-${Math.random().toString(36).slice(2, 10)}`,
    runId: meta.id,
    agent: `${agentName ?? "anonymous"}#${ordinal}`,
    agentName,
    agentOrdinal: ordinal,
    agentIndex,
    instructions,
    question: escalation.question,
    evidence: escalation.evidence,
    createdAt: new Date().toISOString(),
    askMeta,
    personaTools,
  };
}

function findReplayedArtifact(
  journal: Journal,
  id: string,
  kind: "file" | "markdown",
  fingerprint: string,
): { id: string; version: number } | undefined {
  for (const r of journal.all) {
    if (r.kind !== "artifact" || r.id !== id || r.kindOf !== kind) continue;
    if (r.path === fingerprint) return { id, version: r.version };
  }
  return undefined;
}

function declarePreset(journal: Journal, publisher: ArtifactPublisher, id: string, kind: string, spec: Record<string, unknown>): void {
  publisher.declarePreset(id, kind, spec);
  const existing = journal.artifactSpec(id);
  if (!existing || JSON.stringify(existing.spec) !== JSON.stringify(spec)) {
    void journal.append({ kind: "artifact", id, kindOf: kind as never, version: 0, spec });
  }
}
