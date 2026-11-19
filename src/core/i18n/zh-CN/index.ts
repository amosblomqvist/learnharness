/**
 * THE SIMPLIFIED CHINESE DICTIONARY (i18n foundation, 2026-11-19).
 *
 * One flat map — English source string → Simplified Chinese — assembled from
 * per-surface modules so each file stays reviewable and a future string in one
 * surface does not conflict with another. Order does not matter: a test
 * (tests/i18n.test.ts) rejects a key that appears in two modules, because two
 * translations for one English string is always a mistake.
 *
 * STYLE (the glossary reviewers should hold us to):
 * - Second person 你, plain and warm; no 您, no exclamation marks.
 * - Sentence case in Chinese, full-width punctuation (，。：；！？（）「」).
 * - Product nouns stay as they are: LearnHarness, 模型/Provider 名, tool names,
 *   thinking level values, keys such as mod+, and anything backticked.
 * - Actions are verbs (删除, 复制, 重试); states are adjectives (已保存, 运行中).
 * - Keep placeholders ({name}) byte-identical to the English source.
 */

import { ARTIFACTS } from "./artifacts.ts";
import { CHAT } from "./chat.ts";
import { COMMON } from "./common.ts";
import { DIALOGS } from "./dialogs.ts";
import { GRAPH } from "./graph.ts";
import { PLUGINS } from "./plugins.ts";
import { QUESTION } from "./question.ts";
import { SETTINGS } from "./settings.ts";
import { SIDEBAR } from "./sidebar.ts";

export const ZH_CN: Readonly<Record<string, string>> = Object.freeze({
	...COMMON,
	...SIDEBAR,
	...CHAT,
	...QUESTION,
	...GRAPH,
	...SETTINGS,
	...DIALOGS,
	...ARTIFACTS,
	...PLUGINS,
});
