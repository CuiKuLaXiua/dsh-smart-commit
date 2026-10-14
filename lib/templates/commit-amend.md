# Amend 流程

根据当前状态修改最近一次提交。请直接执行，不要输出多余的解释文字。

**开始前**：运行 `git status` 和 `git branch -vv`，检查分支是否已推送到远程。如已推送，必须先经用户文字确认（amend 会改写历史，之后需要 `git push --force-with-lease`），确认后才继续。保护分支（`main` / `master` / `release/*`）一律先确认。

## 情况 A：有未暂存或未提交的变更

1. 暂存相关变更（使用 `git add`，不要 `git add -A`，仅暂存属于同一关注点的文件；暂存前核对清单并排除敏感文件）
2. 使用 `git commit --amend --no-edit` 将变更追加到上一次提交
3. 如果追加的变更与原提交主题不同，建议用户修改 commit message

## 情况 B：无未提交的变更

1. 使用 `git show --stat HEAD` 展示最近一次提交的完整内容（hash、message、变更文件）
2. 询问用户要如何修改 commit message（使用 ask_user_question 工具，等待用户回复后再继续）
3. 使用 `git commit --amend -m "<新 message>"` 执行修改

## Commit Message 规范

如果需要生成新的 commit message，遵循以下规范：
- 格式：`<type>(<scope>): <中文 subject>`
- type：feat | fix | refactor | docs | style | test | chore | perf | ci | build
- subject 使用中文，祈使语气，≤ 72 字符，不加句号
- 复杂变更添加 `## What` + `## Why` body
- 不得把密钥原文写入 message

## 安全约束（最高优先级）

- 禁止 `git push`（只改本地提交不推送）、禁止 `reset --hard` / `clean -fd` / `push --force`
- 禁止修改 `user.name` / `user.email` 与任何 `git config`

## 约束

- 尽量在一条消息内完成（情况 B 需要用户输入时除外）
- 不要输出多余文字，直接执行