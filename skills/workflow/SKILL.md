---
name: workflow
description: "ZCode dynamic workflows for OpenClaw: writing, debugging and resubmitting workflow scripts for workflow_create — choosing subagent topology, typing subagent results, fanning out over files or git, gating loops on world.run commands, testing pieces with workflow_eval_snippet, planner-reviewer loops, confirming findings before reporting them, report() salvage, publishing artifacts, leaving typed holes to fill mid-run, and handling a backgrounded run. Trigger when the user says workflow/工作流 as the means, or invokes /workflow."
user-invocable: true
---

# Writing dynamic workflows (ZCode-style, on OpenClaw)

This skill is the whole authoring contract for `workflow_create`. The facade the
compiler checks against, the rules a script must satisfy and the fields each tool
takes are in §16, and `workflow_create`, `workflow_amend`, `workflow_fill_hole`,
`workflow_save` and `workflow_eval_snippet` are best used only after this skill
has been loaded. The rest is the judgment layer: how many subagents a request
deserves, which of them should share a context, what each one should hand back,
and how to keep the run's work from dying with the run.

`/workflow <task>` and any request naming workflow/工作流 as the means route
here. A single delegation or a few independent lookups belong to normal
subagents (`sessions_spawn`) instead.

## The bar: first-class, expert-level work

A workflow exists to produce first-class, expert-level work — the deliverable a
senior practitioner would hand over after doing the job properly, not a faster
draft of what one reply could have said. A user who asks for a workflow is
paying for that depth, and every choice in this skill serves it: enough
subagents to actually cover the ground, fresh eyes on every plan and every
draft (§3), an independent confirmation of every finding, deterministic checks
wherever a command can decide, and a report that says what was verified, what
was not, and what it all means. Depth is measured by what is at stake, not by
how many subagents re-read the same work: verification goes where a wrong claim
would cost the user something, and each piece of work gets the one check that
decides it. When a shortcut and the expert's way disagree, take the expert's
way; trim the work only when the task is small, and trim the checking when a
wrong claim costs little or a command has already decided it.

## 1. Is this the right tool, and how big should it be?

| The request | The tool |
| --- | --- |
| One thing delegated to one agent | `sessions_spawn` |
| A few independent lookups, nobody reading anybody's answer | `sessions_spawn`, in parallel |
| Anything else the user did not name a workflow for, however many steps it needs | subagents, or do it yourself |
| The user said "use a workflow" / "使用 workflow" / "用工作流", or typed `/workflow` | `workflow_create`, mandatory, even if a plain reply could answer |

**Only an explicit request starts a workflow.** A workflow begins with `/workflow`
or with the user naming workflow/工作流 as the means, never with your own
judgement that a task looks orchestration-shaped. Results feeding later steps,
a bounded loop, a branch on a typed result — those are shapes the script is good
at once one has been requested, not reasons there should be one.

**An explicit request is binding.** Once the user names workflow/工作流 as the
means, the routing question is closed — not subagents, not inline, not "too
small for a workflow"; what remains is only how big the script should be, and
the smallest task gets a small workflow.

An explicit workflow request is a request for depth, and the bar above is the
measure. Default to the thorough shape — a fresh subagent per unit of work, a
deterministic gate wherever a command can decide, an independent confirmation
of every finding the user will act on as fact (§10) — sized to the stakes: a
bug the user will fix on your word gets a confirmer; a poem or a survey gets a
reader at most. Every subagent ask is a full model session, so put sessions
where they raise confidence, not where they repeat each other: "review the
changed files" wants a reviewer per file plus a confirmer per finding; "write
me twenty poems" wants twenty poets and no confirmers.

**Write only as much of that shape as you know for sure.** Where a later stage
depends on what an earlier one finds, write up to that point, end in a hole
(§15), and let the findings write the rest. Guessing a topology is not depth.

## 2. Subagent topology

This is the decision that separates a good script from a bad one. It is made
twice: now, for what the request already tells you, and at a hole (§15), for
what only the run can tell you.

**Fresh subagent per item, or one shared subagent?** Every `agent()` call
creates a new conversation. Sharing a context means sharing the *variable*:

```ts
// Independent: each judge sees only its own item. Runs concurrently.
items.map((i) => agent(`judge-${i.id}`).ask<Verdict>(`Judge ${i.id}`));

// Calibrated: one context sees every item in sequence, so its later verdicts are
// consistent with its earlier ones. Asks on one subagent queue FIFO — this serializes.
const judge = agent("judge", "You rank consistently across a whole batch.");
items.map((i) => judge.ask<Verdict>(`Judge ${i.id}`));
```

Independent is right for unrelated items; shared is right when the answers must
be consistent with each other, at the price of serialization. Hoisting the
`agent()` call out of a loop for tidiness turns a fan-out into a queue, and
nothing rejects that script.

**A name is an identity, and it has to be unique.** No two subagents in one run
may share a non-empty name — a duplicate fails the run. One fixed name inside a
fan-out is a duplicate per item, so write `` agent(`judge-${i.id}`) ``; the
compiler catches the literal form, a name built at run time costs you the run.
Anonymous is always safe.

Names are worth giving anyway: a **revised** re-run finds its cache by them
(§13), importing every ask whose instructions did not change at zero tokens.
Anonymous subagents start empty.

**Persona, frozen at creation.** A persona stacks on the harness's own subagent
contract — citing `path:line`, never reporting a check it did not run, saying
what it could not do, escalating instead of faking — so write the role and the
standard of judgement and leave those rules out. Subagents run as OpenClaw
background subagents with the workspace's normal tool surface; what they may do
with it is said in the ask: a reviewer that must not touch the code is told "do
not edit any file".

**Per-subagent model**, only when the user asked for one, with the name they
used: `agent("judge", { model: "GLM-5.3-Flash" })`. On this host a model
override additionally needs the operator opt-in
`plugins.entries.zcode-workflow.subagent.allowModelOverride: true` (and may be
restricted by `subagent.allowedModels`); a bare model name resolves within the
session's provider — never move a subagent to another provider on your own.
When a lighter model would clearly fit (one-turn judges, routers) and the user
has not said, ask them first, before the call: name the model and the provider,
say what it would save, and go with their answer.

**Search budget.** `persona.budget.webSearch` is accepted and recorded but not
enforced by this host; OpenClaw's own tool policy governs subagent web search.

**Where each item goes next.** A run with more than one stage is a pipeline: an
item leaves its stage as soon as it is done, and the next stage takes it while
the rest are still being worked on. Decide this at every hand-off when you lay
out the topology, and let a stage wait for all of its items only where the next
step needs every one. §7 says how to write each case.

**Loops.** Bound every loop with a round cap, and carry the feedback forward:

```ts
let feedback = "none";
for (let round = 0; round < 5; round++) {
  const plan = await planner.ask<Plan>(`Plan the fix. Previous critique: ${feedback}`);
  const review = await reviewer.ask<Review>(`Critique this plan: ${JSON.stringify(plan)}`);
  if (review.approved) return plan;
  feedback = review.feedback;
}
```

Reuse the same two subagents across rounds: a subagent asked again keeps its
context, so round five is cheap. Reuse costs freshness — by round three the
reviewer is anchored on its own critique — so add an independent one at the end
(§3).

**No nesting.** Subagents cannot call `workflow_create`; model a big sub-task as
more subagents here.

## 3. Fresh eyes

The author of a plan or a draft cannot see its gaps, because they filled them
while writing. A reader with a separate context has no such fill, so the gaps
show. That is the whole method, and it applies at every stage *inside* the
workflow where something is drafted — a plan, a fix, a finding, the final
report. It pays most on plans, which are cheap to critique and expensive to
execute wrongly.

Four rules make the eyes actually fresh:

- **Separate context, not a second opinion from the same head.** An independent
  reader is a new `agent()` that has seen nothing but the draft. Every
  planner–reviewer loop keeps a persistent reviewer for continuity (§2), and
  then puts the final draft in front of a reviewer that has never seen an
  earlier round.
- **Ask for failures, not approval.** "Is this good?" gets a yes. "What would
  break this? What is missing? Restate the plan in your own words" gets
  findings. Write the ask so that approving takes evidence and objecting is the
  easy move.
- **Give the eyes the same evidence.** A reviewer judging a plan about code from
  its text alone can only judge coherence: tell plan reviewers to read the files
  the plan touches, and not to edit them.
- **Give a prose deliverable an independent read.** When the deliverable is text
  nothing else checked — a guide, an analysis — hand it, before the script
  returns, to a reader-proxy subagent asked what is unclear, what the text fails
  to support, and what the user will ask next; then fix those. Say it judges
  from the text alone — checking claims is a confirmer's job. A report whose
  findings were each confirmed (§10) has had its eyes; add no reader on top.

Three cautions. Correlated reviewers add little — same model, same prompt, same
blind spots — so give each a distinct lens. Bound it: one deliverable gets one
mechanism — a plan a reviewer who reads the code, findings a confirmer, prose a
reader; two is the ceiling, with a reason you can say. And these rules are about
the subagents *inside* the script, plus one read of your own script against the
request before submitting; at every `Promise.all` ask whether the next step
needs every item; where it does not, pipeline it (§7). The confirmation step
then puts the plan in front of the user.

## 4. Typed results

Pass a type argument to `ask` whenever your control flow will branch on the
answer; leave it off when you just want prose back. The type must be an
interface or type alias you write in the script (plain object types, arrays,
string-literal unions, `Record<string, T>`; anything else is a compile
diagnostic).

**JSDoc on a property becomes the field description the subagent actually
reads.** This is the cheapest quality lever in the whole surface and the
easiest to skip:

```ts
interface Finding {
  /** Workspace-relative path the problem is in. */
  path: string;
  /** One sentence: what is wrong, not how to fix it. */
  problem: string;
  /** How much it matters. Reserve "high" for data loss or a crash. */
  severity: "low" | "medium" | "high";
}
```

Without the comments you get whatever the subagent guessed `severity` meant.
Typed asks are validated against a schema derived from the interface; a failing
answer is re-asked once with the validation errors, then the run errors.

Keep results narrow: a result crosses a schema boundary and gets interpolated
into the next prompt, so a wide one costs tokens twice. **Pass paths, not file
contents** — a subagent has its own tools; a stringified 4000-line file spends
tokens on what it could have read.

## 5. Getting the world in

`files.glob` and `git.changedFiles` are how a script learns what to fan out
over; both are executed by the harness, recorded, and replayed on resume.

Caps **reject rather than truncate** (§16.2), so narrow the pattern instead of
fanning out over a silently partial view. Reads are catchable, so a coarser
fallback is a `catch` — which `git` needs, since every `git` call rejects
outside a repository:

```ts
let paths: string[];
try {
  paths = await git.changedFiles("origin/main");
} catch {
  paths = await files.glob("src/**/*.ts");
}
```

Reach for `files.read` or `files.grep` only when the *script itself* must shard
or branch on content; reading files is subagent work.

**`world.run` is the deterministic gate.** When a check is fixed and
machine-checkable — the build passes, the proof checks, the tests are green —
run it as code and branch on the exit code, instead of asking a subagent to run
it and trusting the claim:

```ts
const check = await world.run("lake", ["build"], { timeoutMs: 1_800_000 });
if (check.exitCode !== 0) feedback = check.stderr;
```

A nonzero exit code is a **value**, not an exception: read `exitCode` and carry
`stderr` forward as the next round's feedback, with no `catch`; rejections are
for the world failing to answer (spawn failure, timeout, output over the cap).
A test suite can print more than the 16 MiB cap: a gate that reads only
`exitCode` passes `{ output: "discard" }`, and a gate that hands the failure on
passes `{ output: { tail: 16_384 } }`. The command name must be a compile-time
string literal — or a top-level `const` bound to one (`const PY = "python3";
world.run(PY, [...])` resolves statically) — because the user approves the
script's command set at confirmation: interpolate paths, flags and round
numbers into the **args array**, never into the command (`let`/`var` and
computed values stay rejected). Open-ended editing belongs to a subagent;
`world.run` is for checks your control flow branches on.

**Choose the gate before you write it.** A gate decides exactly as much as the
check it runs. Before the first `world.run`, find out what checks the repository
has — `package.json` scripts, `Makefile` targets, the CI config, the README's
"run this to verify" line — and rank them by how much they decide: a unit suite
decides less than an end-to-end suite, which decides less than the acceptance
command the README names, and none decides a performance request the way the
bench does. Then build the gate in two tiers: the fast tier may drive a loop's
rounds; the **strongest** tier the request implies decides the exit and runs for
real at least once before the final `return`, even when the fast tier said yes.
Give a slow tier the `timeoutMs` it needs; a faster substitute is a different
check.

```ts
phase("Fix until the unit tests pass");
for (let round = 1; round <= 5; round++) {
  const unit = await world.run("npm", ["test"]);
  if (unit.exitCode === 0) break;
  await fixer.ask(`The unit tests failed:\n${unit.stderr}\nFix them.`);
}

phase("Run the end-to-end suite once before handing over");
const e2e = await world.run("npm", ["run", "e2e"], { timeoutMs: 1_800_000 });
const verified = e2e.exitCode === 0;
```

A check that exists in the repository and did not run is not "not covered"; it
is unverified work (§10).

## 6. Test the pieces before you commit

A workflow script is final at submit. The fixed logic inside it does not have
to be: run it through the `workflow_eval_snippet` tool first, synchronously and
without persisting anything. What passed there pastes into the workflow
verbatim. Send the snippet as `code`, or as `path` to a file holding it — the
second try then costs an edit.

Snippet work is the non-subagent part: what a glob really returns, whether a
grep pattern overruns its cap, how `world.run("lean", ...)`'s stderr parses,
whether a gate predicate does what you meant. A snippet has `files.*`, `git.*`,
`world.run` and `log`, but no `agent()`. Once you know which check decides the
result (§5), run it once here too: that shows its output, whether it exits
nonzero as you assumed, and how long it takes — the `timeout_ms` you write, not
a guess. Note that a snippet's `world.run` executes for real, with no
confirmation step.

## 7. Pipeline by default; join only where the next step needs every item

A workflow with more than one stage should run like a pipeline: every stage
works at the same time, and each item moves on the moment it is ready. A
reviewed file goes to its confirmer while the other files are still being
reviewed; a fact goes to its checker while the researchers are still reading.
Write it this way wherever the next step can take items one at a time, which is
nearly every hand-off. Let a stage wait for all of its items only where the next
step needs every one: a deduplication across files, a ranking on one scale, a
synthesis. Those are the barriers, and a script has few of them.

`Promise.all` is a join, and a join is a barrier: nothing after it starts until
the slowest item before it has landed. Parallelism comes from *not awaiting yet*:

```ts
// Concurrent: nothing is awaited until the join.
const all = await Promise.all(
  paths.map((p) => agent(`reviewer-${p}`).ask<Review>(`Review ${p}`)),
);

// Serial: each await blocks the next call. Only write this when you mean it.
for (const p of paths) results.push(await agent(`reviewer-${p}`).ask<Review>(`Review ${p}`));
```

**Decide, at every hand-off, how an item leaves its stage:**

| The next step takes | The stages | Write |
| --- | --- | --- |
| one item at a time | one to one: a reviewer per file, a confirmer per finding, a migrator per file and a checker per file | the stages chained per item inside one fan-out, one join at the end |
| one item at a time | a pool of shared workers serves a stage; items are still being found while the next stage works; a later stage sends work back; the stages read better as separate blocks | a `channel` between the stages, a `future` per stage |
| every item at once | deduplication, a ranking on one scale, a synthesis, the final report | a join, with a comment saying what needs every item |

**Chaining.** When two stages map one to one, a barrier between them makes
every worker of the second stage wait for the slowest worker of the first while
the run's concurrency slots sit idle. Chain the stages per item inside the
fan-out instead, and join once at the end:

```ts
// One join: each file's findings go to their confirmers the moment its review lands
// (two Promise.all — review every file, then confirm every finding — is the barrier).
const confirmed = (
  await Promise.all(
    paths.map(async (p) => {
      const review = await agent(`reviewer-${p}`).ask<Review>(`Review ${p}`);
      return Promise.all(
        review.findings.map((f, i) => agent(`confirmer-${p}-${i}`).ask<Confirmation>(`Reproduce: ${JSON.stringify(f)}`)),
      );
    }),
  )
).flat();
```

A shared, calibrated subagent is not a barrier: asks on it queue first in, first
out, so feed it each item as it lands and it stays consistent while the pipeline
keeps moving (§11).

One rejection inside `Promise.all` rejects the whole join and the sibling
results with it. When one bad item should cost one item, catch inside the
callback or use `Promise.allSettled` and read each outcome.

**Channels.** Chaining covers stages that map one to one. It cannot write a
stage served by a pool of shared workers, a producer still finding items while
consumers work, stages laid out as separate blocks, or a feedback loop to an
earlier stage. For those, a `channel<T>()` carries items between two stages and
each stage is a `future(async () => { … })`. An item sent into the channel is
taken by the next stage at once, by a worker that is waiting for it or by a new
one started for it:

```ts
const facts = channel<Fact>("facts");
const verified: Fact[] = [];

const research = future(async () => {
  phase("Research the topic from each angle");
  try {
    await Promise.all(
      angles.map(async (angle) => {
        const found = await agent(`researcher-${angle}`).ask<Research>(`Research ${angle}.`);
        for (const fact of found.facts) facts.send(fact);
      }),
    );
  } finally {
    facts.close(); // the producer side owns the close; a failed researcher still ends the stream
  }
});

const verify = future(async () => {
  phase("Check each fact as it arrives");
  await Promise.all(
    [1, 2, 3].map(async (k) => {
      const verifier = agent(`verifier-${k}`);
      for await (const fact of facts) {
        const verdict = await verifier.ask<Verdict>(`Does this hold? ${JSON.stringify(fact)}`);
        if (verdict.holds) verified.push(fact);
      }
    }),
  );
});

await Promise.all([research, verify]); // start every stage, then join once
```

The rules, in the order the code reads:

- **A stage is a future.** Its marker first, then the workers (a `Promise.all`
  over K `for await` loops on the input channel), then the output's `close()`
  in a `finally`. Start every stage, then join all of them once with
  `Promise.all`, with no `await` between.
- **A channel where the next stage should start before the previous one ends; a
  join where it needs every item.** Never a channel between two stages that
  need a barrier.
- **A new subagent per item inside a consumer is a `future` inside the `for
  await`**, pushed into an array and joined before the stage ends; without that
  join the stage ends when the channel closes with checks still running, and
  nothing reports it.
- **A cycle is counted.** A feedback channel has no single producer who knows
  when it is done, so keep one count of open work items: increment *before*
  finishing the item that produced the new work, close the feedback channel
  when the count hits zero, bound the loop with a depth field on the item
  (`{baseDir}/patterns.md` #12).
- **Pools trade cache reuse for consistency.** A pool of shared workers judges
  on one scale, but which item lands on which worker depends on timing, so an
  amendment that changes one upstream item misses the cache for the whole pool;
  a fresh `verifier-${fact.id}` per item misses only itself. `send` never waits
  (the buffer is unbounded); a channel nobody can send to any more fails the
  run as `ChannelDeadlock`.

**Keep the data flow visible.** The harness recovers the run's shape by reading
your code: plain variables, template interpolation and destructuring are traced
exactly.

## 8. Group the run into named phases

Phases are required. The user experiences a workflow through its phase list:
the compiled plan shows one entry per phase, and thirty steps is a plan nobody
reads. Cover the whole script — every stage gets a `phase("...")` marker at its
head:

```ts
interface Attempt {
  /** One sentence: the optimization this round is trying. */
  approach: string;
}

/** Total nanoseconds the bench reports, or Infinity when it printed none. */
function benchNanos(output: string): number {
  const match = /time:\s*([\d.]+) ns/.exec(output);
  return match?.[1] === undefined ? Number.POSITIVE_INFINITY : Number(match[1]);
}

phase("Measure today's baseline");
const baseline = await world.run("cargo", ["bench"], { timeoutMs: 1_800_000 });
const target = benchNanos(baseline.stdout);
const optimizer = agent("optimizer");

let winner = "none";
for (let round = 1; round <= 3; round++) {
  phase("Make one improvement");
  const plan = await optimizer.ask<Attempt>(
    `Round ${round}. Baseline timings:\n${baseline.stdout}\nMake one improvement.`,
  );

  phase("Check that the tests still pass");
  const check = await world.run("cargo", ["test"]);
  if (check.exitCode !== 0) continue;

  phase("Measure whether it is actually faster");
  const bench = await world.run("cargo", ["bench"], { timeoutMs: 1_800_000 });
  if (bench.exitCode === 0 && benchNanos(bench.stdout) < target) {
    winner = plan.approach;
    break;
  }
}

phase("Collect the final numbers");
const head = await world.run("git", ["rev-parse", "HEAD"]);
return { approach: winner, commit: head.stdout.trim() };
```

Five nodes, with the loop body two of them — and still five when the real
script grows to thirty steps: the user sees the story instead of a wall of
steps.

**Write the names for the user, not for the graph.** A phase name is a short
natural phrase saying what this stage accomplishes for the user, written in the
language the user is speaking in this session — "Research each changed file in
parallel", "汇总并产出最终报告" (§9). Names are compile-time string literals, so you
cannot number rounds by interpolation, and should not want to: two markers with
the same name are one phase, so a loop body stays one box across its rounds.

**Put the marker where the steps are.** A marker claims the rest of the block
it sits in, nested blocks and inlined helper calls included, so mark the block
where the `ask` and `world.run` calls actually live.

**Not inside a concurrent fan-out callback.** Twenty `map(async …)` callbacks
re-entering `phase("Review")` out of order would count every re-entry as a
round. A per-item pipeline (§7) is one phase named for what it does to each
item, with the markers at the top level around it.

**One marker at the head of each stage's future.** Concurrent stages written as
futures (§7) each open their body with their own `phase("...")`; still no marker
in the per-item callback or the `for await` body.

**Every phase should contain at least one `ask` or one `world.run`.** Plain
script logic — reading `args`, shaping a prompt, building the `return` — shows
no progress, so it is not a stage: fold it into the phase before or after it,
and open none for the setup at the top or the `return` at the bottom.

## 9. Write for the user

Six things you write are read by the user, not by the script: phase names,
subagent names, `log` lines, artifact titles and the markdown you publish, the
four report fields, and any question a subagent escalates. Write each one as
you would tell a colleague across the desk what is happening: what the work is,
in the user's words and language. The machinery — fan-out, gate, node, stage,
pipeline — is yours, not theirs, and so is the numbering.

| Read by the user | Write | Not |
| --- | --- | --- |
| Phase name | Review each changed file / 逐个检查改动的文件 | Fan-out review stage / 文件评审阶段 |
| Phase name | Check that the tests still pass / 确认测试仍然通过 | Gate: test verification / 执行测试验证任务 |
| Subagent name | Code reviewer / 代码评审员 | reviewer_2 / 节点3 |
| Subagent name | Benchmark runner / 跑基准测试的人 | runner / 子代理A |
| Phase name | Independent review of the final plan / 请没看过方案的人再审一遍 | Cold read of the plan / 冷读方案 |
| Subagent name | Independent reviewer / 独立评审员 | cold-reviewer / 冷眼评审 |
| `log` line | Reviewing 12 changed files / 正在检查 12 个改动的文件 | Fan-out sized: n=12 / 扇出阶段初始化完成 |
| Report conclusion | Two of the twelve files have real bugs, both in the parser. / 12 个文件里有 2 个有真问题，都在解析器里。 | The workflow executed successfully and produced findings. / 工作流已成功执行并生成结果。 |
| Artifact title | Review report / 评审报告 | report-artifact-v1 / 产物输出 |
| Escalation question | Should the threshold be 94 rather than 96? / 阈值应该是 94 而不是 96 吗？ | Requesting clarification regarding gate configuration parameters / 请求对门控配置参数进行澄清 |

The method names in this skill — fresh eyes, independent read — are idioms for
you, not words for the user: in Chinese that is 独立复核 or 换人复审, never 冷读 or
冷眼. The language travels through your asks: findings and summaries are
written by subagents answering the ask you wrote, so write asks in the user's
language, or say which language to answer in; otherwise a Chinese report
arrives wrapping English findings.

## 10. Verify, report, deliver

`log(...)` is narration for the human watching the run: after a fan-out is
sized, at the top of each loop round.

**Verify before you report, in proportion to what a wrong claim costs.**
Verification exists to buy down the cost of the user acting on something false,
so it goes where that cost is real: a bug they will fix, a security claim, a
number they will quote, a fact a decision rests on. Each finding of that kind
is confirmed independently before it reaches the user: a second subagent that
reproduces the finding from its evidence alone — reading the code, running a
check when one decides it, never editing — or a `world.run` command when one
can decide. The reviewer that found it does not confirm it. A finding that
fails confirmation is **kept and labelled** `unconfirmed`, never silently
dropped — a real issue the confirmer could not reproduce is still worth a
human's eyes, and the label tells the user "seen" from "suspected".

Three things that look like verification and are waste. A confirmer on a
finding a `world.run` already decided: the exit code is the confirmation;
record the command in `verified`. A confirmer on work nobody will act on as
fact — poems, brainstormed options, a first-draft survey — which gets at most
one independent read (§3). A suite run three times because the hunter, the
confirmer and the gate each ran it: a gate runs once, by the script, and the
asks say so ("the script runs the full suite after you; do not run it
yourself").

**Gate at the task's scale.** `verified` names the commands that actually
decided the result, and the reader holds them against what they asked for. A
unit suite in `verified` and the end-to-end suite in `notCovered` is an
unverified deliverable with a disclosure attached. `notCovered` is for what
*could not* be checked — no test exists, the environment lacks the tool, the
check needs something only the user has — never for a check that exists and was
skipped because it is slow. If the strongest check the request implies exists
and did not run, the run is not done: run it, or say in `conclusion` that the
work is unverified and why (§5).

**Salvage by report.** `report(...)` is not `log`: reported items are delivered
with the run's results **even when the run fails**, which is how a run that
dies on its twelfth task keeps eleven tasks' worth of work. Report each finding
the moment it lands — after its confirmation, with its status — rather than
accumulating an array to return at the end: the array is what you lose. Items
are recorded, so a resumed run never shows one twice.

**Stamp what outlives the run with `run.id`.** A ledger line, a file the script
writes for a later run, a report item someone will trace back: put `run.id` in
it, so the record names the run that produced it. Keep both `run.id` and
`run.resumedFrom` out of ask text, personas and `files`/`world` arguments.
Those are cache keys, and an amendment mints a new id, so an ask that quotes it
misses the cache and runs again.

**Deliver a report.** The script's final `return` is the handoff you present, in
the order below; what the user themselves keep is the artifact of the next
paragraph. Return this shape (copy the interfaces; they compile as-is) rather
than a bare array:

```ts
interface Finding {
  /** Workspace-relative path, with a line when it applies: "src/a.ts:42". */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the lines read, or the command and the output that proved it. */
  evidence: string;
  /** "verified" when an independent subagent or a deterministic check confirmed it; "unconfirmed" when confirmation failed or was not attempted. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}
interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

const result: WorkflowReport = {
  conclusion: "Nothing was reviewed: this snippet only shows the shape.",
  findings: [],
  verified: [],
  notCovered: ["everything — no subagent ran"],
};
return result;
```

Each field has a reader. `conclusion` is the answer to what the user asked.
`findings` carry their evidence and their status, so the user can tell what was
seen from what was suspected. `verified` says what this run actually checked and
how. `notCovered` says what it did not look at and why, which is the difference
between "we found nothing" and "we looked nowhere". Write all four in the
language the user is speaking in this session.

**Deliver artifacts.** The `return` is read by you, which retells it.
`artifact.*` is the other channel: things the *user* opens. On this host
artifacts land under `.zcode-workflow/artifacts/<runId>/` in the workspace —
`file` copies a workspace file (versioned per id), `markdown` publishes text
you composed, and the presets (`chart`/`table`/`metrics`/`board`) are fed by
`report(item, "<id>")` tags and recorded as a data file plus a rendered
markdown table (there is no live dashboard UI here; the data file is the
deliverable). Two habits:

- **Every run publishes its deliverable.** When the user asked for a thing — a
  webpage, a PDF — a subagent writes it into the workspace and returns the path
  ("write it to `out/…` and return the path" belongs in the ask), and the
  script publishes it with `artifact.file`; until it does, nothing the run left
  in the workspace exists for the user. When the user asked for an answer —
  findings, a review — the `return` is the compact handoff and the deliverable
  is the long form of the same facts: markdown built from the values the return
  is built from, published once, at the end. With more than one artifact, mark
  the deliverable `{ primary: true }`: the run's summary leads with it. One
  primary per run.
- **A preset is for the person watching the run.** Declare one when the run has
  state worth watching — the key number after each round, which items are done
  or failed: `report(item, "perf")` feeds it, and the data file grows live and
  survives a resume. A run that is over before anyone would look needs none.

**Show what matters.** Two tests decide what earns an artifact: would the user
open it on its own (else it is a section of the deliverable), and does it
repeat another artifact. The common run publishes one deliverable, one preset
when there is something to watch, and further files only when a subagent
produced something else a person opens.

**A rejected publish is a repair opportunity, not an error to swallow.**
Content publishes reject catchably — the file is missing, the path escaped the
workspace, the bytes are over the cap — and the honest response is to hand the
gap back to a subagent and publish again, rather than let a run end with
nothing the user can open:

```ts
phase("Hand the user the profile and the write-up");
try {
  await artifact.file("profile", "out/profile.html", { title: "Query profile after the last round" });
} catch {
  const profiler = agent("profiler");
  await profiler.ask("out/profile.html is missing. Profile the query path as it stands and write the profile there.");
  await artifact.file("profile", "out/profile.html", { title: "Query profile after the last round" });
}
```

Ids and the report tag are compile-time string literals: what a run can publish
is fixed when the user approves the script, and an id assembled at runtime is a
compile diagnostic. Publishing an id a second time mints the next version and
keeps the old one.

## 11. A complete example

The complete review workflow — a reviewer per changed file, triage through one
shared subagent that is fed as reviews land, a confirmer per kept finding
chained inside the same callback, one join for the cross-file deduplication —
is `{baseDir}/examples.md` §5; §7 and §10 carry its rules. The open-ended form
— a seed that surveys and ends in a tail hole, grown fill by fill — is
`{baseDir}/examples.md` #7 (§15).

## 12. Anti-patterns

| What you wrote | What it costs you |
| --- | --- |
| One subagent hoisted out of a fan-out for tidiness | The fan-out became a FIFO queue (§2) |
| One fixed name for every subagent in a fan-out | A literal duplicate fails compile, a computed one kills the run; name per item or stay anonymous (§2) |
| A fresh subagent each loop round | Round five re-learns what round four knew, at full price (§2) |
| An unbounded `while` | The run dies on the stall watchdog instead of finishing (§2) |
| Findings accumulated in an array, returned at the end | A failure on the last task loses them all; `report` as you go (§10) |
| A whole file interpolated into a prompt | Tokens spent on what the subagent's own tools read; pass the path (§4) |
| A wide `files.grep` with no glob | The call rejects; there is no partial result (§5) |
| A subagent asked to run the tests and say if they passed | A session paid for what `world.run` decides as code, and a claim it can fake (§5) |
| A `world.run` command name built at run time | Compile fails: the command is a literal; runtime values go in the args array (§5) |
| The gate written from habit, or only the unit tests gated | The project named a stronger check; survey its checks, and run the strongest one before `return` (§5) |
| A workflow submitted to see whether a parse function works | A full run for what `workflow_eval_snippet` answers now (§6) |
| An unguarded `.find()` / `.match()` result or optional property | Compile fails under `strict` (§16.3) |
| `Date.now()` / `Math.random()` / `fetch` / `fs` in ask-critical paths | Not replayable: those are not facade APIs; derive time from `world.run("date", [])` when a script must have it |
| An `await` per item in a loop with no ordering need | Serial wall-clock for concurrent work (§7) |
| A stage that waits for the whole previous stage though it handles items one at a time | Chain per item, or use a channel (§7) |
| A join with no comment saying what needs every item | On the next revision nobody can tell the barrier from a habit; say why, or pipeline it (§7) |
| A channel nobody closes | `ChannelDeadlock`; the producing stage closes it in a `finally` (§7) |
| An `await` between starting the stage futures and joining them | Start all, then join once (§7) |
| Phases or subagents named after the machinery ("fan-out", "文件评审阶段", "节点3"), or no markers | A plan that says nothing about the work, or thirty entries (§8, §9) |
| A reviewer asked "is this good?" | It approves; ask what would break it (§3) |
| Findings reported unconfirmed, or a slow existing check put in `notCovered` | The user cannot tell "seen" from "suspected", or verified from skipped (§10) |
| A bare array returned, or nothing published | You improvise the handoff and the user keeps nothing; return the report shape and publish the deliverable (§10) |
| A persona that says only "make the check pass" | Faking is the obedient reading of an impossible gate; tell it to escalate (§14) |
| A tunable constant interpolated into an ask | Amending it rewrites every such prompt and re-pays everything downstream (§13) |
| A wrong run left to finish, or stopped and left | `workflow_amend` it now, while it runs (§13) |
| A revised script pasted inline after a diagnostic | Twenty thousand tokens re-streamed to change one line; edit the named file and pass `path` (§13) |
| A hole for what an `if` or a subagent could decide, or one in a fan-out callback | A run parked on you for nothing; the fan-out case does not compile (§15) |

## 13. After you submit

`workflow_create` compiles first and returns a **plan** (phases, world.run
command set, named subagents) plus a `token`. **Diagnostics mean nothing
ran**, and they name the file your script is in: an inline `script` is written
under `.zcode-workflow/drafts/` before it is compiled and the result hands you
the path; a `path` submission is that file already. Each diagnostic reads
`{path}:L{line}:C{column} {message}`.

**Show the plan to the user, then start.** Present the phase list and —
whenever the command set is non-empty or the run will spend real money — get
the user's go-ahead, then call `workflow_create` again with `confirm: true` and
the same `token`/source. This two-step flow is this host's confirmation
window; the token expires after 30 minutes.

On a clean compile and confirmation the run starts in the background and you
get a run id. **Mount the status card before waiting** (§17): on a Control UI
session call `workflow_dashboard { run_id, live: true }` and then `show_widget`
exactly with its returned parameters (`pin: true`) — the panel renders the
phase board, the ask/report counters, recent logs and hole/escalation banners,
and refreshes itself while the run goes. On a chat-only surface call
`workflow_dashboard { run_id }` and hand the returned JSON to the core
`dashboard` tool (static snapshot; refresh by re-applying after each
`workflow_wait`).

**Wait, don't poll**: `workflow_wait` blocks until the run
settles (completed / errored / stopped / waiting_hole / waiting_question) and
returns the final `return` value and reported items. Do other work, unless the
user asked you to wait. `workflow_get` is the instant snapshot — pending
questions and holes included — when you must not block. `workflow_list`
enumerates the workspace's runs.

Read the terminal state precisely. A run ends in exactly one of these states:

- **completed** — the script returned.
- **errored** — the script itself failed (an uncaught throw, a cap it overran,
  an artifact whose source file was missing, an answer that failed validation
  twice). Replaying it would fail the same way, so `workflow_resume` refuses
  it; edit the run's script file, which the result names, and resubmit it with
  `workflow_amend` and `path`. For a transient failure (provider, host,
  authority) you may amend with the **unchanged** script: the finished work
  replays from the journal and only the rest re-runs.
- **stopped** — resumable as-is with `workflow_resume`. The stop reason says
  why: `user` (leave it alone unless they ask), `model` (you stopped it),
  `interrupted` (the gateway exited or a question was resolved; resume it).
- **waiting_hole / waiting_question** — the run is parked on you (§15, §14);
  fill or answer, and it continues.

Reported items come back on errored and stopped runs too.

**When the script itself was wrong, do not start over.** Any run — errored,
stopped, completed, or still running — can be superseded: edit the run's script
file and call `workflow_amend` with `run_id` and that `path`. The new run
imports the old one's finished work, matched per named subagent along its
sequence of asks, so every step you did not touch settles from cache and only
the changed part runs. This is the move after a script error, a bad prompt, or
a completed analysis that needs one more stage. Two things make the cache hit:
names that stay the same, and asks whose instructions stay byte-identical (an
upstream change cascades downstream).

**Every run remembers its script file, so a revision is an edit.** The run's
`scriptPath` names it, so the script never has to live in your context: edit it
in place and pass `path`; pass `script` only for something genuinely new. A
`path` whose bytes still equal what the run ran is refused as `script_unchanged`
only when that run already **completed** with the same settings (a full-cache
replay would change nothing). On an errored, stopped, interrupted or running
run the same bytes mean "restart with the cache": the finished phases settle
from the imported journal and the rest runs again.

**Repair a run while it is still going.** When a run is heading the wrong way,
do not wait for it and do not stop it first: call `workflow_amend` on it. The
tool stops the predecessor, imports everything that settled before the stop at
zero cost, and starts the revision — one call. The old run shows as
"superseded"; the result names both runs.

The cascade rule has a converse that decides whether revisions are cheap or
ruinous. Interpolating an upstream **result** into a prompt is safe: on resume
it replays byte-identical, so the prompt does too. Interpolating a script
**constant** is the opposite bet — constants are what an amendment tunes, and
every ask whose text mentions one forfeits its cache when you tune it, plus
everything downstream:

```ts
// ✗ Amending PASS_THRESHOLD (say 96 → 94) rewrites this text, so the resumed run
//   misses cache at the first revision and re-pays every ask after it.
draft = await writer.ask<Draft>(
  `Scored ${review.score}; passing needs ${PASS_THRESHOLD}. Revise: ${JSON.stringify(review.comments)}`,
);

// ✓ Only replayed upstream values and the fact that the branch was taken; amending
//   the threshold now moves only where the loop exits, and earlier rounds settle from cache.
draft = await writer.ask<Draft>(
  `The review did not pass. Address each comment: ${JSON.stringify(review.comments)}`,
);
```

Keep the tunable knobs — thresholds, round caps — in the script's control flow,
where amending them is free, and out of ask text, where it is a cache purge. A
subagent rarely needs the number; it needs the verdict and the feedback.

## 14. When a subagent escalates

Every ask carries an escalation clause: a subagent walled in by something not
its fault — a gate it cannot pass, two instructions no single output satisfies,
a fact only whoever started the run knows — answers
`{"escalated": true, "question": "...", "evidence": "..."}` instead of
fabricating. Nothing in the script switches this on.

**What reaches you.** The run settles as **waiting_question** carrying the
question id (`dwfq-...`), the subagent, the question and its evidence — check
`workflow_wait`'s return or `workflow_get`'s `pendingQuestions` for what a run
still owes you. Then decide which of two things is true:

- The question **has an answer** — a clarification, one missing fact, a
  tradeoff only you or the user can call. Answer it with
  `workflow_resolve_question` and that `question_id`. Your text is delivered
  into the subagent's session as the answer to its ask, and the run resumes
  from its journal at zero cost. Not sure of the answer yourself? Put the
  question to the user first, then come back — nothing answers in your place.
- The **script** is what is broken — a gate no output can pass, control flow
  routing work to the wrong subagent. No sentence fixes that. Edit the run's
  script file and call `workflow_amend` on it with that `path`; it stops the
  run for you. The escalation is what makes that amendment cheap: the ask that
  escalated never settled, so it sits exactly past the cache boundary —
  everything before it imports at no token cost, and it re-runs against the
  fixed script.

**Write personas that make honesty the cheap move.** A persona that says "make
the check pass" and stops there leaves faking a pass as the obedient reading.
One sentence closes that off: *"If a check is impossible to pass, or your
instructions contradict each other, escalate and say so plainly rather than
working around it."*

## 15. Holes: growing the workflow as the run learns

`hole<T>()` is the other mid-run request — §14 is the subagent's, this one is
yours. A script is what you know for sure; a hole is where knowing stops. Any
phase whose subagents, asks or gate you would have to guess is a hole: write
the part before the guess, end it in `hole<T>()`, and the run's findings write
the rest. A workflow whose shape the request fixes has no holes, and that is
fine too.

A subagent returns a **value**; a hole returns **code**. Ask a subagent when
the script already knows what to do with the answer and only the data is
missing. Leave a hole when what is missing is the rest of the workflow — which
phases come next, which subagents exist, what each is told, what gate runs.
*If you could write the code now and only the data is missing, it is not a
hole.*

| The unknown is… | Use |
| --- | --- |
| an answer the script knows how to consume | a subagent ask; fresh eyes if it is a judgment (§3) |
| a branch among outcomes you can enumerate now | a typed result and an `if` or a loop, in the script |
| what the remaining workflow should be, knowable only from findings | a hole |
| a question a subagent hits mid-task that only the run's owner can answer | escalation (§14) |

Subagents run without you, in parallel; a hole parks the run until you take a
turn (on this host the whole run parks — the fill then replays everything
before the hole from the journal at zero cost). Spend holes on shape, never on
answers.

Three forms; `T` is always written out:

```ts
const plan = await hole<Plan>("决定分组", `最慢的模块是 ${survey.slowest}`); // decide, then continue
return await hole<Guide>("第1步：决定导览结构", `盘点：${JSON.stringify(survey)}`); // tail: the rest is not written yet
const plan = await hole<Plan>("决定分组", `…`, async () => { /* filled: the body stands in for the hole */ });
```

- **The name is a phase name.** A literal, unique among the script's holes and
  phase markers (nested fills included), in the user's language: it labels the
  waiting state, the notification and the fill file. `T` is the contract the
  body is checked against.
- **The prompt is the one channel for values.** Interpolate what the decision
  needs; the fill reads values there and types from the code.
- **The body sees every binding declared before the hole, none after**, and may
  leave holes of its own.
- **Filled once, run per reach.** A hole in a loop or a helper is filled once
  and its body runs each iteration with that iteration's bindings. Never inside
  a fan-out callback (`.map` or another array-method body): the fill would be
  owed while the items already run.

### Grow by tail holes — the default for a task whose shape is not known upfront

When the request does not tell you the workflow — a repository to understand
before the work can be planned, a bug whose next step depends on what the last
one found — do not guess the topology. Write the part you know and end the
script with a tail hole. The script then grows by **nesting**: each fill is the
statements of the innermost body, does one step, and ends in the next tail
hole, until one returns instead.

```ts
// 0. The seed you submit: what is known, then a typed gap.
phase("盘点仓库顶层目录");
const survey = await agent("勘察员").ask<Survey>("列出顶层目录，各用一句话说明作用。");
return await hole<Guide>("第1步：决定导览结构", `盘点：${JSON.stringify(survey.dirs)}`);
```

```ts
// 1. After the first fill: the hole has a body — one step, then the next hole.
return await hole<Guide>("第1步：决定导览结构", `盘点：…`, async () => {
  phase("分章并行撰写初稿");
  const drafts = await Promise.all(
    survey.dirs.map((d) => agent(`写手·${d.path}`).ask<Chapter>(`写「${d.path}」一章：${d.purpose}`)),
  );
  return await hole<Guide>("第2步：审读与交付", `${drafts.length} 章初稿已就绪`);
});
```

```ts
// 2. After the second fill: the chain closes with a value, which is the run's result.
return await hole<Guide>("第1步：决定导览结构", `盘点：…`, async () => {
  /* step 1 as above; `survey` and `drafts` are in scope below */
  return await hole<Guide>("第2步：审读与交付", `…`, async () => {
    phase("独立审读并修订");
    const critique = await agent("审读员").ask<string>(`只凭文本挑毛病：${JSON.stringify(drafts)}`);
    const chapters = await agent("修订编辑").ask<Chapter[]>(`按意见修订：${critique}`);
    return { title: "仓库导览", chapters, notCovered: [] };
  });
});
```

You send only the innermost statements; `workflow_fill_hole` splices them into
the run's script and the result hands you the rewritten draft path, so the
draft you read before the next fill is the script that is running. The chain's
rules: a fresh name per step (`第N步：<what it does>`; a repeated name is a
diagnostic); the prompt is the progress ledger; results stay in bindings
(`survey`, `drafts`), because every inner body sees the ones around it; a step
may add phases, subagents and holes of its own. This is the normal way to run
a task whose shape only appears as the work proceeds, not a fallback.

### A stage shaped by discovery

The survey's *value* goes to the script as data; the fill writes the *topology*
of the next stage, which the survey decided: three reviewers or one, fanned out
or sequential, which check gates them.

```ts
const hot = await agent("剖析员").ask<Hotspots>("找出最慢的三个模块，说明各自的耦合。");
const reviews = await hole<Review[]>("怎么审查这些热点", `热点：${JSON.stringify(hot.modules)}`);
```

### A procedure decided at first sight, run every round

```ts
for (const failure of failures) {
  const triage = await hole<Triage>("每个失败怎么分诊", `第一个失败：${failure.name}\n${failure.output}`);
  report(triage);
}
```

Filled at the first failure, the body runs for every one after with that
round's `failure`. The fill is a *procedure* — which subagent to send, what to
ask, when to mark `unconfirmed` — not an answer about one failure; that would
be a subagent ask inside the loop.

### A remedy the plan could not enumerate

```ts
const gate = await world.run("pnpm", ["test"]);
if (gate.exitCode !== 0) {
  await hole<void>("测试没过怎么办", `退出码 ${gate.exitCode}：\n${gate.stderr.slice(0, 2000)}`);
}
```

**Not a hole:** a verdict, a summary, a choice among options, an answer per
item — those are subagent asks — and any branch an `if` over a typed result can
express.

**Filling one.** The waiting run carries the hole's site id (`hole#21b40fca`),
its name and type, and the prompt with its values in. Then:

1. Read the run's script around the hole: the body is compiled where the hole
   stands and sees what is declared above it.
2. Write only the statements — no `hole(...)` call, no arrow — returning a
   value of `T`, or ending in a new tail hole when the next step is not known
   yet; rehearse fixed logic in `workflow_eval_snippet` first (§6).
3. Call `workflow_fill_hole` with `run_id`, `hole_id` and `script` (or `path`).
   The run grows by the body and continues — everything before the hole
   replays from its journal at no cost; the response names the phases added.
4. Diagnostics mean nothing was spliced and the hole still waits: edit the fill
   file the response names and resubmit with `path`, never paste it again.

A fill that throws at run time ends the run errored unless caught; amend the
script as usual. Full scripts: `{baseDir}/patterns.md` #14–#16,
`{baseDir}/examples.md` #7.

## Going deeper

- `{baseDir}/patterns.md` — the topology catalogue. Its index puts the pipeline
  shapes first: per-item chaining, streaming through channels, a feedback loop
  with a counted close. Then fan-out/fan-in, review sweeps, planner-reviewer
  loops, judge panels, staged handoffs, bounded discovery, `world.run`-gated
  verifier loops, and the hole shapes. Read it when you know the shape you want
  and want it written correctly.
- `{baseDir}/examples.md` — complete worked scripts, including a two-subagent
  adversarial prove/disprove loop and a repository guide grown step by step
  through tail holes. Read one when you want to see a whole script's arc.

## 16. Tool reference

The authoring tools carry short descriptions on purpose; this section is the
part of their contract the descriptions do not carry. Read it before writing or
revising a script; the compiler holds you to it.

### 16.1 `workflow_create`

Typechecks the script; on a clean compile returns the plan (phases, world.run
command set, named subagents, holes) plus a confirm token; a second call with
`confirm: true` and the token starts the run in the background. Wait for it
with `workflow_wait`.

**Three sources; pass exactly one.**

- `script`: a one-off workflow written inline. It is saved to a file under
  `.zcode-workflow/drafts/` and the result names that file, compiled or not;
  revise it by editing the file and resubmitting with `path` (§13).
- `saved`: a workflow saved in this workspace, by name —
  `saved: { name: "pr-review", args: { pr: "123" } }`; arguments are validated
  against its declaration before anything runs. Check `workflow_list_saved`
  before writing one from scratch: a saved workflow the user kept beats a
  rebuilt one.
- `path`: a script file on disk, relative to the workspace or absolute —
  normally the file a previous result named.

**Fields.**

- `name`: a short label for the run in the user's language ("PR review",
  "代码评审"). Always pass it for an inline script; it labels the run everywhere
  and names its draft file. It defaults to the saved workflow's name.
- `max_concurrency`: an upper bound on how many subagent asks work at once.
  Omit it to use the tighter of `agents.defaults.subagents.maxConcurrent` and
  `maxChildrenPerAgent` (a per-agent `subagents` override wins). A number you
  set cannot go above that lane. Set it only when the user asks to limit
  parallelism.
- `subagent_model`: the model the subagents run on, as `providerId/modelId` or
  a bare model id. Set it only when the user asks for a specific model; never
  a provider the user did not name. On this host overrides additionally need
  the operator opt-in described in §2.

This tool starts a new run. To change a run that exists — errored, completed,
stopped or still running — call `workflow_amend` (§13), never
`workflow_create` again.

### 16.2 The facade

Every script and snippet is checked against these declarations — the same
constant the compiler is fed, so what you read here is what typechecks. Your
script defines plain interfaces and never uses `declare`.

```ts
/** The pending result of one ask. Await it, or pass it to Promise.all with others. */
declare interface Node<T> extends PromiseLike<T> {}

/** A model declared with model(). */
declare class ModelRef { private constructor(); private readonly modelRef: never }

/** Declare a model subagents may run on: "modelId" or "providerId/modelId". */
declare function model(id: string): ModelRef;

declare interface AgentPersona {
  /** System prompt describing the actor's role. */
  system?: string;
  /** Model id literal or ModelRef; omitted = the run's subagent model. */
  model?: ModelRef | string;
  /** WebSearch calls per ask (recorded, not enforced on this host). */
  budget?: { webSearch?: number };
}

declare interface Agent {
  /** One task; with a type argument the answer is a validated value of T. */
  ask<T = string>(instructions: string): Node<T>;
}

declare function agent(name?: string, persona?: string | AgentPersona): Agent;

declare const args: Readonly<Record<string, unknown>>;
declare const run: { readonly id: string; readonly resumedFrom?: string };
declare function log(message: string): void;
declare function report(item: unknown, artifactId?: string): void;
declare const artifact: {
  file(id: string, path: string, opts?: ArtifactFileOptions): Promise<ArtifactRef>;
  markdown(id: string, content: string, opts?: ArtifactOptions): Promise<ArtifactRef>;
  chart(id: string, spec: ChartSpec): void;
  table(id: string, spec: TableSpec): void;
  metrics(id: string, spec: MetricsSpec): void;
  board(id: string, spec: BoardSpec): void;
};
declare function phase(name: string): void;
declare function hole<T>(name: string, prompt?: string): Promise<T>;
declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;
declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;
declare const files: {
  glob(pattern: string): Promise<string[]>;
  read(path: string): Promise<string>;
  grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
};
declare const git: {
  changedFiles(base?: string): Promise<string[]>;
  diff(base?: string, path?: string): Promise<string>;
  status(): Promise<GitStatus>;
  log(count?: number): Promise<GitCommit[]>;
};
declare const world: {
  run(cmd: string, args?: string[], opts?: { timeoutMs?: number; output?: "full" | "discard" | { tail: number } }): Promise<WorldRunResult>;
};
declare interface Channel<T> extends AsyncIterable<T> {
  send(item: T): void;
  close(): void;
}
declare function channel<T>(name?: string): Channel<T>;
declare function future<T>(body: () => Promise<T>): Promise<T>;
```

Caps: glob 2000 files; grep 2000 matches / 256KB; read 2MB; diff 512KB; log 100
commits; world.run output 16MiB (`full` rejects over it; `discard` and
`{ tail: n }` shape it); artifacts 32 ids / 16 versions / 20MiB per file /
256KB per markdown. Caps reject rather than truncate.

### 16.3 Rules the compiler enforces

- Plain TypeScript. Define result types with a plain `interface Foo { ... }` or
  `type Foo = ...` and pass them as `ask<T>` type arguments. Supported in
  result types: primitives, string-literal unions, arrays, nested objects,
  optional properties, `Record<string, T>`; anything else is a diagnostic.
- Compiled under `strict`: `.find()`, `.match()`, `Map.get()` and optional
  properties yield `T | undefined` and must be guarded before use; plain
  `items[i]` indexing needs no guard.
- No `declare` modifier, no `export`, no `import` statements. No Node or web
  APIs: `process`, `fetch`, `fs` do not exist and fail typechecking.
- Top-level `await` and a final `return <value>` are allowed; the returned
  value is exactly what `workflow_wait` carries back.
- `world.run`'s first argument must be a compile-time string literal — the
  script's command set is in the plan the user confirms. A nonzero exit code
  comes back as a value, not an exception (§5).
- `hole<T>()`: explicit type argument; a literal name of at most 128
  characters, unique among the script's holes and phase markers; never inside
  an array-method fan-out callback (a `for...of` body is fine).
- Phases are required (§8): cover the script with `phase("...")` markers; the
  name is a compile-time string literal and the call a standalone statement;
  two markers with the same name are one phase.
- Subagent names: unique within the run — a literal duplicate fails compile, a
  computed one fails the run. Keep names stable across revisions, and give
  duplicates in a loop their own computed names.
- Artifact ids and the `report` tag are compile-time literals; one id belongs
  to one artifact kind; at most one artifact carries `primary: true`; presets
  are declared at the top level, not inside a loop, callback or branch.
- `channel`, `future`, `Channel.send` and `Channel.close` are facade
  callables: call them directly. `send` after `close()` throws `ChannelClosed`,
  catchable. Stalls fail the run: `ChannelDeadlock` when receivers wait on
  channels nothing can send to any more (naming each), a stall error when some
  other promise can never settle.
- On diagnostics, edit the file the result names and call the tool again with
  `path`; never paste the script a second time.

### 16.4 `workflow_amend`

Revises an existing run: it starts a new run that supersedes the old one and
imports its finished work as a cache, so only what you changed is paid for
again (§13 has the rules). It works on any run of this workspace — completed,
errored, stopped or still running; a running predecessor is stopped and
superseded in the same call. To continue a stopped run unchanged, use
`workflow_resume`.

**Fields — every field you omit keeps the predecessor's value.**

- `run_id` (required).
- `path` or `script`, never both. `path` is the usual form: the run's
  `scriptPath` after an edit — pass the same path back. A file whose bytes you
  did not change is refused (`script_unchanged`) unless the call also changes
  `max_concurrency` or `subagent_model`; nothing is stopped and nothing is
  created. Omit both to keep the predecessor's script byte for byte and change
  only the settings below.
- `name`: a new display label.
- `max_concurrency`: omit to keep, `null` to remove, a number to change.
- `subagent_model`: omit to keep, `null` to return subagents to the configured
  default, a model id to change.

**How the cache works.** Named subagents are matched by name across the two
scripts; each one's asks are matched in order by byte-identical instructions. A
match settles from the journal at zero tokens; a changed or added ask runs
live. The cache stays open until a live ask completes or a live `world.run`
executes: from that moment, cached world reads and cached asks would describe
a workspace that may no longer exist, so they run live too. Editing an ask's
text is how you force it to run again.

### 16.5 `workflow_save`

Saves a script with its metadata so it can be rerun by name — through
`workflow_create`'s `saved` source, discovered with `workflow_list_saved`.
Definitions go in `.zcode-workflow/saved/<name>.dwf.ts` inside the workspace.

**When to call it.** Never unsolicited: saving writes a file into the user's
workspace; that is their decision. When a workflow you just built looks
reusable, suggest saving it in prose, then stop and wait. Call only after the
user agrees, or when they ask directly ("save this workflow", "保存这个工作流").

**Fields.** `name` (file-safe identifier); `description` (required) and
`when_to_use`, written for a reader who has not seen this conversation;
`scope` (`project` when the script references this repository's files, commands
or layout; `global` otherwise — on this host both save into the workspace's
`.zcode-workflow/saved/`); `script` or `script_path`, never both —
`script_path` saves a draft a result named without re-emitting it, dropping any
metadata block in that file; `args`: name exactly the values that would change
between runs — a PR number, a directory, a depth — each with a `type`
(`string`, `number`, `boolean`, `json`), optionally `description`,
`required: true` and `default`; every future call is validated against them.
Diagnostics mean nothing was written.

### 16.6 `workflow_eval_snippet`

Compiles and runs a small snippet synchronously against the same compiler,
sandbox and world-read path a real run uses, and returns the result in the
tool call. Nothing persists. It is the test bench of §6.

- `code` or `path`, never both; `timeout_ms` default 60000, max 600000.
- The snippet facade is the `args`, `run`, `log`, `files`/`git`, `world.run`,
  `channel` and `future` parts of §16.2; `agent()`, `report()`, `artifact.*`,
  `hole()` and `phase` do not exist here and fail typechecking. Top-level
  `await` and a final `return <value>`; the returned value is serialized into
  the result — return a summary, not a dump; over 256KB fails the call.
  `log(...)` lines come back in order. A snippet's `world.run` executes for
  real, with no confirmation step (§6). On diagnostics nothing ran.

### 16.7 `workflow_fill_hole`

Writes the body of a hole a run is waiting at (§15). It splices the body into
the run's script, compiles the whole thing, and continues the run — everything
before the hole replays from the journal at no cost.

- `run_id` and `hole_id` (the site id `hole#...` or the hole's name).
- `script` or `path`, never both: the body's statements only. An inline
  `script` is written to a fill file under `.zcode-workflow/drafts/` when it
  has diagnostics, and the result names it; `path` is that file after an edit,
  and bytes equal to the last rejected attempt are refused as `fill_unchanged`.
- The body is compiled where the hole stands, against the whole script; on
  diagnostics nothing was spliced and the hole still waits. A body may end in
  a new tail hole instead of returning.

### 16.8 The runtime tools

- `workflow_wait { run_id, timeout_ms? }` — blocks until the run settles;
  default budget 300000ms, max 1800000ms.
- `workflow_get { run_id, include_logs? }` — instant snapshot: state, phases,
  scriptPath, pendingQuestions, pendingHole, reported items, logs tail.
- `workflow_list {}` — the workspace's runs, newest first.
- `workflow_stop { run_id, reason: "user" | "model" }` — stop a run; reported
  items survive.
- `workflow_resume { run_id }` — resume a stopped/interrupted run unchanged;
  its journal replays everything that settled.
- `workflow_resolve_question { question_id, answer }` — §14.
- `workflow_dashboard { run_id?, live? }` — §17: by default returns exact core
  `dashboard` `widget_put` parameters for a native `session:report` card (call
  `dashboard` with them in the same turn). With `live: true` returns `show_widget`
  parameters for the self-refreshing Control UI panel.

Everything the run leaves behind is in the workspace: run records and journals
under `.zcode-workflow/runs/`, artifacts under `.zcode-workflow/artifacts/`,
drafts under `.zcode-workflow/drafts/`, saved definitions under
`.zcode-workflow/saved/`.

## 17. The status surfaces: live panel or native card

ZCode shows a run's phase graph while it executes. This host has two equivalents;
pick by surface, not by taste:

- **Control UI session → the live panel.** `workflow_dashboard { run_id, live: true }`
  returns exact `show_widget` parameters: `pin: true`, grant
  `zcode-workflow.runs`, and `widget_code` from `skills/workflow/dashboard.html`
  with the run id injected. Call `show_widget` with that JSON once. The panel
  then polls the plugin's `zcode-workflow.dashboard` gateway method through the
  widget bridge every 2.5s and re-renders itself — phase board, ask/report
  counters, recent logs, hole/escalation banners, errors and conclusion — with
  no further turns from you, including after your turn ends and the run keeps
  going in the background. It also self-heals to the newest run when the id
  placeholder was not injected.
- **Chat-only surface (or a plain snapshot) → the native card.**
  `workflow_dashboard { run_id }` returns the exact core `dashboard` parameters:
  `action: "widget_put"`, `pluginKind: "session:report"`, stable `name`
  `zcode-workflow-status-<runId>`, `props.blocks` with metrics, phase table,
  recent logs, hole/question text and conclusion. The Control UI draws it from
  the board snapshot — no HTML document, no widget sandbox, no loopback port —
  so Tailscale and other remote clients can see it. A native report is a
  **snapshot**: it updates only when `dashboard` writes new props, so after each
  `workflow_wait` return call `workflow_dashboard` again and re-apply the params
  (reuse the same `name`) to refresh it.

Neither surface mounts itself: relay the returned JSON to `show_widget` / the
core `dashboard` tool in the same turn. Use at most one surface per run.

## 18. Background runs: fire, end the turn, recap automatically

`workflow_create` already runs the workflow in the background. You do **not**
need to block the conversation with `workflow_wait` unless the user is actively
waiting for the result. To "confirm the launch, end the turn, and come back
with a recap when the run settles":

1. `workflow_create` → keep the returned `run_id` (`state=running`).
2. Schedule a one-shot self-wakeup with the core `automations` tool:
   ```
   automations {
     action: "add",
     job: {
       name: "workflow-recap-<runId>",
       schedule: { kind: "at", at: "<now + 3 min, ISO-8601>" },
       sessionTarget: "current",
       deleteAfterRun: true,
       payload: {
         kind: "agentTurn",
         message: "调 workflow_get {run_id:\"<runId>\"}。state=completed → 向用户总结 result 与关键 journal/ artifact；errored/stopped → 报告错误原文。仍 running/waiting_* → 调 automations {action:\"next_check\", in:\"2m\"} 续等（同一任务自动重挂）。"
       }
     }
   }
   ```
3. End the turn with one line: launched, will recap automatically.
4. The watcher turn runs in this same conversation: `workflow_get`, then recap
   (or `next_check in:"2m"` to rearm the same one-shot job while still running;
   `deleteAfterRun` cleans the job up once the recap turn completes).

Long runs: set the first `at` generously (expected duration + margin); the
`next_check` rearm loop handles overshoot. Never `exec sleep` or busy-poll
`workflow_get` in the main turn. `workflow_wait` remains right when the user
explicitly wants the answer in this turn (timeout still returns a snapshot).
