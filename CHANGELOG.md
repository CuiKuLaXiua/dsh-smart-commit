# Changelog

## [0.4.1] - 2026-10

### Fixed
- **确认纪律回归**：移植时把「供用户审阅的预览」误做成了阻塞式提问，导致每跑一次 /commit
  要被问 2-3 个问题（提交确认 + 推送确认，模型甚至还会自行 invent 第三个
  「计划已最终确认，是否输出提交计划？」）。现恢复 Zenith 原始设计的纪律：

  | 流程 | 提问次数（0.4.0） | 提问次数（0.4.1，同原始设计） |
  |------|------------------|------------------------------|
  | commit | 2（+ 模型自行追加） | **1**（仅推送确认） |
  | commit-wip | 0 | **0** |
  | commit-amend | 3 | **1**（仅情况 B 需要新 message 时） |
  | commit-squash | 3 | **1**（仅未指定压缩范围时） |

- 文件清单与 commit message 预览改为在正文用可读多行 markdown 展示，用户读预览即完成确认，
  不再做成 ask_user_question
- amend / squash 的「分支已推送」「保护分支」「工作区不干净」等安全检查从结构化提问降回
  正文提醒，与原始设计一致
- 四个模板均新增显式禁止：不得提出流程未列出的其他确认问题（点名禁止
  「是否输出提交计划」「是否继续」这类追问）

## [0.4.0] - 2026-10

## [0.4.0] - 2026-10

### Fixed
- **提交计划可读性**：围栏协议从 JSON 改为 YAML 块标量（`message: |`）。此前多行
  commit message 必须写成 `\n` 转义的单行字符串，围栏块里整条 message 挤成一行，
  `## What` / `## Why` 完全无法审阅——而这恰恰是用户唯一要看的内容
- **确认通道失效时不再中止流程**：`ask_user_question` 连续失败两次时，改为在正文
  列出待确认内容（文件清单 + commit message 预览）、明确声明未经确认、`push` 强制
  为 `false`，并照常输出提交计划。此前该故障会直接结束整个流程，不创建任何提交

### Changed
- 新增受限 YAML 解析器（`lib/git.js`，零外部依赖，保持 host 半自包含）：
  支持两级映射/序列、块标量 `|` 与 `>`、行内序列 `[a, b]`、布尔与整数标量
- `parsePlan` 自动判别 YAML 与 JSON：**旧版 JSON 围栏仍可执行**，0.3 缓存的
  agent 行为或模型惯性输出不会导致解析失败
- 四个模板的协议示例与字段说明同步更新（`execution-rules.md` 为四流程共用）

### Security
- 权限闸门保持不变且经断言覆盖：未授权 `push` / `amend` / `squash` 一律拒绝；
  敏感文件、`reset --hard`、force push 等约束仍由宿主侧强制执行
- `message` 的 clip chomping 仅保留一个尾部换行（YAML 标准行为），不产生尾部空行

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
