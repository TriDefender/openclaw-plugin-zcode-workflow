/** Shared engine types for the ZCode workflow plugin. */

export interface WorkflowDiagnostic {
  path: string;
  line: number;
  column: number;
  message: string;
  code: number;
}

export interface AskMeta {
  /** Type name as written in the ask<T> type argument. */
  typeName: string;
  /** Interface/type-alias source text including JSDoc, for the ask prompt. */
  source: string;
  /** JSON schema derived from the declaration. */
  schema: JsonSchema;
}

export type JsonSchema =
  | { type: "object"; properties: Record<string, JsonSchema>; required: string[]; description?: string; additionalProperties?: JsonSchema | boolean }
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "number"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: JsonSchema; description?: string }
  | { type: "null"; description?: string }
  | { type: "any"; description?: string };

export interface ScriptMeta {
  phases: string[];
  /** Literal subagent names in source order (duplicates are a compile error). */
  agentNames: string[];
  /** Count of agent() calls with a computed (non-literal) name. */
  dynamicAgentNames: number;
  /** world.run command string literals — the command set the user approves. */
  commands: string[];
  /** Artifact ids by kind. */
  artifacts: { id: string; kind: ArtifactKind }[];
  /** report(item, tag) literal tags. */
  reportTags: string[];
  /** model("...") literals referenced via model() or persona.model. */
  models: string[];
  holes: { name: string; typeName: string; prompt: string; hasBody: boolean; id: string }[];
  /** Non-blocking notes (empty phases, ignored budget, ...). */
  notes: string[];
  hasAskCalls: boolean;
  hasWorldRun: boolean;
}

export type ArtifactKind = "file" | "markdown" | "chart" | "table" | "metrics" | "board";

export type RunState =
  | "running"
  | "completed"
  | "errored"
  | "stopped"
  | "waiting_hole"
  | "waiting_question"
  | "superseded";

export interface StopInfo {
  reason: "user" | "model" | "interrupted" | "provider";
  detail?: string;
  at: string;
}

export interface PendingHole {
  /** Site id, shaped hole#xxxxxxxx. */
  id: string;
  name: string;
  typeName: string;
  prompt: string;
  waitingSince: string;
}

export interface PendingQuestion {
  /** Globally unique id shaped dwfq-.... */
  id: string;
  runId: string;
  agent: string;
  agentName?: string;
  /** agent() call ordinal within the run (used to address its session). */
  agentOrdinal: number;
  /** In-order ask index within that agent, for the journal cache. */
  agentIndex: number;
  instructions: string;
  question: string;
  evidence?: string;
  createdAt: string;
  /** Ask metadata when the escalating ask was typed. */
  askMeta?: AskMeta;
  /** Tool policy of the escalating agent, reapplied on continuation runs. */
  personaTools?: "none" | "submit";
}

export interface ReportedItem {
  seq: number;
  at: string;
  item: unknown;
  artifactId?: string;
}

export interface RunMeta {
  id: string;
  name: string;
  state: RunState;
  /** Agent that owns this run's subagent sessions. Stamped at start; never guessed later. */
  agentId?: string;
  /** Session key that invoked this run, when the calling turn exposed one. Provenance only. */
  invokerSessionKey?: string;
  createdAt: string;
  updatedAt: string;
  /** Run this one amends, if any. */
  supersededFrom?: string;
  /** Journal imported as cache on resume, if any. */
  resumedFrom?: string;
  scriptPath: string;
  /** Script source with hole bodies spliced in (the effective script). */
  effectiveScriptHash: string;
  subagentModel?: string;
  maxConcurrency?: number;
  phases: string[];
  commands: string[];
  agentNames: string[];
  holes: { name: string; typeName: string; prompt: string; hasBody: boolean; id: string }[];
  stop?: StopInfo;
  error?: string;
  result?: unknown;
  pendingHole?: PendingHole;
  pendingQuestions: PendingQuestion[];
  primaryArtifact?: string;
  /** Fills applied to this run, by hole name. */
  fills: Record<string, string>;
  /** Saved-workflow provenance, when started from a saved definition. */
  savedFrom?: { name: string; args?: Record<string, unknown> };
  /** Session-event notifications: push task/settle events to the originating session. */
  notify?: { sessionKey: string };
  /** Evaluation-only runs (EvalWorkflowSnippet) never appear here. */
}

export type JournalRecord =
  | { seq: number; at: string; kind: "ask"; agent: string; agentIndex: number; instructions: string; result: unknown; typed: boolean; escalated?: boolean; resumedAnswer?: boolean }
  | { seq: number; at: string; kind: "world"; key: string; result: { exitCode: number; stdout: string; stderr: string } }
  | { seq: number; at: string; kind: "files"; key: string; result: unknown }
  | { seq: number; at: string; kind: "git"; key: string; result: unknown }
  | { seq: number; at: string; kind: "report"; item: unknown; artifactId?: string }
  | { seq: number; at: string; kind: "log"; message: string }
  | { seq: number; at: string; kind: "artifact"; id: string; kindOf: ArtifactKind; version: number; path?: string; spec?: unknown }
  | { seq: number; at: string; kind: "phase"; name: string }
  | { seq: number; at: string; kind: "status"; state: RunState; detail?: string };

export interface CompiledScript {
  ok: boolean;
  diagnostics: WorkflowDiagnostic[];
  /** JS body (statements) ready to embed in an async function wrapper. */
  js?: string;
  meta?: ScriptMeta;
  /** The effective source (with hole bodies spliced in), for draft files. */
  effectiveSource?: string;
}

export interface SavedWorkflowDeclaration {
  name: string;
  description: string;
  whenToUse?: string;
  scope: "project" | "global";
  args?: { name: string; type: "string" | "number" | "boolean" | "json"; description?: string; required?: boolean; default?: unknown }[];
}

export interface SavedWorkflow {
  decl: SavedWorkflowDeclaration;
  script: string;
  path: string;
}

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}
