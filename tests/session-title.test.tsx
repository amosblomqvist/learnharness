import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { useSessionTitle } from "../components/session-title.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

async function fixture() {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const requests: Array<(response: Response) => void> = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window, document, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: (url: string) => {
			assert.equal(url, "/api/chats/chat_title");
			return new Promise<Response>((resolve) => { requests.push(resolve); });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	const events = new Map<string, (data: string) => void>();
	let reopen = () => {};
	const source: NotifySource = {
		close() {}, onOpen(cb) { reopen = cb; }, onEvent(name, cb) { events.set(name, cb); },
	};
	let rename!: (title: string) => void;
	function Header() {
		const [title, setTitle] = useSessionTitle("chat_title", "Opening prompt");
		rename = setTitle;
		return <h1>{title}</h1>;
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	dispose = async () => {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	await act(async () => root.render(<ServerEventsProvider connect={() => source}><Header /></ServerEventsProvider>));
	return {
		requests,
		title: () => document.querySelector("h1")!.textContent,
		respond: async (index: number, body: unknown, status = 200) => {
			await act(async () => { requests[index]!(Response.json(body, { status })); });
		},
		changed: async () => { await act(async () => events.get("chats-changed")!("{}")); },
		reconnect: async () => { await act(async () => reopen()); },
		rename: async (title: string) => { await act(async () => rename(title)); },
	};
}

test("an open header adopts plan titles on notification and heals on reconnect", async () => {
	const f = await fixture();
	await f.respond(0, { title: "Opening prompt" });
	await f.changed();
	await f.respond(1, { title: "Python decorators" });
	assert.equal(f.title(), "Python decorators");
	await f.reconnect();
	await f.respond(2, { title: "My Python notes" });
	assert.equal(f.title(), "My Python notes");
});

test("a late title read cannot overwrite a completed manual rename", async () => {
	const f = await fixture();
	await f.rename("My chosen title");
	await f.respond(0, { title: "Opening prompt" });
	assert.equal(f.title(), "My chosen title");
});

test("title refreshes ignore out-of-order responses and failed reads", async () => {
	const f = await fixture();
	await f.changed();
	await f.respond(1, { title: "Python decorators" });
	await f.respond(0, { title: "Opening prompt" });
	assert.equal(f.title(), "Python decorators");
	await f.changed();
	await f.respond(2, { error: "Unavailable" }, 503);
	assert.equal(f.title(), "Python decorators");
	await f.changed();
	await f.respond(3, {});
	assert.equal(f.title(), "Python decorators");
});
