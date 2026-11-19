/**
 * The subagent layer: every workflow `agent()` maps to one persistent
 * OpenClaw subagent session; `ask()` maps to one background subagent run on
 * that session. Context is kept across asks, so a later round on the same
 * subagent is cheap. Concurrency is bounded by a semaphore (plus OpenClaw's
 * own subagent queue). Session keys are `agent:<agentId>:subagent:…` so the
 * child stays out of the sidebar; the semaphore is sized to that lane.
 */
import { subagentSessionKey } from "./scope.js";

/** The slice of OpenClaw's plugin runtime the engine needs. */
export interface SubagentRuntime {
  run(params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    model?: string;
    provider?: string;
    promptMode?: "minimal";
    cwd?: string;
  }): Promise<{ runId: string; sessionKey?: string }>;
  waitForRun(params: { runId: string; timeoutMs: number }): Promise<{
    status: "ok" | "timeout" | "error" | "pending";
    error?: string;
    stopReason?: string;
    terminalReply?: { disposition: "visible"; text: string } | { disposition: "silent" } | { disposition: "empty" };
  }>;
  getSessionMessages(params: { sessionKey: string; limit?: number }): Promise<{ messages: unknown[] }>;
}

export class AskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskError";
  }
}

export class Escalation {
  constructor(
    readonly question: string,
    readonly evidence: string | undefined,
  ) {}
}

export interface Persona {
  system?: string;
  model?: string;
  provider?: string;
  budgetWebSearch?: number;
}

const ASK_WAIT_CHUNK_MS = 60_000;

export class SubagentPool {
  /** name (or synthetic) → per-agent ask counter, for journal cache indexes. */
  private askCounts = new Map<string, number>();
  private seenNames = new Set<string>();

  constructor(
    private readonly runtime: SubagentRuntime,
    private readonly runId: string,
    private readonly agentId: string,
    private readonly workspaceDir: string | undefined,
    private readonly defaultModel: string | undefined,
    private readonly semaphore: Semaphore,
  ) {}

  /** Runtime identity check: a computed duplicate name fails the run. */
  registerName(name: string | undefined): void {
    if (!name) return;
    if (this.seenNames.has(name)) {
      throw new AskError(`duplicate subagent name "${name}" at run time: names are identities and must be unique within the run`);
    }
    this.seenNames.add(name);
  }

  nextAskIndex(name: string | undefined, ordinal: number): number {
    const key = name ?? `#${ordinal}`;
    const next = (this.askCounts.get(key) ?? 0);
    this.askCounts.set(key, next + 1);
    return next;
  }

  /**
   * One ask on one subagent session. Returns the reply text.
   * Throws AskError on terminal failure, Escalation-aware parsing left to the caller.
   */
  async ask(
    name: string | undefined,
    ordinal: number,
    persona: Persona | undefined,
    message: string,
  ): Promise<string> {
    const sessionKey = subagentSessionKey(this.agentId, this.runId, name, ordinal);
    const first = !this.askCounts.has(name ?? `#${ordinal}`) || (this.askCounts.get(name ?? `#${ordinal}`) ?? 0) === 0;
    const extraSystemPrompt = persona?.system;
    const modelParts = persona?.model?.includes("/") ? persona.model.split("/") : undefined;

    const release = await this.semaphore.acquire();
    try {
      const { runId: subRunId } = await this.runtime.run({
        sessionKey,
        message,
        extraSystemPrompt,
        promptMode: "minimal",
        cwd: this.workspaceDir,
        model: modelParts ? modelParts[1] : (persona?.model ?? this.defaultModel),
        provider: modelParts?.[0],
      });
      // Wait in bounded chunks so a long ask never wedges the run silently.
      const deadline = Date.now() + 24 * 60 * 60 * 1000;
      while (Date.now() < deadline) {
        const wait = await this.runtime.waitForRun({ runId: subRunId, timeoutMs: ASK_WAIT_CHUNK_MS });
        if (wait.status === "ok") {
          if (wait.terminalReply && wait.terminalReply.disposition === "visible") {
            return wait.terminalReply.text;
          }
          return this.lastAssistantText(sessionKey);
        }
        if (wait.status === "pending" || wait.status === "timeout") continue;
        throw new AskError(`subagent ${name ?? "(anonymous)"} failed: ${wait.error ?? wait.stopReason ?? "unknown error"}`);
      }
      throw new AskError(`subagent ${name ?? "(anonymous)"} exceeded the 24h ask deadline`);
    } finally {
      release();
    }
  }

  /** Direct continuation (used by workflow_resolve_question to answer an escalation in place). */
  async continueAsk(name: string | undefined, ordinal: number, message: string): Promise<string> {
    const sessionKey = subagentSessionKey(this.agentId, this.runId, name, ordinal);
    const release = await this.semaphore.acquire();
    try {
      const { runId: subRunId } = await this.runtime.run({ sessionKey, message, promptMode: "minimal", cwd: this.workspaceDir });
      const wait = await this.runtime.waitForRun({ runId: subRunId, timeoutMs: 10 * 60_000 });
      while (wait.status === "pending" || wait.status === "timeout") {
        const again = await this.runtime.waitForRun({ runId: subRunId, timeoutMs: ASK_WAIT_CHUNK_MS });
        if (again.status === "ok") {
          if (again.terminalReply && again.terminalReply.disposition === "visible") return again.terminalReply.text;
          return this.lastAssistantText(sessionKey);
        }
        if (again.status === "error") throw new AskError(`answering subagent failed: ${again.error ?? "unknown error"}`);
      }
      if (wait.status === "ok") {
        if (wait.terminalReply && wait.terminalReply.disposition === "visible") return wait.terminalReply.text;
        return this.lastAssistantText(sessionKey);
      }
      if (wait.status === "error") throw new AskError(`answering subagent failed: ${wait.error ?? "unknown error"}`);
      throw new AskError("answering subagent timed out");
    } finally {
      release();
    }
  }

  private async lastAssistantText(sessionKey: string): Promise<string> {
    try {
      const { messages } = await this.runtime.getSessionMessages({ sessionKey, limit: 20 });
      for (let i = messages.length - 1; i >= 0; i--) {
        const text = extractAssistantText(messages[i]);
        if (text !== undefined) return text;
      }
    } catch {
      // fall through
    }
    throw new AskError(`subagent completed but no reply text was found (${sessionKey})`);
  }
}

/** Best-effort extraction of assistant text from an OpenClaw session message. */
export function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  const role = m.role as string | undefined;
  const inner = m.message as Record<string, unknown> | undefined;
  const innerRole = inner?.role as string | undefined;
  if (role !== "assistant" && innerRole !== "assistant") return undefined;
  const content = (inner?.content ?? m.content) as unknown;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as Record<string, unknown>).text) : ""))
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }
  if (typeof m.text === "string") return m.text;
  return undefined;
}

/** Bounded concurrency for asks. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
