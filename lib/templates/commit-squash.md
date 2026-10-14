# Squash 提交流程

将多个最近的提交压缩为一个。请直接执行，不要输出多余的解释文字。

## 第零步：安全检查（阻断式，不满足则停下先问用户）

1. 运行 `git status` 检查是否有未提交的变更：
   - 如有**已暂存**的变更：提醒用户先提交或 stash，避免被 `git reset --soft` 卷入合并提交
   - 如有**未暂存**的变更：同样提醒用户先提交或 stash
2. 运行 `git branch -vv` 检查分支是否已推送到远程，如已推送，必须先经用户文字确认（压缩后需要 `git push --force-with-lease`），确认后才继续
3. 保护分支（`main` / `master` / `release/*`）一律先经用户文字确认

## 第一步：确定压缩范围

- 如果用户指定了数量参数（模板注入时已把 {N} 解析为具体数字），压缩最近 {N} 个提交
- 如果未指定，运行 `git log --oneline -20` 分析最近提交：
  - 查找连续的 `wip:` / `fixup:` / `fix:` 等临时提交
  - 建议将这些临时提交与相关的正式提交压缩在一起
  - 向用户确认压缩范围（使用 ask_user_question 工具）

## 第二步：生成合并后的 Commit Message

综合所有被压缩提交的内容，生成一条规范的 commit message：
- 格式：`<type>(<scope>): <中文 subject>`
- type：feat | fix | refactor | docs | style | test | chore | perf | ci | build
- subject 使用中文，祈使语气，≤ 72 字符，不加句号
- 如果合并后的变更较复杂，添加 `## What` + `## Why` body
- 不得把密钥原文写入 message

## 第三步：执行压缩

1. 确认暂存区干净后，使用 `git reset --soft HEAD~<N>` 保留所有变更在暂存区（N 必须等于已确认的数量；禁止 `reset --hard`）
2. 使用 `git commit -m "<新 message>"` 创建新的合并提交
3. 展示压缩结果（hash + stat，不回显全量 diff）

## 安全提醒

- 压缩前确认没有未提交的变更（如有，提醒用户先提交或 stash）
- 如果分支已推送到远程，提醒用户需要 `git push --force-with-lease`
- 本流程只压缩本地提交，不执行 `push`

## 约束

- 尽量在一条消息内完成（需要用户确认压缩范围时除外）
- 不要输出多余文字，直接执行