import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import type { ChatInput } from "../src/core/input-events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const PLUGIN = "takeaway-notebook";
const LESSON = `${PLUGIN}:lesson`;
const NOTEBOOK = `${PLUGIN}:notebook`;
const TEACH_BACK = "notebook_teach_back";
const SEARCH = "notebook_search";

// Set the roots before importing any app code. The fake file key satisfies the
// real turn gate; only the in-process faux stream may answer model requests.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-takeaway-notebook-"));
const install = path.join(root, "data", "plugins", PLUGIN);
const authFile = path.join(root, "auth.json");
Object.assign(process.env, {
	NODE_ENV: "test", HOME: root, USERPROFILE: root, LH_DATA_DIR: path.join(root, "data"),
	LH_AUTH_FILE: authFile, LH_IGNORE_ENV_KEYS: "1",
});
let outboundAttempts = 0;
function noNetwork(): never {
	outboundAttempts++;
	throw new Error("Network is forbidden in the Takeaway Notebook test");
}
mock.method(globalThis, "fetch", noNetwork);
mock.method(Socket.prototype, "connect", noNetwork);
let disposeHost: (() => Promise<void>) | undefined;
after(async () => {
	try { await disposeHost?.(); }
	finally {
		mock.restoreAll();
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(outboundAttempts, 0, "even caught network attempts must fail the test");
});
fs.writeFileSync(authFile, JSON.stringify({ OPENROUTER_API_KEY: "offline-presence-only" }), { mode: 0o600 });
fs.cpSync(fileURLToPath(new URL("../examples/plugins/takeaway-notebook/", import.meta.url)), install, { recursive: true });

const { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } = await import("@earendil-works/pi-ai");
const { createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { hasProbeDone, newMessageId, newUserMessage, pendingPluginQuestionOf } = await import("../src/core/native-messages.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { deleteChatSession, sessionCoverage } = await import("../src/server/chats.ts");
const { getPluginHost } = await import("../src/server/plugins.ts");
const { runRecordExtraction } = await import("../src/server/record-extraction.ts");
const { resolveChatRecord } = await import("../src/server/record-kinds.ts");
const { stores: { chatStore, jobStore } } = await import("../src/server/stores.ts");
const { runningTurn, turnFailure } = await import("../src/server/turn-runs.ts");

const host = await getPluginHost();
disposeHost = () => host.dispose();
await host.setEnabled(PLUGIN, true);
const notebookFile = path.join(install, "data", "takeaways.json");
const notebook = async () => await host.call(PLUGIN, "list") as { chatId: string; title: string; entries: string[] }[];
const chatRecord = (id: string) => {
	const chat = chatStore.getChat(id);
	assert.ok(chat, `expected saved session ${id}`);
	return chat;
};
async function notebookTarget(id: string) {
	const target = await resolveChatRecord(chatRecord(id).kind);
	assert.ok(target.status === "plugin", `expected plugin record, got ${target.status}`);
	assert.equal(target.recordKindId, NOTEBOOK);
	return target;
}
function agentFor(chatId: string, teaching: boolean, options: AgentBuildOptions) {
	const ctx = { chatId, chatStore, jobStore, spawn: () => assert.fail("Notebook must not spawn background jobs") };
	return teaching
		? createTeacherAgent(ctx, options)
		// The probe handoff is exercised via the next explicit learner turn, not
		// an automatic wake (which would bypass the injected model factory).
		: createProberAgent({ ...ctx, deliver: () => {} }, options);
}

test("the copied Notebook activates, builds lean phase prompts and scopes tools to lesson teachers", () => {
	const info = host.list().find(plugin => plugin.id === PLUGIN);
	assert.ok(info?.enabled);
	assert.equal(info.status, "active", JSON.stringify(info));
	assert.deepEqual(info.sessionKinds?.map(({ id, record }) => ({ id, record })), [{ id: LESSON, record: NOTEBOOK }]);
	assert.deepEqual(info.recordKinds?.map(({ id }) => id), [NOTEBOOK]);
	const resolved = host.resolveSessionKind(LESSON);
	assert.ok(resolved.status === "available");
	assert.equal(host.resolveQuestionType(PLUGIN, "teach-back", 1).status, "available");

	const faux = createFauxCore({});
	const accuracy = fs.readFileSync(new URL("../src/agent/prompts/shared/15-accuracy.md", import.meta.url), "utf8").trim();
	for (const teaching of [false, true]) {
		const options = { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, pluginContributions: host.agentContributions };
		const lessonChat = chatStore.createChat("Lesson registry", LESSON);
		const nativeChat = chatStore.createChat("Native registry");
		const lesson: ReturnType<typeof createTeacherAgent>["state"] = agentFor(lessonChat.id, teaching, { ...options, chatId: lessonChat.id, sessionKind: resolved.definition }).state;
		const native = agentFor(nativeChat.id, teaching, { ...options, chatId: nativeChat.id }).state;
		const [first, phase, ...extra] = lesson.systemPrompt.split("\n\n---\n\n");
		assert.equal(first, accuracy);
		assert.deepEqual(extra, [], "no default phase fragments or shared appendix");
		assert.match(phase ?? "", teaching ? /one-node plan with plan_init/ : /call probe_done with one strand/);
		assert.ok(lesson.systemPrompt.length < native.systemPrompt.length);

		const lessonTools = lesson.tools.map(tool => tool.name);
		const nativeTools = native.tools.map(tool => tool.name);
		for (const tool of [TEACH_BACK, SEARCH]) {
			assert.equal(lessonTools.includes(tool), teaching, `${tool} must be teacher-only in the lesson`);
			assert.ok(!nativeTools.includes(tool), `${tool} must stay out of native sessions`);
		}
		assert.ok(lessonTools.includes(teaching ? "plan_init" : "probe_done"));
		for (const tool of ["read", "ls", "find", "grep", "research", "pdf", "ask_user_question", ...(teaching ? ["quiz", "explain", "demo", "visual"] : [])]) {
			assert.ok(!lessonTools.includes(tool), `${tool} was not removed from the lesson`);
		}
	}
});

test("real turns probe, plan, pose, accept a teach-back and search the extracted note", { timeout: 10_000 }, async () => {
	const chat = chatStore.createChat("Why the sky is blue", LESSON);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const takeaway = "Shorter wavelengths scatter more strongly in the atmosphere.";
	const question = "Why does scattered skylight look blue?";
	const answer = "Air scatters short blue wavelengths more strongly.\nTakeaway: learner text is not a note";
	const faux = createFauxCore({});
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	let builds = 0;
	async function turn(input: ChatInput, teaching: boolean, calls: number, ...responses: Parameters<typeof faux.setResponses>[0]) {
		faux.setResponses(responses);
		const before = faux.state.callCount;
		const response = await handleChatInput(chat.id, input, options => {
			builds++;
			assert.equal(options.teaching, teaching);
			assert.equal(options.sessionKind?.id, LESSON);
			// With a custom factory, the handler leaves contribution wiring to us.
			return agentFor(chat.id, options.teaching, { ...options, engine, pluginContributions: host.agentContributions });
		});
		assert.equal(response.status, 200, await response.text());
		const live = runningTurn(chat.id);
		if (live) await new Response(live.subscribe()).text();
		assert.equal(turnFailure(chat.id), undefined);
		assert.equal(faux.state.callCount - before, calls, JSON.stringify(chatRecord(chat.id).messages.slice(-6), null, 2));
	}
	const tool = (name: string, id: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });

	await turn({ type: "text", text: "Teach me why the sky is blue." }, false, 2,
		tool("probe_done", "assessment", { assessment: { strands: [{ strand: "Scattering", assessment: "Prior understanding unknown." }] } }),
		fauxAssistantMessage("Let's look at how air scatters light."));
	assert.ok(hasProbeDone(chatRecord(chat.id).messages));

	await turn({ type: "text", text: "Show me one example." }, true, 2,
		tool("plan_init", "plan", { mermaid: "graph TD\n  scattering[Wavelength-dependent scattering]" }),
		fauxAssistantMessage([
			fauxText("Blue light scatters in more directions than red light; look away from the sun and you see that scattered light."),
			fauxToolCall(TEACH_BACK, { type: "check", nodeId: "scattering", question, payload: {} }, { id: "teach-back" }),
		], { stopReason: "toolUse" }));
	const lesson = chatRecord(chat.id);
	assert.deepEqual(lesson.tree?.nodes.map(node => node.id), ["scattering"]);
	const pending = pendingPluginQuestionOf(lesson.messages);
	assert.ok(pending, "the question must park the real turn and survive in the canonical transcript");
	assert.equal(pending.pluginId, PLUGIN);
	assert.equal(pending.typeId, "teach-back");
	assert.equal(pending.occurrence.toolName, TEACH_BACK);
	assert.equal(pending.input.nodeId, "scattering");
	assert.equal(pending.input.question, question);

	const submission = { type: "plugin-question-answer", questionId: pending.questionId, occurrence: pending.occurrence, answer } as const;
	const rejected = await handleChatInput(chat.id, { ...submission, answer: "  " }, () => assert.fail("blank answer must not start a turn"));
	assert.equal(rejected.status, 400);
	assert.deepEqual(await rejected.json(), { error: "Enter a short explanation." });
	assert.equal(pendingPluginQuestionOf(chatRecord(chat.id).messages)?.questionId, pending.questionId);
	await turn(submission, true, 1, fauxAssistantMessage(`That's right.\nTakeaway: ${takeaway}`));
	const answered = chatRecord(chat.id).messages;
	assert.equal(pendingPluginQuestionOf(answered), undefined);
	const result = answered.find(message => message.role === "toolResult" && message.toolName === TEACH_BACK);
	assert.ok(result?.role === "toolResult" && !result.isError);
	assert.deepEqual(result.lhQuestionOccurrence, pending.occurrence);
	assert.partialDeepStrictEqual(result.details, { kind: "plugin-question", questionId: pending.questionId, answer });

	const target = await notebookTarget(chat.id);
	assert.equal((await runRecordExtraction({ chatStore }, chat.id, target, "manual")).status, "done");
	assert.deepEqual((await notebook()).find(group => group.chatId === chat.id), { chatId: chat.id, title: chat.title, entries: [takeaway] });
	await turn({ type: "text", text: "What does the notebook remember about shorter wavelengths?" }, true, 2,
		tool(SEARCH, "lookup", { query: "  SHORTER WAVELENGTHS  " }),
		fauxAssistantMessage("I found the note on scattering."));
	const lookup = chatRecord(chat.id).messages.find(message => message.role === "toolResult" && message.toolName === SEARCH);
	assert.ok(lookup?.role === "toolResult" && !lookup.isError);
	assert.deepEqual(lookup.details, { matches: [takeaway] });
	assert.equal(builds, 4);
});

test("raw extraction retains only delivered notes, tolerates batch replay, and purges just the deleted lesson", async () => {
	const chat = chatStore.createChat("Raw notebook transcript", LESSON);
	const other = chatStore.createChat("Unrelated notebook lesson", LESSON);
	const prose = "An explicit marker in assistant prose.";
	const delivered = "A marker in acknowledged send_to_user output.";
	const assistant = (...args: Parameters<typeof fauxAssistantMessage>): LhMessage => ({ id: newMessageId(), ...fauxAssistantMessage(...args) });
	const call = (id: string, note: string, name = "send_to_user") => fauxToolCall(name, { message: `Takeaway: ${note}` }, { id });
	const result = (toolCallId: string, isError: boolean, toolName = "send_to_user"): LhMessage => ({
		id: newMessageId(), role: "toolResult", toolCallId, toolName, isError, timestamp: Date.now(),
		content: [fauxText("Takeaway: private tool output")],
	});
	const raw = [
		newUserMessage("Takeaway: learner request"),
		assistant([
			fauxThinking("Takeaway: private thinking"),
			fauxText(`Takeaway: ${prose}\r\nTakeaway: ${prose}  \r\nTakeaway:   \r\nNo marker in this line.`),
			call("private", "private tool argument", "read"), call("ok", delivered),
			call("failed", "failed delivery"), call("dangling", "no acknowledgement"),
			// Enough raw (not visible) content that results are in a later batch.
			fauxThinking("background reasoning ".repeat(160)),
		], { stopReason: "toolUse" }),
		result("ok", false), result("failed", true), result("private", false, "read"),
		assistant("Takeaway: failed assistant response", { stopReason: "error" }),
		assistant("Takeaway: interrupted assistant response", { stopReason: "aborted" }),
	];
	chatStore.saveMessages(chat.id, raw);
	chatStore.saveMessages(other.id, [assistant("Takeaway: An unrelated saved note.")]);
	const target = await notebookTarget(chat.id);
	const extract = (id: string, mode: "manual" | "trigger" = "manual") => runRecordExtraction({ chatStore }, id, target, mode);
	assert.deepEqual(await extract(other.id, "trigger"), { status: "below-threshold" });
	assert.equal((await extract(other.id)).status, "done");
	const first = await extract(chat.id, "trigger");
	assert.ok(first.status === "done" && first.batches > 1, JSON.stringify(first));
	const coverage = await sessionCoverage(chat.id);
	assert.equal(coverage?.coveredCount, raw.length, "coverage includes user, tool result and private messages");
	assert.equal(coverage?.uncoveredCount, 0);
	const saved = fs.readFileSync(notebookFile, "utf8");
	const batches = JSON.parse(saved) as { chatId: string; entries: string[] }[];
	assert.deepEqual(batches.filter(batch => batch.chatId === chat.id).flatMap(batch => batch.entries), [prose, delivered]);
	assert.deepEqual((await notebook()).find(group => group.chatId === chat.id)?.entries, [prose, delivered]);
	assert.deepEqual(await extract(chat.id), { status: "nothing" });
	assert.equal(fs.readFileSync(notebookFile, "utf8"), saved);

	// Model a crash after the notebook write but before the host's coverage
	// checkpoint. The real host redelivers the same deterministic batches.
	target.coverage.rewrite(target.coverage.read().filter(row => row.chatId !== chat.id));
	assert.deepEqual(await extract(chat.id), first);
	assert.equal((await sessionCoverage(chat.id))?.coveredCount, raw.length);
	assert.equal(fs.readFileSync(notebookFile, "utf8"), saved, "replayed batches must not append duplicate notes");

	const deletion = await deleteChatSession(chat.id, "purge");
	assert.ok(deletion.ok, JSON.stringify(deletion));
	assert.ok(!chatStore.getChat(chat.id));
	assert.ok(!target.coverage.read().some(row => row.chatId === chat.id));
	assert.deepEqual(JSON.parse(fs.readFileSync(notebookFile, "utf8")), batches.filter(batch => batch.chatId !== chat.id));
	const groups = await notebook();
	assert.ok(!groups.some(group => group.chatId === chat.id));
	assert.deepEqual(groups.find(group => group.chatId === other.id)?.entries, ["An unrelated saved note."]);
	assert.equal((await sessionCoverage(other.id))?.coveredCount, 1);
});
