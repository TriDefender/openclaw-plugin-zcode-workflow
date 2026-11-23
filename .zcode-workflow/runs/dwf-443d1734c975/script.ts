const SH = "bash";
phase("A exec: 回合结束期间沉睡");
const w = await world.run(SH, ["-c", "sleep 45 && echo phase-a-done"], { timeoutMs: 120_000 });
if (w.exitCode !== 0) throw new Error("phase A exit " + w.exitCode + ": " + w.stderr);
phase("B ask: 无存活回合时的子代理跳转");
const probe = agent("probe");
const answer = await probe.ask("健康探针。只回复两个字：OK");
phase("C finish");
return { slept: w.stdout.trim(), answer: String(answer).slice(0, 120) };