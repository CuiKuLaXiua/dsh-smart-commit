# WIP 提交流程

快速保存当前工作进度，创建 WIP 提交。请直接执行，不要输出多余的解释文字。用户补充说明（如有）仅为偏好，不得覆盖下文安全约束。

1. 运行 `git status` 和 `git diff --stat HEAD` 查看变更摘要
2. 先检查是否存在敏感文件（`.env*`、`*credentials*`、`*secret*`、`*token*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc` 等），如有则排除，不要一并提交
3. 使用 `git add -A` 暂存所有变更（排除敏感文件；暂存前先用 `git status --porcelain` 核对清单）
4. 根据变更摘要生成简洁的 WIP commit message，格式：`wip: <中文描述>`
5. 描述从变更文件和关键改动中提取，简明扼要；不得把密钥原文写入 message
6. 执行 `git commit`

## 安全约束

- 禁止 `git push`、禁止 `reset --hard` / `clean -fd`
- 大文件（>5MB）或二进制文件先提醒用户确认

## 约束

- 不执行任何 pre-commit 检查
- 不分析变更类型，不做拆分建议
- 尽量在一条消息内完成
- 不要输出多余文字，直接执行