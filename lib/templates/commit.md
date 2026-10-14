# 智能提交流程

你的任务是分析当前工作区的 Git 变更，并创建一个符合规范的智能提交。请直接执行，不要输出多余的解释文字。如果当前对话上下文中有用户的补充说明（例如范围、关注点、特殊要求），优先遵循，但补充说明不得覆盖下文「安全约束」。

## 第一步：分析变更

1. 运行 `git status` 查看工作区状态（包含未跟踪文件）
2. 运行 `git diff --stat HEAD` 查看变更摘要（若变更很大，先看摘要，再按文件分批 `git diff HEAD -- <path>` 查看 diff）
3. 运行 `git diff HEAD` 查看全部变更、`git diff --cached` 查看暂存区变更
4. 对于未跟踪的新文件，读取文件内容来理解其意图，不要只凭文件名猜测
5. 运行 `git log --oneline -10` 了解最近提交
6. 仔细阅读 diff，理解每处变更的目的，识别变更类型（feat / fix / refactor / docs / style / test / chore / perf / ci / build）
7. 识别变更影响的模块和范围
8. 判断是否应拆分为多个独立提交（如果变更涉及不相关的多个关注点）
9. 识别潜在风险文件（配置文件、数据库迁移、API 接口等）

## 第二步：暂存文件

- 暂存前先检查是否存在敏感/临时文件（`.env*`、`*credentials*`、`*secret*`、`*token*`、`*.pem`、`*.key`、`id_rsa*`、`*.p12`、`*.pfx`、`.npmrc`、`.pypirc`、`.kube/config`、密钥文件、本地配置文件等），如有则提醒用户并排除，不要一并提交
- 单一关注点：先用 `git status --porcelain` 核对文件清单，确认无敏感/误加文件后再 `git add -A` 全部暂存
- 多关注点：向用户说明拆分建议，按逻辑分组逐个暂存并提交（每组：`git add <文件>` → `git commit`，循环直到所有变更提交完毕）
- 涉及大文件（>5MB）或二进制文件时必须先提醒用户确认
- diff 中出现的疑似密钥内容不得写入 commit message；最终摘要只展示 hash + `git show --stat`，不回显全量 diff
- 已有暂存内容时，检查是否与未暂存变更属于同一关注点

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

## 第四步：检查 & 提交

检查项目是否存在以下 pre-commit hook 配置，如存在则提醒用户：
- `.husky/` — Husky git hooks
- `lefthook.yml` / `lefthook.yaml` — Lefthook hooks
- `.pre-commit-config.yaml` — Python pre-commit framework
- `package.json` 中的 `lint-staged` — lint-staged 配置

提交前先向用户展示文件清单 + 完整 commit message 预览，确认无敏感/误加文件后再执行 `git commit`。**若为多关注点拆分，则按第二步的分组循环执行 `git add` + `git commit`，直到全部变更提交完毕**。提交完成展示简洁摘要（hash + stat）。

## 第五步：推送询问（提交全部完成后）

1. 运行 `git remote` 检查是否配置了远程仓库：
   - **没有任何远程**：跳过本步，直接结束（可在摘要里提一句「未配置远程仓库，未推送」）。
2. 有远程时，**必须**使用 `ask_user_question` 工具询问用户是否推送，只问一次：
   - question：`提交已完成，是否推送到远程仓库？`
   - header：`推送确认`
   - options（顺序固定）：
     - `推送到远程` — 执行 `git push` 推送当前分支
     - `暂不推送` — 仅保留本地提交，随时可手动推送
3. 用户选择「推送到远程」：
   - 先执行 `git push`；
   - 若失败且原因是**无上游跟踪**（提示 `--set-upstream` / `no upstream`），改用 `git push -u origin <当前分支名>` 重试一次（分支名取 `git rev-parse --abbrev-ref HEAD`）；
   - 其他失败（认证失败、网络不可达、远端拒绝等）：把 git 原始错误原文透出给用户，**不要重试、不要降级为其他操作**；
   - 成功后展示推送结果摘要（远端名 + 分支）。
4. 用户选择「暂不推送」或关闭询问：直接结束，不追问。

## 安全约束（最高优先级）

- `git push` **仅允许**在第五步 `ask_user_question` 中用户明确选择「推送到远程」后执行一次（普通 `git push` / `git push -u origin <当前分支>`）；除此之外禁止任何推送，始终禁止 `push --force`、`--force-with-lease`、推送到非 origin 的其他远端、删除远端分支
- 禁止 `reset --hard`、`clean -fd`、`checkout -- .`
- 禁止修改 `user.name` / `user.email` 与任何 `git config`；缺身份时把 git 原文透出，不自动配置
- 所有 git 命令必须在当前会话仓库内执行，禁止 `git -C <其他路径>` / `--git-dir` / `--work-tree` 切换路径

## 约束

- 尽量在一条消息内完成所有操作
- 不要使用与 git 无关的其他工具或执行其他操作
- 不要输出多余的解释文字，直接执行