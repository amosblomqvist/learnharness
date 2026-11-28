import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import {
	InteractionLayersProvider,
	useInteractionLayers,
	type InteractionLayersController,
} from "../components/interaction-layers.tsx";
import { HostDialog } from "../components/host-dialog.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { AUTH_KEYS, type AuthKeyStatus } from "../src/core/index.ts";
import { installModalDom } from "./modal-dom.ts";

async function withDom(
	run: (
		controller: () => InteractionLayersController,
		render: (node: React.ReactNode) => Promise<void>,
	) => Promise<void>,
) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const values = {
		React,
		window: dom.window,
		document: dom.document,
		HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element,
		Event: dom.window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
		getSelection: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0 }),
	};
	const saved = new Map(Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
	Object.assign(globalThis, values);
	const restore = installModalDom(dom);
	Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
	const { createRoot } = await import("react-dom/client");
	let controller!: InteractionLayersController;
	function Probe({ children }: { children: React.ReactNode }) {
		controller = useInteractionLayers();
		return children;
	}
	const root = createRoot(document.querySelector("#root")!);
	try {
		await run(
			() => controller,
			async (node) => {
				await act(async () => {
					root.render(
						<InteractionLayersProvider>
							<Probe>{node}</Probe>
						</InteractionLayersProvider>,
					);
				});
			},
		);
	} finally {
		await act(async () => {
			root.unmount();
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		restore();
		for (const [k, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, k, descriptor);
			else Reflect.deleteProperty(globalThis, k);
		}
	}
}

const byTest = (id: string) => {
	const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	assert(el, `expected element [data-testid="${id}"]`);
	return el;
};

async function clickEl(el: HTMLElement) {
	await act(async () => {
		el.click();
	});
}

async function click(selector: string) {
	const el = document.querySelector<HTMLElement>(selector);
	assert(el, `expected element matching ${selector}`);
	await clickEl(el);
}

async function type(id: string, value: string) {
	await act(async () => {
		const input = byTest(id) as HTMLInputElement;
		input.focus();
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

async function key(controller: InteractionLayersController, target: Element, value: string) {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: value });
	await act(async () => {
		// linkedom does not implement the browser's window capture route.
		controller.captureKeyDown(event as KeyboardEvent);
		target.dispatchEvent(event);
	});
	return event;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function authInfo(id: string) {
	const info = AUTH_KEYS.find((k) => k.id === id) ?? null;
	assert(info, `missing AUTH_KEYS entry for ${id}`);
	return info;
}

function createFakeKeysHarness() {
	const originalFetch = globalThis.fetch;
	const writes: { method: string; path: string; body: unknown }[] = [];
	const state: {
		keys: AuthKeyStatus[];
		pendingPut: ReturnType<typeof deferred<Response>> | null;
	} = {
		keys: [
			{
				id: "ANTHROPIC_API_KEY",
				info: null,
				present: true,
				masked: "…abcd (40 chars)",
				source: "file",
				shadowedByEnv: false,
			},
			{
				id: "OPENAI_API_KEY",
				info: null,
				present: true,
				masked: "…env1 (48 chars)",
				source: "env",
				shadowedByEnv: false,
			},
			{
				id: "DEEPGRAM_API_KEY",
				info: authInfo("DEEPGRAM_API_KEY"),
				present: true,
				masked: "…1234 (32 chars)",
				source: "file",
				shadowedByEnv: false,
			},
			{
				id: "TAVILY_API_KEY",
				info: authInfo("TAVILY_API_KEY"),
				present: false,
				masked: null,
				source: "none",
				shadowedByEnv: false,
			},
			{
				id: "BRAVE_API_KEY",
				info: authInfo("BRAVE_API_KEY"),
				present: true,
				masked: "…9999 (28 chars)",
				source: "env",
				shadowedByEnv: false,
			},
		],
		pendingPut: null,
	};

	const providers = [
		{ id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
		{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
		{ id: "alpha", envVar: "ALPHA_API_KEY", label: "Alpha" },
	];

	globalThis.fetch = async (input, init) => {
		const path = String(input);
		const method = init?.method ?? "GET";
		if (path.startsWith("/api/custom-provider")) {
			return Response.json(
				{ baseUrl: "", authMode: "keyless", keySource: "none", keyPresent: false, models: [], overrides: {}, manualModels: [] },
				{ headers: { etag: '"fixture"' } },
			);
		}
		if (path.startsWith("/api/keys/")) {
			const id = path.slice("/api/keys/".length);
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			writes.push({ method, path, body });
			if (method === "PUT") {
				if (state.pendingPut) {
					const pending = state.pendingPut;
					state.pendingPut = null;
					const res = await pending.promise;
					if (!res.ok) return res;
				}
				const value = String((body as { value?: string })?.value ?? "").trim();
				const masked = `…${value.slice(-4)} (${value.length} chars)`;
				state.keys = state.keys.map((entry) =>
					entry.id === id ? { ...entry, present: true, masked, source: "file" } : entry,
				);
				return Response.json({ ok: true });
			}
			if (method === "DELETE") {
				state.keys = state.keys.map((entry) =>
					entry.id === id ? { ...entry, present: false, masked: null, source: "none" } : entry,
				);
				return Response.json({ ok: true });
			}
		}
		return Response.json({ keys: state.keys, providers });
	};

	return {
		state,
		writes,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

function SettingsDialogHost({ initialRow }: { initialRow?: string }) {
	const [open, setOpen] = useState(true);
	return (
		<HostDialog open={open} onClose={() => { setOpen(false); return "closed"; }} aria-label="Settings">
			<KeysSection initialRow={initialRow} />
		</HostDialog>
	);
}

test("writable rows show status, Get key link, and Add key/Edit button without nested links in buttons; env rows are status-only", async () =>
	withDom(async (_controller, render) => {
		const mock = createFakeKeysHarness();
		try {
			await render(<SettingsDialogHost />);

			assert.equal(document.querySelectorAll("button a").length, 0, "no <a> nested inside <button>");
			assert.equal(document.querySelectorAll("a button").length, 0, "no <button> nested inside <a>");

			// Unset curated tool row (Tavily)
			const tavilyRow = byTest("key-tavily_api_key-row");
			assert.notEqual(tavilyRow.tagName, "BUTTON", "collapsed row container is not a clickable button");
			const tavilyControls = byTest("key-tavily_api_key-status").parentElement!;
			assert.deepEqual(
				Array.from(tavilyControls.children).map((el) => el.getAttribute("data-testid")),
				["key-tavily_api_key-status", "key-tavily_api_key-get-key", "key-tavily_api_key-action"],
				"row order is status, Get key, action",
			);
			assert.equal(byTest("key-tavily_api_key-status").textContent, "not set");
			const tavilyLink = byTest("key-tavily_api_key-get-key") as HTMLAnchorElement;
			assert.equal(tavilyLink.tagName, "A");
			assert.equal(tavilyLink.getAttribute("href"), "https://app.tavily.com/");
			assert.equal(tavilyLink.getAttribute("target"), "_blank");
			assert.equal(tavilyLink.getAttribute("rel"), "noreferrer");
			assert.match(tavilyLink.textContent ?? "", /Get key/);

			const tavilyAction = byTest("key-tavily_api_key-action") as HTMLButtonElement;
			assert.equal(tavilyAction.tagName, "BUTTON");
			assert.equal(tavilyAction.textContent, "Add key");
			assert.equal(tavilyAction.getAttribute("aria-expanded"), "false");
			assert.equal(tavilyAction.getAttribute("data-slot"), "button");
			assert.equal(tavilyAction.getAttribute("data-variant"), "outline");
			assert.equal(tavilyAction.getAttribute("data-size"), "xs");

			// Button-only open: clicking row container, status, or Get key link must NOT open the inline editor.
			await clickEl(tavilyRow);
			await clickEl(byTest("key-tavily_api_key-status"));
			await clickEl(tavilyLink);
			assert.equal(document.querySelector('[data-testid="key-tavily_api_key-editor"]') === null, true);

			// Set file-sourced curated row (Deepgram)
			const deepgramControls = byTest("key-deepgram_api_key-status").parentElement!;
			assert.deepEqual(
				Array.from(deepgramControls.children).map((el) => el.getAttribute("data-testid")),
				["key-deepgram_api_key-status", "key-deepgram_api_key-get-key", "key-deepgram_api_key-action"],
			);
			assert.equal(byTest("key-deepgram_api_key-status").textContent, "…1234 · 32");
			assert.equal(byTest("key-deepgram_api_key-action").textContent, "Edit");

			// Set file-sourced provider row without docsUrl (Anthropic)
			const anthropicRow = byTest("key-anthropic_api_key");
			const anthropicControls = byTest("key-anthropic_api_key-status").parentElement!;
			assert.deepEqual(
				Array.from(anthropicControls.children).map((el) => el.getAttribute("data-testid")),
				["key-anthropic_api_key-status", "key-anthropic_api_key-action"],
			);
			assert.equal(anthropicRow.querySelector("a") === null, true);
			assert.equal(byTest("key-anthropic_api_key-status").textContent, "…abcd · 40");
			assert.equal(byTest("key-anthropic_api_key-action").textContent, "Edit");

			// Environment-owned rows (curated Brave with docsUrl + provider OpenAI): status only, dimmed, no edit or external link
			for (const [id, expectedStatus] of [
				["brave_api_key", "…9999 · 28 · env"],
				["openai_api_key", "…env1 · 48 · env"],
			] as const) {
				const wrapper = byTest(`key-${id}`);
				assert.match(wrapper.className, /opacity-40/);
				assert.equal(byTest(`key-${id}-status`).textContent, expectedStatus);
				assert.equal(wrapper.querySelectorAll("button, a").length, 0, `${id} must have no button or external link`);
				await clickEl(byTest(`key-${id}-row`));
				assert.equal(document.querySelector(`[data-testid="key-${id}-editor"]`) === null, true);
			}
		} finally {
			mock.restore();
		}
	}));

test("keyboard access, draft preservation, fake-key save, and focus restoration without focus theft", async () =>
	withDom(async (controller, render) => {
		const mock = createFakeKeysHarness();
		try {
			await render(<SettingsDialogHost />);

			// Keyboard activation on Add key button opens editor and focuses input
			const tavilyAction = byTest("key-tavily_api_key-action") as HTMLButtonElement;
			tavilyAction.focus();
			let enterPrevented = false;
			await act(async () => {
				const enterEvent = new window.Event("keydown", { bubbles: true, cancelable: true });
				Object.assign(enterEvent, { key: "Enter" });
				tavilyAction.dispatchEvent(enterEvent);
				enterPrevented = enterEvent.defaultPrevented;
				if (!enterPrevented) tavilyAction.click();
			});
			assert.equal(enterPrevented, false, "Enter on action button retains native button activation");
			const tavilyInput = byTest("key-tavily_api_key-input") as HTMLInputElement;
			assert.equal(document.activeElement === tavilyInput, true, "opening editor focuses key input");

			// Cancel preserves draft and restores focus to Add key button
			await type("key-tavily_api_key-input", "tvly-fake-draft-0000000000");
			await click('[data-testid="key-tavily_api_key-cancel"]');
			assert.equal(document.querySelector('[data-testid="key-tavily_api_key-editor"]') === null, true);
			assert.equal(document.activeElement === byTest("key-tavily_api_key-action"), true, "Cancel restores focus to action");
			assert.equal(byTest("key-tavily_api_key-action").textContent, "Add key");

			// Reopening keeps draft; Escape folds editor, keeps dialog open, restores focus to Add key button
			await click('[data-testid="key-tavily_api_key-action"]');
			assert.equal((byTest("key-tavily_api_key-input") as HTMLInputElement).value, "tvly-fake-draft-0000000000");
			await key(controller(), byTest("key-tavily_api_key-input"), "Escape");
			assert.equal(document.querySelector('[data-testid="key-tavily_api_key-editor"]') === null, true);
			assert.ok(document.querySelector('[role="dialog"]'));
			assert.equal(document.activeElement === byTest("key-tavily_api_key-action"), true, "Escape restores focus to action");

			// Reopen, enter fake key, press Enter to save -> status updates, button becomes Edit, focus returns to action
			await click('[data-testid="key-tavily_api_key-action"]');
			await type("key-tavily_api_key-input", "tvly-fake-saved-key-00000000");
			await key(controller(), byTest("key-tavily_api_key-input"), "Enter");
			assert.deepEqual(mock.writes, [
				{ method: "PUT", path: "/api/keys/TAVILY_API_KEY", body: { value: "tvly-fake-saved-key-00000000" } },
			]);
			assert.equal(document.querySelector('[data-testid="key-tavily_api_key-editor"]') === null, true);
			assert.equal(byTest("key-tavily_api_key-status").textContent, "…0000 · 28");
			assert.equal(byTest("key-tavily_api_key-action").textContent, "Edit");
			assert.equal(document.activeElement === byTest("key-tavily_api_key-action"), true, "Save restores focus to action");

			// Escape while focus is on another control does NOT steal focus back to row action
			await click('[data-testid="key-deepgram_api_key-action"]');
			const addProvider = byTest("add-provider");
			await act(async () => {
				addProvider.focus();
			});
			await key(controller(), addProvider, "Escape");
			assert.equal(document.querySelector('[data-testid="key-deepgram_api_key-editor"]') === null, true);
			assert.ok(document.querySelector('[role="dialog"]'));
			assert.equal(document.activeElement === addProvider, true, "Escape must not steal focus from another focused control");

			// Switching directly between row editors in both DOM directions focuses the newly opened input
			await click('[data-testid="key-deepgram_api_key-action"]');
			await click('[data-testid="key-tavily_api_key-action"]');
			assert.equal(document.querySelector('[data-testid="key-deepgram_api_key-editor"]') === null, true);
			assert.equal(document.activeElement === byTest("key-tavily_api_key-input"), true, "opening row below steals no focus from closing row above");

			await click('[data-testid="key-anthropic_api_key-action"]');
			assert.equal(document.querySelector('[data-testid="key-tavily_api_key-editor"]') === null, true);
			assert.equal(document.activeElement === byTest("key-anthropic_api_key-input"), true, "opening row above steals no focus from closing row below");
			await click('[data-testid="key-anthropic_api_key-cancel"]');

			// Async Save completion does NOT steal focus if user focused another control while Save was in flight
			const pending = deferred<Response>();
			mock.state.pendingPut = pending;
			await click('[data-testid="key-tavily_api_key-action"]');
			await type("key-tavily_api_key-input", "tvly-fake-async-key-11111111");
			await click('[data-testid="key-tavily_api_key-save"]');
			await act(async () => {
				addProvider.focus();
			});
			await act(async () => {
				pending.resolve(Response.json({ ok: true }));
			});
			assert.equal(document.querySelector('[data-testid="key-tavily_api_key-editor"]') === null, true);
			assert.equal(byTest("key-tavily_api_key-status").textContent, "…1111 · 28");
			assert.equal(document.activeElement === addProvider, true, "async save finish must not steal focus from another control");
		} finally {
			mock.restore();
		}
	}));

test("deep link targeting an env-owned row avoids arming an invisible Escape layer, while writable deep link works", async () =>
	withDom(async (controller, render) => {
		const mock = createFakeKeysHarness();
		try {
			// Env-owned deep link on initial mount: no editor, one Escape closes dialog immediately
			await render(<SettingsDialogHost initialRow="BRAVE_API_KEY" />);
			assert.equal(document.querySelector('[data-testid="key-brave_api_key-editor"]') === null, true);
			await key(controller(), document.querySelector('[role="dialog"]')!, "Escape");
			assert.equal(document.querySelector('[role="dialog"]') === null, true, "first Escape closes dialog when deep link targets env row");

			// Writable deep link opens editor and arms editor Escape layer first
			await render(<SettingsDialogHost key="writable-deep-link" initialRow="TAVILY_API_KEY" />);
			const input = byTest("key-tavily_api_key-input");
			assert.equal(document.activeElement === input, true, "writable deep link focuses input");
			await key(controller(), input, "Escape");
			assert.equal(document.querySelector('[data-testid="key-tavily_api_key-editor"]') === null, true);
			assert.ok(document.querySelector('[role="dialog"]'));
			assert.equal(document.activeElement === byTest("key-tavily_api_key-action"), true, "Escape from writable deep link restores focus to action");
			await key(controller(), byTest("key-tavily_api_key-action"), "Escape");
			assert.equal(document.querySelector('[role="dialog"]') === null, true, "second Escape closes dialog");

			// While-open retarget to an env-owned row does not open editor or arm invisible Escape layer
			await render(<SettingsDialogHost key="retarget-host" initialRow={undefined} />);
			assert.ok(byTest("key-brave_api_key"));
			await render(<SettingsDialogHost key="retarget-host" initialRow="BRAVE_API_KEY" />);
			assert.equal(document.querySelector('[data-testid="key-brave_api_key-editor"]') === null, true);
			await key(controller(), document.querySelector('[role="dialog"]')!, "Escape");
			assert.equal(document.querySelector('[role="dialog"]') === null, true, "retargeted env deep link does not swallow first Escape");
		} finally {
			mock.restore();
		}
	}));
