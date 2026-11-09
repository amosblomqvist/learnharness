import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { NotesPanel, useSessionNotes, type NoteLocation } from "../components/session-notes.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { emptyNotesView, type NotesView } from "../src/core/session-notes.ts";

function savedNotes(): NotesView {
	const edition = (title: string) => ({ document: { title, overview: "", sections: [] }, fingerprint: title, writtenAt: "now" });
	return { ...emptyNotesView(), eligible: true, handout: edition("Saved handout"), liveNotes: edition("Live draft") };
}

async function withPanel(fetcher: typeof fetch, check: () => Promise<void>) {
	const dom = parseHTML("<html><body><div id='app'></div></body></html>");
	Object.assign(globalThis, {
		React, window: dom.window, self: dom.window, document: dom.document,
		Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetcher;
	const root = createRoot(document.getElementById("app")!);
	function Harness() {
		const notes = useSessionNotes("lesson");
		const [location, navigate] = useState<NoteLocation>({ mode: "handout" });
		return <NotesPanel chatId="lesson" notes={notes} location={location} navigate={navigate} close={() => {}} />;
	}
	try {
		await act(async () => {
			root.render(
				<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
					<Harness />
				</ServerEventsProvider>,
			);
		});
		await check();
	} finally {
		await act(async () => root.unmount());
		globalThis.fetch = originalFetch;
	}
}
function button(label: string) {
	return [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === label);
}
async function click(label: string) {
	const element = button(label);
	assert.ok(element, `Missing button: ${label}`);
	assert.equal(element.disabled, false);
	await act(async () => element.click());
}

it("keeps navigation read-only and scopes live notes controls to live notes actions, with PDF actions only in Handout", async () => {
	const view = savedNotes();
	const writes: unknown[] = [];
	await withPanel(async (_url, init) => {
		if (init?.method === "POST") {
			const action = JSON.parse(init.body as string);
			writes.push(action);
			if (action.action === "set-live-notes-enabled") view.liveNotesEnabled = action.enabled;
		}
		return Response.json(view);
	}, async () => {
		assert.equal(document.querySelector("a[download]")?.textContent, "Download handout PDF");
		assert.ok(button("Regenerate handout"));
		assert.equal(button("Update now"), undefined);
		assert.equal(button("Resume live notes"), undefined);
		await click("Live notes");
		assert.deepEqual(writes, [], "opening Live notes does not enable or generate anything");
		assert.equal(document.querySelector("a[download]"), null);
		assert.equal(button("Regenerate handout"), undefined);
		assert.match(document.body.textContent!, /Paused/);
		await click("Update now");
		assert.deepEqual(writes, [{ action: "update-live-notes" }]);
		assert.match(document.body.textContent!, /Live draft/);
		assert.ok(button("Resume live notes"), "a manual refresh leaves automatic updates paused");
		await click("Resume live notes");
		assert.match(document.body.textContent!, /Active/);
		await click("Pause live notes");
		await click("Handout");
		await click("Regenerate handout");
		assert.deepEqual(writes, [
			{ action: "update-live-notes" },
			{ action: "set-live-notes-enabled", enabled: true },
			{ action: "set-live-notes-enabled", enabled: false },
			{ action: "generate-handout" },
		]);
		assert.equal(document.querySelector("a[download]")?.getAttribute("href"), "/api/chats/lesson/notes/pdf");
	});
});

it("shows generation progress, PDF retries, and request failures only with their own edition", async () => {
	const view = savedNotes();
	view.running = ["handout"];
	view.handoutPdfPending = true;
	view.error.liveNotes = "Earlier live failure";
	await withPanel(async (_url, init) => init?.method === "POST"
		? Response.json({ error: "Live refresh refused" }, { status: 409 })
		: Response.json(view), async () => {
		assert.equal(document.querySelector('[role="status"]')?.textContent, "Composing handout…");
		assert.equal(document.querySelector('[role="alert"]'), null);
		await click("Live notes");
		assert.equal(document.querySelector('[role="status"]'), null);
		assert.equal(document.querySelector('[role="alert"]')?.textContent, "Earlier live failure");
		assert.equal(button("Retry handout PDF"), undefined);
		await click("Update now");
		assert.equal(document.querySelector('[role="alert"]')?.textContent, "Live refresh refused");
		await click("Handout");
		assert.equal(document.querySelector('[role="alert"]'), null, "a live request failure does not leak into Handout");
		await click("Live notes");
		assert.equal(document.querySelector('[role="alert"]')?.textContent, "Live refresh refused");
	});
});
