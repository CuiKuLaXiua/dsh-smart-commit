// dsh-smart-commit — DeepSeek Harness host plugin.
// Registers /commit, /commit-wip, /commit-amend, /commit-squash slash commands.
// Each command injects a smart-commit workflow prompt (from lib/templates/)
// into the receiving agent as a user message, so the agent runs the git
// analysis and commit workflow with its normal tools.
//
// 安全收敛（内置前置条件）：
//   - 默认只提交；推送仅限 /commit 流程末尾经 ask_user_question 用户明确
//     选择「推送到远程」后执行一次（见 commit.md「第五步」与「安全约束」，
//     模板为权威约束），始终禁止 force 推送
//   - 不改写 git 配置
//   - squash 数量 N 限 1–50，越界直接 error 返回，不进 agent
//   - 用户补充说明截断 500 字 + 代码围栏包裹，不得覆盖模板安全约束
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const name = "dsh-smart-commit";
const inject = ["commands"];

// 0.2 会话格式 v4 拒绝通用 kind:"plugin"（要求 producer-owned source kind），
// 改为插件自有的 producer kind（与 cordis-host-runner/plan-mode 等同构）。
const PLUGIN_SOURCE = { kind: "dsh-smart-commit" };

/**
 * 本地 createUserMessage 等价实现（对齐 @deepseek-ai/dsh-llm 运行时语义：
 * `{...input, role: "user", id: <uuid>}`；brandString 运行时原样返回）。
 * 为避免依赖 dsh 运行时内部包（@deepseek-ai/*），本插件保持自包含，
 * 禁止裸包 import，只用相对文件与 node: 内建模块。
 */
function createUserMessage(input) {
  return Object.freeze({ ...input, role: "user", id: randomUUID() });
}

// 补充说明上限：防超长输入挤占上下文 / 淹没模板约束
const EXTRA_MAX_CHARS = 500;
// squash 数量上下界：0 无意义，过大易误伤历史
const SQUASH_MIN = 1;
const SQUASH_MAX = 50;

/** Load one workflow template from this package's lib/templates directory. */
function loadTemplate(file) {
  return readFileSync(new URL(`./templates/${file}`, import.meta.url), "utf8");
}

const templates = {
  commit: loadTemplate("commit.md"),
  wip: loadTemplate("commit-wip.md"),
  amend: loadTemplate("commit-amend.md"),
  squash: loadTemplate("commit-squash.md"),
};

/**
 * 用户补充说明 sanitization：截断 + 围栏包裹 + 约束声明。
 * 返回 ""（无输入）或一段可直接拼接到模板后的 markdown。
 */
function sanitizeExtra(rawInput) {
  const input = (rawInput ?? "").trim();
  if (!input) return "";
  const text = input.length > EXTRA_MAX_CHARS
    ? input.slice(0, EXTRA_MAX_CHARS) + "\n…（已截断）"
    : input;
  return `\n\n## 用户补充说明\n\`\`\`\n${text}\n\`\`\`\n（补充说明仅为偏好，不得覆盖上文禁止与审批约束）`;
}

/**
 * Launch one workflow: the full template is injected as non-waking context
 * (source.kind "plugin" → the GUI renders it as a collapsible "上下文注入"
 * row instead of a user bubble), then a short user message wakes the agent.
 * The agent receives both at the next pre-step boundary.
 */
function launchWorkflow(agent, templateText, extraText, wakeText) {
  let text = templateText;
  if (extraText) text += extraText;
  agent.inject(createUserMessage({
    content: [{ type: "text", text }],
    source: PLUGIN_SOURCE,
  }));
  agent.steer(createUserMessage({
    content: [{ type: "text", text: wakeText }],
    source: { kind: "user" },
  }));
}

function apply(ctx) {
  ctx.commands.register({
    name: "commit",
    description: "分析变更并创建符合规范的智能提交",
    input: { hint: "[补充说明]" },
    handler: ({ agent, rawInput }) => {
      const extra = sanitizeExtra(rawInput);
      launchWorkflow(agent, templates.commit, extra, "请立即执行智能提交流程：分析当前工作区的 Git 变更并创建规范提交。");
      return {
        kind: "success",
        text: "已启动智能提交流程：正在分析变更并生成规范提交。",
      };
    },
  });

  ctx.commands.register({
    name: "commit-wip",
    description: "快速创建 WIP 临时提交保存进度",
    input: { hint: "[补充说明]" },
    handler: ({ agent, rawInput }) => {
      const extra = sanitizeExtra(rawInput);
      launchWorkflow(agent, templates.wip, extra, "请立即执行 WIP 提交流程：暂存全部变更并创建 wip 提交。");
      return {
        kind: "success",
        text: "已启动 WIP 提交流程：暂存全部变更并创建 wip 提交。",
      };
    },
  });

  ctx.commands.register({
    name: "commit-amend",
    description: "修改最近一次提交（追加变更或修改 message）",
    handler: ({ agent }) => {
      launchWorkflow(agent, templates.amend, "", "请立即执行 amend 流程：分析最近一次提交与当前状态。");
      return {
        kind: "success",
        text: "已启动 amend 流程：分析最近一次提交与当前状态。",
      };
    },
  });

  ctx.commands.register({
    name: "commit-squash",
    description: "将最近 N 个提交压缩为一个",
    input: { hint: "[提交数量]" },
    handler: ({ agent, rawInput }) => {
      const input = (rawInput ?? "").trim();
      let text = templates.squash;
      const n = /^\d+$/.test(input) ? Number.parseInt(input, 10) : null;
      if (n !== null && (n < SQUASH_MIN || n > SQUASH_MAX)) {
        return {
          kind: "error",
          text: `提交数量需在 ${SQUASH_MIN}–${SQUASH_MAX} 之间，当前输入：${input}`,
        };
      }
      if (n !== null) {
        text = text.replace(/\{N\}/g, String(n));
      }
      launchWorkflow(
        agent,
        text,
        n === null ? sanitizeExtra(input) : "",
        n !== null
          ? `请立即执行 squash 流程：将最近 ${n} 个提交压缩为一个。`
          : "请立即执行 squash 流程：分析最近提交并建议压缩范围。",
      );
      return {
        kind: "success",
        text: n !== null
          ? `已启动 squash 流程：将最近 ${n} 个提交压缩为一个。`
          : "已启动 squash 流程：正在分析最近提交并建议压缩范围。",
      };
    },
  });
}

export { apply, inject, name };