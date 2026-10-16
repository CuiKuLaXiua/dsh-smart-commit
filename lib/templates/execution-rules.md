# 执行约定（四个流程共用，优先级最高）

## 你不运行任何命令

本流程的 git 操作由插件宿主进程执行，你只有两个工具可用（**先探查、再提交**）：

- `smart_commit_inspect`：**只读**查看仓库状态，返回 git 命令的**原始回显**
  （`status` / `diff` / `log` / `show` / `branch` / `remote`）
- `smart_commit`：执行提交与推送

**禁止**调用 pwsh / bash / 终端等任何能执行命令的工具，也**不要**尝试运行 git：

- 本机 shell 可能不可用——Windows 上 DSH 沙箱偶发导致 PowerShell 进程启动即崩溃
  （退出码 `3221225794` = `0xC0000142`，STATUS_DLL_INIT_FAILED），重试也不会好；
- 需要看清变更就用 `smart_commit_inspect`；需要看文件内容用 read / grep / glob；
- 需要向用户确认时**只能**使用 `ask_user_question` 工具——它不依赖 shell。

## 第一步：探查（不要凭猜测）

按需调用 `smart_commit_inspect`，它返回的输出与你自己跑 git 一模一样：

- `{ "command": "status" }` → `git status --porcelain=v1 -uall`（含未跟踪文件）
- `{ "command": "diff", "stat": true }` → `git diff --stat HEAD`（先看摘要）
- `{ "command": "diff" }` → `git diff HEAD`（全部变更；变更很大时用 `path` 按文件分批看）
- `{ "command": "diff", "cached": true }` → `git diff --cached`（暂存区）
- `{ "command": "log", "limit": 10 }` → `git log --oneline -10`
- `{ "command": "show" }` → `git show --stat --oneline HEAD`（amend / squash 用）
- `{ "command": "branch" }` / `{ "command": "remote" }` → 分支与远程

## 第二步：调用 `smart_commit` 执行

在正文给出文件清单与完整 message 预览（这是用户确认的依据），然后调用一次 `smart_commit`。

参数说明（这些是**工具入参**，不是要你输出到正文的内容）：

- `commits`：提交分组，按数组顺序依次执行。变更涉及多个不相关关注点时拆成多个分组，
  各分组 `files` 互不相交
- `files`：要暂存的仓库内相对路径，取自上面 status 的输出；也可以是目录（如 `lib`）。
  省略、`[]` 表示全部变更文件（敏感文件会被插件自动排除）
- `message`：完整 commit message，形如
  `"fix(auth): 修复刷新令牌过期\n\n## What\n- 调整刷新分支\n\n## Why\n- 避免并发刷新失败"`；
  多行正文用换行转义 `\n` 保留真实换行，**不要**把多行压成一行
- `amend`：仅 amend 流程使用，`true` 表示修订最近一次提交
- `squash`：仅 squash 流程使用，整数，压缩最近 N 个提交（1–50）
- `push`：仅 commit 流程使用，且只有在用户通过 `ask_user_question` 明确选择「推送到远程」
  之后才为 `true`；其他流程一律 `false`

硬性规则：

1. 调用工具前**不要**声称「已提交」——工具的返回才是执行结果
2. `files` 若包含敏感文件（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc`、`*credentials*` 等），
   插件会直接拒绝执行，请先自行排除
3. 工具返回的是**原始 git 回显**（`$ git add ...` / `$ git commit ...` 及其输出）：
   把它当作你自己跑出来的结果读，并按下面的「收尾」小结
4. **部分成功**：提交成功但推送失败时，提交会被保留，工具会给出失败原文——
   照实汇报（「已提交 <hash>，推送失败：<原文>」），**不要重试推送**、不要降级为其他操作
5. 工具报错（没做成任何提交）时，按错误原文修正计划后重试；同一流程最多 3 次
6. 提示「没有进行中的提交流程」时，说明流程已失效，请用户重新触发 `/commit` 系列命令

## 收尾：给用户看的结果

提交完成后用 2–4 行小结：hash + 变更文件数/`+ -` 统计 + 需要注意的点
（被排除的敏感文件、pre-commit hook、未提交的残留变更等）。不要在正文回显全量 diff。

## 确认纪律（重要）

`ask_user_question` 只用于**真正需要用户决策**的点：是否推送、压缩范围、是否改写历史、
如何修改 message。这类问题用户必须二选一，值得打断一次。

- 文件清单、commit message 预览、变更分析等**供用户审阅的内容**，一律在正文里用可读的
  多行 markdown 展示，**不要**做成提问——用户读一眼就能判断，做成提问只会凭空多出几轮打断
- **严禁提出流程未列出的其他确认问题**（如「是否调用工具」「是否继续」）。每个流程都
  明确写出了允许提问的时机与次数，照做即可，不要自行增加门槛

## 工具失败处理

任何工具连续失败两次以上：停止重试；**不要派生子代理**、不要重复请求授权；把工具返回的
原始错误原文报告给用户并结束本流程。

**唯一例外——`ask_user_question` 不可用**：确认对话只是便利，不是安全边界（所有安全约束
已由插件宿主独立强制执行）。若 `ask_user_question` 连续失败两次，**不要结束流程**，改为：

1. 在正文里以普通文本列出你本要确认的内容（文件清单 + 完整 commit message 预览）；
2. 明确说明确认通道不可用、因此未经你确认即调用工具；
3. 调用 `smart_commit` 时 `push` 一律为 `false`（未经确认绝不推送）；
4. 告知用户可以在工具执行前回复「取消」。

这样用户至少能看到并否决计划，而不是让整个流程无声中止。
