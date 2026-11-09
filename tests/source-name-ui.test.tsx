import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableOverlay } from "../components/chain-table.tsx";
import { TagsLibrary } from "../components/tags-library.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { type SourceDirectory } from "../src/core/source-organization.ts";

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
		return Response.json({ organization: { version: 2, folders: [], placements: {} }, sources: [], notes: [] });
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

it("Tags lists active material through tags or Untagged, without retained-source rows or session moves", async () => {
	const dom = parseHTML("<html><body><div id='app'></div></body></html>");
	Object.assign(globalThis, { React, window: dom.window, self: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
	const directory: SourceDirectory = {
		organization: { version: 2, folders: [{ id: "school", name: "School", parentId: null, createdAt: "now" }],
			tags: [{ id: "course", name: "Course", parentId: "school" }], placements: { lesson: { tagIds: ["course"] }, retained: { tagIds: ["course"] } } },
		sources: [
			{ id: "lesson", kind: "chat", label: "Tagged lesson", createdAt: "now" },
			{ id: "retained", kind: "missing", label: "Deleted lesson", createdAt: null },
			{ id: "book", kind: "notes", label: "Untagged book", createdAt: "now" },
		],
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ ...directory, notes: [] });
	const root = createRoot(document.getElementById("app")!);
	const click = async (name: string) => {
		const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === name);
		assert.ok(button, name); await act(async () => button.click());
	};
	try {
		await act(async () => root.render(<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}><TagsLibrary /></ServerEventsProvider>));
		assert.match(document.querySelector("main")!.textContent!, /Tagged lesson/);
		assert.doesNotMatch(document.querySelector("main")!.textContent!, /Deleted lesson|Saved graph material/);
		await click("Untagged");
		assert.match(document.querySelector("main")!.textContent!, /Untagged book/);
		assert.doesNotMatch(document.querySelector("main")!.textContent!, /Tagged lesson/);
		await click("School");
		assert.match(document.querySelector("main")!.textContent!, /Tagged lesson/);
		assert.doesNotMatch(document.querySelector("main")!.textContent!, /Untagged book/);
		await click("Course");
		const checkbox = document.querySelector<HTMLInputElement>('input[aria-label="Select Tagged lesson"]')!;
		checkbox.checked = true;
		await act(async () => checkbox.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.match(document.querySelector("main")!.textContent!, /Edit tags/);
		assert.ok(![...document.querySelectorAll("button")].some(b => b.textContent === "Move"));
	} finally { await act(async () => root.unmount()); globalThis.fetch = originalFetch; }
});
