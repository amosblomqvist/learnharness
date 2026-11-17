// Test-only fixture plugin (session/record kinds, stage B). Declares one
// teaching-shaped session kind that extracts into its own record, one kind
// that extracts into the native graph, and a record kind that appends each
// delivered batch to <dataDirectory>/notebook.jsonl — idempotent by batchId,
// as the contract asks of at-least-once delivery.
const fs = require("node:fs");
const path = require("node:path");

exports.activate = (ctx) => {
	const file = path.join(ctx.dataDirectory, "notebook.jsonl");
	const control = { fail: false, gate: null };
	const read = () => {
		try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
		catch { return []; }
	};
	ctx.registerRecordKind({
		id: "notebook",
		label: "Fixture notebook",
		chunkTokens: 500,
		async extract(batch) {
			if (control.gate) await control.gate(batch);
			if (control.fail) throw new Error("fixture extract failure");
			if (read().some((row) => row.batchId === batch.batchId)) return;
			fs.appendFileSync(file, JSON.stringify({
				batchId: batch.batchId, chatId: batch.chatId, recordKindId: batch.recordKindId, sessionKindId: batch.sessionKindId,
				messages: batch.messages.map((message) => ({ id: message.id, role: message.role })),
			}) + "\n");
		},
	});
	ctx.registerSessionKind({
		id: "lesson",
		label: "Fixture lesson",
		record: "kinds-fixture:notebook",
		prompts: { prober: "FIXTURE PROBER PHASE: find what the learner knows.", teacher: "FIXTURE TEACHER PHASE: teach the lesson." },
		tools: { prober: { research: false, probe_done: false }, teacher: { demo: false, plan_init: false } },
	});
	ctx.registerSessionKind({
		id: "graph-lesson",
		label: "Fixture graph lesson",
		record: "graph",
		prompts: { prober: "FIXTURE GRAPH PROBER", teacher: "FIXTURE GRAPH TEACHER" },
	});
	ctx.registerInstructions({ agents: ["prober", "teacher"], sessionKinds: ["kinds-fixture:lesson"], text: "FIXTURE LESSON-ONLY APPENDIX" });
	ctx.handle("context", () => ctx);
	ctx.handle("control", () => control);
	ctx.handle("notebook", () => read());
};
