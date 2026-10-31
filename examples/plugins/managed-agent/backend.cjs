const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

/** This is author-owned feature code, not special handling in the host. */
exports.activate = (ctx) => {
	const definitionFile = path.join(ctx.dataDirectory, "definitions.json");
	let definitions = [];
	try { definitions = JSON.parse(fs.readFileSync(definitionFile, "utf8")); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	if (!Array.isArray(definitions)) throw new Error("Invalid example definitions file");
	const register = (entry) => ctx.agents.register({
		id: entry.id,
		model: entry.model,
		instructions: "You are a plugin API demonstration assistant. Follow the user's explicit task. If human input is needed, use ask. To demonstrate a completed tool that pauses execution, use publish_note when the user asks you to save a note. Do not claim to modify LearnHarness learning records.",
		tools: [
			{ name: "ask", description: "Ask for human input and wait for the answer.", kind: "input",
				parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
				resultSchema: { type: "string", minLength: 1 } },
			{ name: "publish_note", description: "Save a plugin-owned note and pause until the next user message.", endRun: true,
				parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
				execute: async (_id, args, signal) => {
					if (ctx.signal.aborted || signal?.aborted) throw new Error("Plugin disabled or run cancelled");
					fs.appendFileSync(path.join(ctx.dataDirectory, "notes.jsonl"), JSON.stringify({ note: args.note, at: new Date().toISOString() }) + "\n");
					return { content: [{ type: "text", text: "Note saved in this plugin's data directory." }], details: { note: args.note } };
				} },
		],
	});
	for (const entry of definitions) ctx.cleanup(register(entry));
	const object = (value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected operation input object");
		return value;
	};
	ctx.handle("catalog", () => ctx.inference.catalog());
	ctx.handle("list", () => ctx.agents.list());
	ctx.handle("get", (input) => ctx.agents.get(object(input).id));
	ctx.handle("create", async (input) => {
		const model = object(input).model;
		if (!model || typeof model.provider !== "string" || typeof model.id !== "string") throw new Error("Select a model");
		const catalog = await ctx.inference.catalog();
		if (!catalog.models.some((m) => m.provider === model.provider && m.id === model.id)) throw new Error("Model is not available in your configured connections");
		if (ctx.signal.aborted) throw new Error("Plugin disabled");
		const spec = { provider: model.provider, id: model.id };
		const id = "model_" + createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 24);
		if (!definitions.some((entry) => entry.id === id)) {
			const entry = { id, model: spec };
			const next = [...definitions, entry];
			fs.writeFileSync(definitionFile + ".tmp", JSON.stringify(next, null, "\t"));
			fs.renameSync(definitionFile + ".tmp", definitionFile);
			ctx.cleanup(register(entry));
			definitions = next;
		}
		return ctx.agents.create(id);
	});
	ctx.handle("send", (input) => {
		const value = object(input);
		return ctx.agents.send(value.id, value.text, { requestId: value.requestId, purpose: value.purpose });
	});
	ctx.handle("answer", (input) => {
		const value = object(input);
		return ctx.agents.answer(value.id, value.toolCallId, value.answer, { requestId: value.requestId, purpose: "user" });
	});
	ctx.handle("abort", (input) => { ctx.agents.abort(object(input).id); return null; });
};
