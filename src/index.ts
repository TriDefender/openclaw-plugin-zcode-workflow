/**
 * openclaw-plugin-zcode-workflow
 *
 * Migrates ZCode's programmatic-constraint workflows (dynamic workflows) into
 * OpenClaw: a TypeScript workflow facade (agent/phase/hole/channel/future/
 * world.run/files/git/report/artifact) executed in a journaled sandbox, driven
 * by the workflow_* tools and the /workflow skill command.
 *
 * Single entry (definePluginEntry) because the dashboard data binding declared
 * in openclaw.plugin.json requires the gateway method `zcode-workflow.dashboard`
 * to be registered by this plugin during register() — tool factories run too
 * late for that validation.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildToolDefs, type ToolContext, type ToolDef, type ToolHostApi } from "./tools.js";
import { listRunSummaries, readRunSnapshot } from "./engine/dashboard.js";
import { resolveOwningAgentId } from "./engine/scope.js";

const contexts = new WeakMap<object, ToolContext>();

function contextFor(api: object): ToolContext {
  let ctx = contexts.get(api);
  if (!ctx) {
    ctx = {
      api: api as unknown as ToolHostApi,
      pendingPlans: new Map(),
      runners: new Map(),
    };
    contexts.set(api, ctx);
  }
  return ctx;
}

function registerDashboardGatewayMethod(hostApi: ToolHostApi): void {
  const host = hostApi as unknown as {
    registerGatewayMethod?: (
      method: string,
      handler: (opts: {
        params: Record<string, unknown>;
        respond: (ok: boolean, payload?: unknown, error?: { message: string }) => void;
      }) => void,
      opts?: { scope?: string },
    ) => void;
  };
  if (typeof host.registerGatewayMethod !== "function") {
    hostApi.logger.warn("zcode-workflow: registerGatewayMethod unavailable; the status dashboard binding will not serve data");
    return;
  }
  host.registerGatewayMethod(
    "zcode-workflow.dashboard",
    async (opts) => {
      const cfg = hostApi.runtime.config.current();
      let agentId: string;
      try {
        agentId = resolveOwningAgentId(cfg, {
          agentId: typeof opts.params.agentId === "string" ? opts.params.agentId : undefined,
          sessionKey: typeof opts.params.sessionKey === "string" ? opts.params.sessionKey : undefined,
        });
      } catch (err) {
        opts.respond(false, undefined, { message: err instanceof Error ? err.message : String(err) });
        return;
      }
      let workspaceDir: string;
      try {
        workspaceDir = hostApi.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
      } catch {
        opts.respond(false, undefined, { message: `cannot resolve workspace for agent "${agentId}"` });
        return;
      }
      const requestedRunId = typeof opts.params.runId === "string" && opts.params.runId ? opts.params.runId : undefined;
      try {
        const summaries = await listRunSummaries(workspaceDir, 10);
        const runId = requestedRunId ?? summaries[0]?.id;
        const snapshot = runId ? ((await readRunSnapshot(workspaceDir, runId)) ?? null) : null;
        opts.respond(true, { ...(snapshot ? { run: snapshot } : {}), runs: summaries });
      } catch (err) {
        opts.respond(false, undefined, { message: err instanceof Error ? err.message : String(err) });
      }
    },
    { scope: "operator.read" },
  );
}

function registerTools(hostApi: ToolHostApi, defs: ToolDef[], ctx: ToolContext): void {
  const api = hostApi as unknown as {
    registerTool: (
      factory: (turn: { agentId?: string; sessionKey?: string; workspaceDir?: string }) => {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => Promise<{
          content: { type: "text"; text: string }[];
          details: Record<string, unknown>;
        }>;
      },
      opts?: { name?: string; workspaceAccess?: "execute" | boolean },
    ) => void;
  };
  for (const def of defs) {
    api.registerTool((turn) => ({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      async execute(_toolCallId, params) {
        const bound: ToolContext = {
          ...ctx,
          session: {
            agentId: typeof turn?.agentId === "string" ? turn.agentId : undefined,
            sessionKey: typeof turn?.sessionKey === "string" ? turn.sessionKey : undefined,
            workspaceDir: typeof turn?.workspaceDir === "string" ? turn.workspaceDir : undefined,
          },
        };
        try {
          return await def.handler(params as Record<string, unknown>, bound);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          hostApi.logger.error(`workflow tool ${def.name} failed: ${message}`);
          return {
            content: [{ type: "text" as const, text: `${def.name} failed: ${message}` }],
            details: { ok: false, error: message },
          };
        }
      },
    }), { name: def.name, workspaceAccess: "execute" });
  }
}

export default definePluginEntry({
  id: "zcode-workflow",
  name: "ZCode Workflow",
  description:
    "ZCode-style dynamic workflows for OpenClaw: typed TS scripts orchestrating subagents with world.run gates, channels, holes and artifacts (/workflow).",
  register(api) {
    const hostApi = api as unknown as ToolHostApi;
    const ctx = contextFor(api);
    // Dashboard binding validation requires the method to exist by the end of register().
    registerDashboardGatewayMethod(hostApi);
    registerTools(hostApi, buildToolDefs(), ctx);
    hostApi.logger.info("zcode-workflow plugin registered: /workflow skill + 13 workflow_* tools + live status dashboard binding");
  },
});
