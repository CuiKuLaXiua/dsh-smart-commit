// dsh-smart-commit — 宿主侧 git 执行器。
//
// 0.3 起所有 git 操作都在插件宿主进程内执行（node:child_process 直跑 git.exe）：
// 宿主进程不受 agent 命令沙箱约束，因此不受 Windows 上 pwsh 偶发启动失败
// （退出码 3221225794 = 0xC0000142）的影响。所有参数以数组形式传递，不经过
// shell；执行前做路径与内容校验，敏感文件、force 推送、reset --hard 等在本层
// 直接拒绝（模板约束 + 宿主强制双保险）。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT = "git";
const MAX_BUFFER = 8 * 1024 * 1024;
/** commit message 上限：防异常超长输入。 */
const MESSAGE_LIMIT = 16 * 1024;
/** 注入给 agent 的 diff 事实截断上限。 */
const FACTS_DIFF_LIMIT = 24 * 1024;
/** 单次 add 的文件数上限：防 argv 过长。 */
const MAX_STAGE_FILES = 2000;

// 高置信敏感文件：命中即拒绝暂取（与模板规则同源，宿主侧强制执行）
const SECRET_PATH_RE = /(^|[\\/])(\.env(\.[^\\/]+)?|\.env|id_rsa[^\\/]*|id_ed25519[^\\/]*|\.npmrc|\.pypirc|\.netrc|credentials(\.[^\\/]+)?|\.kube[\\/]config|\.aws[\\/]credentials)$/i;
const SECRET_EXT_RE = /\.(pem|key|p12|pfx|jks|keystore|asc)$/i;
// 宽匹配：只警告不阻断（避免误伤 token.ts 这类正常文件）
const SUSPECT_PATH_RE = /(secret|token|password|passwd|apikey|api_key)/i;

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

/** 是否疑似敏感文件（宽匹配，仅警告）。 */
function isSuspectPath(path) {
  return SUSPECT_PATH_RE.test(String(path).replace(/\\/g, "/"));
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

/**
 * 采集注入给 agent 的 git 事实。任何单条命令失败都降级为空字符串，
 * 不让事实采集本身阻断流程。
 */
export function collectFacts(cwd) {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const remotes = git(cwd, ["remote", "-v"]);
  const status = git(cwd, ["status", "--porcelain", "-uall"]);
  const diffStat = git(cwd, ["diff", "--stat", "HEAD"]);
  const diff = git(cwd, ["diff", "HEAD"]);
  const log = git(cwd, ["log", "--oneline", "-10"]);
  const branchVv = git(cwd, ["branch", "-vv"]);
  const head = git(cwd, ["show", "--stat", "--oneline", "HEAD"]);

  const entries = listStatusEntries(cwd);
  const secrets = entries.filter((entry) => isSecretPath(entry.path)).map((entry) => entry.path);
  const suspects = entries.filter((entry) => !isSecretPath(entry.path) && isSuspectPath(entry.path)).map((entry) => entry.path);

  const lines = [];
  lines.push("## Git 事实（由插件宿主进程直接采集）");
  lines.push("");
  lines.push(`- 仓库根目录：\`${cwd}\``);
  lines.push(`- 当前分支：\`${branch.stdout.trim() || "未知"}\`${upstream.ok ? `（跟踪 \`${upstream.stdout.trim()}\`）` : "（无上游跟踪分支）"}`);
  lines.push(`- 工作区：${entries.length === 0 ? "干净，无变更" : `${entries.length} 个文件有变更`}`);
  if (remotes.ok && remotes.stdout.trim()) {
    lines.push("- 远程仓库：");
    for (const line of remotes.stdout.trim().split(/\r?\n/)) lines.push(`  - \`${line.trim()}\``);
  } else {
    lines.push("- 远程仓库：未配置");
  }
  lines.push("");
  lines.push("### git status --porcelain");
  lines.push("```");
  lines.push(status.stdout.trimEnd() || "（无输出）");
  lines.push("```");
  lines.push("");
  lines.push("### git diff --stat HEAD");
  lines.push("```");
  lines.push(diffStat.stdout.trimEnd() || diffStat.stderr.trimEnd() || "（无输出）");
  lines.push("```");
  lines.push("");
  lines.push("### git diff HEAD（超长已截断）");
  lines.push("```");
  lines.push(truncate(diff.stdout.trimEnd() || "（无输出）", FACTS_DIFF_LIMIT));
  lines.push("```");
  lines.push("");
  lines.push("### git log --oneline -10");
  lines.push("```");
  lines.push(log.stdout.trimEnd() || "（无提交历史）");
  lines.push("```");
  lines.push("");
  lines.push("### git branch -vv");
  lines.push("```");
  lines.push(branchVv.stdout.trimEnd() || "（无输出）");
  lines.push("```");
  lines.push("");
  lines.push("### git show --stat HEAD（amend / squash 用）");
  lines.push("```");
  lines.push(head.stdout.trimEnd() || "（无提交历史）");
  lines.push("```");
  lines.push("");
  lines.push("### 敏感文件检查（插件宿主强制执行）");
  if (secrets.length > 0) {
    lines.push(`发现高置信敏感文件，**已被插件锁定、不会暂存**：${secrets.map((p) => `\`${p}\``).join("、")}`);
  } else {
    lines.push("未发现高置信敏感文件（.env*、*.pem、*.key、id_rsa*、.npmrc、*credentials* 等）。");
  }
  if (suspects.length > 0) {
    lines.push(`以下文件名字段疑似敏感，请自行判断是否排除：${suspects.map((p) => `\`${p}\``).join("、")}`);
  }

  return {
    text: lines.join("\n"),
    entries,
    secrets,
    suspects,
    branch: branch.stdout.trim(),
    hasUpstream: upstream.ok,
    hasOrigin: /(^|\s)origin\s/i.test(remotes.stdout),
    clean: entries.length === 0,
  };
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

function writeMessageFile(message) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-smart-commit-"));
  const file = join(dir, "COMMIT_MSG.txt");
  writeFileSync(file, message, "utf8");
  return { file, dir };
}

function removeMessageFile(handle) {
  rmSync(handle.dir, { recursive: true, force: true });
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
  if (targets.length === 0) {
    throw new Error(autoExcluded.length > 0
      ? `没有可暂存的文件（敏感文件已被排除：${autoExcluded.join("、")}）`
      : "没有可暂存的文件");
  }
  const add = git(cwd, ["add", "--", ...targets]);
  if (!add.ok) {
    throw new Error(`git add 失败：${truncate(add.stderr || add.stdout, 500)}`);
  }
  const message = writeMessageFile(group.message);
  let report;
  try {
    const args = group.amend === true
      ? ["commit", "--amend", "-F", message.file]
      : ["commit", "-F", message.file];
    const commit = git(cwd, args);
    if (!commit.ok) {
      throw new Error(`git commit 失败：${truncate(commit.stderr || commit.stdout, 800)}`);
    }
    report = commit.stdout.trim();
  } finally {
    removeMessageFile(message);
  }
  if (autoExcluded.length > 0) {
    report += `\n（已自动排除敏感文件：${autoExcluded.join("、")}）`;
  }
  return report;
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
  const reset = git(cwd, ["reset", "--soft", `HEAD~${group.squash}`]);
  if (!reset.ok) {
    throw new Error(`git reset --soft 失败：${truncate(reset.stderr || reset.stdout, 500)}`);
  }
  const message = writeMessageFile(group.message);
  try {
    const commit = git(cwd, ["commit", "-F", message.file]);
    if (!commit.ok) {
      throw new Error(`git commit 失败：${truncate(commit.stderr || commit.stdout, 800)}`);
    }
    return commit.stdout.trim();
  } finally {
    removeMessageFile(message);
  }
}

/** 推送：仅普通 push；无上游时补一次 -u origin <branch>；永不 force。 */
function pushCommits(cwd) {
  const remotes = git(cwd, ["remote"]);
  if (!remotes.ok || !/(^|\s)origin(\s|$)/m.test(remotes.stdout)) {
    return "未配置 origin 远程仓库，未推送。";
  }
  const first = git(cwd, ["push"]);
  if (first.ok) {
    return `已推送：${truncate((first.stderr || first.stdout).trim(), 400) || "git push 完成"}`;
  }
  const detail = truncate((first.stderr || first.stdout).trim(), 600);
  if (/no upstream|set-upstream|upstream branch/i.test(detail)) {
    const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    const retry = git(cwd, ["push", "-u", "origin", branch]);
    if (retry.ok) {
      return `已推送（设置上游 ${branch}）：${truncate((retry.stderr || retry.stdout).trim(), 400)}`;
    }
    throw new Error(`git push -u origin ${branch} 失败：${truncate((retry.stderr || retry.stdout).trim(), 600)}`);
  }
  throw new Error(`git push 失败：${detail}`);
}

/**
 * 执行提交计划。计划来自 agent 最后一条消息中的 ```smart-commit 围栏 JSON，
 * 已通过 {@link parsePlan} 校验。
 *
 * @param cwd 仓库根目录（会话工作区）
 * @param plan { commits: [{files?, message, amend?, squash?}], push? }
 * @returns 人类可读的执行摘要
 */
export function executePlan(cwd, plan) {
  const reports = [];
  for (const group of plan.commits) {
    const entries = listStatusEntries(cwd);
    if (group.squash !== undefined) {
      reports.push(squashCommits(cwd, group, entries));
    } else {
      reports.push(stageAndCommit(cwd, group, entries));
    }
  }
  if (plan.push === true) {
    reports.push(pushCommits(cwd));
  }
  const summary = git(cwd, ["log", "--oneline", `-${Math.min(plan.commits.length, 10)}`, "--stat"]);
  const lines = [];
  for (const report of reports) {
    if (report) lines.push(report);
  }
  lines.push("");
  lines.push("### 结果");
  lines.push("```");
  lines.push(truncate(summary.stdout.trimEnd() || "（无输出）", 1500));
  lines.push("```");
  return lines.join("\n").trim();
}

//#region 受限 YAML 子集解析器
// 围栏协议 0.4 起从 JSON 改为 YAML：commit message 本质是多行文本，JSON 字符串
// 必须把换行写成 \n 转义，导致围栏块里整条 message 挤成一行，人无法审阅
// （恰恰 ## What / ## Why 才是用户要看的内容）。YAML 的块标量 `|` 保留真实换行。
//
// 本解析器只覆盖协议所需子集，刻意不引入外部依赖（host 半必须自包含）：
//   - 映射：`key: value`，支持两级缩进嵌套
//   - 序列：`- ` 开头的项，项内可含映射
//   - 块标量：`key: |` 及其后更深缩进的原文行
//   - 行内序列：`key: [a, b]`
//   - 标量：裸字符串 / 单双引号字符串 / true / false / 整数
// 不支持锚点、别名、标签、流式映射、多文档——协议也不需要。

/** 去掉一行末尾的注释，但忽略引号内的 `#`。 */
function stripYamlComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** 解析一个 YAML 标量（去引号、识别布尔与整数）。 */
function parseYamlScalar(raw) {
  const text = raw.trim();
  if (text === "") return "";
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => String(parseYamlScalar(item)));
  }
  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2)) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/** 该行是否为空行或纯注释。 */
function isYamlBlank(line) {
  const body = stripYamlComment(line).trim();
  return body === "";
}

/** 行首空格数（tab 视为非法缩进）。 */
function yamlIndent(line) {
  const match = /^[ \t]*/.exec(line);
  const indent = match === null ? 0 : match[0].length;
  if (match !== null && match[0].includes("\t")) {
    throw new Error("提交计划含 tab 缩进；YAML 缩进只能用空格");
  }
  return indent;
}

/**
 * 子块的真实缩进：YAML 只要求比父级更深，不要求恰好深 1。
 * 直接假设 `parent + 1` 会在父级用 2 空格缩进时误判（`commits:` 下缩进 2 的序列）。
 * @param lines 行数组
 * @param start 子块起始行
 * @param parentIndent 父级缩进
 * @returns 子块首行的缩进
 */
function childIndent(lines, start, parentIndent) {
  for (let index = start; index < lines.length; index += 1) {
    if (isYamlBlank(lines[index])) continue;
    const indent = yamlIndent(lines[index]);
    if (indent <= parentIndent) throw new Error("提交计划子块未正确缩进");
    return indent;
  }
  throw new Error("提交计划缺少子块内容");
}

/**
 * 解析缩进块内的若干 `- ` 序列项或 `key: value` 映射项。
 * @param lines 预处理后的行数组
 * @param start 起始行号
 * @param indent 当前块的基准缩进
 */
function parseYamlBlock(lines, start, indent) {
  let index = start;
  let container = null;

  while (index < lines.length) {
    const line = lines[index];
    if (isYamlBlank(line)) {
      index += 1;
      continue;
    }
    const current = yamlIndent(line);
    if (current < indent) break;
    if (current > indent) {
      throw new Error(`提交计划缩进不一致（第 ${index + 1} 行）`);
    }
    const body = stripYamlComment(line).trim();

    if (body.startsWith("- ")) {
      if (container === null) container = [];
      if (!Array.isArray(container)) throw new Error("提交计划中序列与映射混用");
      const itemText = body.slice(2).trim();
      const colon = itemText.indexOf(":");
      if (itemText === "") {
        const nested = parseYamlBlock(lines, index + 1, childIndent(lines, index + 1, indent));
        container.push(nested.value);
        index = nested.next;
        continue;
      }
      if (colon <= 0) {
        container.push(parseYamlScalar(itemText));
        index += 1;
        continue;
      }
      // `- key: value`：该项是映射，后续同缩进的 `key:` 属于同一项
      const item = {};
      const key = itemText.slice(0, colon).trim();
      const rest = itemText.slice(colon + 1).trim();
      if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
        const scalar = readBlockScalar(lines, index + 1, indent, rest);
        item[key] = scalar.value;
        index = scalar.next;
      } else if (rest === "") {
        const nested = parseYamlBlock(lines, index + 1, childIndent(lines, index + 1, indent));
        item[key] = nested.value;
        index = nested.next;
      } else {
        item[key] = parseYamlScalar(rest);
        index += 1;
      }
      // 该映射项后续的兄弟键（缩进 = indent + 2 或更多，且不是新的 `- `）
      for (;;) {
        if (index >= lines.length) break;
        const cont = lines[index];
        if (isYamlBlank(cont)) {
          index += 1;
          continue;
        }
        const contIndent = yamlIndent(cont);
        const contBody = stripYamlComment(cont).trim();
        if (contIndent <= indent || contBody.startsWith("- ")) break;
        const contColon = contBody.indexOf(":");
        if (contColon <= 0) throw new Error(`提交计划第 ${index + 1} 行缺少键名`);
        const contKey = contBody.slice(0, contColon).trim();
        const contRest = contBody.slice(contColon + 1).trim();
        if (contRest === "|" || contRest === "|-" || contRest === ">" || contRest === ">-") {
          const scalar = readBlockScalar(lines, index + 1, contIndent, contRest);
          item[contKey] = scalar.value;
          index = scalar.next;
        } else if (contRest === "") {
          const nested = parseYamlBlock(lines, index + 1, childIndent(lines, index + 1, contIndent));
          item[contKey] = nested.value;
          index = nested.next;
        } else {
          item[contKey] = parseYamlScalar(contRest);
          index += 1;
        }
      }
      container.push(item);
      continue;
    }

    const colon = body.indexOf(":");
    if (colon <= 0) throw new Error(`提交计划第 ${index + 1} 行不是合法的 key: value`);
    if (container === null) container = {};
    if (Array.isArray(container)) throw new Error("提交计划中序列与映射混用");
    const key = body.slice(0, colon).trim();
    const rest = body.slice(colon + 1).trim();
    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const scalar = readBlockScalar(lines, index + 1, indent, rest);
      container[key] = scalar.value;
      index = scalar.next;
    } else if (rest === "") {
      const nested = parseYamlBlock(lines, index + 1, childIndent(lines, index + 1, indent));
      container[key] = nested.value;
      index = nested.next;
    } else {
      container[key] = parseYamlScalar(rest);
      index += 1;
    }
  }

  return { value: container === null ? {} : container, next: index };
}

/**
 * 读取块标量正文：`|` 保留换行，`>` 折叠为空格；`-` 后缀去掉末尾换行。
 * @param lines 行数组
 * @param start 正文起始行
 * @param headerIndent 标量声明行的缩进（正文须更深）
 * @param header 标量头部（`|` / `|-` / `>` / `>-`）
 */
function readBlockScalar(lines, start, headerIndent, header) {
  const collected = [];
  let bodyIndent = null;
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      collected.push("");
      index += 1;
      continue;
    }
    const indent = yamlIndent(line);
    if (indent <= headerIndent) break;
    if (bodyIndent === null) bodyIndent = indent;
    if (indent < bodyIndent) break;
    collected.push(line.slice(bodyIndent));
    index += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
  const fold = header.startsWith(">");
  const chomp = header.endsWith("-") ? "" : "\n";
  const text = fold ? collected.join(" ").replace(/\s+/g, " ").trim() : collected.join("\n");
  return { value: text + (text === "" ? "" : chomp), next: index };
}

/** 解析受限 YAML 文档为 JS 值。 */
function parseYaml(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const parsed = parseYamlBlock(lines, 0, 0);
  return parsed.value;
}
//#endregion

/**
 * 解析并校验 agent 输出的提交计划（围栏 YAML；兼容旧版 JSON）。
 * @param text agent 最后一条消息全文
 * @param options { allowPush, allowAmend, allowSquash }
 */
export function parsePlan(text, options = {}) {
  const match = /```smart-commit\s*\n([\s\S]*?)```/i.exec(String(text ?? ""));
  if (!match) {
    throw new Error("未找到 ```smart-commit 围栏中的提交计划");
  }
  // 只去掉围栏后的首个换行与整体行尾空白，不用 trim()：block scalar 的
  // 相对缩进必须在解析前保持原样，否则 `message: |` 的正文会被误判层级。
  const raw = match[1].replace(/^\s*\n/, "").replace(/[ \t]+$/, "");
  let plan;
  // 兼容 0.3 的 JSON 围栏：旧模板缓存或模型惯性输出时仍可执行。
  if (raw.startsWith("{")) {
    try {
      plan = JSON.parse(raw);
    } catch (error) {
      throw new Error(`提交计划不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    try {
      plan = parseYaml(raw);
    } catch (error) {
      throw new Error(`提交计划不是合法 YAML：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (typeof plan !== "object" || plan === null || !Array.isArray(plan.commits) || plan.commits.length === 0) {
    throw new Error("提交计划必须是包含非空 commits 数组的对象");
  }
  if (plan.commits.length > 10) {
    throw new Error("一次最多 10 个提交分组");
  }
  for (const group of plan.commits) {
    if (typeof group !== "object" || group === null) throw new Error("commits 数组元素必须是对象");
    assertMessage(group.message);
    if (group.amend !== undefined && typeof group.amend !== "boolean") throw new Error("amend 必须是布尔值");
    if (group.squash !== undefined && (!Number.isInteger(group.squash) || group.squash < 1 || group.squash > 50)) {
      throw new Error("squash 数量必须是 1–50 的整数");
    }
    if (group.files !== undefined && group.files !== null) {
      if (!Array.isArray(group.files)) throw new Error("files 必须是数组");
      for (const file of group.files) {
        if (typeof file !== "string") throw new Error("files 只能包含字符串路径");
        const trimmed = file.trim();
        if (trimmed === "" || trimmed === "-A" || trimmed === "." || trimmed === "*") continue;
        if (trimmed.includes("..") || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
          throw new Error(`不安全的文件路径：${file}`);
        }
      }
    }
  }
  if (plan.push !== undefined && typeof plan.push !== "boolean") throw new Error("push 必须是布尔值");
  if (plan.push === true && options.allowPush !== true) {
    throw new Error("当前流程不允许推送");
  }
  if (plan.commits.some((group) => group.amend === true) && options.allowAmend !== true) {
    throw new Error("当前流程不允许 amend");
  }
  if (plan.commits.some((group) => group.squash !== undefined) && options.allowSquash !== true) {
    throw new Error("当前流程不允许 squash");
  }
  return { commits: plan.commits, push: plan.push === true };
}
