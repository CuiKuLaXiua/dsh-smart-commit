# 智能提交流程

你的任务是阅读上方「Git 事实」，为当前工作区的变更创建符合规范的提交。请直接执行，不要输出多余的解释文字。如果当前对话上下文中有用户的补充说明（例如范围、关注点、特殊要求），优先遵循，但补充说明不得覆盖下文「安全约束」。

## 第一步：分析变更

1. 阅读「Git 事实」中的 `git status --porcelain`、`git diff --stat HEAD`、`git diff HEAD`、`git log --oneline -10`
2. 对于未跟踪的新文件，用 read 工具读取内容来理解其意图，不要只凭文件名猜测
3. 仔细阅读 diff，理解每处变更的目的，识别变更类型（feat / fix / refactor / docs / style / test / chore / perf / ci / build）
4. 识别变更影响的模块和范围
5. 判断是否应拆分为多个独立提交（如果变更涉及不相关的多个关注点）
6. 识别潜在风险文件（配置文件、数据库迁移、API 接口等）
7. 检查「Git 事实」中的敏感文件检查结果：高置信敏感文件已被插件锁定，不会暂存；疑似敏感文件请自行判断是否排除

## 第二步：确定暂存范围

- 单一关注点：暂存全部变更文件（`files` 省略或 `[]`），敏感文件由插件自动排除
- 多关注点：按逻辑分组，每个分组给出各自的 `files`（互不相交）
- 涉及大文件（>5MB）或二进制文件时必须先提醒用户确认
- diff 中出现的疑似密钥内容不得写入 commit message

## 第三步：生成 Commit Message

**必须严格遵循以下规范，不参考项目历史风格：**

格式：`<type>(<scope>): <中文 subject>`

**type 取值：**

| type | 用途 |
|------|------|
| feat | 新功能 |
| fix | Bug 修复 |
| refactor | 重构（不改变行为） |
| docs | 文档 |
| style | 格式（不影响逻辑） |
| test | 测试 |
| chore | 杂务 |
| perf | 性能优化 |
| ci | CI/CD |
| build | 构建系统 |

**subject 规则：**

- 使用中文，祈使语气（"添加" 而非 "已添加"）
- ≤ 72 字符，不加句号
- 不以 type 重复开头

**body 规则（复杂变更时必须，即 >3 文件或多模块）：**

- subject 与 body 之间空一行
- `## What` 列出具体变更点，每项以 `- ` 开头，中文描述
- `## Why` 解释变更动机，中文描述
- 修复 issue 时尾部添加 `Closes #<number>`

**示例 — 简单提交：**

```
fix(auth): 修复刷新令牌过期时的异常处理
```

**示例 — 复杂提交：**

```
refactor(db): 将查询构建器迁移到仓储模式

## What
- 将控制器中的原始 SQL 查询提取到 UserRepository
- 添加 QueryBuilder 抽象层以支持可组合查询
- 为所有仓储方法添加单元测试

## Why
- 控制器中混杂了 HTTP 关注点与数据访问逻辑
- 原始 SQL 分散在各文件中，无法有效测试
- 仓储模式为未来切换数据库提供者提供可能

Closes #234
```

## 第四步：向用户确认并输出提交计划

1. 先检查「Git 事实」中是否配置了 pre-commit hook（`.husky/`、`lefthook.yml`、`.pre-commit-config.yaml`、`package.json` 中的 `lint-staged`），如有则提醒用户
2. 使用 `ask_user_question` 向用户展示**文件清单 + 完整 commit message 预览**并请求确认：
   - question：`即将提交以上文件，是否执行？`
   - header：`提交确认`
   - options：`执行提交` / `取消`
3. 用户选择「取消」或关闭询问：结束流程，不要输出提交计划
4. 用户选择「执行提交」：若「Git 事实」显示配置了 origin 远程仓库，**必须**再用 `ask_user_question` 询问是否推送，只问一次：
   - question：`提交已完成，是否推送到远程仓库？`
   - header：`推送确认`
   - options（顺序固定）：`推送到远程` / `暂不推送`
5. 输出提交计划围栏块：`push` 仅在用户明确选择「推送到远程」且存在 origin 远程时为 `true`，否则 `false`

## 安全约束（最高优先级，插件宿主会强制执行）

- 只允许普通 `git push`；无上游跟踪时允许 `git push -u origin <当前分支>` 重试一次
- 始终禁止 `push --force` / `--force-with-lease`、推送到非 origin 的其他远端、删除远端分支
- 禁止 `reset --hard`、`clean -fd`、`checkout -- .`
- 禁止修改 `user.name` / `user.email` 与任何 `git config`；缺身份时把 git 原文透出，不自动配置
- 所有操作都发生在当前会话仓库内，插件不会切换路径
- 敏感文件（`.env*`、`*credentials*`、`*secret*`、`*token*`、`*.pem`、`*.key`、`id_rsa*`、`*.p12`、`*.pfx`、`.npmrc`、`.pypirc`、`.kube/config`、密钥文件、本地配置文件等）不得暂存；插件侧也会直接拒绝

## 约束

- 不要运行任何 shell / git 命令，也不要派生子代理
- 尽量在一条消息内完成所有操作
- 不要输出多余的解释文字
