import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableOverlay } from "../components/chain-table.tsx";
import { TagsLibrary } from "../components/tags-library.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { applyOrganizationAction, type OrganizationAction, type SourceDirectory } from "../src/core/source-organization.ts";

it("sends organization edits to Tags and lets a folder dialog be cancelled without writing", async () => {
	const dom = parseHTML("<html><body><div id='app'></div></body></html>");
	Object.assign(globalThis, {
		React,
		window: dom.window,
		self: dom.window,
		document: dom.document,
		Element: dom.window.Element,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	// linkedom omits the native dialog API. Browsers send cancel for Escape.
	const proto = Object.getPrototypeOf(document.createElement("dialog"));
	proto.showModal = function () {
		this.setAttribute("open", "");
	};
	proto.close = function () {
		this.removeAttribute("open");
	};
	const originalFetch = globalThis.fetch;
	let writes = 0;
	globalThis.fetch = async (_url, init) => {
		if (init?.method === "POST") writes++;
		return Response.json({ organization: { version: 1, folders: [], placements: {} }, sources: [], notes: [] });
	};
	const root = createRoot(document.getElementById("app")!);
	const render = (child: React.ReactNode) =>
		act(async () => {
			root.render(
				<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
					{child}
				</ServerEventsProvider>,
			);
		});
	try {
		await render(<ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => {}} />);
		assert.equal(document.querySelector('a[href="/tags"]')?.textContent, "Organize in Tags");
		assert.equal(document.querySelector('[data-testid="add-source-folder"]'), null);
		await render(<TagsLibrary />);
		const newFolder = document.querySelector<HTMLButtonElement>('button[aria-label="New folder"]');
		assert.ok(newFolder);
		await act(async () => {
			newFolder.click();
		});
		const dialog = document.querySelector("dialog[open]");
		assert.ok(dialog);
		await act(async () => {
			dialog.dispatchEvent(new dom.window.Event("cancel", { bubbles: false, cancelable: true }));
		});
		assert.equal(document.querySelector("dialog"), null);
		assert.equal(writes, 0);
	} finally {
		await act(async () => {
			root.unmount();
		});
		globalThis.fetch = originalFetch;
	}
});

it("lets retained graph material be selected and moved without offering unavailable session actions", async () => {
	const dom = parseHTML("<html><body><div id='app'></div></body></html>");
	Object.assign(globalThis, {
		React, window: dom.window, self: dom.window, document: dom.document,
		Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
	});
	const dialogPrototype = Object.getPrototypeOf(document.createElement("dialog"));
	dialogPrototype.showModal = function () { this.setAttribute("open", ""); };
	dialogPrototype.close = function () { this.removeAttribute("open"); };
	const nativeClick = dom.window.HTMLInputElement.prototype.click;
	dom.window.HTMLInputElement.prototype.click = function () {
		if (this.type === "checkbox") this.checked = !this.checked;
		nativeClick.call(this);
	};
	let directory: SourceDirectory = {
		organization: {
			version: 1, folders: [{ id: "course", name: "Course folder", parentId: null, createdAt: "now" }],
			placements: { retained: { folderId: "course" } },
		},
		sources: [
			{ id: "retained", kind: "missing", label: null, createdAt: null },
			{ id: "book", kind: "notes", label: "Course book", createdAt: "now" },
		],
	};
	const originalFetch = globalThis.fetch;
	const writes: OrganizationAction[] = [];
	globalThis.fetch = async (_url, init) => {
		if (init?.method === "POST") {
			const action: OrganizationAction = JSON.parse(init.body as string);
			assert.notEqual(action.action, "rename-source");
			if (action.action === "rename-source") throw new Error("Unexpected rename");
			writes.push(action);
			directory = { ...directory, organization: applyOrganizationAction(directory.organization, action, new Set(directory.sources.map(source => source.id)), { id: "unused", createdAt: "now" }) };
		}
		return Response.json({ ...directory, notes: [] });
	};
	const root = createRoot(document.getElementById("app")!);
	const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === name);
	const click = async (name: string) => {
		const element = button(name);
		assert.ok(element, `Missing button: ${name}`);
		await act(async () => element.click());
	};
	const select = async (name: string) => {
		const element = document.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`);
		assert.ok(element, `Missing item: ${name}`);
		await act(async () => element.click());
	};
	try {
		await act(async () => root.render(
			<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
				<TagsLibrary />
			</ServerEventsProvider>,
		));
		assert.match(document.querySelector("main")!.textContent!, /Saved graph material/);
		assert.match(document.querySelector("main")!.textContent!, /Original source unavailable/);
		assert.equal(document.querySelector('a[href="/chat/retained"]'), null);
		await select("Course book");
		assert.ok(button("Edit tags"));
		assert.ok(button("Rename"));
		await select("Saved graph material (retained)");
		assert.equal(button("Edit tags"), undefined, "mixed selection cannot send unsupported tag changes");
		await click("Course folder");
		await select("Saved graph material (retained)");
		assert.ok(button("Move"));
		assert.equal(button("Rename"), undefined);
		assert.equal(button("Edit tags"), undefined);
		await click("All material");
		await select("Saved graph material (retained)");
		await click("Move");
		const folder = document.querySelector<HTMLSelectElement>("dialog select");
		assert.ok(folder);
		Object.defineProperty(folder, "value", { value: "", configurable: true });
		await act(async () => folder.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
		const form = document.querySelector("dialog form");
		assert.ok(form);
		await act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
		assert.deepEqual(writes, [{ action: "move", kind: "source", id: "retained", parentId: null }]);
		assert.ok(button("Move"), "refresh keeps a retained source selected like other existing sources");
		await click("Course folder");
		assert.match(document.querySelector("main")!.textContent!, /No material here yet/);
		await click("Remove");
		const removeForm = document.querySelector("dialog form");
		assert.ok(removeForm);
		await act(async () => removeForm.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
		assert.deepEqual(writes[1], { action: "delete-folder", id: "course" });
		assert.equal(button("Course folder"), undefined);
		assert.match(document.querySelector("main")!.textContent!, /Saved graph material/);
	} finally {
		await act(async () => root.unmount());
		globalThis.fetch = originalFetch;
		dom.window.HTMLInputElement.prototype.click = nativeClick;
	}
});
