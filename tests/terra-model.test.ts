import assert from "node:assert/strict";
import { test } from "node:test";
import { getSupportedThinkingLevels, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { piEngineForSpec, piModels, withOpenAITerraFallback } from "../src/agent/models.ts";
import { chatGPTModels, refreshChatGPTModels } from "../src/agent/chatgpt-bridge.ts";

const terra = piModels().getModel("openai", "gpt-6.1-terra") as Model<"openai-responses">;

test("Terra is a narrowly scoped fallback and a native Pi entry wins", () => {
	assert.ok(terra);
	assert.equal(terra.api, "openai-responses");
	assert.deepEqual(terra.input, ["text", "image"]);
	assert.deepEqual(getSupportedThinkingLevels(terra), ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.equal(terra.thinkingLevelMap?.off, "none");
	assert.equal(terra.maxTokens, 128_000);
	assert.equal(terra.contextWindow, 272_000, "Pi's conservative default remains distinct from API maximum");
	const provider = builtinProviders().find((entry) => entry.id === "openai")!;
	const native = { ...terra, name: "Pi native", contextWindow: 333_333 };
	const newer = { ...provider, getModels: () => [native], getAllModels: () => [native] };
	const wrapped = withOpenAITerraFallback(newer);
	assert.equal(wrapped.getModels().length, 1);
	assert.equal(wrapped.getModels()[0], native);
	assert.equal(wrapped.getAllModels!()[0], native);
	const other = builtinProviders().find((entry) => entry.id !== "openai")!;
	assert.equal(withOpenAITerraFallback(other), other);
});

test("Terra requires the account catalog and dispatches with the selected credential and reasoning", async () => {
	const send = Object.getOwnPropertyDescriptor(process, "send");
	const connected = Object.getOwnPropertyDescriptor(process, "connected");
	const realFetch = globalThis.fetch;
	const oldMarker = process.env.LH_DESKTOP_SERVER, oldSecret = process.env.LH_DESKTOP_API_SECRET, oldKey = process.env.OPENAI_API_KEY;
	let accountListsTerra = true;
	let requests: { authorization: string | null; body: Record<string, any> }[] = [];
	const status = { available: true, pending: false, allowBackgroundUse: true, activeId: "account-a", accounts: [{ id: "account-a", connected: true, planEnabled: true }], error: null };
	const ipc = (value: unknown) => (process.emit as (event: string, value: unknown) => boolean)("message", value);
	try {
		process.env.LH_DESKTOP_SERVER = "1";
		process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
		process.env.OPENAI_API_KEY = "sk-scratch-api-key";
		Object.defineProperty(process, "connected", { configurable: true, value: true });
		Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
			queueMicrotask(() => ipc({ channel: "lh:chatgpt", id: message.id, op: message.op, ok: true, value: message.op === "lease"
				? { accessToken: "scratch-oauth", accountId: "account-a", epoch: 1, authorityRevision: 1, revision: 1 }
				: { epoch: 1, authorityRevision: 1, revision: 1, status, accountId: "account-a", models: accountListsTerra ? [{ id: terra.id, name: "Terra for account" }] : [] } }));
			callback?.(); return true;
		} });
		const available = piModels().getModels("openai").filter((model): model is Model<"openai-responses"> => model.api === "openai-responses");
		await refreshChatGPTModels(available);
		assert.equal(chatGPTModels()[0]?.id, "gpt-6.1-terra");
		globalThis.fetch = async (input, init) => {
			const req = new Request(input, init);
			requests.push({ authorization: req.headers.get("authorization"), body: JSON.parse(await req.text()) });
			const event = { type: "response.completed", response: { id: "scratch", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } };
			return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
		};
		const context = normalizeContext({ systemPrompt: "Teaching instructions", messages: [{ role: "user", content: [{ type: "text", text: "Explain" }, { type: "image", data: "c2NyYXRjaA==", mimeType: "image/png" }], timestamp: 1 }], tools: [{ name: "lookup", description: "A local tool", parameters: Type.Object({ value: Type.String() }) }] });
		const plan = piEngineForSpec({ provider: "chatgpt", id: terra.id, thinkingLevel: "off" }, false);
		await plan.streamFn(plan.model, context).result();
		assert.equal(requests[0]!.authorization, "Bearer scratch-oauth");
		assert.equal(requests[0]!.body.model, terra.id);
		assert.equal(requests[0]!.body.reasoning.effort, "none");
		assert.ok(requests[0]!.body.input.some((item: any) => Array.isArray(item.content) && item.content.some((part: any) => part.type === "input_image")), "image input is preserved");
		assert.ok(requests[0]!.body.input.some((item: any) => item.type === "additional_tools" && item.tools?.some((tool: any) => tool.name === "lookup")), "local tools use the supported additional_tools input");

		requests = [];
		const keyed = piEngineForSpec({ provider: "openai", id: terra.id, thinkingLevel: "high" }, false);
		await keyed.streamFn(keyed.model, context).result();
		assert.equal(requests[0]!.authorization, "Bearer sk-scratch-api-key");
		assert.equal(requests[0]!.body.model, terra.id);
		assert.ok(requests[0]!.body.input.some((item: any) => item.type === "configuration_update" && item.reasoning?.effort === "high"));

		accountListsTerra = false;
		await refreshChatGPTModels(available);
		assert.equal(chatGPTModels().length, 0, "a local capability entry never grants account access");
		assert.throws(() => piEngineForSpec({ provider: "chatgpt", id: terra.id }), /catalog has no model/);
	} finally {
		globalThis.fetch = realFetch;
		if (send) Object.defineProperty(process, "send", send); else delete process.send;
		if (connected) Object.defineProperty(process, "connected", connected); else delete (process as { connected?: boolean }).connected;
		if (oldMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = oldMarker;
		if (oldSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = oldSecret;
		if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
	}
});
