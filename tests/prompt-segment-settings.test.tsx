import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { AgentSettings } from "../src/core/index.ts";
import { installModalDom } from "./modal-dom.ts";

it("edits one existing segment with explicit save, discard confirmation, and activation-only retry", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(dom.document, { oninput: null }); // Allow React's native input event path in LinkeDOM.
	const textarea = dom.window.HTMLTextAreaElement.prototype;
	Object.defineProperty(textarea, "defaultValue", { configurable: true, get() { return this.textContent; }, set(text) { this.textContent = text; } });
	const path = "practice/10-doctrine.md";
	const sourceText = "# Shipped default\n\nOriginal text.";
	const revisedText = "# My override\n\nEdited text.";
	let overrideText: string | null = null;
	let agent: AgentSettings = {};
	let failWrite = true;
	let failActivation = true;
	const writes: string[] = [];
	const globals = {
		React, window: dom.window, document: dom.document, Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings/prompts") return Response.json({ teacher: [], prober: [], practice: [
				{ path, sourceText, overrideText, enabled: !!agent.prompts?.[path] && overrideText !== null, shared: false },
			] });
			if (url === `/api/settings/prompts/${path}` && init?.method === "PUT") {
				const { text } = JSON.parse(String(init.body));
				writes.push(text);
				if (failWrite) return Response.json({ error: "fixture error" }, { status: 503 });
				overrideText = text;
				return Response.json({ path, text });
			}
			if (url === "/api/keys") return Response.json({ keys: [] });
			if (url === "/api/models") return Response.json({ models: [], slots: {} });
			if (url === "/api/search") return Response.json({ available: false });
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
	function Harness() {
		const [record, setRecord] = useState(agent);
		return <InteractionLayersProvider><AgentSection agent={record} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={(next) => {
				if (failActivation) return false;
				agent = next;
				setRecord(next);
				notifySettingsSaved("agent");
				return true;
			}} onModelsChange={() => {}} onCompactionChange={() => true} />
		</InteractionLayersProvider>;
	}
	try {
		await act(async () => root.render(<Harness />));
		assert.match(row().textContent ?? "", /In use: Default/);
		assert.ok(row().querySelector<HTMLButtonElement>('[role="switch"]')?.disabled);
		await click(row(), "View default");
		assert.equal(field().value, sourceText);
		assert.ok(field().hasAttribute("readonly"));
		assert.equal(dialog()!.querySelector("h1")?.textContent, "Shipped default");
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
		await click(dialog()!, "Retry activation");
		assert.deepEqual(writes, [revisedText, revisedText], "activation retry must not write prompt text again");
		assert.equal(dialog(), null);
		assert.match(row().textContent ?? "", /In use: Your version/);
		await click(row(), "Edit override");
		assert.equal(field().value, revisedText);
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
