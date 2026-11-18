/**
 * openclaw-plugin-zcode-workflow
 *
 * Migrates ZCode's programmatic-constraint workflows (dynamic workflows) into
 * OpenClaw: a TypeScript workflow facade (agent/phase/hole/channel/future/
 * world.run/files/git/report/artifact) executed in a journaled sandbox, driven
 * by the workflow_* tools and the /workflow skill command.
 */
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { buildToolDefs, type ToolContext, type ToolHostApi } from "./tools.js";

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

export default defineToolPlugin({
  id: "zcode-workflow",
  name: "ZCode Workflow",
  description:
    "ZCode-style dynamic workflows for OpenClaw: typed TS scripts orchestrating subagents with world.run gates, channels, holes and artifacts (/workflow).",
  tools: (tool) =>
    buildToolDefs().map((def) =>
      tool({
        name: def.name,
        label: def.label,
        description: def.description,
        parameters: def.parameters as never,
        factory(context: { api: object }) {
          const ctx = contextFor(context.api);
          return {
            name: def.name,
            label: def.label,
            description: def.description,
            parameters: def.parameters,
            async execute(_toolCallId: string, params: unknown) {
              try {
                return await def.handler(params as Record<string, unknown>, ctx);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
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
