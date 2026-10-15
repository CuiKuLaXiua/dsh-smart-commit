# Changelog

## [0.3.0] - 2026-10

### Changed
- **git 执行迁到插件宿主进程**：host 半用 `node:child_process` 直跑 git（新增 `lib/git.js`），
  不再依赖 agent 的 shell。Windows 上 DSH 沙箱偶发杀死 pwsh 进程（退出码 `3221225794` =
  `0xC0000142`，STATUS_DLL_INIT_FAILED）时，本插件完全不受影响
- 提交流程改为「host 采集 git 事实 → agent 生成提交信息并向用户确认 → host 执行」：
  agent 不再运行任何命令，只读事实、写 commit message、用 `ask_user_question` 确认
- 新增提交计划协议：agent 在最后一条消息输出 ` ```smart-commit ` 围栏 JSON
  （`commits[].files` / `message` / `amend` / `squash` + `push`），host 解析、校验并执行
- 新增 `GET /smart-commit/events`（SSE）与 `GET /smart-commit/status`：执行结果推送给
  浏览器半，以 composer 提示条展示
- 四个模板重写：不再包含任何 git 命令；安全约束改由宿主强制执行

### Security
- 宿主侧强制：敏感文件在显式 `files` 中直接拒绝、在省略 `files` 时自动排除；
  只允许普通 `git push`（无上游时一次 `-u origin <branch>`），永不 force；
  禁止 `reset --hard` / `clean -fd` / `checkout -- .`；squash 只允许 `reset --soft`；
  squash 数量 1–50；文件路径必须位于会话仓库内
- 每个会话同时只有一个进行中的任务（重复触发返回 409）

### Migration（0.2 → 0.3）
- 用户侧行为不变：仍然一键触发、中途确认、结果通知；但 agent 不再需要 shell
- agent 未输出提交计划时，host 在 10 分钟超时后报告失败并给出最后一条消息内容
- 页面刷新后不会再收到执行结果通知（任务仍在宿主侧完成）；重新触发即可

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
