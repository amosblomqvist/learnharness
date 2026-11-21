import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { SettingsDialogProvider, useSettingsDialog } from "../components/settings/settings-dialog.tsx";
import { promptSegmentName } from "../components/settings/prompt-segment-row.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import type { AgentSettings } from "../src/core/index.ts";
import { installModalDom } from "./modal-dom.ts";

it("derives prompt titles from segment paths without a mapping", () => {
	assert.equal(promptSegmentName("practice/10-doctrine.md"), "Doctrine");
	assert.equal(promptSegmentName("shared/20-question-tools.md"), "Question tools");
	assert.equal(promptSegmentName("system-prompt.md"), "System prompt");
});

it("edits one segment with recoverable Settings writes and refreshes without Promise.withResolvers", async (t) => {
	const nativeDeferred = Object.getOwnPropertyDescriptor(Promise, "withResolvers");
	Reflect.deleteProperty(Promise, "withResolvers");
	t.after(() => { if (nativeDeferred) Object.defineProperty(Promise, "withResolvers", nativeDeferred); });
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(dom.document, { oninput: null }); // Allow React's native input event path in LinkeDOM.
	const textarea = dom.window.HTMLTextAreaElement.prototype;
	Object.defineProperty(textarea, "defaultValue", { configurable: true, get() { return this.textContent; }, set(text) { this.textContent = text; } });
	const path = "practice/10-doctrine.md";
	const sourceText = "# Shipped default\n\nOriginal text.";
	const revisedText = "# My override\n\nEdited text.";
	let overrideText: string | null = null;
	let agent: AgentSettings = { tools: { demo: false } };
	let failWrite = true;
	let failActivation = true;
	let holdReads = false;
	let heldAgentAck: (() => void) | undefined;
	const writes: string[] = [];
	const agentWrites: AgentSettings[] = [];
	// Node's native Response.json() reader itself uses Promise.withResolvers.
	const replyJson = (data: unknown, status = 200) => {
		const body = JSON.stringify(data);
		return { status, ok: status >= 200 && status < 300, json: async () => JSON.parse(body) };
	};
	const deferredReads: { signal?: AbortSignal | null; resolve: (response: ReturnType<typeof replyJson>) => void }[] = [];
	const promptView = () => replyJson({ teacher: [], prober: [], practice: [
		{ path, sourceText, overrideText, enabled: !!agent.prompts?.[path] && overrideText !== null, shared: false },
	] });
	const globals = {
		React, window: dom.window, document: dom.document, Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return replyJson({ settings: { version: 1, agent } });
			if (url === "/api/settings/agent" && init?.method === "PUT") {
				const next: AgentSettings = JSON.parse(String(init.body));
				agentWrites.push(next);
				if (failActivation) return replyJson({ error: "fixture error" }, 503);
				agent = next;
				const reply = replyJson({ settings: { version: 1, agent } });
				if (heldAgentAck) await new Promise<void>(resolve => { heldAgentAck = resolve; });
				return reply;
			}
			if (url === "/api/settings/prompts") {
				if (holdReads) return new Promise<ReturnType<typeof replyJson>>(resolve => deferredReads.push({ signal: init?.signal, resolve }));
				return promptView();
			}
			if (url === `/api/settings/prompts/${path}` && init?.method === "PUT") {
				const { text } = JSON.parse(String(init.body));
				writes.push(text);
				if (failWrite) return replyJson({ error: "fixture error" }, 503);
				overrideText = text;
				return replyJson({ path, text });
			}
			if (url === `/api/settings/prompts/${path}` && init?.method === "DELETE") {
				overrideText = null;
				const switchCleared = agent.prompts?.[path] === true;
				const prompts = { ...agent.prompts };
				delete prompts[path];
				agent = { ...agent, prompts };
				return replyJson({ path, deleted: true, switchCleared });
			}
			if (url === "/api/keys") return replyJson({ keys: [] });
			if (url === "/api/models") return replyJson({ models: [], slots: {} });
			if (url === "/api/search") return replyJson({ available: false });
			throw new Error(`Unexpected fetch: ${url}`);
		},
	};
	const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModal = installModalDom(dom);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.querySelector("#root")!);
	const dialog = () => document.querySelector<HTMLElement>('[data-testid="prompt-segment-dialog"]');
	const row = () => document.querySelector<HTMLElement>(`[data-testid="prompt-segment-${path}"]`)!;
	const field = () => dialog()!.querySelector("textarea")!;
	const button = (scope: HTMLElement, text: string) => {
		const match = [...scope.querySelectorAll("button")].find(button => button.textContent === text);
		assert.ok(match, `missing button: ${text}`);
		return match;
	};
	const click = (scope: HTMLElement, text: string) => act(async () => {
		const control = button(scope, text);
		control.focus();
		control.click();
	});
	const edit = (value: string) => act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(field(), value);
		field().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	function Entry() {
		const settings = useSettingsDialog();
		return <button onClick={() => settings.open("agent")}>Open Settings</button>;
	}
	try {
		await act(async () => root.render(<InteractionLayersProvider><SettingsDialogProvider><Entry /></SettingsDialogProvider></InteractionLayersProvider>));
		await click(document.body, "Open Settings");
		assert.match(row().textContent ?? "", /^Doctrine.*In use: Default/);
		assert.equal(button(row(), "View default").dataset.variant, "ghost");
		assert.ok(row().querySelector<HTMLButtonElement>('[role="switch"]')?.disabled);
		await click(row(), "View default");
		assert.equal(field().value, sourceText);
		assert.ok(field().hasAttribute("readonly"));
		assert.equal(dialog()!.querySelector("h1")?.textContent, "Shipped default");
		assert.equal(button(dialog()!, "Preview").getAttribute("aria-checked"), "true");
		await click(dialog()!, "Markdown");
		assert.equal(button(dialog()!, "Markdown").getAttribute("aria-checked"), "true");
		assert.equal(field().getAttribute("wrap"), "soft");
		assert.equal(button(dialog()!, "Close").dataset.variant, "ghost");
		await click(dialog()!, "Close");
		await click(row(), "+ Add override");
		assert.equal(field().value, sourceText);
		assert.ok(button(dialog()!, "Save and activate").disabled);
		await edit(revisedText);
		await click(dialog()!, "Close");
		assert.match(dialog()!.textContent ?? "", /Discard unsaved changes\?/);
		await click(dialog()!, "Keep editing");
		assert.equal(field().value, revisedText);
		await click(dialog()!, "Close");
		await click(dialog()!, "Discard changes");
		assert.equal(dialog(), null);
		assert.deepEqual(writes, []);
		await click(row(), "+ Add override");
		assert.equal(field().value, sourceText);
		await edit(revisedText);
		await click(dialog()!, "Save and activate");
		assert.match(dialog()!.querySelector('[role="alert"]')!.textContent ?? "", /Couldn't save/);
		assert.equal(field().value, revisedText);
		assert.equal(overrideText, null);
		failWrite = false;
		await click(dialog()!, "Save and activate");
		assert.equal(overrideText, revisedText);
		assert.match(row().textContent ?? "", /In use: Default/);
		failActivation = false;
		holdReads = true;
		const staleReply = promptView();
		await click(dialog()!, "Retry activation");
		assert.deepEqual(writes, [revisedText, revisedText], "activation retry must not write prompt text again");
		assert.equal(dialog(), null, "a stalled list read must not block a known successful mutation");
		assert.equal(agent.prompts?.[path], true);
		assert.ok(deferredReads.length > 0);
		assert.ok(button(row(), "Edit override").disabled, "no editor may open from the stale list");
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
		assert.equal(document.activeElement, row(), "focus returns to the prompt row when its opener is disabled");
		holdReads = false;
		const group = document.querySelector<HTMLElement>('[data-testid="group-prompts"]')!;
		await click(group, "Retry");
		assert.match(row().textContent ?? "", /In use: Your version/);
		assert.ok(deferredReads.every(({ signal }) => signal?.aborted));
		await act(async () => { for (const { resolve } of deferredReads) resolve(staleReply); });
		assert.match(row().textContent ?? "", /In use: Your version/, "late aborted reads cannot overwrite a successful retry");
		const research = document.querySelector<HTMLButtonElement>('[data-testid="toggle-tool-research"]')!;
		heldAgentAck = () => assert.fail("fixture response must be held after the PUT commits");
		await act(async () => research.click());
		assert.equal(agent.tools?.research, false, "Research is durable before its ACK reaches Settings");
		assert.equal(research.getAttribute("aria-checked"), "true");
		await click(row(), "Edit override");
		assert.equal(field().value, revisedText);
		const count = agentWrites.length;
		failActivation = true; // The old redundant post-delete PUT would've failed here.
		await click(dialog()!, "Delete override");
		assert.match(dialog()!.querySelector('[role="alert"]')!.textContent ?? "", /Settings is still saving/);
		assert.equal(overrideText, revisedText, "a pending full-record ACK prevents dispatch");
		assert.equal(button(dialog()!, "Close").disabled, false);
		await click(dialog()!, "Close");
		await act(async () => { heldAgentAck?.(); heldAgentAck = undefined; });
		assert.equal(dialog(), null);
		assert.equal(overrideText, revisedText, "a declined delete must not run when the ACK arrives");
		await click(row(), "Edit override");
		await click(dialog()!, "Delete override");
		assert.equal(dialog(), null);
		assert.equal(agentWrites.length, count, "DELETE already cleared the switch; no mirror PUT");
		assert.equal(agent.prompts?.[path], undefined);
		assert.equal(research.getAttribute("aria-checked"), "false");
		failActivation = false;
		await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="toggle-tool-visual"]')!.click());
		assert.equal(agentWrites.at(-1)?.prompts?.[path], undefined, "later whole-section writes omit the deleted switch");
		assert.equal(agent.tools?.demo, false);
		await click(row(), "+ Add override");
		const replacement = "# Replacement after deletion";
		await edit(replacement);
		await click(dialog()!, "Save and activate");
		assert.equal(dialog(), null);
		assert.equal(overrideText, replacement);
		assert.equal(agent.prompts?.[path], true);
		assert.equal(agent.tools?.demo, false);
		assert.equal(agent.tools?.research, false);

		holdReads = true;
		const liveSwitch = row().querySelector<HTMLButtonElement>('[role="switch"]')!;
		await act(async () => liveSwitch.click());
		assert.equal(liveSwitch.getAttribute("aria-checked"), "false", "switch reflects the durable acknowledgement without waiting for the list");
		assert.equal(button(row(), "Edit override").disabled, false);
		assert.ok(!group.querySelector('[role="status"]'), "an acknowledged switch must not flash a loading state");
		await act(async () => deferredReads.at(-1)!.resolve(promptView()));
	} finally {
		await act(async () => root.unmount());
		await new Promise(resolve => setTimeout(resolve, 5));
		restoreModal();
		Reflect.deleteProperty(textarea, "defaultValue");
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
