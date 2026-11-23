/**
 * Engine smoke test — runs without OpenClaw, using a fake subagent runtime.
 * Usage: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { compileWorkflow } from "../dist/engine/compile.js";
import { createTools } from "../dist/tools.js";
import { WorkflowRunner } from "../dist/engine/runner.js";
import { SubagentPool } from "../dist/engine/agents.js";
import { RunStore } from "../dist/engine/store.js";
import { Journal } from "../dist/engine/journal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, "tmp-workspace");
await fs.rm(workspace, { recursive: true, force: true });
await fs.mkdir(path.join(workspace, "data"), { recursive: true });
await fs.writeFile(path.join(workspace, "data", "a.txt"), "alpha\n");
await fs.writeFile(path.join(workspace, "data", "b.txt"), "beta\n");
await fs.writeFile(path.join(workspace, "notes.md"), "# notes\n");

// ---------- 1. compiler ----------
{
  const good = `
interface Verdict { ok: boolean; note: string; }
phase("检查文件");
const paths = await files.glob("data/*.txt");
log("found " + paths.length);
const v = await agent("评审员").ask<Verdict>("判断 " + paths[0]);
phase("跑一个门控");
const gate = await world.run("git", ["rev-parse", "HEAD"], { output: "discard" });
return { count: paths.length, note: v.note, gateCode: gate.exitCode };
`;
  const r = compileWorkflow({ scriptPath: "good.ts", source: good });
  assert.ok(r.ok, "good script compiles: " + JSON.stringify(r.diagnostics));
  assert.deepEqual(r.meta.phases, ["检查文件", "跑一个门控"]);
  assert.deepEqual(r.meta.agentNames, ["评审员"]);
  assert.deepEqual(r.meta.commands, ["git"]);
  assert.ok(r.js.includes("__workflow__"), "emits wrapper");
  assert.ok(r.js.includes('\\"typeName\\":\\"Verdict\\"'), "ask meta injected as a JSON string literal");
}

{
  const bad = [
    // non-literal world.run command
    { src: 'phase("a");\nconst c = "gi"+"t";\nawait world.run(c, []); return 1;', code: 9003 },
    // duplicate literal agent names
    { src: 'phase("a");\nconst a1 = agent("dup");\nconst a2 = agent("dup");\nawait a1.ask("x");\nreturn 1;', code: 9002 },
    // no phase markers
    { src: 'const v = await agent("solo").ask("hi");\nreturn v;', code: 9009 },
    // Node API
    { src: 'phase("a");\nconst p = process.env;\nreturn 1;', code: null },
    // unsupported ask type (tuple)
    { src: 'phase("a");\nconst v = await agent("x").ask<[number]>("hi");\nreturn v;', code: 9015 },
    // import
    { src: 'import fs from "fs";\nphase("a");\nreturn 1;', code: 9010 },
  ];
  for (const { src, code } of bad) {
    const r = compileWorkflow({ scriptPath: "bad.ts", source: src });
    assert.ok(!r.ok, "should fail: " + src.slice(0, 40));
    if (code !== null) assert.ok(r.diagnostics.some((d) => d.code === code), `code ${code} in ${JSON.stringify(r.diagnostics)}`);
  }
}

// snippet facade rejects agent()
{
  const r = compileWorkflow({ scriptPath: "s.ts", source: 'const v = await agent("x").ask("hi"); return v;', snippet: true });
  assert.ok(!r.ok, "snippet facade has no agent()");
  const ok = compileWorkflow({ scriptPath: "s.ts", source: 'const g = await files.glob("*.md"); return g;', snippet: true });
  assert.ok(ok.ok, "snippet glob compiles: " + JSON.stringify(ok.diagnostics));
}

// ---------- 2. snippet eval ----------
{
  const runner = new WorkflowRunner(new RunStore(workspace), fakeSubs(), workspace, quietLogger(), () => ({}));
  const { logs, result } = await runner.evalSnippet(
    `
const paths = await files.glob("data/*.txt");
log("files: " + paths.join(","));
const matches = await files.grep("alph", "data/*.txt");
const echo = await world.run("echo", ["hello"]);
return { paths, matchLines: matches.length, echo: echo.stdout.trim() };
`,
    "snippet.ts",
    30_000,
  );
  assert.deepEqual(logs, ["files: data/a.txt,data/b.txt"]);
  assert.deepEqual(result.paths, ["data/a.txt", "data/b.txt"]);
  assert.equal(result.matchLines, 1);
  assert.equal(result.echo, "hello");
}

// ---------- 2b. channel + future pipeline in a snippet ----------
{
  const runner = new WorkflowRunner(new RunStore(workspace), fakeSubs(), workspace, quietLogger(), () => ({}));
  const { result } = await runner.evalSnippet(
    `
const ch = channel<number>("nums");
const out = [];
future(async () => {
  for (let i = 1; i <= 3; i++) ch.send(i);
  ch.close();
});
for await (const n of ch) out.push(n);
return out;
`,
    "snippet.ts",
    15_000,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [1, 2, 3], "channel delivers items in order then closes");
}

// ---------- 3. full run with typed ask + artifact ----------
{
  const store = new RunStore(workspace);
  const runner = new WorkflowRunner(store, fakeSubs(), workspace, quietLogger(), () => ({}));
  const script = `
interface Verdict { ok: boolean; note: string; }
phase("检查文件");
const paths = await files.glob("data/*.txt");
log("found " + paths.length);
const v = await agent("评审员").ask<Verdict>("判断 " + paths[0]);
phase("产出报告");
artifact.table("t", { columns: [{ field: "n", label: "文件数" }], title: "盘点" });
report({ n: paths.length }, "t");
await artifact.markdown("report", "# 报告\\n\\n" + v.note, { title: "报告", primary: true });
return { count: paths.length, note: v.note };
`;
  const meta = newMeta(store, "smoke-full");
  await store.saveMeta(meta);
  await store.writeScript(meta.id, script);
  runner.start(meta);
  await waitSettled(store, meta.id);
  const finalMeta = await store.loadMeta(meta.id);
  assert.equal(finalMeta.state, "completed", "completed: " + finalMeta.error);
  assert.equal(finalMeta.result.count, 2);
  assert.equal(finalMeta.result.note, "all good");
  const journal = await Journal.open(path.join(store.runDir(meta.id), "journal.jsonl"));
  assert.ok(journal.reportedItems().length === 1);
  const md = await fs.readFile(path.join(store.artifactsDir(meta.id), "report.v1.md"), "utf8");
  assert.ok(md.includes("all good"));
  assert.equal(finalMeta.primaryArtifact, "report");
}

// ---------- 4. hole: wait, fill, resume with journal replay ----------
{
  const store = new RunStore(workspace);
  const subs = fakeSubs();
  const runner = new WorkflowRunner(store, subs, workspace, quietLogger(), () => ({}));
  const script = `
phase("第一步：勘察");
const x = await agent("勘察").ask<string>("说一句话");
const plan = await hole<{ step: string }>("第二步：决定怎么继续", "勘察结果：" + x);
phase("第三步：收尾");
return { x, plan };
`;
  const meta = newMeta(store, "smoke-hole");
  await store.saveMeta(meta);
  await store.writeScript(meta.id, script);
  runner.start(meta);
  await waitSettled(store, meta.id);
  let m = await store.loadMeta(meta.id);
  assert.equal(m.state, "waiting_hole", "waiting at hole: " + m.state);
  assert.equal(m.pendingHole.name, "第二步：决定怎么继续");
  assert.equal(subs.askCount, 1, "one live ask before the hole");

  // fill the hole and continue
  meta.fills = { "第二步：决定怎么继续": 'return { step: "go" };' };
  meta.state = "running";
  await store.saveMeta(meta);
  runner.start(meta);
  await waitSettled(store, meta.id);
  m = await store.loadMeta(meta.id);
  assert.equal(m.state, "completed", "completed after fill: " + m.error);
  assert.deepEqual(m.result, { x: "勘察完成", plan: { step: "go" } });
  assert.equal(subs.askCount, 1, "resume replayed the ask from the journal, zero new asks");
}

// ---------- helpers ----------
function newMeta(store, name) {
  return {
    id: store.newRunId(),
    agentId: "main",
    name,
    state: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scriptPath: "script.ts",
    effectiveScriptHash: "",
    phases: [],
    commands: [],
    agentNames: [],
    holes: [],
    pendingQuestions: [],
    fills: {},
  };
}

function fakeSubs() {
  let counter = 0;
  const messages = new Map();
  return {
    askCount: 0,
    async run(params) {
      const runId = "sub-" + ++counter;
      messages.set(runId, params.message);
      return { runId, sessionKey: params.sessionKey };
    },
    async waitForRun({ runId }) {
      const message = messages.get(runId) ?? "";
      this.askCount += 1;
      let text;
      if (message.includes("判断")) {
        text = '```json\n{"ok": true, "note": "all good"}\n```';
      } else if (message.includes("说一句话")) {
        text = "勘察完成";
      } else if (message.includes("failed validation")) {
        text = '{"ok": true, "note": "recovered"}';
      } else {
        text = message.includes("Answer with a single JSON value") ? '{"ok": true, "note": "generic"}' : "ok";
      }
      return { status: "ok", terminalReply: { disposition: "visible", text } };
    },
    async getSessionMessages() {
      return { messages: [] };
    },
    async deleteSession() {},
  };
}

function quietLogger() {
  return { info() {}, warn() {}, error(e) { console.error("[runner]", e); } };
}

async function waitSettled(store, runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = await store.loadMeta(runId);
    if (meta && meta.state !== "running") return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("run did not settle in " + timeoutMs + "ms");
}


// ---------- 5. 0.1.4: const identifiers resolve as compile-time literals ----------
{
  const src = [
    "const PY = 'python3';",
    "const P1 = 'scan';",
    "const TAG = 'board1';",
    "phase(P1);",
    "const r = await world.run(PY, ['-c', 'print(1)']);",
    "report({ ok: r.exitCode === 0 }, TAG);",
    "return r.exitCode;",
  ].join("\n");
  const r = compileWorkflow({ scriptPath: "const.ts", source: src });
  assert.ok(r.ok, "const script compiles: " + JSON.stringify(r.diagnostics));
  assert.deepEqual(r.meta.commands, ["python3"]);
  assert.deepEqual(r.meta.phases, ["scan"]);
  assert.deepEqual(r.meta.reportTags, ["board1"]);

  const letSrc = src.replace("const PY = 'python3';", "let PY = 'python3';");
  const letted = compileWorkflow({ scriptPath: "let.ts", source: letSrc });
  assert.ok(!letted.ok, "let stays dynamic");
  assert.ok(letted.diagnostics.some((d) => d.code === 9003), "let-bound command rejected");
}

// ---------- 6. 0.1.4: background wrapper + model-override fallback + amend guard ----------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dwf-smoke-"));
  const asks = [];
  const warnings = [];
  let overrideRejections = 0;
  const subs = {
    async run(params) {
      if (params.model !== undefined) {
        overrideRejections += 1;
        throw new Error('plugin "zcode-workflow" is not trusted for fallback provider/model override requests.');
      }
      asks.push(params);
      return { runId: "sub-" + asks.length, sessionKey: params.sessionKey };
    },
    async waitForRun() {
      return { status: "ok", terminalReply: { disposition: "visible", text: "hello" } };
    },
    async getSessionMessages() {
      return { messages: [] };
    },
  };
  let backgroundRuns = 0;
  const api = {
    runtime: {
      agent: { resolveAgentWorkspaceDir: () => dir },
      config: { current: () => ({}) },
      subagent: subs,
    },
    logger: { info() {}, warn: (m) => warnings.push(m), error(e) { warnings.push(e); }, debug() {} },
  };
  const ctx = {
    api,
    pendingPlans: new Map(),
    runners: new Map(),
    background: async (run) => {
      backgroundRuns += 1;
      return await run();
    },
    session: { agentId: "main", sessionKey: "agent:main:dashboard:smoke", workspaceDir: dir },
  };
  const defs = createTools(ctx);
  const byName = (name) => {
    const found = defs.find((d) => d.name === name);
    if (!found) throw new Error("tool " + name + " missing");
    return (params) => found.execute(params);
  };
  const create = byName("workflow_create");
  const wait = byName("workflow_wait");
  const amend = byName("workflow_amend");
  const dashboard = byName("workflow_dashboard");

  const script = "phase('p1');\nconst a = agent('echo');\nconst t = await a.ask('say hi');\nreturn { t };";
  const plan = await create({ script, name: "smoke2", subagent_model: "prov/model-x" });
  const started = await create({ script, confirm: true, token: plan.details.token });
  assert.ok(started.details.runId, "run started: " + started.details.text);
  const runId = started.details.runId;

  const settled = await wait({ run_id: runId, timeout_ms: 15000 });
  assert.ok(settled.details.text.includes("completed"), "run completed: " + settled.details.text);
  assert.ok(backgroundRuns >= 1, "background wrapper used");
  assert.equal(overrideRejections, 1, "override attempted once");
  assert.equal(asks.length, 1, "ask admitted after fallback");
  assert.equal(asks[0].model, undefined, "retry dropped the override");
  assert.ok(warnings.some((w) => String(w).includes("allowModelOverride")), "fallback warning logged");

  const refused = await amend({ run_id: runId });
  assert.equal(refused.details.ok, false);
  assert.ok(refused.details.text.includes("script_unchanged"), "completed+unchanged refused");

  const metaFile = path.join(dir, ".zcode-workflow", "runs", runId, "meta.json");
  const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
  meta.state = "errored";
  meta.error = "SessionMutationAuthorizationChangedError: agent tool caller authority is no longer active";
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");
  const restarted = await amend({ run_id: runId });
  assert.equal(restarted.details.ok, true, "unchanged amend on errored run accepted: " + restarted.details.text);
  assert.ok(restarted.details.text.includes("unchanged"), "restart note present");
  const settled2 = await wait({ run_id: restarted.details.newRunId, timeout_ms: 15000 });
  assert.ok(settled2.details.text.includes("completed"), "restart completes from cache");
  assert.equal(asks.length, 1, "journal cache served the ask");

  const live = await dashboard({ run_id: restarted.details.newRunId, live: true });
  const wp = live.details.widgetParams;
  assert.ok(wp, "live widget params returned");
  assert.equal(wp.name, "zcode-workflow-live-" + restarted.details.newRunId);
  assert.ok(wp.widget_code.includes(restarted.details.newRunId), "run id injected");
  assert.deepEqual(wp.capabilities.tools, ["zcode-workflow.runs"]);
  assert.ok(!wp.widget_code.includes("__RUN_ID__"), "placeholder replaced");
  const card = await dashboard({ run_id: restarted.details.newRunId });
  assert.equal(card.details.dashboardParams.pluginKind, "session:report");

  await fs.rm(dir, { recursive: true, force: true });
}

// ---------- session-event notify: per-task callback + coalesced/settle pushes ----------
{
  // a. SubagentPool reports ask resolutions through onTaskDone (success + failure)
  {
    const events = [];
    const subs = {
      async run(p) { return { runId: "n-" + (p.message.includes("炸") ? "bad" : "good") }; },
      async waitForRun({ runId }) {
        if (runId === "n-bad") return { status: "error", error: "boom" };
        return { status: "ok", terminalReply: { disposition: "visible", text: "任务回复" } };
      },
    };
    const pool = new SubagentPool(
      subs, "notify-run", "main", undefined, undefined,
      { acquire: async () => () => {} }, undefined,
      (info) => events.push(info),
    );
    const reply = await pool.ask("worker", 0, undefined, "干一件事");
    assert.equal(reply, "任务回复");
    assert.equal(events.length, 1);
    assert.equal(events[0].ok, true);
    assert.equal(events[0].name, "worker");
    await assert.rejects(() => pool.ask("bomber", 1, undefined, "炸一下"));
    assert.equal(events.length, 2);
    assert.equal(events[1].ok, false);
    assert.ok(events[1].summary.includes("boom"), "failure summary surfaced");
  }

  // b. Runner coalesces task lines and pushes settle to the notify target
  {
    const pushes = [];
    const system = {
      enqueueSessionEvent(text, opts) {
        pushes.push({ text, opts });
        return { accepted: Promise.resolve({ ok: true }), settled: Promise.resolve({ status: "completed" }), cancel: () => {} };
      },
    };
    const store = new RunStore(workspace);
    const runner = new WorkflowRunner(store, fakeSubs(), workspace, quietLogger(), () => ({}), (r) => r(), system);
    const script = `
phase("a");
const x = await agent("甲").ask<string>("说一句话");
const y = await agent("乙").ask<string>("说一句话");
return { x, y };
`;
    const meta = newMeta(store, "notify-run");
    runner.rememberNotifyTarget(meta.id, { agentId: "main", sessionKey: "agent:main:main:webchat", expectedTarget: { gen: 7 } });
    await store.saveMeta(meta);
    await store.writeScript(meta.id, script);
    runner.start(meta);
    await waitSettled(store, meta.id);
    const m = await store.loadMeta(meta.id);
    assert.equal(m.state, "completed", "notify run completed: " + m.error);
    const allText = pushes.map((p) => p.text).join("\n");
    assert.ok(allText.includes("任务 甲 完成"), "task 甲 line delivered");
    assert.ok(allText.includes("任务 乙 完成"), "task 乙 line delivered");
    assert.ok(allText.includes("已完成"), "settle push delivered");
    assert.ok(allText.includes("workflow_dashboard {run_id:"), "card refresh hint present");
    assert.ok(pushes.length >= 2, "progress + settle pushes: " + pushes.length);
    assert.equal(pushes.at(-1).opts.sessionKey, "agent:main:main:webchat");
    assert.deepEqual(pushes.at(-1).opts.expectedTarget, { gen: 7 });
  }

  // c. Notify failures never break the run
  {
    const store = new RunStore(workspace);
    const system = { enqueueSessionEvent() { throw new Error("admission down"); } };
    const runner = new WorkflowRunner(store, fakeSubs(), workspace, quietLogger(), () => ({}), (r) => r(), system);
    const meta = newMeta(store, "notify-fail");
    runner.rememberNotifyTarget(meta.id, { agentId: "main", sessionKey: "agent:main:main:other" });
    await store.saveMeta(meta);
    await store.writeScript(meta.id, `phase("a");\nreturn 1;`);
    runner.start(meta);
    await waitSettled(store, meta.id);
    const m = await store.loadMeta(meta.id);
    assert.equal(m.state, "completed", "run survives notify failure: " + m.error);
  }
}

console.log("smoke: all assertions passed");