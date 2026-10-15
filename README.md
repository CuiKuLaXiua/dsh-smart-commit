# dsh-smart-commit

DeepSeek Harness (DSH) 标准插件 — **智能 Git 提交**。

在对话中使用斜杠命令，让 agent 分析当前工作区的 Git 变更，并生成符合 [Conventional Commits](https://www.conventionalcommits.org/) 规范的中文提交信息，支持 **WIP / amend / squash** 三种提交流程。

## 命令

| 命令 | 作用 |
|------|------|
| `/commit` | 分析变更并创建规范提交（含推送询问） |
| `/commit-wip` | 快速暂存全部变更并创建 `wip:` 临时提交 |
| `/commit-amend` | 修改最近一次提交（追加变更或修改 message） |
| `/commit-squash` | 将最近 N 个提交压缩为一个 |

在 `/` 菜单中，四个命令与官方命令同款显示：**左侧图标 + 中间本地化名称 + 右侧英文名 + 最右描述**
（中文界面显示「提交 / 临时提交 / 修订提交 / 压缩提交」，英文界面显示 `Commit / WIP Commit / …`）。

## 安装

前置：已安装 DeepSeek Harness（Web 或桌面版），agent 具备可用的 git 工具（终端/Shell 类工具）。

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

## 架构（0.3 起）

0.2 把命令面从 host 命令迁到**开放 API 的客户端贡献**，以获得官方命令的菜单样式；
0.3 把 **git 执行从 agent 的 shell 迁到插件宿主进程**，使功能不再受 agent 执行环境影响。

- **host 半**（`lib/index.js` + `lib/git.js`）：
  - `POST /smart-commit/run`：校验入参 → 用 `ctx.agents.get(sessionId)` 解析 agent →
    在会话仓库内采集 git 事实（status / diff / log / branch / remote / 敏感文件检查）→
    注入「执行约定 + 命令模板 + git 事实」并唤醒 agent → 等 agent 产出提交计划 →
    校验并执行（add / commit / amend / squash / push）→ 通过 SSE 推送结果
  - `GET /smart-commit/events`（SSE）与 `GET /smart-commit/status`：任务状态查询
  - 自包含：只用 `node:` 内建模块，禁裸 `@deepseek-ai/*` import
- **client 半**（`lib/client.js`）：`ctx.commandUi.register()` 注册四个贡献
  （`label()` / `description()` / `icon` 即官方行契约），action 调用 host 路由，
  并用 SSE 订阅执行结果；同时装饰 `/` 菜单的技能源，让技能行也呈现
  「图标 + 中文名 + 英文名 + 描述」

### 提交计划协议

agent 不需要（也不允许）运行任何命令。它在最后一条消息输出一个围栏块，host 解析后执行：

```smart-commit
{
  "commits": [
    { "files": ["lib/index.js"], "message": "refactor(plugin): 示例\n\n## What\n- ...", "amend": false, "squash": 0 }
  ],
  "push": false
}
```

- `files` 省略 / `[]` / `["-A"]` 表示全部变更（敏感文件自动排除）；显式列出敏感文件会被拒绝
- `amend` 仅 amend 流程；`squash` 仅 squash 流程（1–50）；`push` 仅 commit 流程且需用户明确确认

### 宿主强制的安全约束

敏感文件拒绝/排除、只允许普通 push（无上游时一次 `-u origin <branch>`，永不 force）、
禁止 `reset --hard` / `clean -fd` / `checkout -- .`、squash 只允许 `reset --soft`、
文件路径必须在会话仓库内、每会话同时只有一个任务（409）。

与 0.1/0.2 的行为差异：

- 不再有 host 命令生命周期事件（`command/run`、`command/done`）与结果流节点；执行结果以 composer 提示条反馈
- 不再支持命令后带行内参数（`/commit <补充说明>` 的 input claim）；当前贡献只响应裸 token。
  host 路由的协议保留 `extra` / `n` 字段（同一套 sanitize 与边界校验），供后续 popup 形态使用

本地化文案在 `lib/client.js` 顶部的 `COMMAND_ZH` / `COMMAND_EN` / `SKILL_ZH` 表中维护
（`SKILL_ZH` 可自行扩充，未收录的技能保留英文名但仍获得图标）。

## 排障：PowerShell 启动即崩溃（退出码 3221225794）

Windows 上 DSH 用 ACL 受限令牌沙箱（Low 完整性 + `WRITE_RESTRICTED`）执行 agent 的每条 pwsh
命令，该后端有已知限制：受限令牌下创建的子进程可能在 DLL 初始化阶段直接死亡，退出码
`3221225794`（`0xC0000142`，STATUS_DLL_INIT_FAILED）。这是 DSH 平台问题，与本插件无关。

**0.3 起本插件完全不受它影响**：git 由插件宿主进程直接执行（`node:child_process`），
不经过 agent 的命令沙箱；agent 只读 host 采集的 git 事实、生成 commit message、
用 `ask_user_question` 向你确认——这些都不需要 shell。

如果会话里**其他**功能（让 agent 跑命令）遇到该崩溃：它是瞬时性的（通常几分钟内自行恢复），
可以稍后重试，或把该会话的文件策略切到 `danger-full-access`；`read-only` 模式下写操作被拒
是设计行为，与崩溃无关。

## 开发

```sh
npm run smoke     # 语法 + 模板安全断言
npm pack          # 打包检查
```

- 纯 Node ESM，零运行时依赖，host 半只用 `node:` 内建模块
- 流程模板位于 `lib/templates/*.md`（`execution-rules.md` 为四流程共用），是 agent 行为的权威约束
- 宿主侧 git 执行器位于 `lib/git.js`（facts 采集 + 计划校验 + 执行）
- 本地安装测试：`dsh plugin --profile desktop add file:<本目录>`

## 发布（维护者）

见 `docs/PUBLISHING.md`。

## License

MIT
