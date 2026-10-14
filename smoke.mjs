// dsh-smart-commit 冒烟：语法 + 模板安全禁令断言（node --check 级别，零依赖）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const nodeExe = process.execPath;

execFileSync(nodeExe, ["--check", join(here, "lib", "index.js")], { stdio: "inherit" });
console.log("smoke: index.js 语法 OK");

const entry = readFileSync(join(here, "lib", "index.js"), "utf8");
for (const anchor of ["SQUASH_MIN", "SQUASH_MAX", "sanitizeExtra", "EXTRA_MAX_CHARS"]) {
  if (!entry.includes(anchor)) throw new Error(`index.js 缺少安全收敛锚点: ${anchor}`);
}
console.log("smoke: 输入收敛锚点 OK");

// 自包含回归 guard：禁止裸 @deepseek-ai/* import（宿主运行时不解析工作区包）
if (/(["'])@deepseek-ai\//.test(entry)) {
  throw new Error("index.js 含裸 @deepseek-ai/* import，宿主运行时不解析工作区包，host 半必须自包含");
}
console.log("smoke: 自包含 import OK");

const requiredByTemplate = {
  "commit.md": ["reset --hard", "git push"],
  "commit-wip.md": ["reset --hard", "git push"],
  "commit-amend.md": ["reset --hard", "force-with-lease"],
  "commit-squash.md": ["reset --hard", "force-with-lease"],
};
for (const [t, keywords] of Object.entries(requiredByTemplate)) {
  const body = readFileSync(join(here, "lib", "templates", t), "utf8");
  for (const kw of keywords) {
    if (!body.includes(kw)) throw new Error(`${t} 缺少安全关键字: ${kw}`);
  }
}
console.log("smoke: 四模板安全禁令 OK");