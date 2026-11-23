# Learnings

Append structured entries:
- LRN-YYYYMMDD-XXX for corrections / best practices / knowledge gaps
- Include summary, details, suggested action, metadata, and status
\n## LRN-20261123-001 OpenClaw plugin authority model (verified in dist 2026.11.5)\n- Tool execute() runs inside withGatewayToolCallerIdentity(turn); AsyncContext propagates it into every continuation, so background promise chains keep a dead authority after the turn ends.\n- Supported detachment: api.lifecycle.runInBackgroundContext (managed instances) = runInDetachedAsyncContext + registry gateway resolver; dispatches then run as system actor like hook/cron turns.\n- session:report cards are immutable board snapshots; only a new widget_put updates them. Live UI for third-party plugins = html widget + dashboard.dataBindings poll via openclaw.data.read.\n- Plugin subagent model overrides outside an authorized request scope require plugins.entries.<id>.subagent.allowModelOverride: true.\n- Status: applied in 0.1.4 (runner detach + live widget restore + amend restart semantics + const-literal resolution).

## LRN-20261123-002 复活被否决方案前先核对否决原因
- Correction: Issue 2 修复恢复了 live HTML 卡（iframe+数据绑定），但 2026-11-19 该方案正是因 iframe/沙箱端口在本环境加载不了而被否决换成原生卡的
- Lesson: 重新启用历史上被否决的方案前，先确认当初的否决原因是否已消失；原因未消失或不确定时问用户，而不是默认"旧限制已过时"
- Action: 已回退（原生卡恢复、serve 规则撤销），SKILL/tools.ts 指引改为"原生卡默认，live 需沙箱可达"
