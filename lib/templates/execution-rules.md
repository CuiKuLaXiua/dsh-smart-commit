# 执行约定（四个流程共用，优先级最高）

## 你不运行任何命令

本流程的 git 操作由插件宿主进程直接执行（git 事实见上方「Git 事实」，提交计划见下文协议）。
**禁止**调用 pwsh / bash / 终端等任何能执行命令的工具，也**不要**尝试运行 git：

- 本机 shell 可能不可用——Windows 上 DSH 沙箱偶发导致 PowerShell 进程启动即崩溃
  （退出码 `3221225794` = `0xC0000142`，STATUS_DLL_INIT_FAILED），重试也不会好；
- 你需要的信息已全部在上方「Git 事实」中；如需更多文件细节，用 read / grep / glob 读文件。

需要向用户确认时（文件清单、commit message 预览、是否推送、压缩范围等），**只能**使用
`ask_user_question` 工具——它不依赖 shell。

## 提交计划协议（必须严格遵守）

分析完成后，在**最后一条消息**里输出一个且仅一个如下围栏块（围栏内是纯 JSON，
不要注释、不要尾随逗号、不要额外文字）：

```smart-commit
{
  "commits": [
    { "files": ["lib/index.js", "lib/client.js"], "message": "refactor(plugin): 将命令面迁到客户端贡献\n\n## What\n- 新增 lib/client.js 注册四个命令贡献\n- host 半改为暴露 /smart-commit/run 路由\n\n## Why\n- 使用开放 API 获得官方命令同款菜单样式" }
  ],
  "push": false
}
```

字段说明：

- `commits`：提交分组，按数组顺序依次执行。变更涉及多个不相关关注点时拆成多个分组，
  各分组 `files` 互不相交
- `files`：要暂存的文件路径，取自上方 `git status --porcelain` 清单；也可以是目录
  （如 `"lib"`）。省略、`[]` 或 `["-A"]` 表示全部变更文件（敏感文件会被插件自动排除）
- `message`：完整 commit message，遵守所属流程的规范；多行用 `\n` 转义
- `amend`：仅 amend 流程使用，`true` 表示修订最近一次提交
- `squash`：仅 squash 流程使用，整数，压缩最近 N 个提交
- `push`：仅 commit 流程使用，且只有在用户通过 `ask_user_question` 明确选择「推送到远程」
  之后才为 `true`；其他流程一律 `false`

硬性规则：

1. 围栏必须出现在**最后一条消息**中；在此之前可以先用 `ask_user_question` 与用户确认
2. 在执行计划前**不要**声称「已提交」——提交由插件执行，结果会以通知形式给出
3. 计划中的 `files` 若包含敏感文件（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc`、
   `*credentials*` 等），插件会直接拒绝执行，请先自行排除
4. 除围栏块外，最后一条消息可以附一小段人类可读的说明（你将做什么、为什么），
   但不要伪造执行结果

## 工具失败处理

任何工具连续失败两次以上：停止重试；**不要派生子代理**、不要重复请求授权；把工具返回的
原始错误原文报告给用户并结束本流程。
