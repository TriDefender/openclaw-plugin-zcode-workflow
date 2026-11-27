# Errors

Append structured entries:
- ERR-YYYYMMDD-XXX for command/tool/integration failures
- Include symptom, context, probable cause, and prevention

## ERR-20261123-001 zcode-workflow: background run dies with SessionMutationAuthorizationChangedError
- Symptom: background workflow run errors at the next subagent ask after the originating agent turn ends
- Context: OpenClaw 2026.11.5, zcode-workflow pre-0.1.4, webchat agent turns
- Cause: runner.start() launched the background chain inside the turn's gateway tool-caller AsyncContext; turn end revoked that authority
- Prevention: wrap background execution in api.lifecycle.runInBackgroundContext (fixed in 0.1.4); fall back to default model when subagent model override is rejected in detached context

## ERR-20261123-002 workflow_create report() 参数顺序
- Symptom: compile error "report()'s artifactId must be a compile-time string literal", position lands on the second argument
- Cause: facade signature is report(item, artifactId?) — value first, id second; putting the id first pushes the value expression into the artifactId slot
- Fix: write report(valueExpression, "artifact-id"); also note the artifact id must be pre-declared via artifact.chart/table/metrics/board before report() tags items at runtime

## ERR-20261123-003 workflow_dashboard live → show_widget 参数提取
- Symptom: show_widget rejects with "title: must have required property 'title'"
- Cause: workflow_dashboard {live:true} returns a text note; the real show_widget parameters sit in a fenced \`\`\`json block inside it
- Fix: extract with /\`\`\`json\n([\s\S]*?)\`\`\`/, JSON.parse, pass the parsed object as-is

## ERR-20261123-004 dashboard widget iframe ERR_CONNECTION_REFUSED（回归）
- Symptom: 用户浏览器里 board HTML widget 整帧显示 scarpa-flow.tailb773cc.ts.net 拒绝连接
- Cause: live HTML 卡渲染在 mcp-app-sandbox iframe（sandboxPort 18790，仅 loopback）；本环境 Control UI 走外部 tailscale serve（gateway.tailscale.mode=off），只有 443/8443→18789 两条路由，18790 无路由
- Facts: `tailscale serve --https=18790` 能注册声明（serve status 可见）但 tailscaled 从未监听 18790（netstat 无 LISTENING；443/8443 均正常监听，说明自定义端口本身可绑，原因未深查）
- Decision: 用户重申 2026-11-19 的决策——原生 session:report 卡为默认，iframe+HTML 路线弃用；已撤 serve 规则并恢复原生卡。live:true 保留为沙箱可达环境的选择项

## ERR-20261123-005 插件 API 路径写错一层导致静默无效（api.system vs api.runtime.system）
- 现象: notify:true 装配成功（meta.json 有 sessionKey）、run 正常完成，但零推送；日志无任何 admit/reject/warn。
- 根因: armSessionNotify 与 runnerOf 读 `(ctx.api as ToolHostApi).system`，真实切片在 `ctx.api.runtime.system`（core dist channel-*.mjs:901 可证）。undefined → 守卫静默早退。自己代码注释里明明写着 api.runtime.system。
- 教训: 接线前用 core dist 里的真实访问路径做对照（grep 一行即可），不要凭注释/记忆拼 API 树；静默守卫要配合"启动消息回报 armed/unarmed"才可诊断。

## ERR-20261123-006 语句式脚本顶层 return 不等待 ask()
- 现象: `phase("x"); const r = agent("a").ask(...); return {r}` → run 3ms 即 completed，ask fire-and-forget 之后落地，结果序列化为 {}。
- 根因: 顶层语句不隐式 await ask()；箭头函数体（phase 第二参在旧版可行）或显式 await 才会等待。
- 教训: 探针/示例脚本一律显式 await ask()，或回到编译器接受的函数体形状；验证 run 结果非空才算 ask 真正执行。

### ERR-20261127-002 插件重载在回合中段被拒
- 现象: dispatch_action plugins {action:"reload", pluginId:"zcode-workflow"} 在回合中段返回 UNAVAILABLE: Plugin cannot replace itself from its own active turn; retry after the turn finishes。
- 原因: 网关禁止插件在它自己的活跃回合内自替换；此前的成功案例都是把 reload 作为回合收尾动作或回合结束后执行。
- 处置: 把 reload 放在回合最后一步发出，或回合后由 automations 一次性任务（sessionTarget 本会话）重试；重载结果以新消息形式返回。
