/**
 * Owning agent and the OpenClaw subagent lane.
 *
 * Session keys use the native `agent:<agentId>:subagent:` shape so the child
 * stays out of the sidebar. Agent ids come from the calling turn, an explicit
 * dashboard param, or OpenClaw's configured default — never a literal agent name.
 *
 * Ask parallelism reads `agents.defaults.subagents.maxConcurrent` and
 * `maxChildrenPerAgent`, with a per-agent `subagents` override winning.
 * OpenClaw queues above maxConcurrent and refuses a child past
 * maxChildrenPerAgent, so the plugin cap is the tighter of the two.
 */
import { resolveAgentConfig, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";

type AgentConfig = Parameters<typeof resolveDefaultAgentId>[0];

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_CHILDREN = 5;

export function agentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const match = /^agent:([^:]+):/i.exec(sessionKey.trim());
  const id = match?.[1]?.trim();
  return id ? id : undefined;
}

/** The agent that owns this call. Throws when OpenClaw itself requires an explicit choice. */
export function resolveOwningAgentId(
  cfg: unknown,
  hints: { agentId?: string; sessionKey?: string },
): string {
  const explicit = hints.agentId?.trim();
  if (explicit) return explicit;
  const fromKey = agentIdFromSessionKey(hints.sessionKey);
  if (fromKey) return fromKey;
  return resolveDefaultAgentId(cfg as AgentConfig);
}

type SubagentLimitFields = { maxConcurrent?: number; maxChildrenPerAgent?: number };

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 1 ? n : undefined;
}

function defaultsSubagents(cfg: unknown): SubagentLimitFields {
  if (!cfg || typeof cfg !== "object") return {};
  const agents = (cfg as { agents?: { defaults?: { subagents?: SubagentLimitFields } } }).agents;
  return agents?.defaults?.subagents ?? {};
}

export function readSubagentLimits(
  cfg: unknown,
  agentId: string,
): { maxConcurrent: number; maxChildrenPerAgent: number } {
  const entry = resolveAgentConfig(cfg as AgentConfig, agentId)?.subagents as SubagentLimitFields | undefined;
  const defaults = defaultsSubagents(cfg);
  const maxConcurrent =
    positiveInt(entry?.maxConcurrent) ?? positiveInt(defaults.maxConcurrent) ?? DEFAULT_MAX_CONCURRENT;
  const rawChildren =
    positiveInt(entry?.maxChildrenPerAgent) ?? positiveInt(defaults.maxChildrenPerAgent) ?? DEFAULT_MAX_CHILDREN;
  return { maxConcurrent, maxChildrenPerAgent: Math.min(20, rawChildren) };
}

/**
 * How many asks this plugin runs at once. A workflow cap can only go lower
 * than the configured lane.
 */
export function resolveAskConcurrency(cfg: unknown, agentId: string, workflowCap: number | undefined): number {
  const limits = readSubagentLimits(cfg, agentId);
  const lane = Math.max(1, Math.min(limits.maxConcurrent, limits.maxChildrenPerAgent));
  const cap = positiveInt(workflowCap);
  return cap === undefined ? lane : Math.min(cap, lane);
}

/** Native hidden-subagent key. Same key on a later ask continues that child. */
export function subagentSessionKey(
  agentId: string,
  runId: string,
  agentName: string | undefined,
  ordinal: number,
): string {
  if (!agentId || agentId.includes(":")) {
    throw new Error(`refusing subagent session key: agent id ${JSON.stringify(agentId)} is empty or contains ':'`);
  }
  const slug = (agentName ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = slug.length > 0 ? slug : `anon-${ordinal}`;
  return `agent:${agentId}:subagent:${runId}:${suffix}`;
}
