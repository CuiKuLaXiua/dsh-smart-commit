# dsh-smart-commit

DeepSeek Harness (DSH) 标准插件 — **智能 Git 提交**。

在对话中使用斜杠命令，让 agent 分析当前工作区的 Git 变更，并生成符合 [Conventional Commits](https://www.conventionalcommits.org/) 规范的中文提交信息，支持 **WIP / amend / squash** 三种提交流程。

## 命令

| 命令 | 作用 |
|------|------|
| `/commit [补充说明]` | 分析变更并创建规范提交（含推送询问） |
| `/commit-wip [补充说明]` | 快速暂存全部变更并创建 `wip:` 临时提交 |
| `/commit-amend [补充说明]` | 修改最近一次提交（追加变更或修改 message） |
| `/commit-squash [N]` | 将最近 N 个提交压缩为一个（N 可省略，届时由 agent 建议范围） |

四个命令是 host 命令，因此：命令后可以带行内参数（`/commit 只提交 lib 目录`、`/commit-squash 3`）；
每次执行都会在会话日志里留下 `command/run` → `command/done` 记录，刷新页面后仍可回溯。

提交本身由模型可见工具 `smart_commit` 完成（agent 分析与确认后调用），执行输出以工具结果
显示在对话里，因此**真实 git 输出可见、可回溯**。

## 安装

前置：已安装 DeepSeek Harness（Web 或桌面版）。**agent 不需要 shell 或 git 工具**——
git 由插件宿主进程直接执行。

### Web 版

```sh
dsh plugin --profile web add dsh-smart-commit
```

重启 dsh 服务后生效，在对话中输入 `/commit` 即可使用。

### 桌面版

1. 打开桌面端 → 侧边栏 **Plugins / 插件** 页
2. 安装来源填 `dsh-smart-commit`（或本地 tarball 的 `file:` 路径）
3. 按提示重启桌面端生效

### 从 GitHub 安装（未发布 npm 时）

```sh
dsh plugin --profile web add github:CuiKuLaXiua/dsh-smart-commit
```

> 本插件是 bundle 型包（声明了 `dsh.bundle.patch`），`dsh plugin add` 会自动把它加进
> profile 的 `dsh.profile.bundles` 并应用 `cordis.patch.yml`，**不需要手工加 loader 行**。

## 安全特性

- **推送需明确确认**：`/commit` 流程末尾必须经 `ask_user_question` 用户选择「推送到远程」后才执行 `git push`，始终禁止 force 推送
- **禁止危险命令**：模板禁止 `reset --hard`、`clean -fd`、`push --force` 等
- **不改写 git 配置**：不自动设置 `user.name` / `user.email`
- **敏感文件防护**：提交前检查 `.env`、密钥、token 等敏感文件并排除
- **输入收敛**：补充说明截断 500 字，squash 数量限制 1–50
- **路由信任栅栏**：host 路由仅接受本机 GUI 的同源请求（Host 回环/显式信任 + 同源标记，与 `/api` 网关同构）

## 架构（0.5 起）

命令面是 **host 命令**，执行面是 **模型可见工具**：

- **命令面**：四个命令通过 `ctx.commands.register` 注册，声明 `input` 提示。因此
  `/` 菜单行、行内参数（`/commit 补充说明`、`/commit-squash 5`）与官方命令生命周期
  （`command/run` → `command/done`，记录进会话日志）都在；刷新后仍可回溯。
  命令处理体只做三件事：采集 git 事实 → 注入「执行约定 + 模板 + 事实」→ 唤醒 agent。
- **执行面**：`ctx.tools.register` 注册工具 `smart_commit`。agent 分析变更、向用户确认后
  调用该工具；执行体在插件宿主进程用 `node:child_process` 直跑 git（`lib/git.js`），
  **不经过 agent 的命令沙箱**。执行输出作为 `tool/result` 落在对话里，真实 git 输出可见。
- **自包含**：只用 `node:` 内建模块与相对文件，禁止裸 `@deepseek-ai/*` import。

### 工具入参

agent 不运行任何命令；它调用一次 `smart_commit`：

```json
{
  "commits": [
    { "files": ["lib/index.js"], "message": "refactor(plugin): 示例\n\n## What\n- ...", "amend": false, "squash": 3 }
  ],
  "push": false
}
```

- `files` 省略 / `[]` 表示全部变更（敏感文件自动排除）；显式列出敏感文件会被拒绝
- `amend` 仅 amend 流程（且必须为 `true`）；`squash` 仅 squash 流程（1–50，必须给出）
- `push` 仅 commit 流程，且需用户明确确认

### 宿主强制的安全约束

- **权限随流程收窄、单次生效**：`smart_commit` 只在本会话刚触发过命令后可用；
  `/commit` 允许 push、`/commit-amend` 允许 amend、`/commit-squash` 允许 squash；
  成功即失效，超过 60 分钟或超过 3 次尝试即失效
- 敏感文件拒绝/排除、只允许普通 push（无上游时一次 `-u origin <branch>`，永不 force）、
  禁止 `reset --hard` / `clean -fd` / `checkout -- .`、squash 只允许 `reset --soft`、
  文件路径必须在会话仓库内
- 流程形态校验：squash 流程缺 `squash` 数量、amend 流程缺 `amend: true` 都会被拒绝，
  避免模型漏字段时「悄悄」新建提交

### 版本沿革

| 版本 | 命令面 | git 执行 |
|---|---|---|
| 0.1 | host 命令 | agent 的 shell（受沙箱影响） |
| 0.2 | 客户端 `action` 贡献（拿菜单样式，丢行内参数与生命周期） | agent 的 shell |
| 0.3 | 客户端贡献 | 插件宿主进程（宿主校验 + SSE 推结果） |
| 0.4 | 客户端贡献 | 插件宿主进程，提交计划走围栏协议 |
| **0.5** | **host 命令（行内参数 + 生命周期结果行）** | **宿主进程，由 `smart_commit` 工具触发** |

本地化：菜单行文案来自 host 命令的 `description`（`lib/index.js` 的 `COMMANDS` 表）；
`locale/*.json` 提供插件列表里的标题与描述。

## 排障：PowerShell 启动即崩溃（退出码 3221225794）

Windows 上 DSH 用 ACL 受限令牌沙箱（Low 完整性 + `WRITE_RESTRICTED`）执行 agent 的每条 pwsh
命令，该后端有已知限制：受限令牌下创建的子进程可能在 DLL 初始化阶段直接死亡，退出码
`3221225794`（`0xC0000142`，STATUS_DLL_INIT_FAILED）。这是 DSH 平台问题，与本插件无关。

**0.3 起本插件完全不受它影响**：git 由插件宿主进程直接执行（`node:child_process`），
不经过 agent 的命令沙箱；agent 只读 host 采集的 git 事实、生成 commit message、
用 `ask_user_question` 向你确认，然后调用 `smart_commit` 工具——这些都不需要 shell。

如果会话里**其他**功能（让 agent 跑命令）遇到该崩溃：它是瞬时性的（通常几分钟内自行恢复），
可以稍后重试，或把该会话的文件策略切到 `danger-full-access`；`read-only` 模式下写操作被拒
是设计行为，与崩溃无关。

## 开发

```sh
npm run smoke     # 语法 + 模板断言 + 伪 ctx 挂载 + 真实临时 git 仓库端到端
npm pack          # 打包检查
```

- 纯 Node ESM，零运行时依赖，host 半只用 `node:` 内建模块
- 流程模板位于 `lib/templates/*.md`（`execution-rules.md` 为四流程共用），是 agent 行为的权威约束
- 命令族表与 `smart_commit` 工具定义位于 `lib/index.js`（`COMMANDS` + `PLAN_PARAMETERS` + `runPlan`）
- 宿主侧 git 执行器位于 `lib/git.js`（facts 采集 + 计划校验 + 执行）
- 本地安装测试：`dsh plugin --profile desktop add file:<本目录>`

## 发布（维护者）

见 `docs/PUBLISHING.md`。

## License

MIT
