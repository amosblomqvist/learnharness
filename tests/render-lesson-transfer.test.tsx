import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { LessonTransfer } from "../components/settings/lesson-transfer.tsx";
import { LessonImport } from "../components/settings/lesson-import.tsx";
import { LessonLan } from "../components/settings/lesson-lan.tsx";
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document });
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
async function choose(host: HTMLElement, name = "synthetic.zip") {
	const upload = host.querySelector<HTMLInputElement>('input[type="file"]')!;
	await act(async () => {
		Object.defineProperty(upload, "files", { configurable: true, value: [new File(["authored"], name)] });
		upload.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
}
async function selectValue(select: HTMLSelectElement, value: string) {
	await act(async () => {
		for (const option of select.options) option.selected = option.value === value;
		select.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
}
async function check(input: HTMLInputElement, checked: boolean) {
	await act(async () => { input.checked = checked; input.dispatchEvent(new window.Event("click", { bubbles: true })); });
}

test("simple English UI has Import/Export, formats and warnings, without preview or approval controls", () => {
	const html = renderToStaticMarkup(<LessonTransfer />);
	for (const text of ["Markdown (.md)", "Text (.txt)", "Lesson JSON (.json)", "Lessons and graph (.zip)", "Continue with your local model settings"])
		assert.ok(html.includes(text));
	assert.ok(!html.includes("read-only"));
	assert.match(html, /aria-label="Export format"/); assert.match(html, /disabled=""[^>]*>Export/);
	assert.doesNotMatch(html, /Preview|Saved native|I understand|continuation|[А-Яа-яЁё]/);
	assert.equal((html.match(/type="checkbox"/g) ?? []).length, 0);
	assert.match(html, /type="file"[^>]*hidden=""/);
});

test("device connection shows QR in one click and polls presence without resetting QR or leaking timers", async t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const calls: string[] = []; let enabled = false, pairingActive = false, unavailable = false;
	let devices: { id: string; name: string; online: boolean }[] = [];
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "/api/lesson-lan"); const body = JSON.parse(init!.body as string); calls.push(body.action);
		if (unavailable) return Response.json({ error: "Offline" }, { status: 503 });
		if (body.action === "start") enabled = true;
		if (body.action === "stop") { enabled = false; pairingActive = false; }
		if (body.action === "revoke") { assert.equal(body.id, "synthetic-device"); devices = []; }
		if (body.action === "pair") { assert.deepEqual(body, { action: "pair" }); pairingActive = true; return Response.json({ connection: "learnharness-lan://pair?synthetic", qr: "data:image/png;base64,AA==", expires: 1 }); }
		return Response.json({ enabled, pairingActive, devices });
	};
	const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
	try {
		await act(async () => root.render(<LessonLan />)); assert.deepEqual(calls, ["status"]);
		await act(async () => button(host, "Connect a device").click());
		assert.ok(host.querySelector("img")); assert.equal(host.querySelector("select"), null);
		assert.doesNotMatch(host.textContent!, /LAN sync|Listening|Reasoned|Refresh|models|192\.168/);
		assert.equal(host.querySelector<HTMLTextAreaElement>("textarea")!.defaultValue, "learnharness-lan://pair?synthetic");
		for (let i = 0; i < 3; i++) {
			const before = calls.length; await act(async () => t.mock.timers.tick(1000));
			assert.equal(calls.length, before + 1); assert.equal(calls.at(-1), "status");
			assert.ok(host.querySelector("img")); // Polling must not regenerate or remove a valid QR.
		}
		devices = [{ id: "synthetic-device", name: "Authored device", online: true }]; pairingActive = false;
		await act(async () => t.mock.timers.tick(1000));
		assert.equal(host.querySelector("img"), null); assert.ok(button(host, "Connect another device"));
		assert.ok(host.querySelector('[aria-label="Online"]')?.classList.contains("bg-green-500"));
		devices[0]!.online = false; await act(async () => t.mock.timers.tick(1000));
		assert.ok(host.querySelector('[aria-label="Offline"]')?.classList.contains("bg-red-500"));
		unavailable = true; await act(async () => t.mock.timers.tick(1000)); assert.ok(host.querySelector('[role="alert"]'));
		unavailable = false; devices[0]!.online = true; await act(async () => t.mock.timers.tick(1000));
		assert.ok(host.querySelector('[aria-label="Online"]')); assert.equal(host.querySelector('[role="alert"]'), null);
		await act(async () => button(host, "Disconnect").click()); assert.equal(button(host, "Disconnect"), undefined);
		await act(async () => button(host, "Turn off").click());
		assert.deepEqual(calls.filter(action => action !== "status"), ["start", "pair", "revoke", "stop"]);
	} finally { await act(async () => root.unmount()); host.remove(); }
	const stopped = calls.length; t.mock.timers.tick(5000); assert.equal(calls.length, stopped);
});

test("choosing JSON checks and imports immediately without an acknowledgement checkbox", async () => {
	const calls: string[] = []; let installed = 0;
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "/api/lesson-import");
		const form = init!.body as FormData, action = form.get("action") as string; calls.push(action);
		assert.equal((form.get("file") as File).name, "synthetic.json");
		if (action === "preview") return Response.json({ revision: "rev", chats: [{ id: "chat_ui", title: "Authored JSON", kind: "new" }], nodes: 0, chains: 0, warnings: [], blockers: [] });
		assert.equal(form.get("revision"), "rev"); assert.equal(form.has("acknowledged"), false); assert.equal(form.get("choices"), "{}");
		return Response.json({ installed: ["chat_ui"] });
	};
	const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
	try {
		await act(async () => root.render(<LessonImport onInstalled={() => installed++} />));
		assert.equal(calls.length, 0); assert.equal(button(host, "Import").disabled, false);
		await choose(host, "synthetic.json");
		assert.deepEqual(calls, ["preview", "install"]); assert.equal(installed, 1);
		assert.match(host.textContent!, /Imported: 1/); assert.equal(host.querySelector('input[type="checkbox"]'), null);
	} finally { await act(async () => root.unmount()); host.remove(); }
});

test("import pauses only for conflicts; every choice is required and selecting another file clears old choices", async () => {
	const calls: string[] = []; let installed = 0;
	globalThis.fetch = async (_url, init) => {
		const form = init!.body as FormData, action = form.get("action") as string; calls.push(action);
		if (action === "preview") return Response.json({ revision: "rev", chats: [{ id: "chat_ui", title: "Synthetic conflict", kind: "conflict" }], nodes: 0, chains: 0, warnings: [], blockers: [] });
		assert.deepEqual(JSON.parse(form.get("choices") as string), { chat_ui: "incoming" });
		return Response.json({ installed: ["chat_ui"] });
	};
	const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
	try {
		await act(async () => root.render(<LessonImport onInstalled={() => installed++} />));
		await choose(host); assert.equal(button(host, "Import selected versions").disabled, true);
		await selectValue(host.querySelector("select")!, "incoming");
		assert.equal(button(host, "Import selected versions").disabled, false); assert.equal(installed, 0);
		await choose(host); assert.equal(button(host, "Import selected versions").disabled, true);
		await selectValue(host.querySelector("select")!, "incoming");
		await act(async () => button(host, "Import selected versions").click());
		assert.deepEqual(calls, ["preview", "preview", "install"]); assert.equal(installed, 1);
	} finally { await act(async () => root.unmount()); host.remove(); }
});

test("blocked or rejected imports never install", async () => {
	let calls = 0, installed = 0;
	globalThis.fetch = async (_url, init) => {
		assert.equal((init!.body as FormData).get("action"), "preview"); calls++;
		return calls === 1 ? Response.json({ revision: "rev", chats: [], blockers: ["Incompatible graph"], warnings: [] }) : Response.json({ error: "Invalid lesson" }, { status: 400 });
	};
	const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
	try {
		await act(async () => root.render(<LessonImport onInstalled={() => installed++} />));
		await choose(host); assert.match(host.textContent!, /Cannot import: Incompatible graph/);
		assert.equal(button(host, "Import selected versions"), undefined);
		await choose(host); assert.match(host.textContent!, /Invalid lesson/); assert.equal(installed, 0);
	} finally { await act(async () => root.unmount()); host.remove(); }
});

test("one Export click checks and downloads a source-free ZIP; actual source files remain opt-in", async () => {
	const calls: { preview: boolean; revision?: string; files?: number[] }[] = [];
	let available = false, downloads = 0;
	const timer = window.setTimeout, create = URL.createObjectURL, revoke = URL.revokeObjectURL;
	window.setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof window.setTimeout;
	URL.createObjectURL = () => { downloads++; return "blob:synthetic"; }; URL.revokeObjectURL = () => {};
	globalThis.fetch = async (input, init) => {
		if (input === "/api/lesson-lan") return Response.json({ enabled: false, addresses: [], devices: [] });
		if (input === "/api/chats") return Response.json({ chats: [{ id: "chat_ui", title: "Synthetic lesson", kind: "teach" }] });
		assert.equal(input, "/api/lesson-export");
		const body = JSON.parse(init!.body as string); calls.push(body);
		if (body.preview) return Response.json({ revision: "rev", chats: [{ id: "chat_ui" }], files: available ? [{ path: "/synthetic/private.pdf", status: "available", bytes: 10 }] : [], issues: [], complete: false });
		assert.equal(body.revision, "rev"); assert.equal("allowIncomplete" in body, false); assert.deepEqual(body.files, []);
		return new Response("authored ZIP", { headers: { "content-disposition": 'attachment; filename="synthetic.zip"' } });
	};
	const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
	try {
		await act(async () => root.render(<LessonTransfer />));
		const lesson = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		await check(lesson, true); await selectValue(host.querySelector("select")!, "zip");
		assert.equal(button(host, "Export").disabled, false);
		await act(async () => button(host, "Export").click());
		assert.deepEqual(calls.map(c => c.preview), [true, false]); assert.equal(downloads, 1);
		available = true;
		await act(async () => button(host, "Export").click());
		assert.equal(downloads, 1); assert.match(host.textContent!, /Optional files/);
		assert.equal(host.querySelectorAll('input[type="checkbox"]').length, 2); // Lesson and optional file, no acknowledgement.
		await check(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!, true);
		await selectValue(host.querySelector("select")!, "md"); await selectValue(host.querySelector("select")!, "zip");
		await act(async () => button(host, "Export").click());
		assert.equal(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.checked, false);
		await act(async () => button(host, "Export").click());
		assert.equal(downloads, 2); assert.deepEqual(calls.map(c => c.preview), [true, false, true, true, false]);
	} finally {
		await act(async () => root.unmount()); host.remove();
		window.setTimeout = timer; URL.createObjectURL = create; URL.revokeObjectURL = revoke;
	}
});
