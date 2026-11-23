# ZCode dynamic-workflows skill（原样副本）

ZCode 服务端内置的 workflow skill，原样复制，作为本项目的参考基线。

- 来源：`~/.zcode/server/releases/3.19.0-linux-x64-60f71efd6a01/runtime/packages/bundled-skills/skills/dynamic-workflows`
- 版本：ZCode 3.19.0
- 复制时间：2026-11-19
- 内容：`SKILL.md`（authoring 契约）、`patterns.md`（拓扑目录）、`examples.md`（完整示例）

与项目内的 `skills/workflow/` 的关系：后者是从本副本**改编**而来的 OpenClaw 版本——
工具名换成 `workflow_*`、`${ZCODE_SKILL_DIR}` 换 `{baseDir}`、确认窗口/面板/升级问题等
宿主差异按 OpenClaw 实际行为重写（见 `skills/workflow/SKILL.md` 与根 README 的差异章节）。
本副本不参与插件注册，仅作对照。
