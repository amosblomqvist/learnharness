/**
 * useSidebarDrag owns the gesture — a dragstart bubbled from the
 * list's own SourceDragRow payload arms it (a teaching chat), folder
 * headers and the Outside folders zone are the only targets, and a
 * drop rides the same moveChat as the menu path. Foreign payloads,
 * practice chats, the current folder and mismatched ids never become
 * a move.
 * Same linkedom harness as source-tree-drag.test.tsx.
 */
import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SourceDragRow, SOURCE_DRAG_TYPE } from "../components/source-folder-tree.tsx";
import { buildSidebarFolderView, SidebarFolderTree } from "../components/sidebar-folder-tree.tsx";
import { useSidebarDrag } from "../components/sidebar-folder-actions.tsx";
import type { ChatListItem } from "../src/core/index.ts";
import { chat, STAMP, type TestOrg } from "./helpers/sidebar-fixtures.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
	getComputedStyle: () => ({ fontFamily: "monospace" }),
	requestAnimationFrame: (cb: FrameRequestCallback) => { queueMicrotask(() => cb(0)); return 1; },
});

type MoveChat = (chatId: string, parentId: string | null) => Promise<string | null>;

/* Fixture per the contract: Algebra (root) → Maps; teaching t1 inside
   Algebra, teaching t2 and practice p1 at the root. */
const ORG: TestOrg = {
	folders: [
		{ id: "alg", name: "Algebra", parentId: null, createdAt: STAMP },
		{ id: "maps", name: "Maps", parentId: "alg", createdAt: STAMP },
	],
	placements: { t1: { folderId: "alg" } },
};
const CHATS: ChatListItem[] = [
	chat("t1", { title: "Linear maps" }),
	chat("t2", { title: "Loose teach" }),
	chat("p1", { title: "Practice", kind: "practice" }),
];

/* Mirrors SessionsSidebar's wiring: the drag hook on the list container,
   SourceDragRow around teaching chat rows only, the Outside folders zone
   while a drag is armed, drop props into the tree, error above the list. */
function Harness({ moveChat }: { moveChat: MoveChat }) {
	const [expanded, setExpanded] = useState(() => new Set(["alg"]));
	const drag = useSidebarDrag({ organization: ORG, chats: CHATS, moveChat });
	const view = buildSidebarFolderView(CHATS, ORG, "", expanded, new Set());
	return (
		<div>
			{drag.error !== null && (
				<div role="alert" data-testid="sidebar-folder-error">{drag.error}</div>
			)}
			<div data-testid="sidebar-list" {...drag.containerProps}>
				{drag.dragChatId !== null && (
					<div
						data-testid="sidebar-root-drop"
						data-drop-active={String(drag.dropTarget === null)}
						{...drag.targetProps(null)}
					>
						Outside folders
					</div>
				)}
				<SidebarFolderTree
					view={view}
					onToggleFolder={(id) =>
						setExpanded((prev) => {
							const next = new Set(prev);
							if (next.has(id)) next.delete(id);
							else next.add(id);
							return next;
						})
					}
					drop={{ activeTarget: drag.dropTarget, targetProps: drag.targetProps }}
					renderChat={(c) => {
						const row = <button type="button" data-testid={`chat-row-${c.id}`}>{c.title}</button>;
						if ((c.kind ?? "teach") === "practice") return row;
						return (
							<SourceDragRow key={c.id} kind="source" id={c.id} name={c.title} enabled>
								{row}
							</SourceDragRow>
						);
					}}
				/>
			</div>
		</div>
	);
}

let root: Root | undefined, host: HTMLDivElement | undefined;
let moves: Array<{ chatId: string; parentId: string | null }>;

async function mount(moveChat?: MoveChat) {
	moves = [];
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const handler =
		moveChat ??
		(async (chatId: string, parentId: string | null) => {
			moves.push({ chatId, parentId });
			return null;
		});
	await act(async () => {
		root!.render(<Harness moveChat={handler} />);
	});
}
afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = undefined;
	host?.remove();
});

function transfer() {
	const data = new Map<string, string>();
	return {
		types: [] as string[],
		effectAllowed: "",
		dropEffect: "",
		preview: undefined as HTMLElement | undefined,
		setData(type: string, value: string) {
			data.set(type, value);
			this.types.push(type);
		},
		getData(type: string) {
			return data.get(type) ?? "";
		},
		setDragImage(element: HTMLElement) {
			this.preview = element;
		},
	};
}
function dispatchDrag(el: Element, type: string, data: ReturnType<typeof transfer>) {
	const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", { value: data });
	Object.defineProperty(event, "clientX", { value: 100 });
	Object.defineProperty(event, "clientY", { value: 100 });
	el.dispatchEvent(event);
	return event;
}
async function fire(selector: string, type: string, data: ReturnType<typeof transfer>) {
	const target = document.querySelector(selector);
	assert.ok(target, selector);
	let event!: ReturnType<typeof dispatchDrag>;
	await act(async () => {
		event = dispatchDrag(target, type, data);
		// The drag arms on the next task (see the dragstart DOM test below).
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return event;
}

it("dragstart leaves the list DOM unchanged until the next task, so the browser keeps the native drag", async () => {
	await mount();
	const data = transfer();
	const before = document.querySelector('[data-testid="sidebar-list"]')!.innerHTML;
	const row = document.querySelector('[data-source-drag-row="t2"]')!;

	act(() => {
		dispatchDrag(row, "dragstart", data);
	});
	assert.equal(
		document.querySelector('[data-testid="sidebar-list"]')!.innerHTML,
		before,
		"Chrome cancels a drag whose source moves during dragstart: the Outside folders zone must not render synchronously",
	);

	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	assert.ok(document.querySelector('[data-testid="sidebar-root-drop"]'), "the zone appears once the drag is armed");
});

it("a dragend before the drag is armed leaves no zone behind", async () => {
	await mount();
	const data = transfer();
	const row = document.querySelector('[data-source-drag-row="t2"]')!;

	act(() => {
		dispatchDrag(row, "dragstart", data);
		dispatchDrag(row, "dragend", data);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	assert.equal(document.querySelector('[data-testid="sidebar-root-drop"]'), null);
});

it("dragging a teaching chat onto a folder header moves it there once", async () => {
	await mount();
	const data = transfer();
	await fire('[data-source-drag-row="t1"]', "dragstart", data);
	await fire('[data-sidebar-folder="maps"]', "drop", data);
	assert.deepEqual(moves, [{ chatId: "t1", parentId: "maps" }]);
});

it("the Outside folders zone exists only mid-drag and drops the chat at the root", async () => {
	await mount();
	assert.equal(document.querySelector('[data-testid="sidebar-root-drop"]'), null, "no zone before a drag");

	const data = transfer();
	await fire('[data-source-drag-row="t1"]', "dragstart", data);
	const zone = document.querySelector('[data-testid="sidebar-root-drop"]');
	assert.ok(zone, "the zone appears once the sidebar drag starts");
	assert.equal(zone.textContent, "Outside folders");

	await fire('[data-testid="sidebar-root-drop"]', "drop", data);
	assert.deepEqual(moves, [{ chatId: "t1", parentId: null }]);
	assert.equal(document.querySelector('[data-testid="sidebar-root-drop"]'), null, "the drop ends the gesture");

	const second = transfer();
	await fire('[data-source-drag-row="t1"]', "dragstart", second);
	assert.ok(document.querySelector('[data-testid="sidebar-root-drop"]'));
	await fire('[data-source-drag-row="t1"]', "dragend", second);
	assert.equal(document.querySelector('[data-testid="sidebar-root-drop"]'), null, "dragend clears the gesture");
	assert.deepEqual(moves, [{ chatId: "t1", parentId: null }], "no second move");
});

it("the chat's current folder is not a target: no preventDefault, dropEffect none, no highlight, no move", async () => {
	await mount();
	const data = transfer();
	await fire('[data-source-drag-row="t1"]', "dragstart", data);
	const over = await fire('[data-sidebar-folder="alg"]', "dragover", data);
	assert.equal(over.defaultPrevented, false, "not a drop target");
	assert.equal(data.dropEffect, "none");
	assert.equal(document.querySelector('[data-drop-active="true"]'), null);
	await fire('[data-sidebar-folder="alg"]', "drop", data);
	assert.deepEqual(moves, []);
});

it("a valid folder highlights only itself during dragover and dragend clears it", async () => {
	await mount();
	const data = transfer();
	await fire('[data-source-drag-row="t1"]', "dragstart", data);
	await fire('[data-sidebar-folder="maps"]', "dragover", data);
	assert.equal(data.dropEffect, "move");
	assert.equal(document.querySelector('[data-sidebar-folder="maps"]')?.getAttribute("data-drop-active"), "true");
	assert.equal(document.querySelector('[data-sidebar-folder="alg"]')?.getAttribute("data-drop-active"), "false");
	assert.equal((document.querySelectorAll('[data-drop-active="true"]').length), 1, "exactly one highlighted target");
	await fire('[data-source-drag-row="t1"]', "dragend", data);
	assert.equal(document.querySelector('[data-drop-active="true"]'), null);
});

it("a drop carrying a valid payload but no sidebar dragstart performs no move", async () => {
	await mount();
	const data = transfer();
	data.setData(SOURCE_DRAG_TYPE, JSON.stringify({ kind: "source", id: "t1" }));
	await fire('[data-sidebar-folder="maps"]', "dragover", data);
	assert.equal(document.querySelector('[data-drop-active="true"]'), null, "external drags never highlight");
	await fire('[data-sidebar-folder="maps"]', "drop", data);
	assert.deepEqual(moves, []);
	assert.equal(document.querySelector('[data-testid="sidebar-root-drop"]'), null);
});

it("a drop whose payload id differs from the dragged chat performs no move", async () => {
	await mount();
	const start = transfer();
	await fire('[data-source-drag-row="t1"]', "dragstart", start);
	const foreign = transfer();
	foreign.setData(SOURCE_DRAG_TYPE, JSON.stringify({ kind: "source", id: "t2" }));
	await fire('[data-sidebar-folder="maps"]', "drop", foreign);
	assert.deepEqual(moves, []);
});

it("a practice chat never arms the sidebar drag", async () => {
	await mount();
	const data = transfer();
	data.setData(SOURCE_DRAG_TYPE, JSON.stringify({ kind: "source", id: "p1" }));
	await fire('[data-testid="chat-row-p1"]', "dragstart", data);
	assert.equal(document.querySelector('[data-testid="sidebar-root-drop"]'), null, "no zone for a practice payload");
	await fire('[data-sidebar-folder="maps"]', "drop", data);
	assert.deepEqual(moves, []);
});

it("a moveChat error string renders in the panel's alert region", async () => {
	await mount(async (chatId, parentId) => {
		moves.push({ chatId, parentId });
		return "Could not save the folder change.";
	});
	const data = transfer();
	await fire('[data-source-drag-row="t1"]', "dragstart", data);
	await fire('[data-sidebar-folder="maps"]', "drop", data);
	await act(async () => {});
	const alert = document.querySelector('[data-testid="sidebar-folder-error"]');
	assert.ok(alert, "the error region renders");
	assert.equal(alert.getAttribute("role"), "alert");
	assert.match(alert.textContent ?? "", /Could not save the folder change\./);
});
