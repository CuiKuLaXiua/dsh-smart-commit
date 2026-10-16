// dsh-smart-commit — 宿主侧 git 执行器。
//
// 0.3 起所有 git 操作都在插件宿主进程内执行（node:child_process 直跑 git.exe）：
// 宿主进程不受 agent 命令沙箱约束，因此不受 Windows 上 pwsh 偶发启动失败
// （退出码 3221225794 = 0xC0000142）的影响。所有参数以数组形式传递，不经过
// shell；执行前做路径与内容校验，敏感文件、force 推送、reset --hard 等在本层
// 直接拒绝（模板约束 + 宿主强制双保险）。
//
// 0.6 起另提供只读探查（inspectRepo）：agent 用它自己看清仓库状态，返回**原始 git 输出**，
// 与在 Zenith 里 agent 自己跑 `git status` / `git diff` / `git log` 的观感一致；执行结果同样
// 回显原始输出，并支持部分成功（先做的提交不会被后面的失败吞掉）。

import { execFileSync } from "node:child_process";

const GIT = "git";
const MAX_BUFFER = 8 * 1024 * 1024;
/** commit message 上限：防异常超长输入。 */
const MESSAGE_LIMIT = 16 * 1024;
/** 单次 add 的文件数上限：防 argv 过长。 */
const MAX_STAGE_FILES = 2000;

// 高置信敏感文件：命中即拒绝暂取（与模板规则同源，宿主侧强制执行）
const SECRET_PATH_RE = /(^|[\\/])(\.env(\.[^\\/]+)?|\.env|id_rsa[^\\/]*|id_ed25519[^\\/]*|\.npmrc|\.pypirc|\.netrc|credentials(\.[^\\/]+)?|\.kube[\\/]config|\.aws[\\/]credentials)$/i;
const SECRET_EXT_RE = /\.(pem|key|p12|pfx|jks|keystore|asc)$/i;

/** 执行一条 git 命令；非零退出不抛异常，结果带 ok 标记。 */
function git(cwd, args) {
  try {
    const stdout = execFileSync(GIT, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout, stderr: stderr || message, status: typeof error?.status === "number" ? error.status : -1 };
  }
}

/** 是否敏感文件（高置信，阻断）。 */
export function isSecretPath(path) {
  const base = String(path).replace(/\\/g, "/");
  return SECRET_PATH_RE.test(base) || SECRET_EXT_RE.test(base);
}

/** 该目录是否在 git 仓库内（命令流程的前置校验）。 */
export function isRepo(cwd) {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).ok;
}

/** `git status --porcelain -z -uall` 条目；重命名取新路径。 */
function listStatusEntries(cwd) {
  const res = git(cwd, ["status", "--porcelain", "-z", "-uall"]);
  if (!res.ok) return [];
  const parts = res.stdout.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    let path = entry.slice(3);
    if (code.includes("R") || code.includes("C")) {
      i += 1;
      if (i < parts.length) path = parts[i];
    }
    // git 可能给出目录形式的未跟踪项（配置关闭 -uall 时）；统一去掉尾部斜杠
    if (path.endsWith("/")) path = path.slice(0, -1);
    if (path) entries.push({ code, path });
  }
  return entries;
}

function truncate(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断，共 ${value.length} 字符）`;
}

/** 路径是否被 status 条目覆盖（文件本身或其所在目录）。 */
function isCovered(path, entries) {
  const target = String(path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!target || target === "." || target === "-A" || target === "*") return true;
  if (target.includes("..")) return false;
  return entries.some((entry) => {
    const candidate = entry.path.replace(/\\/g, "/").replace(/\/+$/, "");
    return candidate === target
      || candidate.startsWith(`${target}/`)
      || target.startsWith(`${candidate}/`);
  });
}

function isSafeRelativePath(path) {
  const value = String(path);
  if (!value || value.includes("\0")) return false;
  if (value.includes("..")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  return true;
}

function assertMessage(message) {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error("提交计划缺少 message（commit message 不能为空）");
  }
  if (message.length > MESSAGE_LIMIT) {
    throw new Error(`commit message 超过 ${MESSAGE_LIMIT} 字符上限`);
  }
}

function assertFiles(files, entries) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) throw new Error("提交计划的 files 必须是数组");
  if (files.length > MAX_STAGE_FILES) throw new Error(`单次暂存文件数超过上限（${MAX_STAGE_FILES}）`);
  const paths = [];
  for (const file of files) {
    if (typeof file !== "string") throw new Error("提交计划的 files 只能包含字符串路径");
    const trimmed = file.trim();
    if (trimmed === "" || trimmed === "-A" || trimmed === "." || trimmed === "*") continue;
    if (!isSafeRelativePath(trimmed)) throw new Error(`不安全的文件路径：${file}`);
    if (!isCovered(trimmed, entries)) throw new Error(`文件不在本次变更清单中：${file}`);
    paths.push(trimmed);
  }
  return paths;
}

//#region 只读探查（原始 git 回显）

/** 只读探查允许的 git 子命令（其余一律拒绝）。 */
const INSPECT_COMMANDS = ["status", "diff", "log", "show", "branch", "remote"];
/** 单次探查返回文本的截断上限。 */
const INSPECT_LIMIT = 32 * 1024;

/** 校验 revision：只接受常规 revision 语法，且不得以 `-` 开头（避免被当成选项）。 */
function assertRevision(rev) {
  if (rev === undefined || rev === null || rev === "") return undefined;
  const value = String(rev).trim();
  if (!/^[\w.\-~^@{}/]{1,80}$/.test(value) || value.startsWith("-")) {
    throw new Error(`不安全的 revision：${rev}`);
  }
  return value;
}

/** 校验探查用的 path：必须是仓库内相对路径。 */
function assertInspectPath(path) {
  if (path === undefined || path === null || path === "") return undefined;
  const value = String(path).trim();
  if (!isSafeRelativePath(value)) throw new Error(`不安全的文件路径：${path}`);
  return value;
}

/** 把一条 git 命令与它的原始输出渲染成终端风格（与 agent 自己跑 git 时的观感一致）。 */
function renderCall(args, res) {
  const lines = [`$ git ${args.join(" ")}`];
  const out = String(res.stdout ?? "").trimEnd();
  const err = String(res.stderr ?? "").trimEnd();
  if (out) lines.push(out);
  if (err) lines.push(err);
  if (!out && !err) lines.push(res.ok ? "（无输出）" : `（退出码 ${res.status}）`);
  else if (!res.ok) lines.push(`（退出码 ${res.status}）`);
  return lines.join("\n");
}

/**
 * 只读探查：返回指定 git 子命令的**原始输出**（宿主进程执行，不经 agent 的 shell）。
 * 只读命令不参与提交流程，随时可调用——agent 用它自己看清仓库状态，与在 Zenith 里
 * 自己跑 `git status` / `git diff` / `git log` 的观感一致。
 *
 * @param cwd 会话仓库根目录
 * @param input { command, path?, cached?, stat?, limit?, rev? }
 * @returns { text } 终端风格文本
 */
export function inspectRepo(cwd, input = {}) {
  const command = String(input?.command ?? "").trim();
  if (!INSPECT_COMMANDS.includes(command)) {
    throw new Error(`只读探查只支持 ${INSPECT_COMMANDS.join(" / ")}，收到：${String(input?.command)}`);
  }
  let args;
  if (command === "status") {
    args = ["status", "--porcelain=v1", "-uall"];
  } else if (command === "diff") {
    const path = assertInspectPath(input.path);
    args = input.stat === true
      ? ["diff", "--stat", "HEAD"]
      : input.cached === true
        ? ["diff", "--cached"]
        : ["diff", "HEAD"];
    if (path !== undefined) args.push("--", path);
  } else if (command === "log") {
    const limit = Math.min(Math.max(Number.isInteger(input.limit) ? input.limit : 10, 1), 50);
    args = input.stat === true
      ? ["log", "--oneline", `-${limit}`, "--stat"]
      : ["log", "--oneline", `-${limit}`];
  } else if (command === "show") {
    args = ["show", "--stat", "--oneline", assertRevision(input.rev) ?? "HEAD"];
  } else if (command === "branch") {
    args = ["branch", "-vv"];
  } else {
    args = ["remote", "-v"];
  }
  const res = git(cwd, args);
  return { text: truncate(renderCall(args, res), INSPECT_LIMIT) };
}
//#endregion

//#region 执行（原始回显 + 部分成功）

/** 单次执行返回文本的截断上限。 */
const RESULT_LIMIT = 16 * 1024;

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** commit 命令的终端风格回显：只回显 subject，避免把整段 message 重复一遍。 */
function commitEcho(group) {
  const subject = String(group.message).split(/\r?\n/)[0];
  const more = String(group.message).includes("\n") ? "…" : "";
  return `$ git commit${group.amend === true ? " --amend" : ""} -m "${subject}${more}"`;
}

/** 暂存 + 提交一组变更。显式 files 命中敏感文件直接拒绝；省略 files 时自动排除敏感文件。 */
function stageAndCommit(cwd, group, entries) {
  const explicit = assertFiles(group.files, entries);
  let targets;
  let autoExcluded = [];
  if (explicit.length > 0) {
    // 展开目录为目标文件，避免 `git add -- dir` 绕过敏感文件检查
    const covered = [];
    for (const target of explicit) {
      for (const entry of entries) {
        const candidate = entry.path.replace(/\\/g, "/");
        if (candidate === target || candidate.startsWith(`${target}/`) || target.startsWith(`${candidate}/`)) {
          covered.push(entry.path);
        }
      }
    }
    targets = [...new Set(covered)];
    const blocked = targets.filter((path) => isSecretPath(path));
    if (blocked.length > 0) {
      throw new Error(`已拦截敏感文件，未执行提交：${blocked.join("、")}`);
    }
  } else {
    targets = entries.map((entry) => entry.path);
    autoExcluded = targets.filter((path) => isSecretPath(path));
    targets = targets.filter((path) => !isSecretPath(path));
  }
  const blocks = [];
  let noStageNote = "";
  if (targets.length === 0) {
    // amend 且工作区干净：只改写 message（amend 流程的「情况 B」）
    if (group.amend !== true) {
      throw new Error(autoExcluded.length > 0
        ? `没有可暂存的文件（敏感文件已被排除：${autoExcluded.join("、")}）`
        : "没有可暂存的文件");
    }
    noStageNote = autoExcluded.length > 0
      ? `（工作区无其它变更；敏感文件未暂存：${autoExcluded.join("、")}）`
      : "（工作区无变更，仅改写提交信息）";
  } else {
    const addArgs = ["add", "--", ...targets];
    const added = git(cwd, addArgs);
    blocks.push(renderCall(addArgs, added));
    if (!added.ok) {
      throw new Error(`git add 失败：${truncate(added.stderr || added.stdout, 500)}`);
    }
  }
  const commitArgs = group.amend === true
    ? ["commit", "--amend", "-m", group.message]
    : ["commit", "-m", group.message];
  const committed = git(cwd, commitArgs);
  blocks.push(commitEcho(group));
  if (!committed.ok) {
    throw new Error(`git commit 失败：${truncate(committed.stderr || committed.stdout, 800)}`);
  }
  blocks.push(String(committed.stdout).trimEnd());
  if (autoExcluded.length > 0) {
    blocks.push(`（已自动排除敏感文件：${autoExcluded.join("、")}）`);
  }
  if (noStageNote) {
    blocks.push(noStageNote);
  }
  return blocks.join("\n");
}

/** squash：soft reset 回 N 个提交后再提交。 */
function squashCommits(cwd, group, entries) {
  if (!Number.isInteger(group.squash) || group.squash < 1) {
    throw new Error("squash 数量必须是 ≥ 1 的整数");
  }
  if (!entries.every((entry) => entry.code.trim() === "")) {
    throw new Error("工作区不干净，squash 前请先提交或 stash 当前变更");
  }
  const total = git(cwd, ["rev-list", "--count", "HEAD"]);
  const count = Number(total.stdout.trim());
  if (!total.ok || !Number.isInteger(count) || group.squash > count) {
    throw new Error(`squash 数量超出可压缩范围（当前共 ${total.stdout.trim() || "?"} 个提交）`);
  }
  const blocks = [];
  const resetArgs = ["reset", "--soft", `HEAD~${group.squash}`];
  const reset = git(cwd, resetArgs);
  blocks.push(renderCall(resetArgs, reset));
  if (!reset.ok) {
    throw new Error(`git reset --soft 失败：${truncate(reset.stderr || reset.stdout, 500)}`);
  }
  const commitArgs = ["commit", "-m", group.message];
  const committed = git(cwd, commitArgs);
  blocks.push(commitEcho(group));
  if (!committed.ok) {
    throw new Error(`git commit 失败：${truncate(committed.stderr || committed.stdout, 800)}`);
  }
  blocks.push(String(committed.stdout).trimEnd());
  return blocks.join("\n");
}

/**
 * 推送：仅普通 push；无上游时补一次 `-u origin <branch>`；永不 force。
 * 失败不抛异常——由调用方按「部分成功」处理，把原始错误原文透出。
 * @returns { text, failed, error }
 */
function pushCommits(cwd) {
  const remotes = git(cwd, ["remote"]);
  if (!remotes.ok || !/(^|\s)origin(\s|$)/m.test(remotes.stdout)) {
    return { text: "$ git push\n（未配置 origin 远程仓库，未推送）", failed: false };
  }
  const blocks = [];
  const firstArgs = ["push"];
  const first = git(cwd, firstArgs);
  blocks.push(renderCall(firstArgs, first));
  if (first.ok) return { text: blocks.join("\n"), failed: false };
  const detail = truncate((first.stderr || first.stdout).trim(), 700);
  if (/no upstream|set-upstream|upstream branch/i.test(detail)) {
    const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    const retryArgs = ["push", "-u", "origin", branch];
    const retry = git(cwd, retryArgs);
    blocks.push(renderCall(retryArgs, retry));
    if (retry.ok) return { text: blocks.join("\n"), failed: false };
    return {
      text: blocks.join("\n"),
      failed: true,
      error: `git push -u origin ${branch} 失败：${truncate((retry.stderr || retry.stdout).trim(), 700)}`,
    };
  }
  return { text: blocks.join("\n"), failed: true, error: `git push 失败：${detail}` };
}

/**
 * 执行提交计划。计划来自 `smart_commit` 工具入参，已通过 {@link validatePlan} 校验。
 *
 * 部分成功语义（与在 Zenith 里 agent 自己逐步跑 git 一致）：先做的提交不会被后面的失败吞掉——
 * 只要产生过提交，结果就是成功，失败步骤的**原始错误原文**附在结果里。
 *
 * @param cwd 仓库根目录（会话工作区）
 * @param plan { commits: [{files?, message, amend?, squash?}], push? }
 * @returns { text, committed, failure? } text 为原始 git 回显（作为工具结果显示在对话里）
 */
export function executePlan(cwd, plan) {
  const blocks = [];
  let committed = 0;
  let failure;
  for (const group of plan.commits) {
    const entries = listStatusEntries(cwd);
    try {
      blocks.push(group.squash !== undefined
        ? squashCommits(cwd, group, entries)
        : stageAndCommit(cwd, group, entries));
      committed += 1;
    } catch (error) {
      failure = {
        step: group.squash !== undefined ? `git reset --soft HEAD~${group.squash} + commit` : "git commit",
        message: messageOf(error),
      };
      break;
    }
  }
  if (failure === undefined && plan.push === true) {
    const pushed = pushCommits(cwd);
    blocks.push(pushed.text);
    if (pushed.failed === true) failure = { step: "git push", message: pushed.error };
  }
  const summaryArgs = ["log", "--oneline", "-5", "--stat"];
  blocks.push(renderCall(summaryArgs, git(cwd, summaryArgs)));
  return {
    text: truncate(blocks.filter((block) => block !== "").join("\n\n"), RESULT_LIMIT),
    committed,
    ...failure === undefined ? {} : { failure },
  };
}
//#endregion

//#region 提交计划校验（宿主强制）

/** 一次最多允许的提交分组数。 */
const MAX_COMMIT_GROUPS = 10;

/** 校验一组目标文件路径：不安全路径直接拒绝，敏感文件留给执行层拦截。 */
function assertPlanFiles(files) {
  if (files === undefined || files === null) return;
  if (!Array.isArray(files)) throw new Error("commits[].files 必须是字符串数组");
  if (files.length > MAX_STAGE_FILES) throw new Error(`单次暂存文件数超过上限（${MAX_STAGE_FILES}）`);
  for (const file of files) {
    if (typeof file !== "string") throw new Error("commits[].files 只能包含字符串路径");
    const trimmed = file.trim();
    if (trimmed === "" || trimmed === "-A" || trimmed === "." || trimmed === "*") continue;
    if (!isSafeRelativePath(trimmed)) throw new Error(`不安全的文件路径：${file}`);
  }
}

/**
 * 校验计划分组：message 必填，squash 必须是 1–50 的整数。
 * @param group 计划里的一个 commits 元素
 */
function assertPlanGroup(group) {
  if (typeof group !== "object" || group === null) throw new Error("commits 数组元素必须是对象");
  assertMessage(group.message);
  if (group.amend !== undefined && typeof group.amend !== "boolean") throw new Error("amend 必须是布尔值");
  if (group.squash !== undefined && (!Number.isInteger(group.squash) || group.squash < 1 || group.squash > 50)) {
    throw new Error("squash 数量必须是 1–50 的整数");
  }
  assertPlanFiles(group.files);
}

/**
 * 校验 agent 通过 `smart_commit` 工具提交的计划（计划即工具入参，没有文本协议）。
 *
 * @param plan { commits: [{files?, message, amend?, squash?}], push? }
 * @param options { allowPush, allowAmend, allowSquash } 由触发流程的命令决定
 * @returns 规范化后的 { commits, push }
 */
export function validatePlan(plan, options = {}) {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new Error("提交计划必须是对象（{ commits: [...], push?: boolean }）");
  }
  if (!Array.isArray(plan.commits) || plan.commits.length === 0) {
    throw new Error("提交计划必须包含非空 commits 数组");
  }
  if (plan.commits.length > MAX_COMMIT_GROUPS) {
    throw new Error(`一次最多 ${MAX_COMMIT_GROUPS} 个提交分组`);
  }
  for (const group of plan.commits) assertPlanGroup(group);
  if (plan.push !== undefined && typeof plan.push !== "boolean") throw new Error("push 必须是布尔值");
  if (plan.push === true && options.allowPush !== true) throw new Error("当前流程不允许推送");
  if (plan.commits.some((group) => group.amend === true) && options.allowAmend !== true) {
    throw new Error("当前流程不允许 amend");
  }
  if (plan.commits.some((group) => group.squash !== undefined) && options.allowSquash !== true) {
    throw new Error("当前流程不允许 squash");
  }
  return { commits: plan.commits.map((group) => ({ ...group })), push: plan.push === true };
}
//#endregion
