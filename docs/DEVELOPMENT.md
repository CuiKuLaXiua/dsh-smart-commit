# 开发说明

- 纯 Node ESM 宿主插件，零运行时依赖，只用 `node:` 内建模块（`node:fs` / `node:crypto`）。
- 入口 `lib/index.js`：注册 `/commit`、`/commit-wip`、`/commit-amend`、`/commit-squash`
  四个斜杠命令，把 `lib/templates/*.md` 中的流程模板注入给 agent。
- 模板是 agent 行为的权威约束（安全禁令、推送确认等），修改行为请改模板。
- 自检：`npm run smoke`（语法 + 模板安全断言）。
- 本地测试安装：
  ```sh
  dsh plugin --profile web add file:D:\code\dsh-smart-commit
  ```
- 安装后无需手工改 patch：bundle 的 `cordis.patch.yml` 会自动插入 loader 行。