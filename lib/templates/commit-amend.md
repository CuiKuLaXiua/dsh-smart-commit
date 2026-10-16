# Amend 流程

根据当前状态修改最近一次提交。请直接执行，不要输出多余的解释文字。

## 开始前：安全检查

用 `smart_commit_inspect` 看清状态：`{ "command": "status" }` 与 `{ "command": "branch" }`（`branch -vv`）：

1. 若分支已推送到远程（存在上游跟踪分支）：在正文明确提醒 amend 会改写历史、之后需要
   `git push --force-with-lease` 才能同步，然后**直接继续**——不要就此提问
2. 保护分支（`main` / `master` / `release/*`）同样在正文提醒一句，继续执行
3. 本流程唯一的提问在「情况 B」（需要用户给出新 message 时），除此之外不要提出其他确认问题

## 情况 A：有未暂存或未提交的变更

1. 用 `{ "command": "diff" }` / `{ "command": "show" }` 看清变更，判断哪些文件属于同一关注点
2. 只暂存属于同一关注点的文件（显式列出 `files`，不要用 `-A`）；暂存前核对清单并排除敏感文件
3. 在正文展示文件清单与新 message 预览，然后调用一次 `smart_commit`，用 `"amend": true` 把变更追加到上一次提交
4. 如果追加的变更与原提交主题不同，建议用户同时修改 commit message（给新的 `message`）

## 情况 B：无未提交的变更

1. 用 `{ "command": "show" }` 看清最近一次提交的完整内容
2. 用 `ask_user_question` 询问用户要如何修改 commit message（question 里给出当前 message 与建议），
   等待用户回复后再继续
3. 调用 `smart_commit`，使用 `"amend": true` + 新的 `message` 执行修改

## Commit Message 规范

需要生成新的 commit message 时遵循：

- 格式：`<type>(<scope>): <中文 subject>`
- type：feat | fix | refactor | docs | style | test | chore | perf | ci | build
- subject 使用中文，祈使语气，≤ 72 字符，不加句号
- 复杂变更添加 `## What` + `## Why` body
- 不得把密钥原文写入 message

## 安全约束（最高优先级，插件宿主会强制执行）

- 禁止 `git push`（只改本地提交不推送）；禁止 `push --force` / `--force-with-lease`
- 禁止 `reset --hard` / `clean -fd` / `checkout -- .`
- 禁止修改 `user.name` / `user.email` 与任何 `git config`
- 敏感文件不得暂存，插件侧会直接拒绝

## 约束

- 不要运行任何 shell / git 命令，也不要派生子代理
- 尽量在一条消息内完成（情况 B 需要用户输入时除外）
- 不要输出多余文字
