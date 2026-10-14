window.__ModuleLoader__.load({
	id: "dsh-smart-commit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/types/client/locales.js
		/**
		 * `dsh-smart-commit` namespace dictionaries：菜单贡献的本地化名称与描述，
		 * 以及技能行美化所使用的中文技能名。英文项的 label 刻意等于命令名本身
		 * （大小写差异内不显示别名），与官方命令在英文词典下的行为一致。
		 */
		/** Dictionary namespace owned by this plugin. */
		const NS = "dsh-smart-commit";
		/** 命令族表：贡献名 → 图标（与 host 半 lib/index.js 的 COMMANDS 同源维护）。 */
		const COMMAND_FACES = [
			{ name: "commit", icon: _deepseek_ai_dsh_client_ui_primitives.IconCheckCircleOutlineRegular },
			{ name: "commit-wip", icon: _deepseek_ai_dsh_client_ui_primitives.IconArchiveOutlineRegular },
			{ name: "commit-amend", icon: _deepseek_ai_dsh_client_ui_primitives.IconEditOutlineRegular },
			{ name: "commit-squash", icon: _deepseek_ai_dsh_client_ui_primitives.IconCompactOutlineRegular }
		];
		/** 中文（zh 为 key-set 真源）：label / description。 */
		const COMMAND_ZH = {
			"commit": { label: "提交", description: "分析变更并创建符合规范的智能提交" },
			"commit-wip": { label: "临时提交", description: "快速创建 WIP 临时提交保存进度" },
			"commit-amend": { label: "修订提交", description: "修改最近一次提交（追加变更或修改 message）" },
			"commit-squash": { label: "压缩提交", description: "将最近 N 个提交压缩为一个" }
		};
		/** English：label 为展示名（首字母大写，与命令名仅大小写差异 → 不显示别名）。 */
		const COMMAND_EN = {
			"commit": { label: "Commit", description: "Analyze changes and create a Conventional Commits message" },
			"commit-wip": { label: "WIP Commit", description: "Quickly save progress with a WIP commit" },
			"commit-amend": { label: "Amend Commit", description: "Revise the most recent commit (add changes or rewrite the message)" },
			"commit-squash": { label: "Squash Commits", description: "Compress the most recent N commits into one" }
		};
		/** 已知技能的中文名（技能行美化）。未收录的技能保留英文名，但仍获得图标。 */
		const SKILL_ZH = {
			"diagnose-windows-sandbox-acl": "沙箱诊断",
			"modlens": "模型视觉",
			"office-docx": "Word 文档",
			"office-pptx": "PPT 演示文稿",
			"office-xlsx": "Excel 表格",
			"webup-buddy-reroll": "宠物重抽",
			"webup-statusline": "状态栏定制"
		};
		const zh = {
			"notice.started": "已启动智能提交流程。",
			"notice.failed": "命令执行失败"
		};
		const en = {
			"notice.started": "Smart-commit workflow started.",
			"notice.failed": "Command failed"
		};
		for (const [command, face] of Object.entries(COMMAND_ZH)) {
			zh[`label.${command}`] = face.label;
			zh[`description.${command}`] = face.description;
		}
		for (const [command, face] of Object.entries(COMMAND_EN)) {
			en[`label.${command}`] = face.label;
			en[`description.${command}`] = face.description;
		}
		for (const [skill, label] of Object.entries(SKILL_ZH)) {
			zh[`skill.${skill}`] = label;
			en[`skill.${skill}`] = skill;
		}
		//#endregion
		//#region lib/types/client/run.js
		/** host 半注册的路由（lib/index.js 的 RUN_ROUTE）。 */
		const RUN_ROUTE = "/smart-commit/run";
		/** 把一次失败/成功送到会话的 composer 提示条（与命令执行器的提示同通道）。 */
		function notify(ctx, session, level, text) {
			const actx = ctx.sessions.scope(session.sessionId);
			const conversation = actx?.get("conversation");
			conversation?.input.for(actx).notify(level, text);
		}
		/** 调用 host 路由执行一条命令；结果通过 composer 提示条反馈。 */
		async function runCommand(ctx, t, session, command) {
			try {
				const response = await fetch(RUN_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId: session.sessionId, command })
				});
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload?.ok !== true) {
					const text = typeof payload?.error === "string" ? payload.error : t("notice.failed");
					notify(ctx, session, "error", text);
					return;
				}
				notify(ctx, session, "info", typeof payload.text === "string" ? payload.text : t("notice.started"));
			} catch (error) {
				notify(ctx, session, "error", error instanceof Error ? error.message : String(error));
			}
		}
		//#endregion
		//#region lib/types/client/skill-polish.js
		/** Guard property against double-wrapping one source object (plugin HMR re-apply). */
		const POLISHED = "__dshSmartCommitSkillPolish";
		/**
		 * Wrap the '/' skill source's candidate synthesis so every skill row
		 * carries the leading skill icon and every known skill carries its
		 * localized label — the same row contract the official commands use
		 * (icon, localized name, English name alias, description). Display-only:
		 * filtering and ordering stay exactly what the wrapped source produced.
		 * @param src - the registered source object (mutated in place).
		 * @param t - the `dsh-smart-commit` namespace translator.
		 */
		function decorateSkillSource(src, t) {
			if (src === null || typeof src !== "object") return;
			if (typeof src.candidates !== "function") return;
			if (src[POLISHED] === true) return;
			const original = src.candidates;
			src[POLISHED] = true;
			src.candidates = async (session, req) => {
				const items = await original(session, req);
				return items.map((item) => {
					const label = Object.hasOwn(SKILL_ZH, item.name) ? { label: t(`skill.${item.name}`) } : {};
					return { ...item, ...label, icon: _deepseek_ai_dsh_client_ui_primitives.IconSkillOutlineRegular };
				});
			};
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required services: the '/' source registry, the command contribution seat, locale, and sessions. */
		const inject = ["commandUi", "inputTriggers", "locale", "sessions"];
		/**
		 * Client plugin body:
		 * 1. register the four commands as '/' menu contributions through the
		 *    open commandUi API — each row renders exactly like an official
		 *    command (icon, localized label, English name alias, description);
		 * 2. decorate the skill source so skill rows render in that same layout.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-smart-commit: dictionaries");
			const t = ctx.locale.bind(NS);
			for (const face of COMMAND_FACES) {
				ctx.effect(() => ctx.commandUi.register({
					name: face.name,
					available: () => true,
					label: () => t(`label.${face.name}`),
					description: () => t(`description.${face.name}`),
					icon: face.icon,
					ui: {
						kind: "action",
						run: (session) => runCommand(ctx, t, session, face.name)
					}
				}), `dsh-smart-commit: /${face.name} contribution`);
			}
			ctx.effect(() => {
				const inputTriggers = ctx.get("inputTriggers");
				if (inputTriggers === void 0) return;
				const originalRegister = inputTriggers.registerSource.bind(inputTriggers);
				inputTriggers.registerSource = (src) => {
					const dispose = originalRegister(src);
					if (src.trigger === "/" && src.name === "skill") decorateSkillSource(src, t);
					return dispose;
				};
				for (const src of inputTriggers.live.sources) {
					if (src.trigger === "/" && src.name === "skill") decorateSkillSource(src, t);
				}
				return () => {
					inputTriggers.registerSource = originalRegister;
				};
			}, "dsh-smart-commit: skill menu polish");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
