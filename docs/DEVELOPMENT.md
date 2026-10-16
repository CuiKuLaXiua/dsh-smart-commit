# 开发说明

- 纯 Node ESM 宿主插件，零运行时依赖，只用 `node:` 内建模块（`node:fs` / `node:crypto` / `node:child_process`）。
- 入口 `lib/index.js` 分两面：
  - **命令面**：`ctx.commands.register` 注册 `/commit`、`/commit-wip`、`/commit-amend`、`/commit-squash`
    （声明 `input` 提示 → 支持行内参数）。处理体只做两件事：校验工作区在 git 仓库内 → 注入模板 → 唤醒 agent，
    并登记本次流程的许可（`workflows`）。
  - **工具面**：`ctx.tools.register` 注册两个工具——
    `smart_commit_inspect`（只读探查，白名单子命令，返回原始 git 回显）与
    `smart_commit`（`runPlan()` 校验计划 `validatePlan` + `assertFlowShape` 后在宿主进程执行 git）。
  - 入参宽松化：模型可能把 `commits` / `files` / 整体入参写成 JSON 字符串，`normalizePlan()` 负责还原。
- 流程模板位于 `lib/templates/*.md`（`execution-rules.md` 为四流程共用），是 agent 行为的权威约束
  （安全禁令、确认纪律、工具调用协议）；改行为请改模板。
- 自检：`npm run smoke`
  （语法 + 模板/自包含断言 + 伪 ctx 挂载 + 真实临时 git 仓库端到端：探查回显、入参宽松化、
  原始回显、敏感文件排除、单次使用、权限收窄、部分成功、squash、amend、不可用工作区）。
- 调试提示：宿主半不能裸 import `@deepseek-ai/*`（宿主机运行时解析不到工作区包），
  smoke 里有对应断言；工具定义按官方 `ctx.tools.register` 的字段要求手工构造
  （`{ name, description, parameters, output: { schema, render }, execute }`），
  **参数校验由本方 `execute` 自己做**。
- 命令名互斥：host 命令与 `ctx.commandUi` 的同名客户端贡献会冲突（官方规则：同名冲突显式报错），
  因此本插件不再有客户端半（`lib/client.js` 已删除）。
- 本地测试安装：
  ```sh
  dsh plugin --profile desktop add file:D:\code\dsh-smart-commit
  ```
- 安装后无需手工改 patch：bundle 的 `cordis.patch.yml` 会自动插入 loader 行。
