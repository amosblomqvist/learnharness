import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChatSpeedSwitch } from "../components/chat-speed-switch.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	React, window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});

async function mountSwitch(t: TestContext) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	t.after(async () => {
		await act(async () => root.unmount());
		host.remove();
	});
	await act(async () => root.render(<ChatSpeedSwitch />));
	const control = host.querySelector<HTMLButtonElement>('button[role="switch"]');
	assert.ok(control, "Fast mode is keyboard-operable and exposes its checked state");
	return { host, control };
}

test("Fast defaults off and one chat's saved change reaches other mounted and newly opened chats", async (t) => {
	let fast: boolean | undefined;
	const writes: unknown[] = [];
	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		if (init?.method === "PUT") {
			assert.equal(url, "/api/settings/chatSpeed");
			const body = JSON.parse(String(init.body));
			writes.push(body);
			fast = body.fast;
		} else {
			assert.equal(url, "/api/settings");
		}
		return Response.json({ settings: fast === undefined ? null : { chatSpeed: { fast } } });
	});
	const first = await mountSwitch(t);
	const second = await mountSwitch(t);
	assert.equal(first.control.getAttribute("aria-checked"), "false");
	assert.equal(second.control.getAttribute("aria-checked"), "false");
	assert.deepEqual(writes, []);

	await act(async () => first.control.click());
	const reopened = await mountSwitch(t);
	for (const { control } of [first, second, reopened]) assert.equal(control.getAttribute("aria-checked"), "true");

	await act(async () => reopened.control.click());
	for (const { control } of [first, second, reopened]) assert.equal(control.getAttribute("aria-checked"), "false");
	assert.deepEqual(writes, [{ fast: true }, { fast: false }]);
});

test("a failed write allows retrying the read without repeating the write", async (t) => {
	let writes = 0;
	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		if (init?.method === "PUT") {
			assert.equal(url, "/api/settings/chatSpeed");
			writes++;
			return new Response(null, { status: 503 });
		}
		assert.equal(url, "/api/settings");
		return Response.json({ settings: { chatSpeed: { fast: true } } });
	});
	const { host, control } = await mountSwitch(t);
	assert.equal(control.getAttribute("aria-checked"), "true");
	await act(async () => control.click());
	assert.ok(control.disabled);
	const retry = host.querySelector<HTMLButtonElement>('[role="alert"] button');
	assert.ok(retry, "a failed save exposes a retry action");

	await act(async () => retry.click());
	assert.equal(control.disabled, false);
	assert.equal(control.getAttribute("aria-checked"), "true");
	assert.equal(host.querySelector('[role="alert"]'), null);
	assert.equal(writes, 1);
});
