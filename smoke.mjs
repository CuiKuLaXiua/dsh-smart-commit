// dsh-smart-commit 冒烟：语法 + 模板/自包含断言 + 伪 ctx 挂载 + 真实临时 git 仓库端到端。
// 零依赖：只用 node: 内建模块与 node --check 级别断言（外加真实 git 执行）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const nodeExe = process.execPath;
const read = (rel) => readFileSync(join(here, rel), "utf8");

function ok(label) {
  console.log(`smoke: ${label} OK`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

//#region 1. 语法
for (const file of ["lib/index.js", "lib/git.js"]) {
  execFileSync(nodeExe, ["--check", join(here, file)], { stdio: "inherit" });
}
ok("lib/index.js + lib/git.js 语法");

//#region 2. 宿主半自包含与架构收敛
const entry = read("lib/index.js");
const gitLib = read("lib/git.js");
for (const source of [entry, gitLib]) {
  assert(!/(["'])@deepseek-ai\//.test(source), "宿主半含裸 @deepseek-ai/* import：宿主机运行时解析不到工作区包");
}
for (const anchor of ["INSPECT_TOOL", "COMMIT_TOOL", "WORKFLOW_TTL_MS", "MAX_ATTEMPTS", "SQUASH_MIN", "SQUASH_MAX", "sanitizeExtra", "EXTRA_MAX_CHARS", "normalizePlan"]) {
  assert(entry.includes(anchor), `index.js 缺少安全/协议锚点: ${anchor}`);
}
// 0.4/0.5 的旧实现必须彻底消失
for (const banned of ["EventSource", "/smart-commit/run", "/smart-commit/events", "/smart-commit/status", "webServer", "trustedHosts", "whenIdle", "waitForPlan", "collectFacts", "PLAN_PARAMETERS_V1"]) {
  assert(!entry.includes(banned), `index.js 仍残留旧实现 ${banned}`);
}
assert(!gitLib.includes("collectFacts"), "git.js 仍残留 collectFacts（0.6 起不再预注入 git 事实）");
assert(!existsSync(join(here, "lib", "client.js")), "lib/client.js 必须删除：同名客户端贡献会与 host 命令冲突");
ok("自包含 + 旧实现清理 + 客户端半移除");

//#region 3. 模板：必须点名两个工具、不得残留围栏协议、安全禁令必须在
const templateFiles = ["commit.md", "commit-wip.md", "commit-amend.md", "commit-squash.md"];
for (const file of templateFiles) {
  const body = read(`lib/templates/${file}`);
  assert(body.includes("smart_commit"), `${file} 未点名 smart_commit 工具`);
  assert(body.includes("smart_commit_inspect"), `${file} 未点名 smart_commit_inspect 只读探查工具`);
  assert(!/```smart-commit/.test(body), `${file} 仍残留围栏协议示例`);
  assert(!body.includes("Git 事实"), `${file} 仍在引用已移除的预注入 Git 事实`);
}
const requiredByTemplate = {
  "commit.md": ["reset --hard", "git push"],
  "commit-wip.md": ["reset --hard", "git push"],
  "commit-amend.md": ["reset --hard", "force-with-lease"],
  "commit-squash.md": ["reset --hard", "force-with-lease"],
};
for (const [file, keywords] of Object.entries(requiredByTemplate)) {
  const body = read(`lib/templates/${file}`);
  for (const keyword of keywords) {
    assert(body.includes(keyword), `${file} 缺少安全关键字: ${keyword}`);
  }
}
const rules = read("lib/templates/execution-rules.md");
for (const anchor of ["smart_commit_inspect", "smart_commit", "ask_user_question", "3221225794", "确认纪律", "部分成功"]) {
  assert(rules.includes(anchor), `execution-rules.md 缺少锚点: ${anchor}`);
}
ok("四模板 + execution-rules 协议与安全禁令");

//#region 4. 伪 ctx 挂载
const plugin = await import(pathToFileURL(join(here, "lib", "index.js")).href);

function mount() {
  const commands = new Map();
  const tools = new Map();
  const ctx = {
    commands: { register: (definition) => { commands.set(definition.name, definition); return () => {}; } },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
  };
  plugin.apply(ctx);
  return { commands, tools };
}

function fakeAgent(id, cwd) {
  const injected = [];
  const steered = [];
  return {
    agent: {
      id,
      session: { header: { cwd } },
      inject: (message) => injected.push(message),
      steer: (message) => steered.push(message),
    },
    injected,
    steered,
  };
}

const { commands, tools } = mount();
assert(commands.size === 4, `应注册 4 个命令，实际 ${commands.size}`);
for (const command of ["commit", "commit-wip", "commit-amend", "commit-squash"]) {
  const definition = commands.get(command);
  assert(definition !== undefined, `缺少命令 ${command}`);
  assert(definition.input?.hint !== undefined, `${command} 未声明 input 提示（行内参数会失效）`);
  assert(typeof definition.handler === "function", `${command} 缺少 handler`);
}
const tool = tools.get("smart_commit");
const inspect = tools.get("smart_commit_inspect");
assert(tool !== undefined, "缺少 smart_commit 工具");
assert(inspect !== undefined, "缺少 smart_commit_inspect 工具");
for (const [label, definition] of [["smart_commit", tool], ["smart_commit_inspect", inspect]]) {
  assert(definition.parameters?.type === "object", `${label} 参数必须是 JSON Schema 对象`);
  assert(typeof definition.output?.render === "function", `${label} 缺少 output.render（结果无法渲染）`);
}
ok("伪 ctx 挂载：4 个 host 命令 + 2 个工具");

//#region 5. 真实临时 git 仓库端到端
const sandbox = mkdtempSync(join(tmpdir(), "dsh-smart-commit-smoke-"));
const repo = join(sandbox, "repo");
function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

try {
  execFileSync("git", ["init", "-q", repo], { stdio: "inherit" });
  git("config", "user.email", "smoke@example.invalid");
  git("config", "user.name", "dsh-smart-commit smoke");
  git("config", "commit.gpgsign", "false");
  // 让沙箱仓库的行为不依赖宿主机全局 autocrlf（否则 LF→CRLF 归一化会凭空产生「不干净」）
  git("config", "core.autocrlf", "false");
  git("config", "core.safecrlf", "false");
  writeFileSync(join(repo, "a.txt"), "first\n");
  git("add", "--", "a.txt");
  git("commit", "-q", "-m", "chore: 初始提交");

  // 变更：一个正常文件 + 一个高置信敏感文件
  writeFileSync(join(repo, "a.txt"), "first\nsecond\n");
  writeFileSync(join(repo, "b.txt"), "new file\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");

  const sessionId = "session-smoke";
  const { agent, injected, steered } = fakeAgent(sessionId, repo);

  // 5.1 命令：/commit 行内补充说明进入注入上下文，且不再预注入 Git 事实
  const started = commands.get("commit").handler({ agent, rawInput: " 只提交 a.txt" });
  assert(started.kind === "success", `commit 命令应成功，实际 ${JSON.stringify(started)}`);
  assert(injected.length === 1 && steered.length === 1, "命令应注入一次上下文并唤醒一次");
  const injectedText = injected[0].content[0].text;
  assert(injectedText.includes("只提交 a.txt"), "行内补充说明未进入注入上下文");
  assert(injectedText.includes("smart_commit_inspect"), "注入的模板未点名只读探查工具");
  assert(!injectedText.includes("## Git 事实"), "0.6 起不应再预注入 Git 事实");
  assert(injected[0].source.kind === "dsh-smart-commit", "注入上下文缺少 producer-owned source kind");
  // 唤醒消息同样使用插件自有 kind：GUI 会把它渲染成可折叠的「上下文注入」行，
  // 而不是伪装成用户发言（渲染分流依据 source.kind，见 dsh-client-ui-chat 的 messageDefinition）
  assert(steered[0].source.kind === "dsh-smart-commit", "唤醒消息的 source 应为插件自有 kind（不应是 user）");
  const wakeText = steered[0].content[0].text;
  assert(wakeText.length <= 24, `唤醒文案应足够短，实际：${wakeText}`);
  assert(!wakeText.includes("shell"), "唤醒文案不应再重复模板里的禁令（禁令在注入模板中）");
  assert(injected[0].content[0].text.includes("执行约定"), "注入内容应包含执行约定模板");

  // 5.2 只读探查：返回终端风格原始回显
  const status = await inspect.execute({ command: "status" }, { agent });
  assert(status.ok === true && status.text.startsWith("$ git status"), `探查应回显原始命令，实际：${status.text.slice(0, 120)}`);
  assert(status.text.includes("a.txt") && status.text.includes(".env"), "探查未列出变更文件");
  const diffStat = await inspect.execute({ command: "diff", stat: true }, { agent });
  assert(diffStat.text.includes("$ git diff --stat HEAD"), "diff --stat 回显不正确");
  const log = await inspect.execute({ command: "log", limit: 3 }, { agent });
  assert(log.text.includes("$ git log --oneline -3"), "log 回显不正确");
  let inspectRejected = "";
  try {
    await inspect.execute({ command: "reset" }, { agent });
  } catch (error) {
    inspectRejected = String(error?.message ?? error);
  }
  assert(inspectRejected.includes("只读探查只支持"), `非只读子命令应被拒绝，实际：${inspectRejected}`);

  // 5.3 提交：入参被模型写成 JSON 字符串时必须宽松还原，且返回原始回显
  const result = await tool.execute({
    commits: JSON.stringify([{ message: "feat(a): 追加第二行" }]),
    push: false,
  }, { agent });
  assert(result.ok === true, "工具应返回 ok:true");
  assert(result.text.includes("$ git add"), "提交结果应回显 git add 原始命令");
  assert(result.text.includes("$ git commit"), "提交结果应回显 git commit 原始命令");
  assert(result.text.includes("$ git log --oneline -5 --stat"), "提交结果应回显结果日志");
  assert(git("log", "-1", "--pretty=%s").trim() === "feat(a): 追加第二行", "提交信息未生效");
  const tracked = git("ls-files").split("\n").map((line) => line.trim()).filter(Boolean);
  assert(!tracked.includes(".env"), ".env 被暂存了：敏感文件防护失效");
  assert(tracked.includes("a.txt") && tracked.includes("b.txt"), "正常变更未提交");

  // 5.4 单次使用：同一流程不能重复执行
  let reused = "";
  try {
    await tool.execute({ commits: [{ message: "chore: 重复提交" }] }, { agent });
  } catch (error) {
    reused = String(error?.message ?? error);
  }
  assert(reused.includes("没有进行中的提交流程"), `流程应单次使用，实际错误：${reused}`);

  // 5.5 权限收窄：WIP 流程不允许 push
  commands.get("commit-wip").handler({ agent, rawInput: "" });
  writeFileSync(join(repo, "c.txt"), "wip\n");
  let pushDenied = "";
  try {
    await tool.execute({ commits: [{ message: "wip: 测试" }], push: true }, { agent });
  } catch (error) {
    pushDenied = String(error?.message ?? error);
  }
  assert(pushDenied.includes("不允许推送"), `WIP 流程应拒绝 push，实际：${pushDenied}`);

  // 5.6 显式列出敏感文件 → 拒绝；随后正常 WIP 提交应成功（失败不消耗流程）
  let secretDenied = "";
  try {
    await tool.execute({ commits: [{ files: [".env"], message: "chore: 敏感" }] }, { agent });
  } catch (error) {
    secretDenied = String(error?.message ?? error);
  }
  assert(secretDenied.includes("敏感"), `显式暂存 .env 应被拒绝，实际：${secretDenied}`);
  const wipResult = await tool.execute({ commits: [{ message: "wip: 保存进度" }] }, { agent });
  assert(wipResult.ok === true && git("log", "-1", "--pretty=%s").trim() === "wip: 保存进度", "WIP 提交失败");

  // 5.7 部分成功：提交成功 + 推送失败 → 仍算成功，且保留提交与失败原文
  rmSync(join(repo, ".env"), { force: true });
  git("remote", "add", "origin", "file:///C:/nonexistent-dsh-smoke/repo.git");
  commands.get("commit").handler({ agent, rawInput: "" });
  writeFileSync(join(repo, "d.txt"), "partial\n");
  const partial = await tool.execute({ commits: [{ message: "chore: 部分成功用例" }], push: true }, { agent });
  assert(partial.ok === true, "提交成功、推送失败时必须按部分成功返回 ok:true");
  assert(partial.text.includes("$ git push"), "部分成功结果应包含推送的原始回显");
  assert(partial.text.includes("已完成的提交保留"), "部分成功结果应说明提交已保留");
  assert(git("log", "-1", "--pretty=%s").trim() === "chore: 部分成功用例", "部分成功用例的提交未生效");
  git("remote", "remove", "origin");

  // 5.8 squash 流程要求计划里给出 squash 数量
  commands.get("commit-squash").handler({ agent, rawInput: "2" });
  let squashShape = "";
  try {
    await tool.execute({ commits: [{ message: "chore: 缺少 squash" }] }, { agent });
  } catch (error) {
    squashShape = String(error?.message ?? error);
  }
  assert(squashShape.includes("squash"), `squash 流程应要求 squash 数量，实际：${squashShape}`);
  writeFileSync(join(repo, "e.txt"), "again\n");
  git("add", "--", "e.txt");
  git("commit", "-q", "-m", "wip: 第三个提交");
  const squashResult = await tool.execute({ commits: [{ squash: 2, message: "refactor: 合并临时提交" }] }, { agent });
  assert(squashResult.ok === true, "squash 执行失败");
  assert(squashResult.text.includes("$ git reset --soft HEAD~2"), "squash 结果应回显 reset --soft");
  assert(git("log", "-1", "--pretty=%s").trim() === "refactor: 合并临时提交", "squash 后提交信息不正确");

  // 5.9 amend 流程要求 amend:true，并改写最近一次提交
  commands.get("commit-amend").handler({ agent, rawInput: "" });
  let amendShape = "";
  try {
    await tool.execute({ commits: [{ message: "chore: 缺少 amend" }] }, { agent });
  } catch (error) {
    amendShape = String(error?.message ?? error);
  }
  assert(amendShape.includes("amend"), `amend 流程应要求 amend:true，实际：${amendShape}`);
  const countBefore = Number(git("rev-list", "--count", "HEAD").trim());
  const amendResult = await tool.execute({ commits: [{ amend: true, message: "refactor: 合并临时提交（修订）" }] }, { agent });
  assert(amendResult.ok === true, "amend 执行失败");
  assert(Number(git("rev-list", "--count", "HEAD").trim()) === countBefore, "amend 不应新增提交");
  assert(git("log", "-1", "--pretty=%s").trim() === "refactor: 合并临时提交（修订）", "amend 未改写 message");

  // 5.10 amend 情况 B：工作区干净时只改写 message（不应因「没有可暂存的文件」失败）
  commands.get("commit-amend").handler({ agent, rawInput: "" });
  const cleanAmend = await tool.execute({ commits: [{ amend: true, message: "refactor: 仅改写提交信息" }] }, { agent });
  assert(cleanAmend.ok === true, "干净工作区的 amend 应成功");
  assert(git("log", "-1", "--pretty=%s").trim() === "refactor: 仅改写提交信息", "仅改写 message 的 amend 未生效");
  assert(Number(git("rev-list", "--count", "HEAD").trim()) === countBefore, "仅改写 message 的 amend 不应新增提交");

  // 5.11 不可用的工作区：命令直接以 error 收场，工具不再可用
  //（注意：不能拿 %TEMP% 下的空目录来测——本机 `C:\Users\sky` 自身就是一个 git 仓库，
  //  其下任何目录都「在仓库内」，所以用一个不存在的目录来触发守卫）
  const missing = join(sandbox, "no-such-workspace");
  const outside = fakeAgent("session-missing", missing);
  const outsideStarted = commands.get("commit").handler({ agent: outside.agent, rawInput: "" });
  assert(outsideStarted.kind === "error", `不可用工作区的命令应以 error 收场，实际：${JSON.stringify(outsideStarted)}`);
  assert(String(outsideStarted.text).includes("不是 git 仓库"), "不可用工作区的错误文案应说明原因");

  ok("端到端：探查回显 / 入参宽松化 / 原始回显 / 敏感文件排除 / 单次使用 / 权限收窄 / 部分成功 / squash / amend / 非 git 目录");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("smoke: 全部通过");
