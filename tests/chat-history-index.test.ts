import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { readChatHistoryIndex, rebuildChatHistoryIndex } from "../src/store/chat-history-index.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { phaseTimeline } from "../src/core/phases.ts";
import { projectView } from "../src/core/view.ts";
import { coverageOf } from "../src/core/coverage.ts";
import { transcriptOpeningLayout } from "../src/core/transcript-layout.ts";
import type { PlanTree, TurnUsage } from "../src/core/contracts.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-history-index-"));
process.env.LH_DATA_DIR = data;
const { chatStore, getChatCoverageBasis, getChatOpening } = await import("../src/store/chats.ts");
after(() => fs.rmSync(data, { recursive: true, force: true }));

const fileFor = (id: string) => path.join(data, "chats", `${id}.json`);
const indexFor = (id: string) => `${fileFor(id)}.history.idx`;
const messages = Array.from({ length: 90 }, (_, index) =>
	newUserMessage(`Passage ${index} — Ж🙂\\["messages"]\n${index < 50 ? "Long historical text. ".repeat(700) : "Recent."}`));

test("warm open reads a bounded byte range from the original, with one offset per message", async t => {
	const chat = chatStore.createChat("Назва́ние 🙂", "practice");
	chatStore.saveMessages(chat.id, messages);
	const settings = { model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "medium" } as const;
	const turn: TurnUsage = { id: "turn-seed", messageId: messages[0]!.id, at: "2026-11-25T00:00:00Z", model: "openai:gpt-5", steps: [] };
	chatStore.saveSettings(chat.id, settings);
	chatStore.appendTurnUsage(chat.id, turn);
	const file = fileFor(chat.id);
	await rebuildChatHistoryIndex(file);
	const fileSize = fs.statSync(file).size;
	const sourceInode = fs.statSync(file).ino;
	const index = JSON.parse(fs.readFileSync(indexFor(chat.id), "utf8"));
	assert.equal(index.offsets.length, messages.length + 1);
	assert.equal(JSON.stringify(index).includes(turn.id), false, "the index stores a range, not a copy of the usage log");
	assert.ok(fs.statSync(indexFor(chat.id)).size < fileSize / 100);
	const readSync = fs.readSync.bind(fs);
	let sourceBytes = 0;
	t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
		const count = readSync(fd, buffer, offset, length, position);
		if (fs.fstatSync(fd).ino === sourceInode) sourceBytes += count;
		return count;
	});
	t.mock.method(fs, "readFileSync", () => { throw new Error("Indexed opening must not call readFileSync"); });
	assert.deepEqual(getChatOpening(chat.id), {
		id: chat.id, title: chat.title, kind: "practice", messages: messages.slice(-40), partial: true,
		openingLayout: transcriptOpeningLayout(messages),
		settings, turns: [turn], dockUsage: { contextTokens: null, cliContextWindow: null },
		presentation: { phaseBeforeTail: "probe", plan: null, sideHistoryIds: [] }, coverageBasis: undefined,
	});
	assert.ok(sourceBytes > 0 && sourceBytes < fileSize / 10, `read ${sourceBytes} of ${fileSize} bytes`);
	const tail = readChatHistoryIndex(file, { limit: 4, maxBytes: 128 * 1024 })!;
	const previous = readChatHistoryIndex(file, { limit: 4, before: tail.start, maxBytes: 128 * 1024 })!;
	assert.deepEqual([...previous.messages, ...tail.messages], messages.slice(-8));
	assert.equal(tail.revision, previous.revision);
	assert.equal(previous.total, messages.length);
	assert.equal(tail.turns, undefined, "ordinary page reads leave the usage log on disk");
	const bounded = readChatHistoryIndex(file, { limit: 4, before: 40, maxBytes: 20000 })!;
	assert.deepEqual(bounded.messages, messages.slice(39, 40));
});

test("a warm preview carries earlier phase, plan progress, side badges, and exact live coverage", async t => {
	const chat = chatStore.createChat("Opening presentation");
	const timestamp = Date.now();
	const call = (name: string, id: string, args: object): LhMessage => ({
		id, role: "assistant", timestamp, stopReason: "toolUse",
		content: [{ type: "toolCall", id: `call-${id}`, name, arguments: args }],
	} as LhMessage);
	const result = (toolName: string, id: string, details: object): LhMessage => ({
		id: `result-${id}`, role: "toolResult", timestamp, toolName, toolCallId: `call-${id}`, isError: false,
		content: [{ type: "text", text: "ok" }], details,
	} as LhMessage);
	const prose = { id: "prose", role: "assistant", timestamp, stopReason: "stop", content: [{ type: "text", text: "Saved teacher explanation." }] } as LhMessage;
	const tree: PlanTree = { nodes: [{ id: "a", title: "First" }, { id: "b", title: "Second" }], edges: [{ from: "a", to: "b" }], version: 1 };
	const history = [
		messages[0]!, call("probe_done", "probe", {}), result("probe_done", "probe", { ok: true }),
		call("plan_init", "plan", {}), result("plan_init", "plan", { ok: true, tree }), prose,
		call("quiz", "quiz-a", { nodeId: "a" }), result("quiz", "quiz-a", { ok: true }),
		call("quiz", "quiz-b", { nodeId: "b" }), result("quiz", "quiz-b", { ok: true }),
		...messages.slice(1),
	];
	chatStore.saveMessages(chat.id, history);
	chatStore.updateSideChats(chat.id, () => [{
		id: "side", anchor: { messageId: prose.id, partId: "prose-t0", blockIndex: 0, blockText: "Saved teacher explanation." },
		open: false, createdAt: chat.createdAt, messages: [{ id: "question", role: "user", text: "Saved side question", at: chat.createdAt }],
	}]);
	await rebuildChatHistoryIndex(fileFor(chat.id));
	const opening = getChatOpening(chat.id);
	assert.ok(opening?.partial);
	assert.deepEqual(opening.presentation, {
		phaseBeforeTail: "teach", plan: { tree, current: "b", visited: ["a"] }, sideHistoryIds: [prose.id],
	});
	assert.ok(phaseTimeline(projectView(opening.messages), opening.presentation.phaseBeforeTail).every(phase => phase === "teach"));
	assert.ok(!opening.messages.some(message => message.id === prose.id));
	const basis = getChatCoverageBasis(chat.id);
	assert.deepEqual(basis, opening.coverageBasis);
	assert.equal(basis?.totalMessages, history.length);
	assert.equal(basis?.slots.length, 1);
	const { sessionCoverage } = await import("../src/server/chats.ts");
	const { stores } = await import("../src/server/stores.ts");
	const oldIndex = fs.readFileSync(indexFor(chat.id), "utf8");
	assert.ok(!oldIndex.includes("Saved teacher explanation") && !oldIndex.includes("Saved side question"));
	t.mock.method(chatStore, "getChat", () => { throw new Error("Warm coverage must not read the canonical record"); });
	assert.equal(sessionCoverage(chat.id)?.uncoveredCount, 1);
	const entry = { ...basis!.slots[0]!, chatId: chat.id, foldedAt: new Date().toISOString() };
	stores.graphStore.appendCoverage(entry);
	const expected = coverageOf(history, [entry], chat.id);
	assert.deepEqual(sessionCoverage(chat.id), {
		totalMessages: history.length, coveredCount: expected.coveredCount, uncoveredCount: expected.uncoveredCount,
		coveredTokens: expected.coveredTokens, uncoveredTokens: expected.uncoveredTokens, running: false, lastFoldedAt: entry.foldedAt,
	});
});

test("old files backfill the index without rewriting the original", async () => {
	const chat = chatStore.createChat("Legacy");
	const legacy = JSON.stringify({ ...chat, version: 1, messages, sideChats: ["nested JSON \" ], {"] });
	fs.writeFileSync(fileFor(chat.id), legacy);
	assert.deepEqual(getChatOpening(chat.id)?.messages, messages);
	await rebuildChatHistoryIndex(fileFor(chat.id));
	assert.equal(fs.readFileSync(fileFor(chat.id), "utf8"), legacy);
	assert.equal(getChatOpening(chat.id)?.partial, true);
	const current = JSON.parse(fs.readFileSync(indexFor(chat.id), "utf8"));
	fs.writeFileSync(indexFor(chat.id), JSON.stringify({ ...current, format: 1 }));
	assert.equal(getChatOpening(chat.id)?.partial, false);
	await rebuildChatHistoryIndex(fileFor(chat.id));
	assert.equal(getChatOpening(chat.id)?.partial, true);
	assert.equal(chatStore.listChats().filter(entry => entry.id === chat.id).length, 1);
	assert.equal(chatStore.deleteChat(chat.id), true);
	assert.equal(fs.existsSync(indexFor(chat.id)), false);
});

test("replacement, in-place edits and corrupt indices fall back to the current record", async () => {
	const chat = chatStore.createChat("Before");
	chatStore.saveMessages(chat.id, messages);
	const file = fileFor(chat.id);
	await rebuildChatHistoryIndex(file);
	const originalIndex = fs.readFileSync(indexFor(chat.id));
	assert.equal(chatStore.renameChat(chat.id, "After").title, "After");
	chatStore.saveMessages(chat.id, [...messages, newUserMessage("Newest")]);
	await rebuildChatHistoryIndex(file);
	assert.equal(getChatOpening(chat.id)?.title, "After");
	assert.deepEqual(getChatOpening(chat.id)?.messages.at(-1), chatStore.getChat(chat.id)?.messages.at(-1));
	fs.writeFileSync(indexFor(chat.id), originalIndex);
	assert.equal(getChatOpening(chat.id)?.partial, false);
	await rebuildChatHistoryIndex(file);
	assert.equal(getChatOpening(chat.id)?.partial, true);
	fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"After"', '"Later"'));
	const later = getChatOpening(chat.id);
	assert.equal(later?.partial, false);
	assert.equal(later?.title, "Later");
	await rebuildChatHistoryIndex(file);
	fs.truncateSync(indexFor(chat.id), 5);
	assert.equal(getChatOpening(chat.id)?.partial, false);
	await rebuildChatHistoryIndex(file);
	assert.equal(getChatOpening(chat.id)?.partial, true);
});

test("future schemas and deleted records cannot open through their indices", async () => {
	const chat = chatStore.createChat("Future");
	const file = fileFor(chat.id);
	fs.writeFileSync(file, JSON.stringify({ ...chat, version: 999, messages }));
	await rebuildChatHistoryIndex(file);
	assert.equal(readChatHistoryIndex(file, { limit: 40, maxBytes: 128 * 1024 }), null);
	assert.equal(getChatOpening(chat.id), null);
	fs.unlinkSync(file);
	assert.equal(getChatOpening(chat.id), null);
});
