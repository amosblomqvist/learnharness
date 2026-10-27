/**
 * The Spanish dictionary, split by UI area so each area's strings sit
 * together. A key appearing in two areas must translate the same way
 * (tests/i18n.test.ts enforces it).
 */
import { CORE } from "./core.ts";
import { GRAPH } from "./graph.ts";
import { SETTINGS } from "./settings.ts";
import { CHAT } from "./chat.ts";
import { LEARNING } from "./learning.ts";

export const ES_PARTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	core: CORE,
	graph: GRAPH,
	settings: SETTINGS,
	chat: CHAT,
	learning: LEARNING,
};

export const ES: Readonly<Record<string, string>> = Object.assign({}, ...Object.values(ES_PARTS));
