import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { HostDialog } from "../components/host-dialog.tsx";
import { installModalDom } from "./modal-dom.ts";
import type { AgentSettings, AppearanceSettings, CompactionSettings, GraphSettings, PluginSettingsSchema, UserSettings } from "../src/core/index.ts";

let CommitInput: typeof import("../components/settings/controls.tsx").CommitInput;
let AppearanceSection: typeof import("../components/settings/appearance-section.tsx").AppearanceSection;
let GraphSection: typeof import("../components/settings/appearance-section.tsx").GraphSection;
let AgentSection: typeof import("../components/settings/agent-section.tsx").AgentSection;
let SettingsDialogBody: typeof import("../components/settings/settings-dialog.tsx").SettingsDialogBody;
let PluginSettingsRows: typeof import("../components/plugin-settings-rows.tsx").PluginSettingsRows;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

async function fixture(run: (f: {
	render: (node: React.ReactNode) => Promise<void>;
	input: (selector?: string) => HTMLInputElement;
	type: (input: HTMLInputElement, value: string) => Promise<void>;
	blur: (input: HTMLInputElement) => Promise<void>;
	key: (target: Element, key: string) => Promise<Event>;
	setFetch: (fetcher: typeof fetch) => void;
}) => Promise<void>) {
	const dom = parseHTML("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
	Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
	let active: Element = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => active });
	const proto = dom.window.HTMLElement.prototype;
	const oldFocus = Object.getOwnPropertyDescriptor(proto, "focus");
	const oldBlur = Object.getOwnPropertyDescriptor(proto, "blur");
	Object.defineProperty(proto, "focus", { configurable: true, writable: true, value(this: HTMLElement) { active = this; } });
	Object.defineProperty(proto, "blur", { configurable: true, writable: true, value(this: HTMLElement) {
		active = dom.document.body;
		this.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
	} });
	let fetcher: typeof fetch = async (url) => {
		const path = String(url);
		if (path === "/api/settings") return Response.json({ settings: { version: 1 } });
		if (path === "/api/settings/prompts") return Response.json({ prober: [], teacher: [], practice: [] });
		if (path === "/api/models") return Response.json({ models: [], slots: {}, providers: [] });
		if (path === "/api/search") return Response.json({ available: false });
		if (path === "/api/keys") return Response.json({ keys: [] });
		assert.fail(`unexpected fetch: ${path}`);
	};
	const globals = {
		window: dom.window, self: dom.window, document: dom.document,
		HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
		Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		getSelection: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0 }),
		fetch: ((...args) => fetcher(...args)) as typeof fetch,
	};
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModalDom = installModalDom(dom);
	const modalFocus = proto.focus;
	// Keep one observable active-element value for normal blur/save and the
	// modal helper's focusin events. Blur must not synthesize a body focusin:
	// native blur leaves body active without requesting focus outside a trap.
	Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => active });
	Object.defineProperty(proto, "focus", { configurable: true, writable: true, value(this: HTMLElement) {
		active = this; modalFocus.call(this);
	} });
	({ CommitInput } = await import("../components/settings/controls.tsx"));
	({ AppearanceSection, GraphSection } = await import("../components/settings/appearance-section.tsx"));
	({ AgentSection } = await import("../components/settings/agent-section.tsx"));
	({ SettingsDialogBody } = await import("../components/settings/settings-dialog.tsx"));
	({ PluginSettingsRows } = await import("../components/plugin-settings-rows.tsx"));
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.querySelector("#root")!);
	try {
		await run({
			render: async node => {
				let surface = node;
				if (React.isValidElement<React.ComponentProps<typeof SettingsDialogBody>>(node) && node.type === SettingsDialogBody) {
					// The writer body no longer owns a second dismissal listener.
					surface = <HostDialog open onClose={node.props.onClose}>{node}</HostDialog>;
				}
				await act(async () => { root.render(<InteractionLayersProvider>{surface}</InteractionLayersProvider>); });
			},
			input: (selector = "input") => {
				const input = document.querySelector<HTMLInputElement>(selector);
				assert.ok(input, selector); return input;
			},
			type: async (input, value) => { await act(async () => {
				input.focus(); input.value = value;
				input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			}); },
			blur: async input => { await act(async () => { input.blur(); }); },
			key: async (target, key) => {
				const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
				Object.defineProperty(event, "key", { value: key });
				await act(async () => { target.dispatchEvent(event); }); return event;
			},
			setFetch: next => { fetcher = next; },
		});
	} finally {
		await act(async () => { root.unmount(); });
		await new Promise(resolve => setTimeout(resolve, 5));
		restoreModalDom();
		if (oldFocus) Object.defineProperty(proto, "focus", oldFocus); else Reflect.deleteProperty(proto, "focus");
		if (oldBlur) Object.defineProperty(proto, "blur", oldBlur); else Reflect.deleteProperty(proto, "blur");
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
		}
	}
}

it("Escape claims its event, blurs normally, and accepts normalization to the SAME canonical value", async () => fixture(async f => {
	const commits: string[] = [];
	let parentEscapes = 0;
	const onKey = (e: Event) => { if ((e as KeyboardEvent).key === "Escape") parentEscapes++; };
	document.addEventListener("keydown", onKey);
	try {
		await f.render(<CommitInput value="12" ariaLabel="Size" type="number" onCommit={next => { commits.push(next); return true; }} />);
		const input = f.input(); await f.type(input, "-5");
		const event = await f.key(input, "Escape");
		assert.equal(event.defaultPrevented, true);
		assert.equal(document.activeElement, document.body);
		assert.deepEqual(commits, ["-5"]); assert.equal(input.value, "12");
		assert.equal(parentEscapes, 0);
		await f.key(document.body, "Escape"); assert.equal(parentEscapes, 1);
	} finally { document.removeEventListener("keydown", onKey); }
}));

it("pending drafts remain visible while unfocused and enabled, then show acknowledged canonical props", async () => fixture(async f => {
	const save = deferred<void>();
	function Field() {
		const [value, setValue] = React.useState("old");
		return <CommitInput value={value} ariaLabel="Text" onCommit={async () => { await save.promise; setValue("canonical"); return true; }} />;
	}
	await f.render(<Field />); const input = f.input();
	await f.type(input, " candidate "); await f.blur(input);
	assert.equal(input.value, " candidate "); assert.equal(input.disabled, false);
	await act(async () => { save.resolve(); });
	assert.equal(input.value, "canonical");
}));

for (const outcome of ["false", "throw", "reject"] as const) {
	it(`${outcome} preserves unsuccessful drafts across blur and controlled prop changes`, async () => fixture(async f => {
		let accepted = false;
		const onCommit = () => {
			if (accepted) return true;
			if (outcome === "throw") throw new Error("save failed");
			if (outcome === "reject") return Promise.reject(new Error("save failed"));
			return false;
		};
		await f.render(<CommitInput value="stored" ariaLabel="Text" onCommit={onCommit} />);
		const input = f.input(); await f.type(input, "unsaved"); await f.key(input, "Escape");
		assert.equal(input.value, "unsaved");
		await f.render(<CommitInput value="external" ariaLabel="Text" onCommit={onCommit} />);
		assert.equal(input.value, "unsaved");
		accepted = true; input.focus(); await f.blur(input);
		assert.equal(input.value, "external", "retry reconciles to the controlled source, never optimistic text");
	}));
}

it("old completions cannot erase newer typing or a newer acknowledged draft", async () => fixture(async f => {
	const first = deferred<boolean>(), second = deferred<boolean>();
	const commits: string[] = [];
	const callback = (next: string) => { commits.push(next); return commits.length === 1 ? first.promise : second.promise; };
	await f.render(<CommitInput value="stored" ariaLabel="Text" onCommit={callback} />);
	const input = f.input(); await f.type(input, "first"); await f.blur(input);
	await f.type(input, "second");
	await f.render(<CommitInput value="older-server-value" ariaLabel="Text" onCommit={callback} />);
	assert.equal(input.value, "second"); await f.blur(input);
	await act(async () => { second.resolve(true); });
	assert.equal(input.value, "older-server-value");
	await f.type(input, "third"); await act(async () => { first.resolve(true); });
	assert.equal(input.value, "third"); assert.deepEqual(commits, ["first", "second"]);
}));

it("blur does not duplicate a pending revision and an unmounted field ignores its acknowledgement", async () => fixture(async f => {
	const save = deferred<boolean>(); let writes = 0;
	await f.render(<CommitInput value="stored" ariaLabel="Text" onCommit={() => { writes++; return save.promise; }} />);
	const input = f.input(); await f.type(input, "draft"); await f.blur(input); await f.blur(input);
	assert.equal(writes, 1); await f.render(<p>closed</p>);
	await act(async () => { save.resolve(true); }); assert.equal(input.value, "draft");
}));

it("clean fields follow external values and unchanged trimmed drafts do not write", async () => fixture(async f => {
	let writes = 0;
	const callback = () => { writes++; return true; };
	await f.render(<CommitInput value="old" ariaLabel="Text" onCommit={callback} />);
	await f.render(<CommitInput value="new" ariaLabel="Text" onCommit={callback} />);
	const input = f.input(); assert.equal(input.value, "new");
	await f.type(input, " new "); await f.key(input, "Enter");
	assert.equal(writes, 0); assert.equal(input.value, "new");
}));

it("badInput is not an empty/unset write and rerenders do not overwrite the native editing buffer", async () => fixture(async f => {
	let writes = 0;
	const callback = () => { writes++; return true; };
	await f.render(<CommitInput value="8" ariaLabel="Number" type="number" min={1} step={1} onCommit={callback} />);
	const input = f.input(); await f.type(input, "");
	Object.defineProperty(input, "validity", { configurable: true, value: { badInput: true } });
	let assignments = 0;
	// linkedom cannot model the separate visible numeric token. This seam
	// pins the no-assignment guarantee; Chromium must verify actual "1e".
	Object.defineProperty(input, "value", { configurable: true, get: () => "", set: () => { assignments++; } });
	await f.key(input, "Escape");
	await f.render(<CommitInput value="9" ariaLabel="Number" type="number" min={1} step={1} onCommit={callback} />);
	assert.equal(writes, 0); assert.equal(assignments, 0);
	assert.equal(input.type, "number"); assert.equal(input.getAttribute("min"), "1"); assert.equal(input.getAttribute("step"), "1");
}));

it("all built-in number adapters preserve normalization and empty/unset acknowledgements", async () => fixture(async f => {
	const appearance: AppearanceSettings[] = [];
	function Appearance() {
		const [value, setValue] = React.useState<AppearanceSettings>({ proseFontSize: 12 });
		return <AppearanceSection appearance={value} onSectionChange={next => { appearance.push(next); setValue(next); return true; }} />;
	}
	await f.render(<Appearance />);
	let input = f.input('[data-testid="input-prose-size"]');
	await f.type(input, "-5"); await f.blur(input);
	assert.equal(appearance.at(-1)?.proseFontSize, 12); assert.equal(input.value, "12");
	await f.type(input, ""); await f.blur(input);
	assert.equal(appearance.at(-1)?.proseFontSize, undefined);
	input = f.input('[data-testid="input-heading-weight"]');
	await f.type(input, "2000"); await f.blur(input);
	assert.equal(appearance.at(-1)?.mdRendering?.headingWeight, 900);
	await f.type(input, ""); await f.blur(input);
	assert.equal(appearance.at(-1)?.mdRendering?.headingWeight, undefined);
	const graph: GraphSettings[] = [];
	function Graph() {
		const [value, setValue] = React.useState<GraphSettings>({});
		return <GraphSection graph={value} onSectionChange={next => { graph.push(next); setValue(next); return true; }} />;
	}
	await f.render(<Graph />);
	input = f.input('[data-testid="input-chunk-tokens"]');
	await f.type(input, "1"); await f.blur(input); assert.equal(graph.at(-1)?.extractionChunkTokens, 500);
	await f.type(input, "0"); await f.blur(input); assert.equal(graph.length, 1); assert.equal(input.value, "0");
	await f.type(input, ""); await f.blur(input); assert.equal(graph.at(-1)?.extractionChunkTokens, undefined);
}));

it("worker/compaction adapters acknowledge invalid, accepted and unset outcomes", async () => fixture(async f => {
	const agent: AgentSettings[] = [];
	const compaction: CompactionSettings[] = [];
	function Agent() {
		const [value, setValue] = React.useState<AgentSettings>({});
		const [compact, setCompact] = React.useState<CompactionSettings>({});
		return <AgentSection agent={value} models={undefined} graph={undefined} compaction={compact}
			onModelsChange={() => {}} onSectionChange={next => { agent.push(next); setValue(next); return true; }}
			onCompactionChange={next => { compaction.push(next); setCompact(next); return true; }} />;
	}
	await f.render(<Agent />);
	let input = f.input('[data-testid="input-worker-request-concurrency"]');
	// linkedom has no native ValidityState.
	Object.defineProperty(input, "validity", { value: { badInput: false } });
	await f.type(input, "1.5"); await f.key(input, "Escape");
	assert.equal(agent.length, 0); assert.equal(input.value, "1.5");
	assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes("positive, safely representable whole number"));
	await f.type(input, "9"); await f.blur(input); assert.equal(agent.at(-1)?.workerRequestConcurrency, 9);
	await f.type(input, ""); await f.blur(input); assert.equal(agent.at(-1)?.workerRequestConcurrency, undefined);
	input = f.input('[data-testid="input-compaction-threshold"]');
	await f.type(input, "1"); await f.blur(input); assert.equal(compaction.at(-1)?.thresholdTokens, 32000);
	await f.type(input, "0"); await f.blur(input); assert.equal(compaction.length, 1); assert.equal(input.value, "0");
	await f.type(input, ""); await f.blur(input); assert.equal(compaction.at(-1)?.thresholdTokens, undefined);
}));

for (const failure of ["http", "network", "missing", "malformed"] as const) {
	it(`Settings writer keeps draft after ${failure} failure, reports inline, and retries through canonical ACK`, async () => fixture(async f => {
		const initial: UserSettings = { version: 1, appearance: { background: "#141414" } };
		let accept = false, writes = 0, closed = 0;
		f.setFetch(async (_url, init) => {
			if (init?.method !== "PUT") return Response.json({ settings: initial });
			writes++;
			if (accept) return Response.json({ settings: { ...initial, appearance: { background: "#abcdef" } } });
			if (failure === "http") return Response.json({ error: "Invalid color" }, { status: 400 });
			if (failure === "network") throw new Error("Network unavailable");
			if (failure === "malformed") return new Response("not json");
			return Response.json({});
		});
		await f.render(<SettingsDialogBody initialSection="appearance" onClose={() => { closed++; }} />);
		const input = f.input('[data-testid="input-background"]');
		await f.type(input, "#ABCDEF"); await f.key(input, "Escape");
		assert.equal(closed, 0); assert.equal(input.value, "#ABCDEF"); assert.equal(writes, 1);
		const text = document.querySelector('[data-testid="settings-dialog"]')?.textContent;
		assert.ok(text?.includes(failure === "http" ? "appearance: Invalid color" : failure === "network" ? "appearance: Network unavailable" : "appearance: Could not confirm saved settings. Your input has been kept."));
		accept = true; input.focus(); await f.blur(input);
		assert.equal(writes, 2); assert.equal(input.value, "#abcdef");
		await f.key(document.body, "Escape"); assert.equal(closed, 1);
	}));
}

it("Settings PUT keeps an unfocused draft until server acknowledgement and does not disable built-in controls", async () => fixture(async f => {
	const saved = deferred<Response>();
	f.setFetch(async (_url, init) => init?.method === "PUT" ? saved.promise : Response.json({ settings: { version: 1, appearance: { proseFontSize: 12 } } }));
	await f.render(<SettingsDialogBody initialSection="appearance" onClose={() => {}} />);
	const input = f.input('[data-testid="input-prose-size"]');
	await f.type(input, "-5"); await f.key(input, "Escape");
	assert.equal(input.value, "-5"); assert.equal(input.disabled, false);
	await act(async () => { saved.resolve(Response.json({ settings: { version: 1, appearance: { proseFontSize: 12 } } })); });
	assert.equal(input.value, "12");
}));

it("plugin validation and callback failures retain drafts; successful callbacks use controlled schema values", async () => fixture(async f => {
	const errors: unknown[] = []; const changes: unknown[] = [];
	let reject = true;
	const schema: PluginSettingsSchema = { rows: [
		{ key: "text", type: "text", label: "Text", value: "stored", validate: value => value === "invalid" ? "Invalid preference" : undefined,
			async onChange(value) { changes.push(value); if (reject) throw new Error("Plugin save failed"); } },
		{ key: "number", type: "number", label: "Number", value: 3, min: 1, max: 5, onChange(value) { changes.push(value); } },
	] };
	const render = () => f.render(<PluginSettingsRows schema={schema} onError={error => { errors.push(error); }} />);
	await render(); const input = f.input('[data-plugin-setting="text"] input');
	await f.type(input, "invalid"); await f.key(input, "Escape");
	assert.equal(input.value, "invalid"); assert.equal(changes.length, 0);
	assert.ok(document.body.textContent?.includes("Invalid preference"));
	await f.type(input, "candidate"); await f.blur(input);
	assert.equal(input.value, "candidate"); assert.equal(errors.length, 1);
	assert.ok(document.body.textContent?.includes("Plugin save failed"));
	reject = false; input.focus(); await f.blur(input);
	assert.equal(input.value, "stored", "void callback completion does not assign optimistic plugin state");
	const number = f.input('[data-plugin-setting="number"] input');
	await f.type(number, "6"); await f.blur(number);
	assert.equal(number.value, "6"); assert.ok(document.body.textContent?.includes("Value is outside the allowed range."));
	await f.type(number, ""); await f.blur(number); assert.equal(number.value, "");
	await f.type(number, "4"); await f.blur(number); assert.equal(number.value, "3");
	assert.deepEqual(changes, ["candidate", "candidate", 4]);
}));

it("plugin asynchronous callbacks retain pending text and reconcile the latest supplied schema", async () => fixture(async f => {
	const save = deferred<void>();
	let schema: PluginSettingsSchema = { rows: [{ key: "text", type: "text", label: "Text", value: "old", onChange: () => save.promise }] };
	const render = () => f.render(<PluginSettingsRows schema={schema} />);
	await render(); const input = f.input(); await f.type(input, "candidate"); await f.blur(input);
	assert.equal(input.value, "candidate"); assert.equal(input.disabled, true, "existing plugin pending disabling is preserved");
	schema = { rows: [{ key: "text", type: "text", label: "Text", value: "normalized", onChange: () => save.promise }] };
	await render(); assert.equal(input.value, "candidate");
	await act(async () => { save.resolve(); });
	assert.equal(input.value, "normalized"); assert.equal(input.disabled, false);
}));

it("a late older Settings record cannot roll back a newer acknowledged field", async () => fixture(async f => {
	const first = deferred<Response>(), second = deferred<Response>();
	let writes = 0;
	f.setFetch(async (_url, init) => {
		if (init?.method !== "PUT") return Response.json({ settings: { version: 1, appearance: { proseFontSize: 12 } } });
		return ++writes === 1 ? first.promise : second.promise;
	});
	await f.render(<SettingsDialogBody initialSection="appearance" onClose={() => {}} />);
	const input = f.input('[data-testid="input-prose-size"]');
	await f.type(input, "16"); await f.key(input, "Escape");
	await f.type(input, "20"); await f.key(input, "Escape");
	assert.equal(writes, 2);
	await act(async () => second.resolve(Response.json({ settings: { version: 1, appearance: { proseFontSize: 20 } } })));
	assert.equal(input.value, "20");
	await act(async () => first.resolve(Response.json({ settings: { version: 1, appearance: { proseFontSize: 16 } } })));
	assert.equal(input.value, "20", "older acknowledged controlled props must not replace a clean newer field");
}));

it("an older Settings failure cannot add a stale error after a newer accepted save", async () => fixture(async f => {
	const first = deferred<Response>(), second = deferred<Response>();
	let writes = 0;
	f.setFetch(async (_url, init) => {
		if (init?.method !== "PUT") return Response.json({ settings: { version: 1, appearance: { proseFontSize: 12 } } });
		return ++writes === 1 ? first.promise : second.promise;
	});
	await f.render(<SettingsDialogBody initialSection="appearance" onClose={() => {}} />);
	const input = f.input('[data-testid="input-prose-size"]');
	await f.type(input, "16"); await f.key(input, "Escape");
	await f.type(input, "20"); await f.key(input, "Escape");
	await act(async () => second.resolve(Response.json({ settings: { version: 1, appearance: { proseFontSize: 20 } } })));
	await act(async () => first.resolve(Response.json({ error: "Old save failed" }, { status: 400 })));
	assert.equal(input.value, "20");
	assert.equal(document.querySelector('[data-testid="settings-error"]'), null);
}));

it("Settings ACK authority survives close/reopen and protects the live appearance", async () => fixture(async f => {
	const { SettingsDialogProvider, useSettingsDialog } = await import("../components/settings/settings-dialog.tsx");
	const { AppearanceProvider, useAppearance } = await import("../components/settings/appearance.tsx");
	const first = deferred<Response>(), second = deferred<Response>();
	let settings!: ReturnType<typeof useSettingsDialog>, liveSize = 0, writes = 0;
	let stored: UserSettings = { version: 1, appearance: { proseFontSize: 12 } };
	f.setFetch(async (_url, init) => {
		if (init?.method !== "PUT") return Response.json({ settings: stored });
		stored = { version: 1, appearance: JSON.parse(String(init.body)) };
		return ++writes === 1 ? first.promise : second.promise;
	});
	function Probe() { settings = useSettingsDialog(); liveSize = useAppearance().appearance.proseFontSize; return null; }
	await f.render(<AppearanceProvider><SettingsDialogProvider><Probe /></SettingsDialogProvider></AppearanceProvider>);
	await act(async () => settings.open("appearance"));
	let input = f.input('[data-testid="input-prose-size"]');
	await f.type(input, "16"); await f.key(input, "Escape");
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-close"]')!.click());
	await act(async () => settings.open("appearance"));
	input = f.input('[data-testid="input-prose-size"]'); assert.equal(input.value, "16");
	await f.type(input, "20"); await f.key(input, "Escape");
	await act(async () => second.resolve(Response.json({ settings: stored })));
	assert.equal(input.value, "20"); assert.equal(liveSize, 20);
	await act(async () => first.resolve(Response.json({ settings: { version: 1, appearance: { proseFontSize: 16 } } })));
	assert.equal(input.value, "20"); assert.equal(liveSize, 20);
}));

it("a newer nonappearance acknowledgement applies its full canonical live appearance", async () => fixture(async f => {
	const { SettingsDialogProvider, useSettingsDialog } = await import("../components/settings/settings-dialog.tsx");
	const { AppearanceProvider, useAppearance } = await import("../components/settings/appearance.tsx");
	const appearanceSave = deferred<Response>(), generalSave = deferred<Response>();
	let settings!: ReturnType<typeof useSettingsDialog>, liveSize = 0;
	let stored: UserSettings = { version: 1, appearance: { proseFontSize: 12 } };
	Object.defineProperty(window, "lh", { configurable: true, value: {
		getUpdateState: async () => ({ status: "idle", version: null, revision: 1 }), onUpdateStatus: () => () => {},
	} });
	f.setFetch(async (url, init) => {
		if (init?.method !== "PUT") return Response.json({ settings: stored });
		const section = String(url).split("/").at(-1)!;
		stored = { ...stored, [section]: JSON.parse(String(init.body)) };
		return section === "appearance" ? appearanceSave.promise : generalSave.promise;
	});
	function Probe() { settings = useSettingsDialog(); liveSize = useAppearance().appearance.proseFontSize; return null; }
	await f.render(<AppearanceProvider><SettingsDialogProvider><Probe /></SettingsDialogProvider></AppearanceProvider>);
	await act(async () => settings.open("appearance"));
	const input = f.input('[data-testid="input-prose-size"]');
	await f.type(input, "16"); await f.key(input, "Escape");
	await act(async () => settings.open("general"));
	await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="toggle-auto-update"]')!.click());
	await act(async () => generalSave.resolve(Response.json({ settings: stored })));
	assert.equal(liveSize, 16, "the authoritative full snapshot includes the earlier saved appearance");
	await act(async () => appearanceSave.resolve(Response.json({ settings: { version: 1, appearance: { proseFontSize: 16 } } })));
	await act(async () => settings.open("appearance"));
	assert.equal(f.input('[data-testid="input-prose-size"]').value, "16");
	assert.equal(liveSize, 16);
}));

for (const arrival of ["before", "after", "failure-after"] as const) {
	it(`reopened Settings receives a previous instance's ACK when its GET arrives ${arrival}`, async () => fixture(async f => {
		const { SettingsDialogProvider, useSettingsDialog } = await import("../components/settings/settings-dialog.tsx");
		const { AppearanceProvider, useAppearance } = await import("../components/settings/appearance.tsx");
		const save = deferred<Response>(), reopenedRead = deferred<Response>();
		let settings!: ReturnType<typeof useSettingsDialog>, liveSize = 0, reads = 0;
		const old: UserSettings = { version: 1, appearance: { proseFontSize: 12 } };
		f.setFetch(async (url, init) => {
			if (init?.method === "PUT") return save.promise;
			assert.equal(String(url), "/api/settings");
			return ++reads === 3 ? reopenedRead.promise : Response.json({ settings: old });
		});
		function Probe() { settings = useSettingsDialog(); liveSize = useAppearance().appearance.proseFontSize; return null; }
		await f.render(<AppearanceProvider><SettingsDialogProvider><Probe /></SettingsDialogProvider></AppearanceProvider>);
		await act(async () => settings.open("appearance"));
		const input = f.input('[data-testid="input-prose-size"]');
		await f.type(input, "20"); await f.key(input, "Escape");
		await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-close"]')!.click());
		await act(async () => settings.open("appearance"));
		assert.equal(reads, 3);
		if (arrival === "before") {
			await act(async () => reopenedRead.resolve(Response.json({ settings: old })));
			assert.equal(f.input('[data-testid="input-prose-size"]').value, "12");
		}
		await act(async () => save.resolve(Response.json({ settings: { version: 1, appearance: { proseFontSize: 20 } } })));
		assert.equal(f.input('[data-testid="input-prose-size"]').value, "20", "the active instance receives an older instance's newly accepted save");
		assert.equal(liveSize, 20);
		if (arrival !== "before") await act(async () => reopenedRead.resolve(arrival === "failure-after"
			? Response.json({ error: "Old load failed" }, { status: 500 }) : Response.json({ settings: old })));
		assert.equal(f.input('[data-testid="input-prose-size"]').value, "20");
		assert.equal(liveSize, 20);
	}));
}

it("startup appearance loading cannot undo a newer canonical live save", async () => fixture(async f => {
	const { SettingsDialogProvider, useSettingsDialog } = await import("../components/settings/settings-dialog.tsx");
	const { AppearanceProvider, useAppearance } = await import("../components/settings/appearance.tsx");
	const initialRead = deferred<Response>();
	let settings!: ReturnType<typeof useSettingsDialog>, liveSize = 0, reads = 0;
	f.setFetch(async (url, init) => {
		if (init?.method === "PUT") return Response.json({ settings: { version: 1, appearance: { proseFontSize: 20 } } });
		assert.equal(String(url), "/api/settings");
		return ++reads === 1 ? initialRead.promise : Response.json({ settings: { version: 1, appearance: { proseFontSize: 12 } } });
	});
	function Probe() { settings = useSettingsDialog(); liveSize = useAppearance().appearance.proseFontSize; return null; }
	await f.render(<AppearanceProvider><SettingsDialogProvider><Probe /></SettingsDialogProvider></AppearanceProvider>);
	await act(async () => settings.open("appearance"));
	const input = f.input('[data-testid="input-prose-size"]');
	await f.type(input, "20"); await f.key(input, "Escape");
	assert.equal(input.value, "20"); assert.equal(liveSize, 20);
	await act(async () => initialRead.resolve(Response.json({ settings: { version: 1, appearance: { proseFontSize: 12 } } })));
	assert.equal(input.value, "20"); assert.equal(liveSize, 20);
}));
