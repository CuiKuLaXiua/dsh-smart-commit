# Squash 提交流程

将多个最近的提交压缩为一个。请直接执行，不要输出多余的解释文字。

## 第零步：安全检查（阻断式，不满足则停下先问用户）

阅读「Git 事实」中的 `git status --porcelain` 与 `git branch -vv`：

1. 若存在**已暂存或未暂存**的变更：提醒用户先提交或 stash（避免被 `reset --soft` 卷入合并提交），
   并用 `ask_user_question` 询问是否仍要继续；插件侧也会在工作区不干净时拒绝执行
2. 若分支已推送到远程：必须先经用户文字确认（压缩后需要 `git push --force-with-lease`），
   确认后才继续
3. 保护分支（`main` / `master` / `release/*`）一律先经用户文字确认
4. 用户选择「取消」或关闭询问：结束流程，不要输出提交计划

## 第一步：确定压缩范围

- 如果用户指定了数量参数（模板注入时已把 {N} 解析为具体数字），压缩最近 {N} 个提交，
  直接使用该数字作为 `squash` 值
- 如果未指定，阅读「Git 事实」中的 `git log --oneline -10`，分析最近提交：
  - 查找连续的 `wip:` / `fixup:` / `fix:` 等临时提交
  - 建议将这些临时提交与相关的正式提交压缩在一起
  - 用 `ask_user_question` 向用户确认压缩范围（options 给出 2–3 个候选数量），等待回复后再继续

## 第二步：生成合并后的 Commit Message

综合所有被压缩提交的内容（用 read 工具查看需要细节的文件），生成一条规范的 commit message：

- 格式：`<type>(<scope>): <中文 subject>`
- type：feat | fix | refactor | docs | style | test | chore | perf | ci | build
- subject 使用中文，祈使语气，≤ 72 字符，不加句号
- 如果合并后的变更较复杂，添加 `## What` + `## Why` body
- 不得把密钥原文写入 message

## 第三步：输出提交计划

围栏块中使用 `"squash": <N>`（N 必须等于已确认的数量）加上合并后的 `message`：

```smart-commit
{
  "commits": [
    { "squash": 3, "message": "refactor(plugin): 合并命令面迁移的临时提交" }
  ],
  "push": false
}
```

## 安全提醒（插件宿主会强制执行）

- 压缩前确认没有未提交的变更（插件侧在工作区不干净时直接拒绝）
- 如果分支已推送到远程，提醒用户之后需要 `git push --force-with-lease`——但本流程**不执行**任何推送
- 只允许 `git reset --soft HEAD~N`；禁止 `reset --hard` / `clean -fd` / `checkout -- .`
- 禁止修改任何 `git config`
- `squash` 数量限 1–50，越界插件直接拒绝

## 约束

- 不要运行任何 shell / git 命令，也不要派生子代理
- 尽量在一条消息内完成（需要用户确认压缩范围时除外）
- 不要输出多余文字
