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
