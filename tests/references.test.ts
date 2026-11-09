/**
 * The session reference shelf (issue #63), four pins:
 *
 *  1. persistence — the add/remove roundtrip through the store, old records
 *     without the field, and summaries staying clean;
 *  2. composition — the grounding segment rides ALL THREE agents' system
 *     prompts exactly when the shelf is non-empty;
 *  3. admission — file references pass the EXISTING source-access rules at
 *     the route (protected locations refused, ordinary paths admitted);
 *  4. URLs — accepted, persisted, surfaced in the segment text, with no
 *     network in sight (validation is shape/protocol only).
 *
 * Env isolation follows tests/source-access.test.ts: synthetic HOME/auth/
 * data locations are pinned BEFORE the config-dependent imports, and the
 * route is driven directly (the chat-flow route-pin pattern).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-references-"));
const home = path.join(root, "home");
const auth = path.join(root, "private", "auth.json");
const data = path.join(root, "private", "data");
const previous = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_AUTH_FILE: auth, LH_DATA_DIR: data });
// The turn gate's env-first key truth (chat-flow's pin) — no turn runs here,
// but the barrel import reads the same environment any real server would.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
after(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	await fs.rm(root, { recursive: true, force: true });
});

await fs.mkdir(path.join(home, "notes"), { recursive: true });
const topic = path.join(home, "notes", "topic.md");
await fs.writeFile(topic, "ordinary study notes\n");
await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "LH_SYNTHETIC_SECRET_MARKER\n");

const { chatStore } = await import("../src/store/chats.ts");
const { parseReferencesBody, MAX_SESSION_REFERENCES } = await import("../src/server/references.ts");
const { sessionReferencesSegment } = await import("../src/agent/prompt-segments.ts");
const { createPracticeAgent, createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const referencesRoute = await import("../app/api/chats/[id]/references/route.ts");
const { createFauxCore } = await import("@earendil-works/pi-ai");
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import type { SessionReference } from "../src/core/contracts.ts";
import type { PiEngine } from "../src/agent/models.ts";

const SHELF: SessionReference[] = [
	{ id: "ref-file", kind: "file", value: topic, addedAt: "2026-11-09T10:00:00.000Z" },
	{ id: "ref-url", kind: "url", value: "https://example.com/grounding-paper", name: "The paper", addedAt: "2026-11-09T10:01:00.000Z" },
];

/** A request the route accepts; body overridable per case. */
function putRequest(id: string, body: unknown): Request {
	return new Request(`http://local/api/chats/${id}/references`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
const put = (id: string, body: unknown) => referencesRoute.PUT(putRequest(id, body), { params: Promise.resolve({ id }) });

describe("references: persistence roundtrip", () => {
	it("adds and removes through the store, replace-whole", () => {
		const chat = chatStore.createChat("References test");
		chatStore.saveReferences(chat.id, SHELF);
		assert.deepEqual(chatStore.getChat(chat.id)?.references, SHELF);
		// Removal is replace-whole with the shortened list; [] clears.
		chatStore.saveReferences(chat.id, SHELF.slice(0, 1));
		assert.deepEqual(chatStore.getChat(chat.id)?.references, [SHELF[0]]);
		chatStore.saveReferences(chat.id, []);
		assert.deepEqual(chatStore.getChat(chat.id)?.references, []);
		// The write stamps the record version like every other persist.
		assert.equal(chatStore.getChat(chat.id)?.version, 1);
	});

	it("reads records written before the field existed, with no shelf", async () => {
		const id = "chat_legacy_refs";
		await fs.writeFile(
			path.join(data, "chats", `${id}.json`),
			JSON.stringify({ id, title: "Legacy", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", messages: [] }),
		);
		const record = chatStore.getChat(id);
		assert.ok(record);
		assert.equal(record.references, undefined);
		// A later write preserves the absent-then-set discipline: the legacy
		// record gains a shelf only through an explicit save.
		chatStore.saveReferences(id, [SHELF[1]!]);
		assert.deepEqual(chatStore.getChat(id)?.references, [SHELF[1]]);
	});

	it("keeps the shelf out of list summaries and bumps no conversation activity", () => {
		const chat = chatStore.createChat("Summary test");
		const before = chatStore.getChat(chat.id)!.updatedAt;
		chatStore.saveReferences(chat.id, SHELF);
		const summary = chatStore.listChats().find((s) => s.id === chat.id);
		assert.ok(summary);
		assert.equal("references" in summary, false);
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, before);
	});
});

describe("references: grounding composes every agent exactly when present", () => {
	// The composition seam: a faux engine so no provider resolves, and the
	// agents' state carries the composed system prompt (pi seeds it at
	// construction — chat-flow's scripted-teacher idiom, no tokens spent).
	const faux = createFauxCore({});
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: (() => {
			throw new Error("no model call in this test");
		}) as typeof faux.streamSimple,
	};
	const ctx = {
		chatId: "synthetic",
		chatStore: { getChat: () => null } as unknown as ChatStore,
		jobStore: {} as JobStore,
		spawn: () => {},
		deliver: () => {},
	};

	it("the segment builder is null on an empty shelf and names every entry otherwise", () => {
		assert.equal(sessionReferencesSegment([]), null);
		const segment = sessionReferencesSegment(SHELF)!;
		assert.match(segment, /^Reference materials for this session/);
		assert.ok(segment.includes(topic));
		assert.ok(segment.includes("https://example.com/grounding-paper"));
		assert.ok(segment.includes("read tool"));
		assert.ok(segment.includes("research tool"));
		assert.match(segment, /learner's goal still sets the direction/);
	});

	for (const case_ of [
		{ name: "prober", build: (references?: SessionReference[]) => createProberAgent(ctx, { engine, ...(references ? { references } : {}) }) },
		{ name: "teacher", build: (references?: SessionReference[]) => createTeacherAgent(ctx, { engine, ...(references ? { references } : {}) }) },
		{ name: "practice", build: (references?: SessionReference[]) => createPracticeAgent({ chatId: ctx.chatId, chatStore: ctx.chatStore }, { engine, ...(references ? { references } : {}) }) },
	] as const) {
		it(`composes the segment into the ${case_.name} system prompt only when the shelf is non-empty`, () => {
			const grounded = case_.build(SHELF).state.systemPrompt;
			assert.match(grounded, /Reference materials for this session/);
			assert.ok(grounded.includes(topic));
			assert.ok(grounded.includes("https://example.com/grounding-paper"));
			// Trailing placement after the static doctrine (cacheable prefix).
			assert.ok(grounded.indexOf("Reference materials for this session") > grounded.indexOf("---"));

			const bare = case_.build(undefined).state.systemPrompt;
			assert.ok(!bare.includes("Reference materials for this session"));
			// The shelf's values never leak into the static prompt.
			assert.equal(bare.includes(topic), false);
			assert.equal(bare.includes("https://example.com/grounding-paper"), false);
		});
		it(`composes nothing for an empty ${case_.name} shelf`, () => {
			assert.ok(!case_.build([]).state.systemPrompt.includes("Reference materials for this session"));
		});
	}
});

describe("references: file admission at the route (existing source-access rules)", () => {
	it("admits an ordinary file and a directory, persists replace-whole", async () => {
		const chat = chatStore.createChat("Admission test");
		const res = await put(chat.id, { references: [{ id: "r1", kind: "file", value: topic, addedAt: "2026-11-09T11:00:00.000Z" }] });
		assert.equal(res.status, 200);
		assert.deepEqual((await res.json()).references, [{ id: "r1", kind: "file", value: topic, addedAt: "2026-11-09T11:00:00.000Z" }]);
		assert.deepEqual(chatStore.getChat(chat.id)?.references, [{ id: "r1", kind: "file", value: topic, addedAt: "2026-11-09T11:00:00.000Z" }]);

		const folder = await put(chat.id, { references: [{ id: "r2", kind: "file", value: path.join(home, "notes"), addedAt: "2026-11-09T11:00:00.000Z" }] });
		assert.equal(folder.status, 200);
	});

	it("resolves home-relative spellings like the read tool does", async () => {
		const chat = chatStore.createChat("Relative test");
		const res = await put(chat.id, { references: [{ id: "r1", kind: "file", value: "notes/topic.md", addedAt: "2026-11-09T11:00:00.000Z" }] });
		assert.equal(res.status, 200);
		assert.equal(chatStore.getChat(chat.id)?.references?.[0]?.value, "notes/topic.md"); // spelling preserved
	});

	it("refuses protected locations with the tools' own denial", async () => {
		const chat = chatStore.createChat("Denial test");
		const res = await put(chat.id, { references: [{ id: "r1", kind: "file", value: path.join(home, ".ssh", "id_ed25519"), addedAt: "2026-11-09T11:00:00.000Z" }] });
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /protected location/);
		assert.equal(chatStore.getChat(chat.id)?.references, undefined); // nothing half-saved
	});

	it("refuses a missing file so a typo grounds nothing silently", async () => {
		const chat = chatStore.createChat("Missing test");
		const res = await put(chat.id, { references: [{ id: "r1", kind: "file", value: path.join(home, "notes", "absent.md"), addedAt: "2026-11-09T11:00:00.000Z" }] });
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /reference file cannot be used/);
	});
});

describe("references: URLs accepted and surfaced, offline", () => {
	it("accepts an http(s) URL, persists it, and the segment names it", async () => {
		const chat = chatStore.createChat("URL test");
		const res = await put(chat.id, { references: [SHELF[1]] });
		assert.equal(res.status, 200);
		const record = chatStore.getChat(chat.id)!;
		assert.deepEqual(record.references, [SHELF[1]]);
		const segment = sessionReferencesSegment(record.references ?? [])!;
		assert.ok(segment.includes(SHELF[1]!.value));
		assert.ok(segment.includes("research tool")); // the honest fetch story
	});

	it("refuses non-http(s) schemes and malformed bodies", async () => {
		const chat = chatStore.createChat("URL refusal test");
		for (const [body, pattern] of [
			[{ references: [{ id: "r", kind: "url", value: "ftp://example.com/paper", addedAt: "2026-11-09T11:00:00.000Z" }] }, /http\(s\) URL/],
			[{ references: [{ id: "r", kind: "url", value: "not a url", addedAt: "2026-11-09T11:00:00.000Z" }] }, /http\(s\) URL/],
			[{ references: "nope" }, /must be an array/],
			[{ references: [{ id: "r", kind: "epub", value: topic, addedAt: "2026-11-09T11:00:00.000Z" }] }, /"file" or "url"/],
			[{ references: [{ ...SHELF[0]! }, { ...SHELF[0]!, id: "dupe" }] }, /duplicate/],
			[{}], // no references key
		] as Array<[unknown, RegExp?]>) {
			const res = await put(chat.id, body);
			assert.equal(res.status, 400, JSON.stringify(body));
			if (pattern) assert.match((await res.json()).error, pattern);
		}
	});

	it("caps the shelf size and 404s unknown sessions", async () => {
		assert.equal(parseReferencesBody({ references: "x" }).ok, false);
		const overflow = Array.from({ length: MAX_SESSION_REFERENCES + 1 }, (_, i) => ({ id: `r${i}`, kind: "url", value: `https://example.com/${i}`, addedAt: "2026-11-09T11:00:00.000Z" }));
		const chat = chatStore.createChat("Cap test");
		const res = await put(chat.id, { references: overflow });
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, new RegExp(`at most ${MAX_SESSION_REFERENCES}`));
		const missing = await put("chat_does_not_exist", { references: [] });
		assert.equal(missing.status, 404);
	});
});
