import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChatSpeedSwitch } from "../components/chat-speed-switch.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import type { FastModeResult } from "../src/core/native-chat-speed.ts";

const defaultModel = { provider: "openai", id: "gpt-6.2-sol" };
const speedResult = (chatId: string, result: FastModeResult, model = defaultModel) => ({ chatId, model, result });

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	React, window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});

function fakeSource() {
	const events = new Map<string, (data: string) => void>();
	let onOpen = () => {};
	let closed = false;
	return {
		close() { closed = true; },
		onOpen(cb: () => void) { onOpen = cb; },
		onEvent(name: string, cb: (data: string) => void) { events.set(name, cb); },
		push(name: string, payload: unknown) { if (!closed) events.get(name)?.(JSON.stringify(payload)); },
		open() { if (!closed) onOpen(); },
	} satisfies NotifySource & { push(name: string, payload: unknown): void; open(): void };
}

async function mountSwitch(t: TestContext, { chatId, modelKey = "openai:gpt-6.2-sol", source }: { chatId?: string; modelKey?: string; source?: NotifySource } = {}) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const connect = source ? () => source : undefined;
	const render = async (id = chatId, key = modelKey) => {
		const split = key.indexOf(":");
		const control = <ChatSpeedSwitch key={`${id}:${key}`} chatId={id} model={{ provider: key.slice(0, split), id: key.slice(split + 1) }} />;
		await act(async () => root.render(connect ? <ServerEventsProvider connect={connect}>{control}</ServerEventsProvider> : control));
	};
	t.after(async () => {
		await act(async () => root.unmount());
		host.remove();
	});
	await render();
	const control = host.querySelector<HTMLButtonElement>('button[role="switch"]');
	assert.ok(control, "Fast mode is keyboard-operable and exposes its checked state");
	return { host, render, get control() { return host.querySelector<HTMLButtonElement>('button[role="switch"]')!; } };
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
	for (const { control } of [first, second, reopened]) assert.equal(control.textContent, "Fast requested");

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

test("saved Fast intent is distinct from the actual tier and only this chat's result is announced", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ settings: { chatSpeed: { fast: true } } }));
	const source = fakeSource();
	const { host, control } = await mountSwitch(t, { chatId: "chat_a", source });
	assert.equal(control.textContent, "Fast requested");
	assert.equal(host.querySelector('[role="status"]'), null);
	await act(async () => source.push("chat-speed-result", speedResult("chat_b", { outcome: "applied", servedTier: "priority" })));
	assert.equal(control.textContent, "Fast requested", "another chat cannot confirm Fast here");
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "not-applied", servedTier: "default" })));
	assert.equal(control.textContent, "Fast not applied");
	assert.equal(control.getAttribute("aria-checked"), "true", "a downgrade does not change the saved preference");
	const notice = host.querySelector('[role="status"]')!;
	assert.equal(notice.getAttribute("aria-live"), "polite");
	assert.equal(notice.textContent, "Fast was requested, but OpenAI used Standard for at least one request in this turn.");
	assert.equal(host.querySelector('[role="alert"]'), null, "a processing downgrade is not a settings-save failure");
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "not-applied", servedTier: "flex" })));
	assert.equal(host.querySelector('[role="status"]')?.textContent, "Fast was requested, but OpenAI used Flex for at least one request in this turn.");
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "unconfirmed" })));
	assert.equal(control.textContent, "Fast unconfirmed");
	assert.equal(host.querySelector('[role="status"]')?.textContent, "OpenAI did not confirm Fast processing for every completed request in this turn.");
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "applied", servedTier: "priority" })));
	assert.equal(control.textContent, "Fast applied");
	assert.equal(control.getAttribute("aria-checked"), "true");
});

test("new turns, reconnects, account changes and chat/model switches clear live-only confirmation", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ settings: { chatSpeed: { fast: true } } }));
	const source = fakeSource();
	const view = await mountSwitch(t, { chatId: "chat_a", source });
	const applied = async (chatId = "chat_a", model = defaultModel) => {
		await act(async () => source.push("turn-started", { chatId }));
		await act(async () => source.push("chat-speed-result", speedResult(chatId, { outcome: "applied", servedTier: "priority" }, model)));
		assert.equal(view.control.textContent, "Fast applied");
	};
	const cleared = () => {
		assert.equal(view.control.textContent, "Fast requested");
		assert.equal(view.host.querySelector('[role="status"]'), null);
	};
	await applied();
	await act(async () => source.push("turn-started", { chatId: "chat_b" }));
	assert.equal(view.control.textContent, "Fast applied", "another chat's turn cannot clear this result");
	await act(async () => source.push("turn-started", { chatId: "chat_a" }));
	cleared();
	await applied();
	await act(async () => source.open());
	cleared();
	await applied();
	await act(async () => source.push("subscriptions-changed", {}));
	cleared();
	await applied();
	await view.render("chat_a", "openai:gpt-6.2-astra");
	cleared();
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "applied", servedTier: "priority" })));
	cleared();
	await applied("chat_a", { provider: "openai", id: "gpt-6.2-astra" });
	await view.render("chat_b");
	cleared();
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "not-applied", servedTier: "default" })));
	cleared();
	await applied("chat_b");
});

test("separate window channels each deliver results without changing Fast intent or leaking across chats", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ settings: { chatSpeed: { fast: true } } }));
	const firstSource = fakeSource(), secondSource = fakeSource();
	const first = await mountSwitch(t, { chatId: "chat_a", source: firstSource });
	const second = await mountSwitch(t, { chatId: "chat_b", source: secondSource });
	for (const source of [firstSource, secondSource]) {
		await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "applied", servedTier: "priority" })));
	}
	assert.equal(first.control.textContent, "Fast applied");
	assert.equal(second.control.textContent, "Fast requested");
	await act(async () => secondSource.push("chat-speed-result", speedResult("chat_b", { outcome: "unconfirmed" })));
	assert.equal(second.control.textContent, "Fast unconfirmed");
	assert.equal(first.control.textContent, "Fast applied");
	await act(async () => firstSource.open());
	assert.equal(first.control.textContent, "Fast requested");
	assert.equal(second.control.textContent, "Fast unconfirmed", "one window's reconnect only resets its own live confirmation");
});

test("switching Fast off clears the response notice and late results cannot turn it back on", async (t) => {
	let fast = true;
	t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
		if (init?.method === "PUT") fast = JSON.parse(String(init.body)).fast;
		return Response.json({ settings: { chatSpeed: { fast } } });
	});
	const source = fakeSource();
	const { host, control } = await mountSwitch(t, { chatId: "chat_a", source });
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "not-applied", servedTier: "default" })));
	assert.ok(host.querySelector('[role="status"]'));
	await act(async () => control.click());
	assert.equal(control.textContent, "Fast off");
	assert.equal(control.getAttribute("aria-checked"), "false");
	assert.equal(host.querySelector('[role="status"]'), null);
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "applied", servedTier: "priority" })));
	assert.equal(control.textContent, "Fast off");
	await act(async () => control.click());
	assert.equal(control.textContent, "Fast requested");
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "applied", servedTier: "priority" })));
	assert.equal(control.textContent, "Fast requested", "off → on ignores an older in-flight response");
	await act(async () => source.push("turn-started", { chatId: "chat_a" }));
	await act(async () => source.push("chat-speed-result", speedResult("chat_a", { outcome: "applied", servedTier: "priority" })));
	assert.equal(control.textContent, "Fast applied");
});
