/**
 * Engine smoke test — runs without OpenClaw, using a fake subagent runtime.
 * Usage: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileWorkflow } from "../dist/engine/compile.js";
import { WorkflowRunner } from "../dist/engine/runner.js";
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
  const runner = new WorkflowRunner(new RunStore(workspace), fakeSubs(), workspace, quietLogger());
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
  const runner = new WorkflowRunner(new RunStore(workspace), fakeSubs(), workspace, quietLogger());
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
  const runner = new WorkflowRunner(store, fakeSubs(), workspace, quietLogger());
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
  const runner = new WorkflowRunner(store, subs, workspace, quietLogger());
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

console.log("smoke: all assertions passed");
