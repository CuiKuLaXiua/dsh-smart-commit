# dsh-smart-commit 独立版缺陷清单（对照官方客户端契约）

> 目标：解释「在 Zenith 里好用、装进 DSH 官方桌面端后体验明显变差」的原因，并给出可执行的修法。
> 结论先给：**git 执行迁到宿主进程（0.3）是对的，问题出在命令面（0.2）**——把 host 命令换成了客户端 `action` 贡献，丢掉了官方命令生命周期的「会话日志 + 结果行」和「行内参数声明」。

> **状态（0.5.0 已实施，方案 C）**：D1–D8 全部按本文件修法落地，另修掉一个未列入的功能缺陷
> （`/commit-amend` 的「无变更只改 message」路径此前必然失败）。实施内容见 `CHANGELOG.md` 0.5.0：
> host 命令面恢复（行内参数 + 生命周期）+ `smart_commit` 宿主工具（真实 git 输出可见）+
> SSE/status/轮询/围栏协议/客户端半全部删除 + smoke 升级为端到端。

---

## 0. 事实基线（本次实测/取证）

| 项 | 结论 | 证据 |
|---|---|---|
| 用户实际运行的版本 | 0.4.1，且与本地仓库内容一致（仅换行符差异） | `~\.dsh\profiles\desktop\node_modules\dsh-smart-commit` 与 `d:\code\dsh-smart-commit` 归一化后逐文件 EQUAL |
| 官方桌面端运行时 | `@deepseek-ai/dsh-desktop-runtime` **0.2.0-rc.2** | `D:\DeepSeek Harness\resources\app.asar` → `dsh/package.json` |
| 桌面端渲染方式 | 宿主起完整 Web 应用（`--no-open --port 19387`），把**带 token 的 loopback URL** 交给 Electron | `dsh-desktop-host/lib/index.js:337` `ctx.connection.authenticatedUrl(...)` + `webServer.collectIndexInjections()` |
| 客户端命令面契约（rc.2） | `CommandContribution = { name, description, available(session), ui }`，`ui.kind` 支持 `popupSelect` / `action`，`label/description/icon` 均为贡献字段 | asar → `dsh-client-ui-commands/README.md`、`lib/client.js:922,989` |

### 已核对「**不是**缺陷」的项（避免误改）

| 插件里的用法 | 官方状态 | 证据 |
|---|---|---|
| `ctx.agents.get(id)` | ✅ 存在 | `dsh-desktop-host/lib/index.js:134` `ctx.get("agents")` |
| `agent.inject()` / `agent.steer()` / `agent.whenIdle()` | ✅ 存在 | `dsh-agent/README.md:47,58` |
| `agent.session.seq` / `snapshotEvents(fromSeq)` | ✅ 存在 | `dsh-session/lib/index.js:1376` `snapshotEvents(fromSeq, toSeqExclusive = this.seq)` |
| `ctx.webServer.register({kind:"exact"})` | ✅ exact/prefix 都支持 | `dsh-host-webserver/README.md:45` |
| 自实现信任栅栏 + `?sessionId` 的 SSE 路由 | ✅ 同源 loopback + cookie 请求可过 | `dsh-client-connection/README.md:39,43` |
| `ctx.sessions.scope(id)` | ✅ 存在（客户端 scope fiber） | `dsh-api-session-controller/lib/client.js:499-527` |
| `conversation.input.for(actx).notify(level, text)` | ✅ **官方包自己就这么写** | `dsh-client-ui-conversation/lib/client.js:15689` |
| `ctx.locale.register(ns,{zh,en})` / `bind(ns)` | ✅ 存在 | `dsh-client-locale/lib/client.js:1387,1414` |
| `ui.kind: "action"` / `label()` / `icon` | ✅ rc.2 支持 | `dsh-client-ui-commands/lib/client.js:989,1004` |

---

## 1. 缺陷清单

### D1 — 结果只在瞬时的 composer 提示里，刷新即丢（对应症状：结果不反馈 / 展示不如 Zenith）· P0

- **机制**：官方 `dsh-commands`（host 命令）会给每次执行写 `command/run` + `command/done` 到会话日志，**UI 把 settled result 渲染在模型历史之外**，刷新后仍在。0.2 版把 host 命令注册删掉了，结果只剩 `notify` 一条**瞬时提示条**。
- **证据**：
  - `lib/client.js:79-128`（`notify` / `watchJob`：只有 SSE 终态才提示，无任何持久表面）
  - `CHANGELOG.md` 0.2 `Removed: host 命令注册`；0.3 `Migration: 页面刷新后不会再收到执行结果通知`
  - `dsh-commands/README.md:12` “Every admitted run is recorded in the receiving agent's session log, while the UI renders the settled result outside model history”；`README.md:89` 生命周期事件
  - `dsh-client-ui-commands/README.md:80` “the command line, the detached result, and every menu and notice rendering stay client-side and never enter the session log”
- **修法**：四个命令改回 **host 命令**（`ctx.commands.register`），结果走官方生命周期渲染；如需保留客户端菜单面，用 `ctx.commandUi.decorate()`（官方说明：保留 catalog 行、参数声明与生命周期日志）。

### D2 — 行内参数彻底失效，导致「每次都要问一遍」（对应症状：反复提问确认）· P0

- **机制**：客户端 `action` 贡献没有参数声明能力，`runCommand` 只 POST `{sessionId, command}`，host 侧 `extra` / `n` 成了**永远不会被填的死字段**；`/commit-squash 5` 无法表达，squash 每次都要 `ask_user_question` 问范围。
- **证据**：
  - `lib/client.js:130-148`（请求体只有 `sessionId` + `command`）
  - `lib/index.js:122-126`（`resolveTemplate` 的 `{N}` 依赖请求体 `n`）、`lib/index.js:406`（`sanitizeExtra(extra)` 依赖请求体 `extra`）
  - `CHANGELOG.md` 0.2 Migration：“`/commit <补充说明>`、`/commit-squash <N>` 的行内参数不再生效（贡献只响应裸 token）”
  - 官方 `dsh-client-ui-commands/README.md:12`：“a host descriptor with `input` is `leadingInput`”；`README.md:32`：“preserving its catalog row, **argument claim**, and lifecycle logging”
- **修法**：host 命令声明 `input: { hint }`，handler 的 `rawInput` 直接喂给 `sanitizeExtra` / `resolveTemplate` → 恢复 `/commit <补充说明>`、`/commit-squash <N>`。

### D3 — 计划检测用轮询 + 计数，会把别人的回合算进来 · P1

- **机制**：`waitForPlan` 反复 `whenIdle()` + 扫 `snapshotEvents(startSeq)`，只要出现**任何** `turn/end` 就计数，连续 3 次没找到围栏即判失败；取消判定靠 `/取消|不用了|先不/` 正则猜最后一条消息。用户在等待期间做别的事、或 agent 先问问题，都可能被判失败（失败信息还只是瞬时提示）。
- **证据**：`lib/index.js:291-323`（`waitForPlan` / `MAX_EMPTY_TURNS` / `JOB_TIMEOUT_MS = 10min`）
- **修法**：改为订阅会话/agent 事件，按本次唤醒的回合区间判定计划与取消；取消用显式事件而不是正则。

### D4 — 命令面之外的退路是「用户改口述 → agent 自己跑 git」（对应症状：仍然要跑 shell）· P1

- **机制**：客户端 `action` 只定义了「裸调用」行为；用户若在命令后补文字（`/commit 只提交 lib`）或直接口述需求，插件完全不介入，agent 收到的是**字面文本**，必然自己去跑 `git`/`pwsh`，于是撞上 DSH 沙箱的 `3221225794`。
- **证据**：
  - 会话日志（`~\.dsh\sessions\--D-code-dsh-smart-commit--`）：成功走插件的会话 `shellCalls=0, fence=9`；未走插件的会话 `shellCalls=18/37, fence=0, crash=23~32`
  - 官方 `dsh-client-ui-commands/README.md:12`：“a command line is never **silently downgraded** to a plain prompt”（这是 host 命令面的保证，客户端贡献不提供）
  - `dsh-commands/README.md:50`：“Lines that are not syntactically a command, or that name an unknown command, are **rejected by the adapter** instead of becoming a model prompt”
- **修法**：命令面 host 化后，`/commit ...` 由官方适配器解析并带参进 handler，不再可能悄悄退化成 prompt；另加一条兜底：注入/唤醒失败时返回 error 而不是静默继续。
- **待实测确认**：需要一次「`/commit 补充说明` + 回车」的现场验证，确认当前版本下该行是被当成 prompt 发出（若如此，D4 直接升级为 P0 症状根因）。

### D5 — `/smart-commit/status` 实现了但客户端从不调用，断线/刷新无任何恢复路径 · P2

- **证据**：`lib/index.js:471-494`（`createStatusHandler`，注释自称“SSE 的轮询兜底”）；`lib/client.js` 只用 `fetch` + `EventSource`，没有轮询兜底
- **修法**：host 命令化后本层可整体删除；若保留进度反馈，则挂载时查一次 status。

### D6 — 前瞻性风险：客户端契约已换代，当前 client.js 在新版会直接失效 · P1

- **机制**：本机另一个 dsh 安装（npm 全局，`@deepseek-ai/dsh` rc.7 + `dsh-client-ui-commands` rc.8）的契约已变为：`CommandUiSpec = { kind: 'popupSelect' }`（**没有 action**）、`description: string`（**不再是函数**）、贡献不再有 `label`/`icon`。当前 `lib/client.js` 注册的 `{ label: () => …, description: () => …, icon, ui: { kind: "action", run } }` 在新契约下是非法贡献。
- **证据**：`~npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-commands\lib\types\client\contract.d.ts:31-51,42-51`
- **修法**：D1/D2 的 host 命令化本身就是向后兼容的方向（host 命令面在 rc.8 仍存在，`decorate` 也在），可一并解决。

### D7 — `dsh.client.inject` 里混进了静态模块 · P3（待确认）

- **机制**：`package.json` 的 `dsh.client.inject` 列了 `@deepseek-ai/dsh-client-ui-primitives`，但官方它是 Web 外壳的**静态模块**（“React, React DOM, Cordis, ui-slots, and ui-primitives retain one browser identity through the web shell's static module table”），不是可等待的客户端 bundle；`dsh-client-modules` 里也搜不到它的提供方。
- **证据**：`dsh-client-ui-renderer/README.md:58`；`dsh-client-modules/lib/client.js:66`
- **修法**：从 `dsh.client.inject` 移除该 id（`require` 照旧）；顺带清理 `peerDependencies`。

### D8 — 冒烟测试只覆盖旧实现，0.4 的协议/客户端面零断言 · P2

- **证据**：`smoke.mjs` 只 `node --check lib/index.js` + 断言 `SQUASH_MIN/SQUASH_MAX/sanitizeExtra/EXTRA_MAX_CHARS` + 模板关键词；`lib/client.js`、`lib/git.js`（YAML 解析器）、贡献字段、命名互斥全部无覆盖。
- **修法**：扩展 smoke：git.js 的 YAML/JSON 计划用例、client.js 的贡献字段断言、host/客户端命名互斥断言、模板禁令关键词。

---

## 2. 建议的修改方案（供确认）

**方案 A（推荐，恢复 Zenith 体验）**

1. **命令面 host 化**：`lib/index.js` 用 `ctx.commands.register` 注册 `/commit`、`/commit-wip`、`/commit-amend`、`/commit-squash`，声明 `input: { hint }`；handler 内取 `{ agent, rawInput }`，立刻返回 `{ kind: "success", text }`，重活（采集事实 → 注入 → 等计划 → 执行）仍由宿主异步跑。
2. **结果走官方生命周期**：把执行结果写进 `command/done`（官方渲染），SSE + status 两条路由连同 `lib/client.js` 的 `watchJob` 一并删除。
3. **参数恢复**：`rawInput` → `extra` 走 `sanitizeExtra`；纯数字或 `N=` 形式 → `resolveTemplate` 的 `{N}`；squash 未给 N 时才问一次。
4. **可选菜单面**：若仍想要「图标 + 中文名」的斜杠菜单行，用 `ctx.commandUi.decorate` 给 host 命令挂一个 `action`（rc.2）/`popupSelect`（rc.8），保留 catalog 行、参数声明与生命周期；**注意官方规则：同名客户端贡献会与 host 命令冲突并报错，二者只能选一**。
5. **计划检测改为事件驱动**（D3），并把失败原因落进会话（不再依赖瞬时提示）。
6. **smoke 扩展**（D8）。

**方案 B（最小改动，保留现有架构）**：保留客户端贡献，只修 D2（客户端改成弹出输入框收集补充说明/数量）、D5（挂载时查 status 兜底）、D3（事件驱动）。**代价：结果依旧没有持久结果行，D1/症状 3 不会改善。**

**方案 C（在 A 之上把结果展示也追平 Zenith，已验证可行）**：按 A host 命令化，**并额外注册一个模型可见的宿主工具**（例如 `smart_commit`），由 agent 直接调用，工具内复用现有 `lib/git.js` 的校验与执行。

- 结果以 **tool/result 行**落在对话里（真实 git 输出、可回溯、刷新不丢）→ 与 Zenith 的「看得到真实命令与输出」对齐
- git 仍在**宿主进程**执行，完全不经过 agent 的 shell / 沙箱
- 顺带解决 D3（不再需要轮询 `waitForPlan`）与 D5（SSE / status 整层删除）
- 可行性证据：同生态的 `dsh-ops`（也装在 desktop profile 里）就是「profile 插件 + 手工构造 `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })` + **零 `@deepseek-ai/*` 裸导入**」的现成先例（`dsh-ops/lib/tools.js:190`）；官方 `dsh-tool-*` 用 `defineTool()` 只是类型/校验便利，不是硬性要求
- 代价：新增模型可见工具会改变工具目录（system prompt 变化），且需在模板里明确要求 agent 使用该工具；工作量大于 A

---

## 2.2 方案 A / C 与「Zenith 内置插件方式」的逐条差异

Zenith 内置（0.1，`D:\code\Zenith\plugins\dsh-smart-commit\src\host\index.js`）的形态：`ctx.commands.register` 注册四个 host 命令（**没有客户端半**），handler 把模板以非唤醒上下文 `inject` 进 agent、再用 `steer` 唤醒；之后 **git 全部由 agent 自己用 shell 工具执行**，安全约束只写在模板里。

| 维度 | Zenith 内置（0.1） | 方案 A | 方案 C |
|---|---|---|---|
| 命令面 | host 命令 + `input` 参数声明 | **相同**（恢复 host 命令） | 同 A，另加一个模型可见工具 |
| 行内参数 `/commit <补充>`、`/commit-squash <N>` | ✅ 原生支持 | ✅ 恢复 | ✅ 恢复 |
| 结果表面 | 命令生命周期行 + **agent 的 shell 工具行**（真实 git 命令与输出） | 命令生命周期行（`command/run`→`command/done`）+ 我们写进结果的执行摘要；**没有逐条 git 行** | 命令生命周期行 + **`smart_commit` 工具行**（真实 git 输出）≈ Zenith |
| 谁执行 git | agent（shell/pwsh） | 插件宿主进程（沿用 0.3 `lib/git.js`） | 同 A |
| 沙箱风险 | 有（官方桌面端会撞 `3221225794`，这正是 0.3 迁移的原因） | 无 | 无 |
| 安全约束强度 | 仅提示词（软约束） | 模板 + 宿主强制（敏感文件 / force push / `reset --hard` 全拒） | 同 A |
| 计划协议 | 无（agent 直接跑 git） | YAML 提交计划 → 宿主校验并执行 | 由工具入参取代围栏解析 |
| 结果是否刷新可见 | ✅（都在会话日志里） | ✅（生命周期结果在日志外渲染，但可回溯） | ✅ |
| 客户端半 | 无 | 可选 `ctx.commandUi.decorate`（rc.2 支持 action；rc.8 仅 popupSelect） | 同 A |

一句话：**方案 A = 把 Zenith 的命令形态与参数体验搬回来，git 执行仍留在宿主进程**；唯一仍不如 Zenith 的是「看不到逐条 git 命令与输出」，而**方案 C 用「宿主工具」把这一点也补齐**。

## 3. 验证方法（改完后按此验收）

1. 桌面端重启后，`/` 菜单里出现四个命令；菜单行显示图标/中文名（若走 `decorate` 则显示 host 描述）。
2. `/commit 只提交 lib 目录`：确认补充说明进入了注入上下文（不再被丢弃）。
3. `/commit-squash 3`：确认不再弹「压缩范围」提问。
4. 执行完成后**刷新页面**：结果仍在会话里（`command/done` 行）——这是 D1 的验收点。
5. 全程不出现 pwsh 调用（除非 agent 真的需要读文件）；会话日志 `shellCalls=0`。
6. `npm run smoke` 全绿。

---

## 4. 附：本次取证用到的临时脚本（不在仓库内）

`%TEMP%\dsh-asar\` 下：`asar.mjs`（asar 读写）、`grep.mjs`、`zdump.mjs`（多帧 zstd 会话日志检索）、`zsess.mjs`（会话结构统计）、`ztimeline.mjs`（事件时序）、`probe.mjs` / `show.mjs`。改完代码后可删除，不污染仓库。
