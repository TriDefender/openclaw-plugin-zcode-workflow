/**
 * openclaw-plugin-zcode-workflow
 *
 * Migrates ZCode's programmatic-constraint workflows (dynamic workflows) into
 * OpenClaw: a TypeScript workflow facade (agent/phase/hole/channel/future/
 * world.run/files/git/report/artifact) executed in a journaled sandbox, driven
 * by the workflow_* tools and the /workflow skill command.
 *
 * The entry is declared with defineToolPlugin so authoring surfaces
 * (`openclaw plugins build` / `validate`, manifest generation, catalogs) can
 * read the static tool metadata stamped on the entry. The dashboard data
 * binding declared in openclaw.plugin.json requires the gateway method
 * `zcode-workflow.dashboard` to exist by the end of register(), so the
 * generated tool register is wrapped (not replaced) to keep that wiring.
 */
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { buildToolDefs, type ToolContext, type ToolHostApi } from "./tools.js";
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
  // Managed instances expose lifecycle.runInBackgroundContext; capture it so
  // background runs detach from the starting turn instead of retaining its
  // (expiring) tool-caller authority. Fallback keeps direct execution for
  // hosts and test harnesses without the capability.
  const runInBackgroundContext = (api as unknown as ToolHostApi).lifecycle?.runInBackgroundContext;
  if (runInBackgroundContext && !ctx.background) {
    ctx.background = (run) => runInBackgroundContext(run);
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

const entry = defineToolPlugin({
  id: "zcode-workflow",
  name: "ZCode Workflow",
  description:
    "ZCode-style dynamic workflows for OpenClaw: typed TS scripts orchestrating subagents with world.run gates, channels, holes and artifacts (/workflow).",
  activation: { onStartup: true },
  tools: (tool) =>
    buildToolDefs().map((def) =>
      tool({
        name: def.name,
        label: def.label,
        description: def.description,
        parameters: def.parameters,
        workspaceAccess: "execute",
        factory: ({ api, toolContext }) => {
          const hostApi = api as unknown as ToolHostApi;
          const ctx = contextFor(api);
          const turn = toolContext as unknown as {
            agentId?: unknown;
            sessionKey?: unknown;
            workspaceDir?: unknown;
          } | undefined;
          return {
            name: def.name,
            label: def.label,
            description: def.description,
            parameters: def.parameters,
            async execute(_toolCallId: string, params: unknown) {
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
          };
        },
      }),
    ),
});

// Authoring metadata carries the static tools; the dashboard gateway method must
// exist by the end of register() for the manifest binding validation, so wrap the
// generated tool register instead of replacing it.
const generatedRegister = entry.register;
entry.register = (api) => {
  const hostApi = api as unknown as ToolHostApi;
  // Dashboard binding validation requires the method to exist by the end of register().
  registerDashboardGatewayMethod(hostApi);
  generatedRegister(api);
  hostApi.logger.info("zcode-workflow plugin registered: /workflow skill + 13 workflow_* tools + live status dashboard binding");
};

export default entry;
