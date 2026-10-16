// dsh-smart-commit 冒烟：语法 + 模板禁令 + 自包含断言 + 伪 ctx 挂载 + 真实临时 git 仓库端到端。
// 零依赖：只用 node: 内建模块与 node --check 级别断言（外加一次真实 git 执行）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
for (const anchor of ["TOOL_NAME", "WORKFLOW_TTL_MS", "MAX_ATTEMPTS", "SQUASH_MIN", "SQUASH_MAX", "sanitizeExtra", "EXTRA_MAX_CHARS"]) {
  assert(entry.includes(anchor), `index.js 缺少安全/协议锚点: ${anchor}`);
}
// 0.5 起命令面是 host 命令 + 宿主工具：这些 0.4 的实现必须彻底消失
for (const banned of ["EventSource", "/smart-commit/run", "/smart-commit/events", "/smart-commit/status", "webServer", "trustedHosts", "whenIdle", "waitForPlan"]) {
  assert(!entry.includes(banned), `index.js 仍残留 0.4 的 ${banned} 实现`);
}
assert(!existsSync(join(here, "lib", "client.js")), "lib/client.js 必须删除：同名客户端贡献会与 host 命令冲突");
assert(!/```smart-commit/.test(entry), "index.js 仍残留围栏协议");
ok("自包含 + 0.4 残留清理 + 客户端半移除");

//#region 3. 模板：必须点名工具、不得残留围栏协议、安全禁令必须在
const templateFiles = ["commit.md", "commit-wip.md", "commit-amend.md", "commit-squash.md"];
for (const file of templateFiles) {
  const body = read(`lib/templates/${file}`);
  assert(body.includes("smart_commit"), `${file} 未点名 smart_commit 工具`);
  assert(!/```smart-commit/.test(body), `${file} 仍残留围栏协议示例`);
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
for (const anchor of ["smart_commit", "ask_user_question", "3221225794", "确认纪律"]) {
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
assert(tool !== undefined, "缺少 smart_commit 工具");
assert(tool.parameters?.type === "object", "smart_commit 参数必须是 JSON Schema 对象");
assert(typeof tool.output?.render === "function", "smart_commit 缺少 output.render（结果无法渲染）");
ok("伪 ctx 挂载：4 个 host 命令 + smart_commit 工具");

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

  // 5.1 命令：/commit 行内补充说明必须进入注入上下文
  const started = commands.get("commit").handler({ agent, rawInput: " 只提交 a.txt" });
  assert(started.kind === "success", `commit 命令应成功，实际 ${JSON.stringify(started)}`);
  assert(injected.length === 1 && steered.length === 1, "命令应注入一次上下文并唤醒一次");
  const injectedText = injected[0].content[0].text;
  assert(injectedText.includes("Git 事实"), "注入内容缺少 git 事实");
  assert(injectedText.includes("只提交 a.txt"), "行内补充说明未进入注入上下文");
  assert(injected[0].source.kind === "dsh-smart-commit", "注入上下文缺少 producer-owned source kind");
  assert(steered[0].source.kind === "user", "唤醒消息的 source 应为 user");
  assert(steered[0].content[0].text.includes("smart_commit"), "唤醒语未点名工具");

  // 5.2 工具：执行提交（敏感文件自动排除）
  const result = await tool.execute({ commits: [{ message: "feat(a): 追加第二行" }], push: false }, { agent });
  assert(result.ok === true, "工具应返回 ok:true");
  assert(git("log", "-1", "--pretty=%s").trim() === "feat(a): 追加第二行", "提交信息未生效");
  const tracked = git("ls-files").split("\n").map((line) => line.trim()).filter(Boolean);
  assert(!tracked.includes(".env"), ".env 被暂存了：敏感文件防护失效");
  assert(tracked.includes("a.txt") && tracked.includes("b.txt"), "正常变更未提交");

  // 5.3 单次使用：同一流程不能重复执行
  let reused = "";
  try {
    await tool.execute({ commits: [{ message: "chore: 重复提交" }] }, { agent });
  } catch (error) {
    reused = String(error?.message ?? error);
  }
  assert(reused.includes("没有进行中的提交流程"), `流程应单次使用，实际错误：${reused}`);

  // 5.4 权限收窄：WIP 流程不允许 push
  commands.get("commit-wip").handler({ agent, rawInput: "" });
  writeFileSync(join(repo, "c.txt"), "wip\n");
  let pushDenied = "";
  try {
    await tool.execute({ commits: [{ message: "wip: 测试" }], push: true }, { agent });
  } catch (error) {
    pushDenied = String(error?.message ?? error);
  }
  assert(pushDenied.includes("不允许推送"), `WIP 流程应拒绝 push，实际：${pushDenied}`);

  // 5.5 显式列出敏感文件 → 拒绝；随后正常 WIP 提交应成功（失败不消耗流程）
  let secretDenied = "";
  try {
    await tool.execute({ commits: [{ files: [".env"], message: "chore: 敏感" }] }, { agent });
  } catch (error) {
    secretDenied = String(error?.message ?? error);
  }
  assert(secretDenied.includes("敏感"), `显式暂存 .env 应被拒绝，实际：${secretDenied}`);
  const wipResult = await tool.execute({ commits: [{ message: "wip: 保存进度" }] }, { agent });
  assert(wipResult.ok === true && git("log", "-1", "--pretty=%s").trim() === "wip: 保存进度", "WIP 提交失败");

  // 5.6 squash 流程要求计划里给出 squash 数量（先清掉前面刻意留下的未跟踪敏感文件：
  // 未跟踪文件也算「工作区不干净」，squash 前需要干净工作区——这是既有的安全语义）
  rmSync(join(repo, ".env"), { force: true });
  commands.get("commit-squash").handler({ agent, rawInput: "2" });
  let squashShape = "";
  try {
    await tool.execute({ commits: [{ message: "chore: 缺少 squash" }] }, { agent });
  } catch (error) {
    squashShape = String(error?.message ?? error);
  }
  assert(squashShape.includes("squash"), `squash 流程应要求 squash 数量，实际：${squashShape}`);
  writeFileSync(join(repo, "d.txt"), "again\n");
  git("add", "--", "d.txt");
  git("commit", "-q", "-m", "wip: 第三个提交");
  const squashResult = await tool.execute({ commits: [{ squash: 2, message: "refactor: 合并临时提交" }] }, { agent });
  assert(squashResult.ok === true, "squash 执行失败");
  assert(git("log", "-1", "--pretty=%s").trim() === "refactor: 合并临时提交", "squash 后提交信息不正确");

  // 5.7 amend 流程要求 amend:true，并改写最近一次提交
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

  // 5.7b amend 情况 B：工作区干净时只改写 message（不应因「没有可暂存的文件」失败）
  commands.get("commit-amend").handler({ agent, rawInput: "" });
  const cleanAmend = await tool.execute({ commits: [{ amend: true, message: "refactor: 仅改写提交信息" }] }, { agent });
  assert(cleanAmend.ok === true, "干净工作区的 amend 应成功");
  assert(git("log", "-1", "--pretty=%s").trim() === "refactor: 仅改写提交信息", "仅改写 message 的 amend 未生效");
  assert(Number(git("rev-list", "--count", "HEAD").trim()) === countBefore, "仅改写 message 的 amend 不应新增提交");

  // 5.8 非 git 目录：命令不抛异常，工具给出可读失败信息
  const plain = join(sandbox, "plain");
  mkdirSync(plain, { recursive: true });
  const outside = fakeAgent("session-plain", plain);
  const outsideStarted = commands.get("commit").handler({ agent: outside.agent, rawInput: "" });
  assert(outsideStarted.kind === "success", `非 git 目录的命令不应失败，实际：${JSON.stringify(outsideStarted)}`);
  let outsideError = "";
  try {
    await tool.execute({ commits: [{ message: "chore: 非 git 目录" }] }, { agent: outside.agent });
  } catch (error) {
    outsideError = String(error?.message ?? error);
  }
  assert(outsideError.includes("没有可暂存的文件"), `非 git 目录应给出可读错误，实际：${outsideError}`);

  ok("端到端：命令注入 / 敏感文件排除 / 单次使用 / 权限收窄 / squash / amend / 非 git 目录");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("smoke: 全部通过");
