import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { clearOpeningPrompt, readOpeningPrompt, OPENING_PROMPT_FAILURE } from "../components/opening-prompt.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
beforeEach(() => {
	const data = new Map<string, string>();
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => { data.set(key, value); },
		removeItem: (key: string) => { data.delete(key); },
	} });
});
afterEach(() => {
	if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "sessionStorage");
});

/**
 * The sessionless draft view (/chat/new, owner 2026-09-13): "+ New session"
 * opens the draft — NOTHING is created until the first message is sent, and
 * that message becomes the session's title. These pins hold the two seams:
 * startDraftSession (the create-on-send contract) and DraftShell (the
 * visible surface: composer blob + stats bar + the fresh-chat empty state).
 */

/** A fetch double: records calls, answers /api/chats with a canned id. */
function fakeFetch(id: string) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify({ id }), { status: 200 });
	}) as typeof fetch;
	return { f, calls };
}

describe("startDraftSession — the create-on-send contract", () => {
	it("creates the session titled with the first message and returns a short path", async () => {
		const { f, calls } = fakeFetch("c_new");
		const target = await startDraftSession("teach me orbital mechanics", f);
		assert.equal(target, "/chat/c_new");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "/api/chats");
		assert.equal(calls[0]!.method, "POST");
		assert.deepEqual(calls[0]!.body, { title: "teach me orbital mechanics" });
	});

	it("no settings PUT on create — the server stamps the newborn (per-session models, owner 2026-09-28)", async () => {
		const { f, calls } = fakeFetch("c_3");
		await startDraftSession("hello", f);
		assert.equal(calls.length, 1, "a single create call — the birth stamp is server-side");
	});

	it("a long opening text stays out of the URL and is stashed for the chat page", async () => {
		const mem = new Map<string, string>();
		const fake = {
			getItem: (k: string) => mem.get(k) ?? null,
			setItem: (k: string, v: string) => {
				mem.set(k, v);
			},
			removeItem: (k: string) => {
				mem.delete(k);
			},
		};
		const holder = globalThis as { sessionStorage?: Storage };
		const prev = holder.sessionStorage;
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: fake });
		try {
			const { f } = fakeFetch("c_long");
			const text = `${"B2 First grammar item. ".repeat(1500)}end`;
			const target = await startDraftSession(text, f);
			assert.equal(target, "/chat/c_long");
			assert.equal(target!.includes("?"), false);
			const stashed = readOpeningPrompt("c_long");
			assert.equal(stashed?.length, text.length);
			assert.equal(stashed, text);
			clearOpeningPrompt("c_long");
			assert.equal(readOpeningPrompt("c_long"), undefined);
		} finally {
			if (prev === undefined) delete holder.sessionStorage;
			else Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: prev });
		}
	});

	it("empty or whitespace text never creates anything", async () => {
		const { f, calls } = fakeFetch("never");
		assert.equal(await startDraftSession("", f), null);
		assert.equal(await startDraftSession("   ", f), null);
		assert.equal(calls.length, 0);
	});
});

describe("DraftShell — the sessionless surface", () => {
	it("storage failure leaves the full draft editable beside the approved error", () => {
		const html = renderToStaticMarkup(<DraftShell busy={false} text="keep all my text" onChange={() => {}} onSend={() => {}} startError />);
		assert.ok(html.includes('role="alert"'));
		assert.ok(html.includes(OPENING_PROMPT_FAILURE));
		assert.match(html, /<textarea[^>]*>keep all my text<\/textarea>/);
	});
	it("renders the composer blob, the stats bar, and the fresh-chat empty state", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
			/>,
		);
		// The chat composer, ready for the first message.
		assert.ok(html.includes('data-testid="composer"'));
		// The draft's model control binds the strong slot — the
		// new-session default (per-session models, owner 2026-09-28).
		assert.ok(html.includes('data-testid="stats-model"'));
		// No CTA by default: a configured surface stays quiet.
		assert.ok(!html.includes('data-testid="setup-cta"'));
		// The same empty state a fresh chat shows.
		assert.ok(html.includes("The teacher will open by probing what you already know."));
		// The pointer-events pattern (953b22b): the wrapper stays inert…
		assert.ok(html.includes("pointer-events-none"));
		// …and the blob re-enables it.
		assert.ok(/rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/.test(html));
	});

	it("renders the setup CTA above the composer blob when passed (fix wave chunk B: /chat/new mirrors home)", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				setupCta={
					<button type="button" data-testid="setup-cta">
						Set up your models
					</button>
				}
			/>,
		);
		// The same affordance home carries, above the draft shell's blob.
		assert.ok(html.includes('data-testid="setup-cta"'));
		assert.match(html, />Set up your models<\/button>/);
		assert.doesNotMatch(html, /chats start after/);
		// Above the composer: the CTA's markup precedes the blob's.
		const cta = html.indexOf('data-testid="setup-cta"');
		const blob = html.search(/rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/);
		assert.ok(cta !== -1 && blob !== -1 && cta < blob, "CTA above the blob");
	});

	it("no chat id anywhere — nothing in the markup references a session", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
			/>,
		);
		assert.ok(!/\/chat\/c[a-z0-9_]+/.test(html));
	});
});
describe("the practice draft (?mode=practice, 2026-10-04)", () => {
	it("the shell swaps copy: practice title, empty state, placeholder", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				mode="practice"
			/>,
		);
		assert.match(html, /New practice session/);
		assert.ok(html.includes("Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."));
		assert.match(html, /What do you want to practice\?/);
	});

	it("THE PICK BAR (owner round 10): the practice draft carries the same pill above its composer", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				mode="practice"
			/>,
		);
		assert.match(html, />Pick nodes<\/button>/);
		// picked: count + Clear, the home register verbatim
		const picked = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				mode="practice"
				picks={[{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }]}
			/>,
		);
		assert.match(picked, /1 node selected/);
		assert.match(picked, /Clear/);
		// teach mode with nothing picked renders nothing (home's law)
		const teach = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="teach" />,
		);
		assert.ok(!teach.includes('data-testid="practice-props-chip"'));
	});

	it("startDraftSession carries the picks as graphContext (the home practice contract)", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c10" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startDraftSession("drill me", f, "practice", [{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }]);
		assert.deepEqual(body, {
			title: "drill me",
			kind: "practice",
			graphContext: { propositions: [{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }] },
		});
	});

	it("practice with NO picks stays lean — no graphContext key on the wire", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c11" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startDraftSession("free practice", f, "practice", []);
		assert.deepEqual(body, { title: "free practice", kind: "practice" });
	});

	it("startDraftSession carries kind:\"practice\" to the create route", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c9" }), { status: 201 });
		}) as unknown as typeof fetch;
		const target = await startDraftSession("the parity chain", f, "practice");
		assert.equal(target, "/chat/c9");
		assert.deepEqual(body, { title: "the parity chain", kind: "practice" });
	});

	it("the teaching default is unchanged — no kind key on the wire", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c8" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startDraftSession("orbital mechanics", f);
		assert.deepEqual(body, { title: "orbital mechanics" });
	});
});
