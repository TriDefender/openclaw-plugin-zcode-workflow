/**
 * The model-facing tools. Names and contracts mirror ZCode's workflow tools,
 * prefixed workflow_: create (with a confirm plan), wait, get, list, stop,
 * amend, resume, fill_hole, resolve_question, eval_snippet, save, list_saved.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type TSchema } from "typebox";
import { compileWorkflow } from "./engine/compile.js";
import { Journal } from "./engine/journal.js";
import { RunStore, validateSavedArgs } from "./engine/store.js";
import { WorkflowRunner, type RunnerLogger } from "./engine/runner.js";
import type { SubagentRuntime } from "./engine/agents.js";
import { resolveOwningAgentId } from "./engine/scope.js";
import { WorkflowError } from "./engine/types.js";
import { workflowReportProps, type RunSnapshot } from "./engine/dashboard.js";
import type { PendingQuestion, RunMeta, SavedWorkflowDeclaration } from "./engine/types.js";

/** The slice of OpenClaw's plugin registration API this module uses. */
export interface ToolHostApi {
  runtime: {
    agent: {
      resolveAgentWorkspaceDir(config: unknown, agentId: string): string;
    };
    config: { current(): unknown };
    subagent: SubagentRuntime;
    /**
     * api.runtime.system slice: session-event notification. captureSessionEventTarget
     * binds the originating session at tool-call time; enqueueSessionEvent later admits
     * immediate work into that session (the sanctioned plugin push path — no trust gate,
     * unlike gateway.request/appendAgentMessage which require bundled/trusted-official).
     */
    system?: {
      captureSessionEventTarget?: (agentId: string, sessionKey: string) => Promise<unknown>;
      enqueueSessionEvent?: (
        text: string,
        opts: { agentId: string; sessionKey: string; expectedTarget?: unknown },
      ) => {
        accepted: Promise<{ ok: boolean; error?: string }>;
        settled: Promise<{ status: string; error?: string }>;
        cancel: () => void;
      };
    };
  };
  logger: RunnerLogger;
  /**
   * Managed plugin instances expose lifecycle.runInBackgroundContext: it runs
   * work detached from the calling turn/request async context while keeping the
   * instance's host bindings. Background workflow runs need it so subagent
   * dispatches survive the end of the turn that started them.
   */
  lifecycle?: { runInBackgroundContext?: <T>(run: () => T) => T };
}

export interface ToolContext {
  api: ToolHostApi;
  /** Pending confirmation plans by token. */
  pendingPlans: Map<string, PendingPlan>;
  /** Live runners by workspace directory. */
  runners: Map<string, WorkflowRunner>;
  /** Detached-execution wrapper from api.lifecycle.runInBackgroundContext, when available. */
  background?: (run: () => Promise<void>) => Promise<void>;
  /** Session-bound facts captured by the v2 tool factory for this invocation. */
  session?: { sessionKey?: string; agentId?: string; workspaceDir?: string; assertCurrent?: () => void };
}

interface PendingPlan {
  token: string;
  source: string;
  draftPath: string;
  name: string;
  options: { subagentModel?: string; maxConcurrency?: number };
  savedFrom?: { name: string; args?: Record<string, unknown> };
  createdAt: number;
}

// OpenClaw's Code Mode bridge surfaces only `details` to the calling program,
// while native tool calls read `content`. Mirror the text into both so either
// call path sees the full payload.
const DETAILS_TEXT_CAP = 32 * 1024;

function text(content: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: content }],
    details: { ok: true, text: content.slice(0, DETAILS_TEXT_CAP), ...details },
  };
}

function failure(message: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { ok: false, text: message.slice(0, DETAILS_TEXT_CAP), ...details },
  };
}

function owningAgentId(ctx: ToolContext): string {
  return resolveOwningAgentId(ctx.api.runtime.config.current(), {
    agentId: ctx.session?.agentId,
    sessionKey: ctx.session?.sessionKey,
  });
}

function stampAgent(meta: RunMeta, ctx: ToolContext): void {
  if (!meta.agentId) meta.agentId = owningAgentId(ctx);
}

/**
 * Capture the origin-session event target while this tool call still holds the
 * session's authority, so the background run can push task/settle events back
 * into that session (api.runtime.system.enqueueSessionEvent — the sanctioned
 * plugin push path). Only binds when the run's notify session matches the
 * calling session; never hijacks another session's binding.
 */
async function armSessionNotify(ctx: ToolContext, runner: WorkflowRunner, meta: RunMeta): Promise<boolean> {
  const notifyKey = meta.notify?.sessionKey;
  const sessionKey = ctx.session?.sessionKey;
  const system = ctx.api.runtime.system;
  if (!sessionKey || !notifyKey || notifyKey !== sessionKey) return false;
  if (!system?.captureSessionEventTarget || !system.enqueueSessionEvent) return false;
  const agentId = meta.agentId ?? owningAgentId(ctx);
  try {
    const expectedTarget = await system.captureSessionEventTarget(agentId, sessionKey);
    runner.rememberNotifyTarget(meta.id, { agentId, sessionKey, expectedTarget });
    return true;
  } catch (err) {
    ctx.api.logger.warn(`workflow run ${meta.id}: session notify capture failed: ${(err as Error).message}`);
    return false;
  }
}

function workspaceOf(ctx: ToolContext): string {
  const fromTurn = ctx.session?.workspaceDir?.trim();
  if (fromTurn) return fromTurn;
  return ctx.api.runtime.agent.resolveAgentWorkspaceDir(ctx.api.runtime.config.current(), owningAgentId(ctx));
}

function storeOf(ctx: ToolContext, workspaceDir: string): RunStore {
  return new RunStore(workspaceDir);
}

function runnerOf(ctx: ToolContext, workspaceDir: string): WorkflowRunner {
  let runner = ctx.runners.get(workspaceDir);
  if (!runner) {
    runner = new WorkflowRunner(
      new RunStore(workspaceDir),
      ctx.api.runtime.subagent,
      workspaceDir,
      ctx.api.logger,
      () => ctx.api.runtime.config.current(),
      ctx.background,
      ctx.api.runtime.system,
    );
    ctx.runners.set(workspaceDir, runner);
  }
  return runner;
}

async function readSourceFile(workspaceDir: string, relOrAbs: string): Promise<string> {
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(workspaceDir, relOrAbs);
  return fs.readFile(abs, "utf8");
}

/**
 * Params for the core `dashboard` tool. Third-party plugins cannot call
 * `runtime.gateway.request` (trusted/bundled only), and an HTML widget would
 * load from a loopback-only sandbox origin. `session:report` is drawn by the
 * Control UI itself, so remote clients never touch that port.
 */
function statusCardParams(run: RunSnapshot) {
  return {
    action: "widget_put" as const,
    pluginKind: "session:report" as const,
    name: `zcode-workflow-status-${run.id}`,
    title: `Workflow: ${run.name}`.slice(0, 80),
    props: workflowReportProps(run),
    size: "xl" as const,
  };
}

function statusCardText(run: RunSnapshot): string {
  const dashboardParams = statusCardParams(run);
  return [
    `Call the core dashboard tool NOW with exactly these parameters. It mounts a native session:report card (no iframe, no sandbox port) named ${dashboardParams.name}. Reuse the same name to refresh it.`,
    "",
    "```json",
    JSON.stringify(dashboardParams, null, 2),
    "```",
  ].join("\n");
}

function planText(meta: RunMeta, notes: string[]): string {
  const lines = [
    `Workflow compiled cleanly. Phases (${meta.phases.length}):`,
    ...meta.phases.map((p, i) => `  ${i + 1}. ${p}`),
  ];
  lines.push(meta.commands.length > 0 ? `world.run commands (need approval): ${meta.commands.join(", ")}` : "world.run commands: none");
  if (meta.agentNames.length > 0) lines.push(`Named subagents: ${meta.agentNames.join(", ")}`);
  if (meta.holes.length > 0) lines.push(`Holes: ${meta.holes.map((h) => h.name).join(", ")}`);
  if (notes.length > 0) lines.push(...notes.map((n) => `Note: ${n}`));
  return lines.join("\n");
}

function settleText(meta: RunMeta, reportedCount: number): string {
  const head = `Run ${meta.id} ("${meta.name}") is ${meta.state}.`;
  const parts: string[] = [head];
  if (meta.state === "completed") {
    parts.push(`Result:\n${JSON.stringify(meta.result, null, 2)}`);
  }
  if (meta.state === "errored") parts.push(`Error:\n${meta.error}`);
  if (meta.state === "stopped" && meta.stop) parts.push(`Stopped (${meta.stop.reason})${meta.stop.detail ? `: ${meta.stop.detail}` : ""}`);
  if (meta.state === "waiting_hole" && meta.pendingHole) {
    parts.push(`Waiting at hole ${meta.pendingHole.id} "${meta.pendingHole.name}" <${meta.pendingHole.typeName}>.`);
    parts.push(`Prompt: ${meta.pendingHole.prompt}`);
    parts.push(`Fill it with workflow_fill_hole.`);
  }
  if (meta.state === "waiting_question" && meta.pendingQuestions.length > 0) {
    for (const q of meta.pendingQuestions) {
      parts.push(`Subagent "${q.agentName ?? "anonymous"}" asks (${q.id}): ${q.question}`);
      if (q.evidence) parts.push(`Evidence: ${q.evidence}`);
    }
    parts.push(`Answer with workflow_resolve_question.`);
  }
  parts.push(`${reportedCount} reported item(s).`);
  return parts.join("\n");
}

async function loadRun(store: RunStore, runId: string): Promise<RunMeta> {
  const meta = await store.loadMeta(runId);
  if (!meta) throw new WorkflowError(`no workflow run "${runId}" (workflow_list lists them)`, "not_found");
  return meta;
}

const TERMINAL_STATES = new Set(["completed", "errored", "stopped", "waiting_hole", "waiting_question", "superseded"]);

export interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  handler: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ReturnType<typeof text>>;
}

/** Static tool metadata + handlers; handlers receive their context so the list is built before any api exists. */
export function buildToolDefs(): ToolDef[] {
  const tools: ToolDef[] = [];

  const tool = (def: ToolDef) => {
    tools.push(def);
  };

  // ---- workflow_create ----
  tool({
    name: "workflow_create",
    label: "Create Workflow",
    description:
      "Typecheck a workflow script against the workflow facade and (after your confirmation) start it in the background. Sources (exactly one): script (inline statements), path (workspace-relative file), or saved {name, args}. First call without confirm returns the compiled plan (phases, world.run commands, subagents) plus a confirm token — present the plan to the user, then call again with confirm: true and that token. Load the /workflow skill before using this tool.",
    parameters: Type.Object({
      script: Type.Optional(Type.String({ description: "Workflow script inline: plain TypeScript statements, top-level await, final return allowed." })),
      path: Type.Optional(Type.String({ description: "Workspace-relative or absolute path to the script file (normally the file a previous result named)." })),
      saved: Type.Optional(Type.Object({
        name: Type.String({ description: "Saved workflow name (workflow_list_saved lists them)." }),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for the saved workflow's declaration." })),
      })),
      name: Type.Optional(Type.String({ description: "Short run label in the user's language, e.g. \"PR review\" / \"代码评审\"." })),
      confirm: Type.Optional(Type.Boolean({ description: "true to start the run whose plan token you hold." })),
      token: Type.Optional(Type.String({ description: "The plan token from the previous call." })),
      max_concurrency: Type.Optional(Type.Number({ description: "Upper bound on concurrent subagent asks. Omit to use the configured OpenClaw subagent lane (maxConcurrent and maxChildrenPerAgent). A number cannot exceed that lane." })),
      subagent_model: Type.Optional(Type.String({ description: "providerId/modelId or bare model id for subagents. Set only when the user asks." })),
      notify: Type.Optional(Type.Boolean({ description: "true: push task/settle events back to the originating session via session events — each completed subagent task (and the final state) wakes that session to refresh the status card. Default off." })),
    }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const sources = [params.script, params.path, params.saved].filter(Boolean).length;
      if (sources !== 1) {
        return failure("Pass exactly one source: script, path, or saved.");
      }

      // confirm branch: start the planned run
      if (params.confirm === true) {
        const token = String(params.token ?? "");
        const plan = ctx.pendingPlans.get(token);
        if (!plan) return failure("Unknown or expired plan token. Call workflow_create again without confirm to recompile.");
        ctx.pendingPlans.delete(token);
        const meta: RunMeta = {
          id: store.newRunId(),
          agentId: owningAgentId(ctx),
          name: plan.name,
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          scriptPath: plan.draftPath,
          effectiveScriptHash: crypto.createHash("sha256").update(plan.source).digest("hex"),
          subagentModel: plan.options.subagentModel,
          maxConcurrency: plan.options.maxConcurrency,
          phases: [],
          commands: [],
          agentNames: [],
          holes: [],
          pendingQuestions: [],
          fills: {},
          savedFrom: plan.savedFrom,
        };
        if (params.notify === true) {
          if (ctx.session?.sessionKey) {
            meta.notify = { sessionKey: ctx.session.sessionKey };
          } else {
            ctx.api.logger.warn("workflow_create notify:true but the calling session key is unavailable; notifications disabled for this run.");
          }
        }
        await armSessionNotify(ctx, runnerOf(ctx, workspaceDir), meta);
        await store.saveMeta(meta);
        await store.writeScript(meta.id, plan.source);
        runnerOf(ctx, workspaceDir).start(meta);
        const notifyArmed = runnerOf(ctx, workspaceDir).notifyTargetFor(meta.id) !== undefined;
        return text(
          [
            `Run started: ${meta.id} ("${meta.name}").`,
            `Script: ${plan.draftPath}`,
            notifyArmed
              ? `Session notify: armed — each completed task and the final state will wake this session to refresh the card.`
              : undefined,
            `Wait for it with workflow_wait { run_id: "${meta.id}" }; snapshot anytime with workflow_get. Do not poll in a loop.`,
            `Before waiting, mount a status card: call workflow_dashboard { run_id: "${meta.id}" } and immediately pass its JSON to the core dashboard tool (widget_put, pluginKind session:report — refresh it by re-applying after each workflow_wait). For an unattended background run, call it with watch: true instead and also apply the returned automations add params so a watcher refreshes the card for you. Default to the native card: live:true renders an HTML panel in the mcp-app-sandbox iframe on sandboxPort, which remote/reverse-proxied browsers usually cannot reach (ERR_CONNECTION_REFUSED); use live:true only when the sandbox port is known reachable.`, 
          ].join("\n"),
          { runId: meta.id },
        );
      }

      // compile branch
      let source: string;
      let draftPath: string;
      let savedFrom: { name: string; args?: Record<string, unknown> } | undefined;
      const name = typeof params.name === "string" && params.name.trim().length > 0 ? params.name.trim() : "workflow";

      if (params.saved) {
        const savedName = String((params.saved as Record<string, unknown>).name ?? "");
        const saved = await store.loadSaved(savedName);
        const args = validateSavedArgs(saved.decl, (params.saved as Record<string, unknown>).args as Record<string, unknown> | undefined);
        source = saved.script;
        draftPath = saved.path;
        savedFrom = { name: saved.decl.name, args };
      } else if (params.path) {
        draftPath = String(params.path);
        source = await readSourceFile(workspaceDir, draftPath);
        const abs = path.isAbsolute(draftPath) ? draftPath : path.resolve(workspaceDir, draftPath);
        draftPath = path.relative(workspaceDir, abs);
      } else {
        source = String(params.script ?? "");
        draftPath = await store.writeDraft(name, source);
      }

      const compiled = compileWorkflow({ scriptPath: draftPath, source });
      if (!compiled.ok) {
        const diags = compiled.diagnostics.map((d) => `${d.path}:L${d.line}:C${d.column} ${d.message}`).join("\n");
        return failure(`Compilation failed (nothing ran). Edit ${draftPath} and resubmit with path — do not paste the script again:\n${diags}`, {
          draftPath,
        });
      }
      const meta: RunMeta = {
        id: "plan",
        name,
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        scriptPath: draftPath,
        effectiveScriptHash: "",
        phases: compiled.meta!.phases,
        commands: compiled.meta!.commands,
        agentNames: compiled.meta!.agentNames,
        holes: compiled.meta!.holes,
        pendingQuestions: [],
        fills: {},
      };
      const token = crypto.randomBytes(8).toString("hex");
      for (const [k, p] of ctx.pendingPlans) {
        if (Date.now() - p.createdAt > 30 * 60_000) ctx.pendingPlans.delete(k);
      }
      ctx.pendingPlans.set(token, {
        token,
        source,
        draftPath,
        name,
        options: {
          subagentModel: typeof params.subagent_model === "string" ? params.subagent_model : undefined,
          maxConcurrency: typeof params.max_concurrency === "number" ? params.max_concurrency : undefined,
        },
        savedFrom,
        createdAt: Date.now(),
      });
      const planLines = [planText(meta, compiled.meta!.notes), "", `Present this plan to the user, then start the run with confirm: true and token: ${token}.`];
      return text(planLines.join("\n"), { token, draftPath });
    },
  });

  // ---- workflow_wait ----
  tool({
    name: "workflow_wait",
    label: "Wait for Workflow",
    description: "Block until a run this session started settles (completed/errored/stopped/waiting_hole/waiting_question), or the timeout passes. Returns the final result and reported items. When it returns, refresh the status card: a live panel needs nothing (it self-refreshes); a static session:report card needs workflow_dashboard + the core dashboard tool again.",
    parameters: Type.Object({
      run_id: Type.String({ description: "Run id from workflow_create." }),
      timeout_ms: Type.Optional(Type.Number({ description: "Wait budget in ms; default 300000, max 1800000." })),
    }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const runId = String(params.run_id ?? "");
      const timeoutMs = Math.min(Math.max(2000, Number(params.timeout_ms ?? 300_000)), 1_800_000);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const meta = await loadRun(store, runId);
        if (TERMINAL_STATES.has(meta.state)) {
          const journal = await Journal.open(path.join(store.runDir(runId), "journal.jsonl"));
          return text(
            [
              settleText(meta, journal.reportedItems().length),
              "",
              `Refresh the native status card with workflow_dashboard { run_id: "${runId}" }, then call dashboard with the returned params.`,
            ].join("\n"),
          );
        }
        if (Date.now() >= deadline) {
          return text(
            `Run ${runId} is still ${meta.state} after ${timeoutMs}ms. Call workflow_wait again later, or workflow_dashboard { run_id: "${runId}" } and apply its dashboard params to refresh the native card.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    },
  });

  // ---- workflow_get ----
  tool({
    name: "workflow_get",
    label: "Get Workflow Run",
    description: "Instant snapshot of a run: state, phases, scriptPath, pending questions and holes, reported items, logs tail. Use when you must not block.",
    parameters: Type.Object({
      run_id: Type.String(),
      include_logs: Type.Optional(Type.Boolean({ description: "Include the last log lines (default true)." })),
    }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const meta = await loadRun(store, String(params.run_id ?? ""));
      const journal = await Journal.open(path.join(store.runDir(meta.id), "journal.jsonl"));
      const reported = journal.reportedItems();
      const lines = [
        settleText(meta, reported.length),
        `Script: ${meta.scriptPath}`,
        `Phases: ${meta.phases.join(" → ")}`,
      ];
      if (reported.length > 0) {
        lines.push("Reported items:", ...reported.slice(-10).map((r) => `- ${JSON.stringify(r.item).slice(0, 300)}${r.artifactId ? ` (→ ${r.artifactId})` : ""}`));
      }
      if (params.include_logs !== false) {
        const logs = journal.logs().slice(-15);
        if (logs.length > 0) lines.push("Logs:", ...logs.map((l) => `- ${l.message.slice(0, 200)}`));
      }
      if (meta.primaryArtifact) lines.push(`Primary artifact: ${meta.primaryArtifact} (under .zcode-workflow/artifacts/${meta.id}/)`);
      return text(lines.join("\n"));
    },
  });

  // ---- workflow_list ----
  tool({
    name: "workflow_list",
    label: "List Workflow Runs",
    description: "Enumerate this workspace's workflow runs, newest first, with state and phase graph.",
    parameters: Type.Object({}),
    handler: async (_params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const runs = await store.listRuns();
      if (runs.length === 0) return text("No workflow runs in this workspace yet.");
      const lines = runs.map((r) => `- ${r.id} "${r.name}" [${r.state}] phases: ${r.phases.join(" → ") || "(none)"}`);
      return text(lines.join("\n"));
    },
  });

  // ---- workflow_stop ----
  tool({
    name: "workflow_stop",
    label: "Stop Workflow Run",
    description: "Stop a run. reason: user (the user asked — leave it alone afterwards) or model (you decided it is wrong). Reported items survive.",
    parameters: Type.Object({
      run_id: Type.String(),
      reason: Type.Optional(Type.String({ description: '"user" or "model" (default "model").' })),
    }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const runner = runnerOf(ctx, workspaceDir);
      const meta = await loadRun(store, String(params.run_id ?? ""));
      if (meta.state === "superseded") return failure(`Run ${meta.id} was already superseded.`);
      if (meta.state === "completed") return failure(`Run ${meta.id} already completed.`);
      const reason = params.reason === "user" ? "user" : "model";
      const wasLive = runner.stop(meta.id, reason);
      if (!wasLive) {
        meta.state = "stopped";
        meta.stop = { reason, at: new Date().toISOString() };
        meta.updatedAt = new Date().toISOString();
        await store.saveMeta(meta);
      }
      return text(`Run ${meta.id} stop requested (${reason}).`);
    },
  });

  // ---- workflow_amend ----
  tool({
    name: "workflow_amend",
    label: "Amend Workflow Run",
    description:
      "Revise an existing run (any state, even running): edit the run's script file and pass its path. Starts a new run that supersedes the old one and imports its finished work as a cache, so only what changed runs again. Omit both script and path to change only settings.",
    parameters: Type.Object({
      run_id: Type.String(),
      path: Type.Optional(Type.String({ description: "Script file path; normally the run's own scriptPath after an Edit." })),
      script: Type.Optional(Type.String({ description: "Whole revised script inline (prefer path)." })),
      name: Type.Optional(Type.String()),
      max_concurrency: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      subagent_model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const runner = runnerOf(ctx, workspaceDir);
      const old = await loadRun(store, String(params.run_id ?? ""));

      let newSource: string | undefined;
      let scriptPath: string;
      if (params.script !== undefined) {
        newSource = String(params.script);
        scriptPath = await store.writeDraft(typeof params.name === "string" ? params.name : old.name, newSource);
      } else if (params.path !== undefined) {
        scriptPath = String(params.path);
        newSource = await readSourceFile(workspaceDir, scriptPath);
        const abs = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(workspaceDir, scriptPath);
        scriptPath = path.relative(workspaceDir, abs);
      } else {
        newSource = await store.readScript(old.id);
        scriptPath = old.scriptPath;
      }

      const settingsChanged =
        (params.max_concurrency !== undefined && params.max_concurrency !== old.maxConcurrency) ||
        (params.subagent_model !== undefined && params.subagent_model !== old.subagentModel);

      const unchangedScript = newSource === (await store.readScript(old.id).catch(() => ""));
      if (unchangedScript && !settingsChanged && old.state === "completed") {
        return failure(
          "script_unchanged: this run already completed with these exact bytes and settings, so an amend would replay its whole journal and change nothing. Rerun fresh with workflow_create from its scriptPath, or edit the script / change a setting first.",
        );
      }

      const newId = store.newRunId();
      // seed the new journal with the predecessor's records (the cache)
      const oldJournalFile = path.join(store.runDir(old.id), "journal.jsonl");
      const newJournalFile = path.join(store.runDir(newId), "journal.jsonl");
      await fs.mkdir(path.dirname(newJournalFile), { recursive: true });
      try {
        await fs.copyFile(oldJournalFile, newJournalFile);
      } catch {
        // no predecessor journal — fresh run
      }

      const meta: RunMeta = {
        ...old,
        id: newId,
        name: typeof params.name === "string" && params.name.trim() ? params.name.trim() : old.name,
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        supersededFrom: old.id,
        scriptPath,
        effectiveScriptHash: crypto.createHash("sha256").update(newSource).digest("hex"),
        subagentModel: params.subagent_model === null ? undefined : (params.subagent_model as string | undefined) ?? old.subagentModel,
        maxConcurrency: params.max_concurrency === null ? undefined : (params.max_concurrency as number | undefined) ?? old.maxConcurrency,
        stop: undefined,
        error: undefined,
        result: undefined,
        pendingHole: undefined,
        pendingQuestions: [],
        fills: old.fills,
        savedFrom: old.savedFrom,
      };
      stampAgent(meta, ctx);
      await armSessionNotify(ctx, runner, meta);

      // stop the predecessor if it is live
      runner.stop(old.id, "model");
      old.state = "superseded";
      old.updatedAt = new Date().toISOString();
      await store.saveMeta(old);

      const compiled = compileWorkflow({ scriptPath, source: newSource, fills: meta.fills });
      if (!compiled.ok) {
        meta.state = "errored";
        meta.error = `script no longer compiles:\n${compiled.diagnostics.map((d) => `${d.path}:L${d.line}:C${d.column} ${d.message}`).join("\n")}`;
        await store.saveMeta(meta);
        return failure(`Amendment compiles failed — the predecessor was superseded but the new script has diagnostics. Fix ${scriptPath} and amend run ${newId}:\n${meta.error}`, { newRunId: newId });
      }

      await store.saveMeta(meta);
      await store.writeScript(newId, newSource);
      runner.start(meta);
      return text(
        `Amended: run ${newId} ("${meta.name}") supersedes ${old.id} and imports its finished work. Wait with workflow_wait { run_id: "${newId}" }.` +
        (unchangedScript ? ' Note: the script bytes are unchanged — this is a restart that settles finished phases from the imported journal and re-runs the rest.' : ""),
        { newRunId: newId, superseded: old.id },
      );
    },
  });

  // ---- workflow_resume ----
  tool({
    name: "workflow_resume",
    label: "Resume Workflow Run",
    description: "Resume a stopped or interrupted run unchanged; its journal replays everything that settled. Runs waiting at a hole or question are resumed after their fill/answer.",
    parameters: Type.Object({ run_id: Type.String() }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const runner = runnerOf(ctx, workspaceDir);
      const meta = await loadRun(store, String(params.run_id ?? ""));
      if (runner.isLive(meta.id)) return failure(`Run ${meta.id} is already running.`);
      if (meta.state === "completed") return failure(`Run ${meta.id} completed; to change it, workflow_amend.`);
      if (meta.state === "errored") {
        return failure(`Run ${meta.id} errored (${meta.error ?? "unknown"}); replaying would fail the same way. Edit ${meta.scriptPath} and workflow_amend — for a transient failure the unchanged script is fine: an amend imports the finished work and only re-runs the rest.`);
      }
      if (meta.state === "waiting_hole") return failure(`Run ${meta.id} is waiting at hole ${meta.pendingHole?.id ?? "?"}; fill it with workflow_fill_hole.`);
      if (meta.state === "waiting_question") return failure(`Run ${meta.id} is waiting on ${meta.pendingQuestions.length} question(s); answer with workflow_resolve_question.`);
      if (meta.state === "superseded") return failure(`Run ${meta.id} was superseded.`);
      stampAgent(meta, ctx);
      await armSessionNotify(ctx, runner, meta);
      meta.state = "running";
      meta.updatedAt = new Date().toISOString();
      await store.saveMeta(meta);
      runner.start(meta);
      return text(`Run ${meta.id} resumed; wait with workflow_wait.`);
    },
  });

  // ---- workflow_fill_hole ----
  tool({
    name: "workflow_fill_hole",
    label: "Fill Workflow Hole",
    description:
      "Write the body of a hole a run is waiting at. The body is statements only (no hole(...) call, no arrow), sees the bindings declared before the hole, and returns a value of the hole's type — or ends in a new tail hole. Compile-checked in place before anything runs.",
    parameters: Type.Object({
      run_id: Type.String(),
      hole_id: Type.String({ description: 'Site id (hole#xxxxxxxx) or the hole name.' }),
      script: Type.Optional(Type.String({ description: "The fill statements inline." })),
      path: Type.Optional(Type.String({ description: "Workspace-relative path to a file holding the statements." })),
    }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const runner = runnerOf(ctx, workspaceDir);
      const meta = await loadRun(store, String(params.run_id ?? ""));
      if (meta.state !== "waiting_hole" || !meta.pendingHole) {
        return failure(`Run ${meta.id} is ${meta.state}, not waiting at a hole (hole_not_waiting).`);
      }
      const wanted = String(params.hole_id ?? "");
      const hole = meta.holes.find((h) => h.id === wanted || h.name === wanted) ?? (meta.pendingHole.name === wanted || meta.pendingHole.id === wanted ? { name: meta.pendingHole.name, id: meta.pendingHole.id, typeName: meta.pendingHole.typeName, prompt: meta.pendingHole.prompt, hasBody: false } : undefined);
      if (!hole) return failure(`No hole "${wanted}" in run ${meta.id}.`);
      if (params.script === undefined && params.path === undefined) return failure("Pass script or path.");
      let source: string;
      let fillPath: string | undefined;
      if (params.path !== undefined) {
        source = await readSourceFile(workspaceDir, String(params.path));
        fillPath = String(params.path);
      } else {
        source = String(params.script);
      }

      const nextFills = { ...meta.fills, [hole.name]: source };
      const scriptSource = await store.readScript(meta.id);
      const compiled = compileWorkflow({ scriptPath: meta.scriptPath, source: scriptSource, fills: nextFills });
      if (!compiled.ok) {
        const diags = compiled.diagnostics.map((d) => `${d.path}:L${d.line}:C${d.column} ${d.message}`).join("\n");
        if (!fillPath && params.script !== undefined) {
          fillPath = await store.writeDraft(`fill-${hole.name}`, source);
        }
        return failure(`Fill diagnostics (nothing was spliced, the hole still waits). Edit ${fillPath} and resubmit with path:\n${diags}`, { fillPath });
      }

      await store.saveFill(meta.id, hole.name, source);
      stampAgent(meta, ctx);
      meta.fills = nextFills;
      meta.state = "running";
      meta.pendingHole = undefined;
      meta.updatedAt = new Date().toISOString();
      await store.writeScript(meta.id, scriptSource);
      await store.saveMeta(meta);
      runner.start(meta);
      return text(`Hole "${hole.name}" filled; run ${meta.id} continues (earlier work replays from its journal). Added phases: ${compiled.meta!.phases.join(" → ")}`);
    },
  });

  // ---- workflow_resolve_question ----
  tool({
    name: "workflow_resolve_question",
    label: "Resolve Workflow Question",
    description: "Answer a subagent's escalated question (dwfq-... id). Your text is delivered into the subagent's session as the answer to its ask, then the run resumes.",
    parameters: Type.Object({
      question_id: Type.String({ description: "The dwfq-... id from the notification or workflow_get." }),
      answer: Type.String({ description: "Your answer, verbatim." }),
    }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const runner = runnerOf(ctx, workspaceDir);
      const questionId = String(params.question_id ?? "");
      // find the run owning this question
      const runs = await store.listRuns();
      const owner = runs.find((r) => r.pendingQuestions.some((q) => q.id === questionId));
      if (!owner) return failure(`No pending question "${questionId}". workflow_get lists a run's pendingQuestions.`);
      const question = owner.pendingQuestions.find((q) => q.id === questionId)!;
      stampAgent(owner, ctx);
      await runner.resolveQuestion(owner, question, String(params.answer ?? ""));
      runner.start(owner);
      return text(`Answer delivered to "${question.agentName ?? "anonymous"}"; run ${owner.id} continues. Wait with workflow_wait.`);
    },
  });

  // ---- workflow_eval_snippet ----
  tool({
    name: "workflow_eval_snippet",
    label: "Eval Workflow Snippet",
    description:
      "Compile and run a small snippet synchronously against the snippet facade (args, run, log, files, git, world.run, channel, future — no agent/phase/hole/report/artifact). Nothing persists. For testing globs, greps, gates and output parsing before committing them to a workflow. Note: world.run executes for real.",
    parameters: Type.Object({
      code: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      timeout_ms: Type.Optional(Type.Number({ description: "Default 60000, max 600000." })),
    }),
    handler: async (params, ctx) => {
      if (params.code === undefined && params.path === undefined) return failure("Pass code or path.");
      const workspaceDir = workspaceOf(ctx);
      const source = params.path !== undefined ? await readSourceFile(workspaceDir, String(params.path)) : String(params.code);
      const scriptPath = params.path !== undefined ? String(params.path) : "snippet.ts";
      const timeoutMs = Math.min(Math.max(1000, Number(params.timeout_ms ?? 60_000)), 600_000);
      const runner = runnerOf(ctx, workspaceDir);
      try {
        const { logs, result } = await runner.evalSnippet(source, scriptPath, timeoutMs);
        const serialized = JSON.stringify(result, null, 2);
        if (serialized && serialized.length > 256 * 1024) {
          return failure("Snippet result over 256KB; return a summary, not a dump.");
        }
        const lines = [
          logs.length > 0 ? "Logs:\n" + logs.map((l) => `- ${l}`).join("\n") : "No logs.",
          "",
          `Result:\n${serialized}`,
        ];
        return text(lines.join("\n"));
      } catch (err) {
        if (err instanceof WorkflowError) return failure(err.message);
        return failure(`Snippet failed: ${(err as Error).message}`);
      }
    },
  });

  // ---- workflow_save ----
  tool({
    name: "workflow_save",
    label: "Save Workflow",
    description:
      "Save a script with metadata so it can be rerun by name via workflow_create {saved:{name}}. Call only after the user agrees. Project-scope definitions land in .zcode-workflow/saved/<name>.dwf.ts.",
    parameters: Type.Object({
      name: Type.String({ description: "File-safe identifier: letters, digits, dot, dash, underscore." }),
      description: Type.String({ description: "One or two sentences, for a reader who has not seen this conversation." }),
      when_to_use: Type.Optional(Type.String()),
      scope: Type.String({ description: '"project" or "global" (project when the script references this repository).' }),
      script: Type.Optional(Type.String({ description: "Script body only (no metadata block)." })),
      script_path: Type.Optional(Type.String({ description: "Draft path a create/amend result named; its metadata block is dropped." })),
      args: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        type: Type.String({ description: '"string" | "number" | "boolean" | "json".' }),
        description: Type.Optional(Type.String()),
        required: Type.Optional(Type.Boolean()),
        default: Type.Optional(Type.Unknown()),
      }))),
    }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      if (params.script === undefined && params.script_path === undefined) return failure("Pass script or script_path.");
      let script = params.script as string;
      if (params.script_path !== undefined) {
        const raw = await readSourceFile(workspaceDir, String(params.script_path));
        script = raw.replace(/^\/\* zcode-workflow[\s\S]*?\*\/\s*/, "");
      }
      const compiled = compileWorkflow({ scriptPath: `saved/${params.name}.dwf.ts`, source: script });
      if (!compiled.ok) {
        return failure(`Diagnostics mean nothing was written:\n${compiled.diagnostics.map((d) => `${d.path}:L${d.line}:C${d.column} ${d.message}`).join("\n")}`);
      }
      const decl: SavedWorkflowDeclaration = {
        name: String(params.name ?? ""),
        description: String(params.description ?? ""),
        whenToUse: params.when_to_use !== undefined ? String(params.when_to_use) : undefined,
        scope: params.scope === "global" ? "global" : "project",
        args: (params.args as SavedWorkflowDeclaration["args"]) ?? undefined,
      };
      const savedPath = await store.saveWorkflow(decl, script);
      return text(`Saved workflow "${decl.name}" to ${savedPath}. Run it with workflow_create { saved: { name: "${decl.name}" } }.`);
    },
  });

  // ---- workflow_list_saved ----
  tool({
    name: "workflow_list_saved",
    label: "List Saved Workflows",
    description: "List saved workflow definitions in this workspace with their declared arguments. Check this before writing a script from scratch.",
    parameters: Type.Object({}),
    handler: async (_params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      const saved = await store.listSaved();
      if (saved.length === 0) return text("No saved workflows yet.");
      const lines = saved.map((s) => {
        const args = s.decl.args && s.decl.args.length > 0 ? ` — args: ${s.decl.args.map((a) => `${a.name}:${a.type}${a.required ? "!" : ""}`).join(", ")}` : "";
        return `- ${s.decl.name} (${s.path}): ${s.decl.description}${args}`;
      });
      return text(lines.join("\n"));
    },
  });

  // ---- workflow_dashboard (live panel via data binding, or static session:report card) ----
  tool({
    name: "workflow_dashboard",
    label: "Workflow Status Dashboard",
    description:
      "Status surface for a workflow run. Default: core dashboard widget_put parameters for a native session:report card — a static snapshot that updates only when you re-apply it (call the dashboard tool with the returned JSON in the same turn; reuse the same widget name). Use live: true on a Control UI session instead: it returns show_widget parameters for a self-refreshing panel (2.5s poll of the zcode-workflow.runs binding) that follows the background run with no further turns. CAUTION: the live panel renders inside the mcp-app-sandbox iframe on sandboxPort; when the viewer's browser cannot reach that port (tailscale serve / reverse proxies usually forward only the main gateway port), the frame stays dead with ERR_CONNECTION_REFUSED — prefer the default native card there. The live path also needs show_widget plus the binding grant; chat-only surfaces should use the default card. For an unattended background run on the native card, pass watch: true: the text then also contains ready-to-apply automations add parameters for a recurring session watcher that re-pushes the card until the run settles (the plugin itself cannot wake sessions or push cards — OpenClaw only lets bundled/trusted-official plugins do that; the agent-owned watcher is the sanctioned bridge).",
    parameters: Type.Object({
      run_id: Type.Optional(Type.String({ description: "Run id; omitted = the most recent run in this workspace." })),
      live: Type.Optional(Type.Boolean({ description: "true: return show_widget params for the self-refreshing Control UI panel instead of the static session:report card." })),
      watch: Type.Optional(Type.Boolean({ description: "true (native card): also return ready-to-apply automations add parameters for a recurring watcher that wakes this session to re-push the card until the run settles." })),
      watchMinutes: Type.Optional(Type.Number({ description: "Watcher cadence in minutes for watch:true (default 5, clamped 2-60)." })),
    }),
    handler: async (params, ctx) => {
      const workspaceDir = workspaceOf(ctx);
      const store = storeOf(ctx, workspaceDir);
      let runId = params.run_id !== undefined ? String(params.run_id) : undefined;
      if (!runId) {
        const runs = await store.listRuns();
        if (runs.length === 0) return failure("No workflow runs in this workspace yet.");
        runId = runs[0]!.id;
      }
      const meta = await loadRun(store, runId);
      if (params.live === true) {
        const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "workflow", "dashboard.html");
        let template: string;
        try {
          template = await fs.readFile(templatePath, "utf8");
        } catch {
          return failure(`Live dashboard template missing at ${templatePath}; use the default session:report card instead.`);
        }
        const widgetCode = template.split("__RUN_ID__").join(runId);
        const widgetParams = {
          title: `Workflow: ${meta.name}`.slice(0, 80),
          name: `zcode-workflow-live-${runId}`.slice(0, 80),
          pin: true,
          size: "md" as const,
          capabilities: { tools: ["zcode-workflow.runs"] },
          widget_code: widgetCode,
        };
        const lines = [
          `Call show_widget now with EXACTLY these parameters (pin: true mounts it on the session dashboard; the panel then self-refreshes every 2.5s from the zcode-workflow.runs binding, no further turns needed):`,
          "",
          "```json",
          JSON.stringify(widgetParams, null, 2),
          "```",
        ];
        return text(lines.join("\n"), { runId, widgetParams });
      }
      const { snapshotRun } = await import("./engine/dashboard.js");
      const run = await snapshotRun(workspaceDir, meta.id);
      if (!run) return failure(`No snapshot for run ${meta.id}.`);
      const dashboardParams = statusCardParams(run);
      if (params.watch === true) {
        const minutes = Math.max(2, Math.min(60, Math.round(Number(params.watchMinutes ?? 5))));
        const jobName = `zcode-workflow-watch-${runId}`.slice(0, 80);
        const watchMessage = [
          `[zcode-workflow watch] run ${runId}（${meta.name}）定时检查：`,
          `1) workflow_get {run_id:"${runId}"} 取快照；`,
          `2) workflow_dashboard {run_id:"${runId}"}，把返回 text 里第一个 \`\`\`json 块原样传给 dashboard 工具（widget_put，同名卡片刷新）；`,
          `3) state 为 completed/errored/stopped：刷新终态卡片后用一句话向用户报告结论或错误，然后 automations {action:"remove", jobId:"本任务id"}（先 automations {action:"list"} 找到 id）；`,
          `4) state 为 waiting_hole/waiting_question：一句话说明待填/待答项；`,
          `5) 仍在 running：阶段有进展只回一行进度，无进展只回复 …。`,
        ].join("\n");
        const watchJob = {
          name: jobName,
          description: `Refresh the workflow status card for run ${runId} every ${minutes} min until it settles, then report and self-remove.`,
          schedule: { kind: "every", everyMs: minutes * 60_000 },
          sessionTarget: "current",
          payload: { kind: "agentTurn", message: watchMessage },
          deleteAfterRun: false,
        };
        const lines = [
          statusCardText(run),
          "",
          `Then mount the watcher with ONE automations call — pass this whole object to automations as {action:"add"} (it wakes this session every ${minutes} min to re-push the card; the watcher removes itself on settle):`,
          "```json",
          JSON.stringify({ action: "add", job: watchJob }, null, 2),
          "```",
        ];
        return text(lines.join("\n"), { dashboardParams, watchJob });
      }
      return text(statusCardText(run), { dashboardParams });
    },
  });

  return tools;
}

/** Bound form used by tests: execute(params) with a fixed context. */
export function createTools(ctx: ToolContext) {
  return buildToolDefs().map((def) => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute: (params: Record<string, unknown>) => def.handler(params, ctx),
  }));
}

export type { PendingQuestion };
