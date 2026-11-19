# ZCode Workflow — OpenClaw 插件

把 ZCode 的「程序化约束的工作流（dynamic workflow）」能力完整迁移到 OpenClaw：用一段类型受约束的
TypeScript 脚本编排子代理（typed results、phase 阶段图、channel 管线、world.run 确定性门控、
hole 中途留白、artifact 交付），由 `/workflow` 技能命令触发，配套迁移了完整的 authoring skill 包。

```
/workflow 用三个子代理评审这次改动……
```

模型加载 `skills/workflow/SKILL.md`（迁移自 zcode dynamic-workflows 的完整写作契约），按契约写脚本，
调用 `workflow_create` 编译并确认，run 在后台执行并落 journal，`workflow_wait` 阻塞取回最终 return 值。

## 组成

| 部分 | 说明 |
| --- | --- |
| `src/engine/facade.ts` | 工作流 facade 的 ambient 声明（`agent/phase/hole/channel/future/world/files/git/report/artifact`），迁移自 ZCode SKILL.md §16.2，另有 snippet 子集 facade |
| `src/engine/compile.ts` | 编译器：对 facade 做 strict 类型检查；规则诊断（9002 重名子代理 / 9003 world.run 命令字面量 / 9004 phase 规则 / 9009 缺 phase / 9012 hole 规则 / 9015 不支持的 ask 类型…）；`ask<T>` 从脚本自己的 interface 推导 JSON schema 并作为字符串实参注入；hole 填充体按精确位置拼进调用 |
| `src/engine/runner.ts` | `node:vm` 沙箱执行（facade 是仅有的全局）；channel/future 以 guest 端 prelude 实现（跨 realm async iteration）；120s 无进展看门狗 → `ChannelDeadlock` / `ScriptStalled`；run 生命周期（running / completed / errored / stopped / waiting_hole / waiting_question / superseded） |
| `src/engine/agents.ts` | 子代理层：每个 `agent()` 映射一个持久的 OpenClaw 后台子代理会话（`api.runtime.subagent.run/waitForRun`），ask 保持上下文跨轮复用；信号量并发上限 |
| `src/engine/journal.ts` | 每 run 一个 append-only JSONL journal：ask 按「具名子代理 + 顺序索引 + 字节相同 instructions」命中缓存，world/files/git 按操作键命中；缓存开放到首个 live ask / live world.run 为止（保守版 cache 边界） |
| `src/engine/world.ts` | 只读世界：glob（≤2000）/grep（≤2000 行、256KB）/read（≤2MB）、git 只读视图（status/changedFiles/diff≤512KB/log≤100）、world.run（无 shell、16MiB cap、discard/tail、timeout），超限拒绝而非截断 |
| `src/engine/artifacts.ts` | artifact：file/markdown 版本化落 `.zcode-workflow/artifacts/<runId>/`；chart/table/metrics/board 预设由 `report(item, id)` 喂成 data.json + 渲染 markdown |
| `src/engine/store.ts` | 落盘布局（见下）；saved workflow（`/* zcode-workflow` 元数据块 + 参数声明校验） |
| `src/engine/dashboard.ts` | 仪表盘快照读取器：meta + journal 尾部 → run 状态 JSON，再编成原生 `session:report` blocks |
| `src/tools.ts` + `src/index.ts` | 13 个模型工具 + `zcode-workflow.dashboard` gateway 方法（入口 `defineToolPlugin` 声明静态 authoring metadata，register 包装保住 dashboard 绑定校验） |
| `skills/workflow/` | 迁移的 skill 包：`SKILL.md`（写作契约全文改编 + §17 仪表盘章节）、`patterns.md`（拓扑目录）、`examples.md`（完整示例）、`dashboard.html`（状态面板 widget） |

### 工具面（对应 zcode 工具）

| OpenClaw 工具 | zcode 原名 |
| --- | --- |
| `workflow_create`（编译→计划→token 确认→后台启动） | `CreateWorkflow` |
| `workflow_wait` / `workflow_get` / `workflow_list` | `TaskOutput` / `GetWorkflowRun` / `ListWorkflowRuns` |
| `workflow_amend`（supersede + journal 缓存导入） | `AmendWorkflow` |
| `workflow_resume` / `workflow_stop` | `ResumeWorkflowRun` / `TaskStop` |
| `workflow_fill_hole`（填充体按名拼接→整体重编译→journal 重放续跑） | `FillWorkflowHole` |
| `workflow_resolve_question`（答案送入子代理会话，作为该 ask 的结果入 journal） | `ResolveWorkflowQuestion` |
| `workflow_eval_snippet`（同步、零持久化、snippet facade） | `EvalWorkflowSnippet` |
| `workflow_save` / `workflow_list_saved` | `SaveWorkflow` / `ListSavedWorkflows` |
| `workflow_dashboard`（直接推送原生 `session:report` 状态卡，不走 iframe） | zcode 确认对话框的实时 phase 图（宿主侧等价物） |

### 实时状态卡（原生 session:report，不走 iframe）

run 启动后模型按 SKILL §17 调 `workflow_dashboard { run_id }`，再把返回的 JSON
原样交给核心 `dashboard`（`action: "widget_put"`，`pluginKind: "session:report"`）。
Control UI 用 `<openclaw-report-widget>`（previewSafe）直接画 props，没有文档框，
也不访问 widget 沙箱端口，所以 Tailscale 远程客户端能打开。

第三方插件不能调用 `runtime.gateway.request`（仅 bundled / trusted official），
因此插件不自己写看板。`workflow_wait` 返回后再次 `workflow_dashboard` 并复用同一
widget name 刷新。`skills/workflow/dashboard.html` 已退役：它的沙箱 origin 只有
本机回环能直达。

### 落盘布局（都在 agent 主 workspace 下）

```
.zcode-workflow/
  runs/<id>/meta.json · script.ts · journal.jsonl · fills/<hole>.ts
  drafts/…            # 内联提交的脚本落这里，诊断都指到该文件
  saved/<name>.dwf.ts
  artifacts/<id>/…
```

## 构建与安装

```bash
npm install
npm run build            # tsc → dist/
openclaw plugins build --entry ./dist/index.js   # 生成/校对 manifest（保留 skills 字段）
openclaw plugins validate --root . --entry ./dist/index.js
openclaw plugins install . --force               # 装进运行中的 Gateway
openclaw plugins inspect zcode-workflow --runtime
openclaw skills list | grep workflow             # /workflow 命令来源
```

引擎冒烟（不依赖 OpenClaw，使用假子代理运行时）：

```bash
node test/smoke.mjs
```

覆盖：编译器接受/拒绝各规则、snippet eval（glob/grep/world.run/channel 管线）、完整 run
（typed ask 校验 + artifact 发布 + journal）、hole 等待→填充→journal 零成本重放。

## 真机验证记录

`openclaw agent -m '/workflow 用一个子代理问……'` 完整走通：
模型按契约写出脚本 → `workflow_create` 计划/确认 → 后台 run → 子代理会话回答 → `workflow_wait`
返回。run 记录：

```json
{"id":"dwf-13465aea48ad","name":"天空颜色冒烟测试","state":"completed",
 "phases":["回答天空颜色"],"agentNames":["问答员"],
 "result":{"conclusion":"晴天时天空通常是蓝色的。"}}
```

## 与 zcode 实现的差异（v1 简化）

- **确认窗口**：宿主无插件的交互确认 UI，改为两步调用（首次返回计划 + token，带 `confirm: true` 再次调用启动），技能要求模型把计划呈现给用户。
- **完成通知**：无推送通道，用 `workflow_wait` 阻塞等待 + `workflow_get` 快照代替。
- **dashboard 卡片**：chart/table/metrics/board 预设落为 data.json + 渲染 markdown，无实时卡片 UI。
- **升级问题（escalation）**：子代理无法中途发问；ask 的提示约定在无法诚实完成时返回 `{"escalated":true,...}`，run 落 `waiting_question`，`workflow_resolve_question` 把答案送进该子代理会话并作为该 ask 的结果入 journal，随后重放续跑（语义与 §14 一致，机制是整 run 重放）。
- **hole 停靠粒度**：zcode 只停靠该分支；本实现整 run 进入 `waiting_hole`，填充后从 journal 重放，已结算步骤零成本（效果等价，代价是多一次重放）。
- **amend 缓存边界**：保守化——首个 live ask 完成或 live world.run 执行后，后续一律实跑（zcode 只在子代理首次写工作区后失效）。
- **预算/模型**：`persona.budget.webSearch` 记录但不强制；子代理模型 override 需要
  `plugins.entries.zcode-workflow.subagent.allowModelOverride: true`（OpenClaw 策略）。
- **同一 run 内重复的相同 world.run 调用**会命中同键 journal（zcode 按调用位置记录）；正常脚本中首个 live ask 后缓存即关闭，影响面很小。

## 设计说明

- **重放即恢复**：resume、amend、fill hole 全部走同一条路——重新执行有效脚本，journal 把已结算的
  ask/world/files/git 以零成本喂回。hole 填充体通过编译期位置拼接成为脚本的一部分，因此
  「有效脚本」就是磁盘上的 `script.ts` + `fills/*`。
- **`ask<T>` 的类型即 schema**：编译期从脚本自己的 interface/type alias 推导 JSON schema（原始类型、
  字符串字面量联合、数组、嵌套、可选、`Record`），以字符串字面量注入调用点；运行时回复解析失败
  或校验失败带错误重问一次，再失败 run 报错。`ask<string>`/缺省为纯文本回复。
- **vm 即边界**：脚本是模型写的代码，沙箱只暴露 facade 与纯 JS 内建；无 fs/process/fetch。
  world.run 命令必须是编译期字面量，构成用户确认的命令集，运行时再校验一次。
