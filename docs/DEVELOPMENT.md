# 开发说明

- 纯 Node ESM 宿主插件，零运行时依赖，只用 `node:` 内建模块（`node:fs` / `node:crypto` / `node:child_process`）。
- 入口 `lib/index.js` 分两面：
  - **命令面**：`ctx.commands.register` 注册 `/commit`、`/commit-wip`、`/commit-amend`、`/commit-squash`
    （声明 `input` 提示 → 支持行内参数）。处理体只做三件事：采集 git 事实 → 注入模板与事实 → 唤醒 agent，
    并登记本次流程的许可（`workflows`）。
  - **执行面**：`ctx.tools.register` 注册工具 `smart_commit`。agent 调用后，`runPlan()` 校验计划
    （`validatePlan` + `assertFlowShape`）并在宿主进程执行 git。
- 流程模板位于 `lib/templates/*.md`（`execution-rules.md` 为四流程共用），是 agent 行为的权威约束
  （安全禁令、确认纪律、工具调用协议）；改行为请改模板。
- 自检：`npm run smoke`
  （语法 + 模板/自包含断言 + 伪 ctx 挂载 + 真实临时 git 仓库端到端：注入、敏感文件排除、
  单次使用、权限收窄、squash、amend、非 git 目录）。
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
