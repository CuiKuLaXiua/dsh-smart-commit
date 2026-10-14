# Changelog

## [0.2.0] - 2026-10

### Added
- 客户端贡献命令面（开放 API `ctx.commandUi.register`）：`/` 菜单中四个命令
  与官方命令同款显示（图标 + 本地化名称 + 英文名 + 描述）
- host 路由 `POST /smart-commit/run`：浏览器信任栅栏 + JSON 协议
  （`sessionId` / `command` / 可选 `extra` / `n`），`ctx.agents.get(sessionId)` 执行工作流
- 技能行美化：`/` 菜单技能行同样呈现「图标 + 中文名 + 英文名 + 描述」
  （已知技能中文名表 `SKILL_ZH`，未收录技能保留英文名但仍获得图标）

### Changed
- 命令面从 host 命令（`ctx.commands.register`）迁移为客户端贡献；host 半自包含性不变
- 执行结果反馈从命令结果流节点改为 composer 提示条（info/error）

### Removed
- host 命令注册（贡献名与 host 命令重名会被 `dsh-client-ui-commands` 拒绝，故必须二选一）

### Migration（0.1 → 0.2）
- `/commit <补充说明>`、`/commit-squash <N>` 的行内参数不再生效（贡献只响应裸 token）；
  host 路由协议保留 `extra` / `n` 字段，后续 popup 形态可复用

## [0.1.0] - 2026-08

### Added
- 初始公开版本：`dsh-smart-commit`
- 支持 `/commit`、`/commit-wip`、`/commit-amend`、`/commit-squash` 四个斜杠命令
- 中文 Conventional Commits 规范生成
- 推送确认、敏感文件防护、危险命令禁令等安全约束
- 标准 bundle 安装：`dsh plugin --profile web add dsh-smart-commit`
