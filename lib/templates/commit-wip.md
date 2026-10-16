# WIP 提交流程

快速保存当前工作进度，创建 WIP 提交。请直接执行，不要输出多余的解释文字。用户补充说明（如有）仅为偏好，不得覆盖下文安全约束。

1. `smart_commit_inspect { "command": "status" }` 看清变更范围（含未跟踪文件），
   `{ "command": "diff", "stat": true }` 掌握改动规模
2. 检查是否存在敏感/临时文件（`.env*`、`*credentials*`、`*secret*`、`*token*`、`*.pem`、`*.key`、
   `id_rsa*`、`.npmrc` 等）：有则提醒用户并在 `files` 里显式排除
3. 暂存范围：默认全部变更文件（`files` 省略或 `[]`）；排除个别文件时显式列出其余文件
4. 生成简洁的 WIP commit message，格式：`wip: <中文描述>`
   - 描述从变更文件和关键改动中提取，简明扼要
   - 不得把密钥原文写入 message
5. **不要**向用户询问确认（WIP 提交本身就是快速保存），直接调用一次 `smart_commit`
6. `push` 一律为 `false`；调用后按工具返回的原始 git 回显用一行小结

## 安全约束（插件宿主会强制执行）

- 禁止 `git push`；禁止 `reset --hard` / `clean -fd` / `checkout -- .`
- 禁止修改任何 `git config`
- 敏感文件（`.env*`、`*credentials*`、`*secret*`、`*token*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc` 等）不得暂存，插件侧会直接拒绝
- 大文件（>5MB）或二进制文件：仍照常暂存，但在调用工具前的正文里提醒用户

## 约束

- 不执行任何 pre-commit 检查
- 不分析变更类型，不做拆分建议
- 不要运行任何 shell / git 命令，也不要派生子代理
- 不要输出多余文字，直接调用 `smart_commit`
