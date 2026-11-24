import React, { act, useLayoutEffect, useRef, type ReactNode } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { PluginTree, validatePluginTree } from "../components/plugin-tree.tsx";
import type { PluginTreeProps, PluginTreeRow } from "../src/core/plugin-tree.ts";
import type { PluginUiContent } from "../src/core/plugin-ui.ts";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";

(globalThis as Record<string, unknown>).React = React;
const noChange = () => {};
const props = (rows: readonly PluginTreeRow[], extra: Partial<PluginTreeProps> = {}): PluginTreeProps => ({ label: "Example tree", rows, ...extra });
function ssr(tree: PluginTreeProps) {
	return parseHTML(`<html><body>${renderToStaticMarkup(<PluginTree {...tree} signal={new AbortController().signal} renderContent={() => assert.fail("SSR fixture expects plain strings")} />)}</body></html>`).document;
}

// Renderer seam: this test host gives each delegated content mount its own
// lifetime, making descendant unmounts observable without the UI factory.
function TestContent({ content, signal }: { content: PluginUiContent; signal: AbortSignal }) {
	const root = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const controller = new AbortController();
		let cleanup: void | (() => void);
		let disposed = false;
		const dispose = () => {
			if (disposed) return;
			disposed = true; controller.abort(); cleanup?.(); root.current?.replaceChildren();
		};
		signal.addEventListener("abort", dispose, { once: true });
		if (signal.aborted) dispose();
		else if (typeof content === "function") {
			void Promise.resolve(content(root.current!, controller.signal)).then(value => { if (disposed) value?.(); else cleanup = value; });
		} else root.current!.append(content);
		return () => { signal.removeEventListener("abort", dispose); dispose(); };
	}, [content, signal]);
	return <div ref={root} />;
}
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });
async function fixture(initial: PluginTreeProps, options: { peers?: readonly PluginTreeProps[]; wrap?: (children: ReactNode) => ReactNode; renderContent?: (content: PluginUiContent, signal: AbortSignal) => ReactNode } = {}) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { get: () => active });
	dom.window.HTMLElement.prototype.focus = function () { active = this; this.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); };
	Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
	const globals = { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	const { createRoot } = await import("react-dom/client"); const root = createRoot(dom.document.getElementById("root")!);
	const lifetime = new AbortController(); const errors: unknown[] = [];
	let tree = initial;
	const render = async (next = tree) => {
		validatePluginTree(next); tree = next;
		const view = (tree: PluginTreeProps, key: string) => <PluginTree key={key} {...tree} signal={lifetime.signal} onError={error => errors.push(error)} renderContent={content => options.renderContent ? options.renderContent(content, lifetime.signal) : <TestContent content={content} signal={lifetime.signal} />} />;
		const children = <>{view(tree, "main")}{options.peers?.map((peer, index) => view(peer, `peer-${index}`))}</>;
		await act(async () => { root.render(options.wrap ? options.wrap(children) : children); });
	};
	cleanup = async () => {
		try { await act(async () => { lifetime.abort(); root.unmount(); }); }
		finally { for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		} }
	};
	await render();
	return { document: dom.document, render, errors, lifetime,
		key: async (target: Element, key: string, extra = {}) => {
			const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key, ...extra });
			await act(async () => { target.dispatchEvent(event); }); return event;
		},
		pointer: async (target: Element) => { await act(async () => { target.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true })); }); },
	};
}

function content(name: string, lifecycle: { mounted: string[]; cleaned: string[]; signals: Map<string, AbortSignal> }): PluginUiContent {
	return (container, signal) => {
		lifecycle.mounted.push(name); lifecycle.signals.set(name, signal);
		const node = container.ownerDocument.createElement("div"); node.dataset.content = name;
		const text = container.ownerDocument.createElement("pre"); text.textContent = "  multiline\n    value  ";
		const button = container.ownerDocument.createElement("button"); button.type = "button"; button.textContent = `Action ${name}`;
		const input = container.ownerDocument.createElement("input"); input.setAttribute("aria-label", `Input ${name}`); input.value = name;
		node.append(text, button, input); container.append(node);
		return () => { lifecycle.cleaned.push(name); node.remove(); };
	};
}
const lifecycle = () => ({ mounted: [] as string[], cleaned: [] as string[], signals: new Map<string, AbortSignal>() });

// Private widget validation accepts occurrence keys, not domain identities.
test("validation covers hidden duplicate row keys, duplicate columns and malformed widths without changing accepted keys", () => {
	const accepted = props([{ key: "", content: "empty key" }, { key: "  ", content: "space key", children: [{ key: "same item elsewhere", content: "Repeated entity" }] }], {
		columns: [{ key: "", header: "Zero width", width: 0 }, { key: "  ", header: "CSS width", width: "  calc(2rem + 1px)  " }],
	});
	const before = structuredClone(accepted); validatePluginTree(accepted); assert.deepEqual(accepted, before);
	assert.throws(() => validatePluginTree(props([{ key: "parent", content: "Parent", disclosure: { label: "Parent children", expanded: false, onChange: noChange }, children: [{ key: "duplicate", content: "Hidden" }] }, { key: "duplicate", content: "Visible" }])), /globally unique/);
	assert.throws(() => validatePluginTree(props([{ key: "", content: "First" }, { key: "", content: "Second" }])), /globally unique/);
	assert.throws(() => validatePluginTree(props([{ key: 1, content: "Not string" } as unknown as PluginTreeRow])), /unique strings/);
	assert.throws(() => validatePluginTree(props([], { columns: [{ key: "x", header: "One", width: 10 }, { key: "x", header: "Two", width: 20 }] })), /column keys/);
	for (const width of [-1, NaN, Infinity, "", " \t ", undefined, null]) assert.throws(() => validatePluginTree(props([], { columns: [{ key: "x", header: "Column", width: width as number }] })), /column width/);
});

test("flat text-only trees are safe named groups with no selection, disclosure or action scaffolding", () => {
	const document = ssr(props([{ key: "occurrence one", content: "<img src=x onerror=alert(1)>" }, { key: "occurrence two", content: "Repeated entity" }, { key: "occurrence three", content: "Repeated entity" }]));
	const group = document.querySelector('[role="group"]')!;
	assert.equal(group.getAttribute("aria-label"), "Example tree");
	assert.match(group.textContent ?? "", /<img src=x onerror=alert\(1\)>/);
	assert.equal(group.querySelector("img"), null);
	assert.equal(group.querySelector("input, button, [role='treegrid'], [role='tree'], [role='toolbar'], [data-plugin-tree-column]"), null);
	const rows = group.querySelectorAll("[data-plugin-tree-row]"); assert.equal(rows.length, 3);
	assert.equal(rows[0]!.children.length, 1, "flat primary content has no empty selection/disclosure columns");
	assert.equal(group.querySelectorAll(".border-b").length, 2, "native separators appear only between top-level occurrences");
	assert.equal(group.querySelector(".sticky"), null);
});

test("optional aligned columns reserve missing cells, preserve widths and default to left alignment", () => {
	const document = ssr(props([{ key: "a", content: "Primary", cells: { count: "42" } }, { key: "b", content: "Other", cells: { date: "Today" } }], {
		header: "Name", columns: [{ key: "count", header: "Count", width: 56, align: "right" }, { key: "date", header: "Created", width: "8rem" }],
	}));
	const header = document.querySelector<HTMLElement>('[data-plugin-tree-column="count"]')!;
	assert.equal(header.textContent, "Count"); assert.equal(header.style.width, "56px"); assert.ok(header.classList.contains("text-right"));
	const date = document.querySelector<HTMLElement>('[data-plugin-tree-column="date"]')!;
	assert.equal(date.style.width, "8rem"); assert.ok(date.classList.contains("text-left"));
	for (const row of document.querySelectorAll("[data-plugin-tree-row]")) {
		assert.ok(row.firstElementChild?.classList.contains("flex-1"), "primary consumes the remaining row width");
		assert.equal(row.querySelectorAll("[data-plugin-tree-cell]").length, 2);
		assert.equal(row.querySelector('[data-plugin-tree-cell="count"]')?.getAttribute("style"), header.getAttribute("style"));
		assert.equal(row.querySelector('[data-plugin-tree-cell="date"]')?.getAttribute("style"), date.getAttribute("style"));
	}
	assert.equal(document.querySelector('[data-plugin-tree-row="a"] [data-plugin-tree-cell="date"]')?.textContent, "");
	assert.equal(document.querySelector('[data-plugin-tree-row="b"] [data-plugin-tree-cell="count"]')?.textContent, "");
	assert.equal(document.querySelectorAll("button").length, 0, "headers do not invent sorting");
});

test("missing cells with Object prototype column names stay empty instead of mounting inherited functions", () => {
	const document = ssr(props([{ key: "row", content: "Primary", cells: {} }], {
		columns: [{ key: "constructor", header: "Constructor", width: 80 }, { key: "toString", header: "String", width: 80 }],
	}));
	const cells = document.querySelectorAll("[data-plugin-tree-cell]");
	assert.equal(cells.length, 2);
	for (const cell of cells) assert.equal(cell.textContent, "");
});

test("hierarchy without disclosure is visible and reserves native guides without a checkbox gutter", () => {
	const document = ssr(props([{ key: "root", content: "Root", children: [{ key: "child", content: "Child" }] }, { key: "peer", content: "Peer" }]));
	assert.equal(document.querySelectorAll("[data-plugin-tree-row]").length, 3);
	assert.equal(document.querySelectorAll("input, button").length, 0);
	assert.equal(document.querySelector('[data-plugin-tree-row="peer"]')?.children.length, 2, "hierarchy reserves disclosure alignment even on a leaf");
	const guide = document.querySelector('.w-px') as HTMLElement;
	assert.equal(guide.style.left, "19px");
	assert.equal(document.querySelectorAll(".border-b").length, 1, "nested rows have no separators");
});

test("selection anywhere, including a collapsed child, reserves a gutter everywhere without inventing checkboxes", () => {
	const document = ssr(props([{ key: "root", content: "Root", disclosure: { label: "Expand root", expanded: false, onChange: noChange }, children: [{ key: "hidden", content: "Hidden", selection: { label: "Select hidden", checked: false, onChange: noChange } }] }, { key: "peer", content: "Peer" }], { header: "Name" }));
	assert.equal(document.querySelectorAll("input").length, 0, "hidden child selection is not mounted");
	for (const row of document.querySelectorAll("[data-plugin-tree-row]")) {
		assert.equal(row.children.length, 3);
		assert.ok(row.firstElementChild?.classList.contains("size-3.5"));
	}
	assert.equal(document.querySelector('[data-plugin-tree-row="root"] button')?.getAttribute("aria-expanded"), "false");
});

test("selection and disclosure are controlled, independent callbacks with no cascade or row activation", async () => {
	const selected: boolean[] = []; const expanded: boolean[] = [];
	const row: PluginTreeRow = { key: "root", content: "Root", selection: { label: "Select root", checked: false, indeterminate: true, onChange: value => { selected.push(value); } }, disclosure: { label: "Expand root", expanded: false, onChange: value => { expanded.push(value); } }, children: [{ key: "child", content: "Child", selection: { label: "Select child", checked: false, onChange: () => assert.fail("selection must not cascade") } }] };
	const f = await fixture(props([row]));
	const disclosure = document.querySelector<HTMLButtonElement>('button[aria-label="Expand root"]')!;
	const checkbox = document.querySelector<HTMLInputElement>('input[aria-label="Select root"]')!;
	assert.equal(checkbox.indeterminate, true);
	await act(async () => { disclosure.click(); });
	assert.deepEqual(expanded, [true]); assert.deepEqual(selected, []);
	assert.equal(disclosure.getAttribute("aria-expanded"), "false"); assert.equal(document.querySelector('[data-plugin-tree-row="child"]'), null);
	await f.render(props([{ ...row, disclosure: { ...row.disclosure!, expanded: true } }]));
	assert.equal(document.querySelectorAll('[data-plugin-tree-row]').length, 2);
	assert.equal((document.querySelector('.w-px') as HTMLElement).style.left, "37px");
	await act(async () => {
		checkbox.checked = true;
		checkbox.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
	});
	assert.deepEqual(selected, [true]); assert.deepEqual(expanded, [true]);
	await act(async () => { (document.querySelector('[data-plugin-tree-row="root"]') as HTMLElement).click(); });
	assert.deepEqual(selected, [true]); assert.deepEqual(expanded, [true]);
});

test("disabled and aborted controls stay inert; callback throws and async rejections reach onError", async () => {
	const sync = new Error("sync selection"), async = new Error("async disclosure"); let disabledCalls = 0;
	const row: PluginTreeRow = { key: "root", content: "Root", selection: { label: "Disabled", checked: false, disabled: true, onChange: () => { disabledCalls++; } }, disclosure: { label: "Expand", expanded: false, onChange: async () => { throw async; } } };
	const f = await fixture(props([row]));
	await act(async () => { document.querySelector<HTMLInputElement>("input")!.click(); document.querySelector<HTMLButtonElement>("button")!.click(); });
	assert.equal(disabledCalls, 0); assert.deepEqual(f.errors, [async]);
	await f.render(props([{ ...row, selection: { label: "Enabled", checked: false, onChange: () => { throw sync; } } }]));
	await act(async () => { const input = document.querySelector<HTMLInputElement>("input")!; input.checked = true; input.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); });
	assert.deepEqual(f.errors, [async, sync]);
	await act(async () => { f.lifetime.abort(); document.querySelector<HTMLButtonElement>("button")!.click(); });
	assert.deepEqual(f.errors, [async, sync]);
});

test("arbitrary content in headers, primary cells and trailing cells keeps DOM identity through no-op updates and same-parent reorder", async () => {
	const life = lifecycle();
	const primaryA = content("primary-a", life), primaryB = content("primary-b", life), cellA = content("cell-a", life), cellB = content("cell-b", life), heading = content("heading", life), columnHeading = content("column-heading", life);
	const a: PluginTreeRow = { key: "a", content: primaryA, cells: { detail: cellA }, selection: { label: "Select a", checked: false, onChange: noChange } };
	const b: PluginTreeRow = { key: "b", content: primaryB, cells: { detail: cellB } };
	const tree = props([a, b], { header: heading, columns: [{ key: "detail", header: columnHeading, width: 120 }] });
	const f = await fixture(tree);
	const names = [...life.mounted]; const nodes = new Map(names.map(name => [name, document.querySelector(`[data-content="${name}"]`)]));
	assert.equal(names.length, 6); assert.equal(document.querySelector('[data-content="primary-a"] pre')?.textContent, "  multiline\n    value  ");
	const input = document.querySelector<HTMLInputElement>('[data-content="primary-a"] input')!; input.value = "uncontrolled edit";
	await f.render({ ...tree, rows: [{ ...a, selection: { ...a.selection!, checked: true } }, { ...b }], columns: tree.columns?.map(column => ({ ...column })) });
	await f.render({ ...tree, rows: [b, a] });
	assert.deepEqual(life.mounted, names); assert.deepEqual(life.cleaned, []);
	for (const [name, node] of nodes) assert.equal(document.querySelector(`[data-content="${name}"]`), node, name);
	assert.equal(input.value, "uncontrolled edit");
	assert.deepEqual(Array.from(document.querySelectorAll("[data-plugin-tree-row]"), row => row.getAttribute("data-plugin-tree-row")), ["b", "a"]);
	let clicks = 0; document.querySelector('[data-content="primary-a"] button')!.addEventListener("click", () => { clicks++; });
	await act(async () => { (document.querySelector('[data-content="primary-a"] button') as HTMLElement).click(); });
	assert.equal(clicks, 1); assert.equal(document.querySelector('[data-content="primary-a"] button')?.getAttribute("tabindex"), null, "the widget adds no plugin-control tabindex or global Tab policy");
});

test("collapse unmounts descendant content and aborts its lifetime; expanding mounts fresh content", async () => {
	const life = lifecycle(); const childContent = content("child", life), childCell = content("child-cell", life), rootContent = content("root", life);
	const row = (expanded: boolean): PluginTreeRow => ({ key: "root", content: rootContent, disclosure: { label: "Root children", expanded, onChange: noChange }, children: [{ key: "child", content: childContent, cells: { detail: childCell } }] });
	const f = await fixture(props([row(true)], { columns: [{ key: "detail", header: "Detail", width: 80 }] }));
	const oldSignal = life.signals.get("child")!; const rootNode = document.querySelector('[data-content="root"]');
	await f.render(props([row(false)], { columns: [{ key: "detail", header: "Detail", width: 80 }] }));
	assert.equal(document.querySelector('[data-content="child"]'), null); assert.equal(document.querySelector('[data-content="child-cell"]'), null);
	assert.equal(oldSignal.aborted, true); assert.deepEqual(life.cleaned.sort(), ["child", "child-cell"]);
	assert.equal(document.querySelector('[data-content="root"]'), rootNode); assert.equal(life.signals.get("root")?.aborted, false);
	await f.render(props([row(true)], { columns: [{ key: "detail", header: "Detail", width: 80 }] }));
	assert.notEqual(life.signals.get("child"), oldSignal); assert.equal(life.signals.get("child")?.aborted, false);
	assert.equal(life.mounted.filter(name => name === "child").length, 2);
	assert.equal(document.querySelectorAll('[data-content="child"]').length, 1);
});

test("HTMLElement content is delegated unchanged rather than cloned or interpreted", async () => {
	const life = lifecycle(); const f = await fixture(props([]));
	const node = document.createElement("input"); node.setAttribute("aria-label", "Plugin input"); node.value = "keep me";
	await f.render(props([{ key: "", content: node }]));
	assert.equal(document.querySelector('input[aria-label="Plugin input"]'), node);
	await f.render(props([{ key: "", content: node }]));
	assert.equal(document.querySelector('input[aria-label="Plugin input"]'), node); assert.equal(node.value, "keep me");
	assert.deepEqual(life.mounted, []);
});

const treeRow = (key: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>("[data-plugin-tree-row]")].find(row => row.dataset.pluginTreeRow === key)!;

test("default typography keeps primary labels on the native small ladder and width-bearing cells on identical metadata metrics", () => {
	const document = ssr(props([{ key: "root", content: "Native primary", cells: { em: "Metadata", ch: "Other" } }], {
		header: "Name", columns: [{ key: "em", header: "Em width", width: "10em" }, { key: "ch", header: "Character width", width: "10ch" }],
	}));
	assert.ok(document.querySelector("[data-plugin-tree]")?.classList.contains("font-ui"));
	assert.ok(document.querySelector("[data-plugin-tree]")?.classList.contains("font-normal"));
	const row = treeRow("root", document);
	assert.ok(row.classList.contains("[&>div]:text-sm")); assert.ok(row.classList.contains("[&>div]:font-medium"));
	assert.equal(row.classList.contains("font-medium"), false, "primary weight must not leak into metadata");
	for (const column of ["em", "ch"]) {
		const header = document.querySelector<HTMLElement>(`[data-plugin-tree-column="${column}"]`)!;
		const cell = document.querySelector<HTMLElement>(`[data-plugin-tree-cell="${column}"]`)!;
		for (const node of [header, cell]) {
			assert.ok(node.classList.contains("font-ui")); assert.ok(node.classList.contains("text-xs")); assert.ok(node.classList.contains("font-normal"));
			assert.equal(node.classList.contains("font-medium"), false);
		}
		assert.equal(header.style.width, cell.style.width, "em/ch widths have identical explicit font family and size at both boxes");
		for (const token of ["font-normal", "tabular-nums", "text-muted-foreground"]) assert.ok(cell.classList.contains(token), token);
	}
});

test("root-local arrows reuse sibling/parent/open-branch navigation without autofocus or global Tab claims", async () => {
	const toggles: boolean[] = [];
	const f = await fixture(props([{ key: "", content: "Root", disclosure: { label: "Root children", expanded: true, onChange: value => { toggles.push(value); } }, children: [{ key: "child-a", content: "Child a" }, { key: "child-b", content: "Child b" }] }, { key: "peer", content: "Peer" }]));
	assert.equal(document.activeElement, document.body, "mounting an arbitrary embedded tree never steals focus");
	const first = treeRow(""), childA = treeRow("child-a"), childB = treeRow("child-b"), peer = treeRow("peer");
	assert.equal(first.getAttribute("tabindex"), "-1"); assert.equal(childA.dataset.pluginTreeDepth, "1"); assert.equal(first.dataset.pluginTreeExpanded, "true");
	assert.equal((await f.key(document.body, "ArrowDown")).defaultPrevented, false, "there is no document/window tree listener");
	await f.pointer(first.querySelector("div")!);
	assert.equal(document.activeElement, first); assert.equal(first.dataset.pluginTreeActive, "true");
	assert.ok(first.classList.contains("data-[plugin-tree-active=true]:bg-accent/50"));
	assert.equal((await f.key(first, "ArrowDown")).defaultPrevented, true); assert.equal(document.activeElement, peer, "Down skips expanded descendants to visit siblings");
	await f.key(peer, "ArrowUp"); assert.equal(document.activeElement, first);
	await f.key(first, "ArrowRight"); assert.equal(document.activeElement, childA);
	await f.key(childA, "ArrowDown"); assert.equal(document.activeElement, childB);
	await f.key(childB, "ArrowUp"); assert.equal(document.activeElement, childA);
	await f.key(childA, "ArrowLeft"); assert.equal(document.activeElement, first); assert.deepEqual(toggles, [false], "Left reaches and requests collapse of the expanded parent");
	assert.equal((await f.key(first, "Tab")).defaultPrevented, false); assert.equal((await f.key(first, "Tab", { shiftKey: true })).defaultPrevented, false);
});

test("controlled Right-open waits through unrelated updates and focuses the first child only after expansion arrives", async () => {
	const changes: boolean[] = [];
	const row = (expanded: boolean): PluginTreeRow => ({ key: "parent", content: "Parent", disclosure: { label: "Parent children", expanded, onChange: value => { changes.push(value); } }, children: [{ key: "child", content: "Child" }] });
	const f = await fixture(props([row(false)]));
	const parent = treeRow("parent"); await f.pointer(parent);
	await f.key(parent, "ArrowRight");
	assert.deepEqual(changes, [true]); assert.equal(document.activeElement, parent); assert.equal(document.querySelector('[data-plugin-tree-row="child"]'), null);
	await f.render(props([row(false)], { label: "Unrelated controlled update" }));
	assert.equal(document.activeElement, parent);
	await f.render(props([row(true)]));
	assert.equal(document.activeElement, treeRow("child"));
	await f.render(props([row(true)], { label: "No new focus request" }));
	assert.equal(document.activeElement, treeRow("child"));
});

for (const intent of ["another row pointer", "another row navigation", "custom input", "outside focus"] as const) test(`delayed Right-open cannot steal focus after ${intent}`, async () => {
	const custom: PluginUiContent = container => { const input = container.ownerDocument.createElement("input"); input.setAttribute("aria-label", "Plugin editor"); container.append(input); };
	const row = (expanded: boolean): PluginTreeRow => ({ key: "parent", content: custom, disclosure: { label: "Children", expanded, onChange: noChange }, children: [{ key: "child", content: "Child" }] });
	const f = await fixture(props([row(false), { key: "peer", content: "Peer" }]));
	const parent = treeRow("parent"); await f.pointer(parent); await f.key(parent, "ArrowRight");
	let expected: HTMLElement;
	if (intent === "another row pointer") { expected = treeRow("peer"); await f.pointer(expected); }
	else if (intent === "another row navigation") { await f.key(parent, "ArrowDown"); expected = treeRow("peer"); }
	else if (intent === "custom input") { expected = document.querySelector<HTMLInputElement>('input[aria-label="Plugin editor"]')!; await f.pointer(expected); expected.focus(); }
	else { expected = document.createElement("input"); document.body.append(expected); expected.focus(); }
	await f.render(props([row(true), { key: "peer", content: "Peer" }]));
	assert.ok(document.activeElement === expected, "the obsolete expand request must not regain focus authority");
	assert.equal(treeRow("child").dataset.pluginTreeActive, undefined);
});

test("Space selects only the host checkbox of a row or its selection prefix, never plugin controls or disclosure", async () => {
	const selected: boolean[] = [];
	const custom: PluginUiContent = container => { const button = container.ownerDocument.createElement("button"); button.textContent = "Plugin action"; container.append(button); };
	const row = (disabled = false): PluginTreeRow => ({ key: "selectable", content: custom, selection: { label: "Select row", checked: false, disabled, onChange: value => { selected.push(value); } }, disclosure: { label: "Children", expanded: false, onChange: noChange } });
	const f = await fixture(props([row(), { key: "plain", content: "No host checkbox" }]));
	const selectable = treeRow("selectable"), checkbox = selectable.querySelector<HTMLInputElement>('[data-plugin-tree-control="selection"]')!;
	// linkedom does not perform the browser checkbox's native click toggle.
	const click = checkbox.click.bind(checkbox); checkbox.click = () => { checkbox.checked = !checkbox.checked; click(); };
	await f.pointer(selectable);
	assert.equal((await f.key(selectable, " ")).defaultPrevented, true); assert.deepEqual(selected, [true]);
	checkbox.focus(); assert.equal((await f.key(checkbox, " ")).defaultPrevented, true); assert.deepEqual(selected, [true, true], "selection-prefix focus requests the same controlled value without an internal toggle");
	const pluginButton = [...selectable.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Plugin action")!;
	pluginButton.focus(); assert.equal((await f.key(pluginButton, " ")).defaultPrevented, false); assert.deepEqual(selected, [true, true]);
	const disclosure = selectable.querySelector<HTMLButtonElement>('[data-plugin-tree-control="disclosure"]')!;
	disclosure.focus(); assert.equal((await f.key(disclosure, " ")).defaultPrevented, false); assert.deepEqual(selected, [true, true]);
	await f.render(props([row(true), { key: "plain", content: "No host checkbox" }]));
	await f.pointer(selectable); assert.equal((await f.key(selectable, " ")).defaultPrevented, false); assert.deepEqual(selected, [true, true]);
	const plain = treeRow("plain"); await f.pointer(plain); assert.equal((await f.key(plain, " ")).defaultPrevented, false);
});

test("typing retains caret keys and plugin key claims win, while unclaimed arrows from buttons follow native row navigation", async () => {
	const custom: PluginUiContent = container => {
		container.innerHTML = '<input aria-label="Text"><textarea aria-label="Area"></textarea><select aria-label="Options"><option>First</option><option>Second</option></select><div contenteditable="true" tabindex="0">Editable</div><div contenteditable="plaintext-only" tabindex="0">Plain editable</div><div contenteditable="" tabindex="0">Empty-attribute editable</div><button type="button">Plugin button</button><div tabindex="0" role="slider">Custom widget</div>';
	};
	const f = await fixture(props([{ key: "a", content: custom }, { key: "b", content: "Peer" }]));
	const row = treeRow("a");
	for (const input of row.querySelectorAll<HTMLElement>('input,textarea,select,[contenteditable]')) {
		input.focus(); await f.pointer(input); assert.equal(document.activeElement, input, "pointer interaction never redirects a plugin editor's focus");
		assert.equal((await f.key(input, "ArrowDown")).defaultPrevented, false); assert.equal((await f.key(input, "ArrowUp")).defaultPrevented, false); assert.equal((await f.key(input, " ")).defaultPrevented, false);
		assert.equal(document.activeElement, input);
	}
	const button = row.querySelector<HTMLButtonElement>("button")!;
	button.focus(); await f.pointer(button); assert.equal(document.activeElement, button, "pointer input does not steal button focus");
	await f.key(button, "ArrowDown"); assert.equal(document.activeElement, treeRow("b"), "native Chains also navigates an unclaimed button arrow");
	button.focus(); const claim = (event: Event) => { event.preventDefault(); }; button.addEventListener("keydown", claim);
	await f.key(button, "ArrowDown"); assert.equal(document.activeElement, button, "leaf preventDefault wins"); button.removeEventListener("keydown", claim);
	const widget = row.querySelector<HTMLElement>('[role="slider"]')!;
	widget.addEventListener("keydown", event => { event.stopPropagation(); }); widget.focus();
	assert.equal((await f.key(widget, "ArrowDown")).defaultPrevented, false); assert.equal(document.activeElement, widget, "a custom widget's own event ownership is preserved");
	const outside = document.createElement("input"); document.body.append(outside); outside.focus();
	await f.render(props([{ key: "a", content: custom }, { key: "b", content: "Peer" }], { label: "Updated label" }));
	assert.equal(document.activeElement, outside, "ordinary prop updates never autofocus the tree");
});

test("two sibling trees and nested trees navigate only their own visible DOM occurrences", async () => {
	const nested: PluginUiContent = () => {};
	const inner = props([{ key: "same", content: "Inner first" }, { key: "inner-peer", content: "Inner peer" }], { label: "Inner" });
	const outer = props([{ key: "same", content: nested }, { key: "outer-peer", content: "Outer peer" }], { label: "Outer" });
	const peer = props([{ key: "same", content: "Peer first" }, { key: "peer-last", content: "Peer last" }], { label: "Peer" });
	const f = await fixture(outer, { peers: [peer], renderContent: (value, signal) => value === nested
		? <PluginTree {...inner} signal={signal} renderContent={content => <TestContent content={content} signal={signal} />} />
		: <TestContent content={value} signal={signal} /> });
	const outerRoot = document.querySelector<HTMLElement>('[data-plugin-tree][aria-label="Outer"]')!;
	const innerRoot = document.querySelector<HTMLElement>('[data-plugin-tree][aria-label="Inner"]')!;
	const peerRoot = document.querySelector<HTMLElement>('[data-plugin-tree][aria-label="Peer"]')!;
	await f.pointer(innerRoot); assert.equal(document.activeElement, document.body, "the inner root does not accidentally own its containing outer row");
	await f.pointer(treeRow("same", innerRoot)); await f.key(treeRow("same", innerRoot), "ArrowDown");
	assert.equal(document.activeElement, treeRow("inner-peer", innerRoot));
	assert.equal(treeRow("same", outerRoot).dataset.pluginTreeActive, undefined, "nested events never activate the containing row");
	await f.pointer(treeRow("same", outerRoot)); await f.key(treeRow("same", outerRoot), "ArrowDown");
	assert.equal(document.activeElement, treeRow("outer-peer", outerRoot), "outer navigation excludes nested widget rows");
	await f.pointer(treeRow("same", peerRoot)); await f.key(treeRow("same", peerRoot), "ArrowDown");
	assert.equal(document.activeElement, treeRow("peer-last", peerRoot));
	assert.equal(treeRow("outer-peer", outerRoot).dataset.pluginTreeActive, "true");
	assert.equal(treeRow("inner-peer", innerRoot).dataset.pluginTreeActive, "true");
});

test("hidden or covered trees and composing, modified or prevented keys cannot claim navigation", async () => {
	let controller!: InteractionLayersController;
	function Capture({ children }: { children: ReactNode }) { controller = useInteractionLayers(); return children; }
	const f = await fixture(props([{ key: "a", content: "First" }, { key: "b", content: "Second" }]), {
		wrap: children => <InteractionLayersProvider><Capture>{children}</Capture></InteractionLayersProvider>,
	});
	const first = treeRow("a"), group = document.querySelector<HTMLElement>("[data-plugin-tree]")!;
	await f.pointer(first);
	for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
		assert.equal((await f.key(first, "ArrowDown", extra)).defaultPrevented, false); assert.equal(document.activeElement, first);
	}
	group.hidden = true; assert.equal((await f.key(first, "ArrowDown")).defaultPrevented, false); group.hidden = false;
	for (const kind of ["modal", "view"] as const) {
		const cover = document.createElement("div"); document.body.append(cover);
		const off = controller.register({ id: `cover-${kind}`, kind, rootRef: { current: cover } });
		assert.equal((await f.key(first, "ArrowDown")).defaultPrevented, false, `${kind} foreground blocks the underlying widget`);
		assert.equal(document.activeElement, first); off(); cover.remove();
	}
	assert.equal((await f.key(first, "ArrowDown")).defaultPrevented, true); assert.equal(document.activeElement, treeRow("b"));
	await act(async () => { f.lifetime.abort(); });
	assert.equal((await f.key(treeRow("b"), "ArrowUp")).defaultPrevented, false);
});
