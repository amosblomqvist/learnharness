import { createInterface } from "node:readline";
import fs from "node:fs";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let connected = false;
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line), p = message.params;
	if (process.env.LH_CODEX_TEST_LOG) fs.appendFileSync(process.env.LH_CODEX_TEST_LOG, `${line}\n`);
	const result = (value) => send({ id: message.id, result: value });
	switch (message.method) {
		case "initialize": result({ userAgent: "fake-codex" }); break;
		case "account/read": result({ account: process.env.LH_CODEX_SIGNED_OUT === "1" && !connected ? null : { type: "chatgpt", email: "fixture@example.invalid" } }); break;
		case "account/login/start": result({ type: "chatgpt", loginId: "fixture-login", authUrl: "https://auth.openai.com/authorize?state=fixture" });
			if (process.env.LH_CODEX_LOGIN_SUCCESS === "1") setTimeout(() => { connected = true; send({ method: "account/login/completed", params: { loginId: "fixture-login", success: true } }); }, 100);
			break;
		case "account/login/cancel": result({}); break;
		case "account/logout": connected = false; result({}); break;
		case "model/list": result({ data: [{ model: "fixture-model", displayName: "Fixture Codex", inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }], nextCursor: null }); break;
		case "thread/start": result({ thread: { id: "fixture-thread" }, model: p.model }); break;
		case "turn/start": {
			result({ turn: { id: "fixture-turn" } });
			if (process.env.LH_CODEX_MODE === "hang") break;
			if (process.env.LH_CODEX_MODE === "crash") { process.exit(1); break; }
			const base = { threadId: p.threadId, turnId: "fixture-turn" };
			send({ method: "item/agentMessage/delta", params: { ...base, itemId: "text-1", delta: "Let's learn." } });
			send({ method: "item/completed", params: { ...base, item: { type: "agentMessage", id: "text-1", text: "Let's learn." } } });
			send({ method: "thread/tokenUsage/updated", params: { ...base, tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 12 } } } });
			const mode = process.env.LH_CODEX_MODE;
			const lessonQuestion = mode === "lesson" && !p.input.some((part) => part.type === "text" && part.text.includes("[tool result quiz]"));
			if (mode === "tool" || mode === "bad-tool" || mode === "intent-only" || lessonQuestion) {
				send({ method: "item/started", params: { ...base, item: { type: "dynamicToolCall", tool: "quiz", arguments: { question: "Why?" } } } });
				if (mode !== "intent-only") send({ id: "tool-request", method: "item/tool/call", params: { ...base, callId: "call-1", tool: mode === "bad-tool" ? "exec_command" : "quiz", arguments: { question: "Why?" } } });
			} else if (mode === "native") send({ id: "native-request", method: "item/commandExecution/requestApproval", params: base });
			else send({ method: "turn/completed", params: { ...base, turn: { id: "fixture-turn", status: mode === "failed" ? "failed" : "completed" } } });
			break;
		}
	}
});
