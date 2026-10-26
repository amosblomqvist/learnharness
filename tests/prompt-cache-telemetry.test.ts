import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, SystemMessage } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import { beginPromptCacheTurn, resetPromptCacheTelemetry } from "../src/server/prompt-cache.ts";

function system(content: string): SystemMessage {
	return { role: "system", content, timestamp: 0 };
}
function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}
function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1010, cost: { input: 0.000132, output: 0.0000396, cacheRead: 0.0000396, cacheWrite: 0, total: 0.0002112 } },
		stopReason: "stop",
		timestamp: 2,
	};
}
function usage(): Usage {
	return {
		input: 100,
		output: 10,
		cacheRead: 900,
		cacheWrite: 0,
		totalTokens: 1010,
		cost: { input: 0.000132, output: 0.0000396, cacheRead: 0.0000396, cacheWrite: 0, total: 0.0002112 },
	};
}

function capture() {
	const info: string[] = [];
	const warn: string[] = [];
	const originalInfo = console.info;
	const originalWarn = console.warn;
	console.info = (...args: unknown[]) => { info.push(args.map(String).join(" ")); };
	console.warn = (...args: unknown[]) => { warn.push(args.map(String).join(" ")); };
	return {
		info,
		warn,
		restore() {
			console.info = originalInfo;
			console.warn = originalWarn;
		},
	};
}

test("a normal turn reports predicted prefix reuse and provider-cache savings", () => {
	resetPromptCacheTelemetry();
	const logs = capture();
	try {
		const turn = beginPromptCacheTurn("chat-1", "deepseek:deepseek-v4-pro");
		turn.observe({ model: "deepseek:deepseek-v4-pro", step: 0, messages: [system("You are a tutor."), user("hi")] });
		turn.recordUsage(usage());
		turn.observe({ model: "deepseek:deepseek-v4-pro", step: 1, messages: [system("You are a tutor."), user("hi"), assistant("hello")] });
		turn.recordUsage(usage());
		turn.finish();
	} finally {
		logs.restore();
	}
	const summary = logs.info.find((line) => line.includes("prompt cache:") && line.includes("calls"));
	assert.ok(summary, `missing summary in ${JSON.stringify(logs.info)}`);
	assert.match(summary!, /90%/);
	assert.match(summary!, /saved \$/);
});

test("a stable prefix with zero provider hits warns once about routing", () => {
	resetPromptCacheTelemetry();
	const logs = capture();
	try {
		// Warm the chat: the first-ever request cannot hit, so its prediction
		// is honestly 0. The NEXT turn compares against it.
		const warm = beginPromptCacheTurn("chat-2", "deepseek:deepseek-v4-pro");
		warm.observe({ model: "deepseek:deepseek-v4-pro", step: 0, messages: [system("You are a tutor."), user("hi")] });
		warm.recordUsage(usage());
		warm.finish();

		const turn = beginPromptCacheTurn("chat-2", "deepseek:deepseek-v4-pro");
		turn.observe({ model: "deepseek:deepseek-v4-pro", step: 0, messages: [system("You are a tutor."), user("hi"), assistant("hello")] });
		turn.recordUsage({ ...usage(), input: 20_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.0264, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0264 } });
		turn.finish();
	} finally {
		logs.restore();
	}
	assert.equal(logs.warn.filter((line) => line.includes("provider reported")).length, 1);
});

test("a system prompt change is named as a prefix reset", () => {
	resetPromptCacheTelemetry();
	const logs = capture();
	try {
		const turn = beginPromptCacheTurn("chat-3", "deepseek:deepseek-v4-pro");
		turn.observe({ model: "deepseek:deepseek-v4-pro", step: 0, messages: [system("You are a tutor.")] });
		turn.observe({ model: "deepseek:deepseek-v4-pro", step: 1, messages: [system("You are a stricter tutor.")] });
		turn.finish();
	} finally {
		logs.restore();
	}
	assert.ok(logs.warn.some((line) => line.includes("SYSTEM PROMPT CHANGED")));
});
