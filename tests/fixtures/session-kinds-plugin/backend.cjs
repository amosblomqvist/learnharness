// Test-only fixture plugin (session/record kinds, stage B). Declares one
// teaching-shaped session kind that extracts into its own record, one kind
// that extracts into the native graph, and a record kind that appends each
// delivered batch to <dataDirectory>/notebook.jsonl — idempotent by batchId,
// as the contract asks of at-least-once delivery. Stage C: the record can
// purge one session's batches (idempotent), and the lesson kind has an icon.
const fs = require("node:fs");
const path = require("node:path");

exports.activate = (ctx) => {
	const file = path.join(ctx.dataDirectory, "notebook.jsonl");
	const control = { fail: false, gate: null, purgeGate: null, purgeFail: false, purged: [] };
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
		async purge(chatId, signal) {
			if (!(signal instanceof AbortSignal)) throw new Error("purge needs the activation signal");
			if (control.purgeGate) await control.purgeGate(chatId);
			signal.throwIfAborted();
			if (control.purgeFail) throw new Error("fixture purge failure");
			control.purged.push(chatId);
			const kept = read().filter((row) => row.chatId !== chatId);
			fs.writeFileSync(file, kept.map((row) => JSON.stringify(row) + "\n").join(""));
		},
	});
	ctx.registerSessionKind({
		id: "lesson",
		label: "Fixture lesson",
		record: "kinds-fixture:notebook",
		icon: '<svg viewBox="0 0 16 16" data-fixture-icon="lesson"><circle cx="8" cy="8" r="6"/></svg>',
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
