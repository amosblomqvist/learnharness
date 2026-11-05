import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";
import { activate as hello } from "./hello-plugin/dist/main.js";
import { activate as teaching } from "./teaching-extension/dist/main.js";
import { activate as managed } from "./managed-agent/dist/main.js";

function fixture(t) {
	const { document } = parseHTML("<html><body></body></html>");
	const previous = globalThis.document;
	globalThis.document = document;
	t.after(() => { globalThis.document = previous; });
	// Linkedom has no writable select.value; only native plugin conversation DOM uses it.
	const createElement = document.createElement.bind(document);
	document.createElement = (tag) => {
		const node = createElement(tag);
		if (tag === "select") Object.defineProperty(node, "value", { writable: true, value: "" });
		return node;
	};
	const registrations = { views: [], actions: [], placements: [], settings: [], fences: [], tools: [], opened: [] };
	const ctx = {
		registerView: (view) => registrations.views.push(view),
		registerAction: (action) => registrations.actions.push(action),
		placeAction: (placement) => registrations.placements.push(placement),
		registerSettings: (settings) => registrations.settings.push(settings),
		registerCodeBlock: (renderer) => registrations.fences.push(renderer),
		registerToolRenderer: (renderer) => registrations.tools.push(renderer),
		app: { openView: (id) => registrations.opened.push(id) },
	};
	return { ctx, registrations, container: document.createElement("div"), controller: new AbortController() };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("hello explicitly places an action; button/dialog share the view lifetime", async (t) => {
	const { ctx, registrations: r, container, controller } = fixture(t);
	let button, dialog, disposed = false;
	ctx.ui = {
		mountButton: (_container, props, options) => {
			button = { props, options };
			return { dispose: () => { disposed = true; } };
		},
		openDialog: (props, options) => { dialog = { props, options }; },
	};
	hello(ctx);
	assert.deepEqual(r.opened, []);
	assert.deepEqual(r.placements.map((p) => p.location), ["sidebar", "graph", "top-bar"]);
	assert.deepEqual(r.placements[2].sessions, ["teaching", "practice"]);
	assert.ok(r.placements.every((p) => p.actionId === r.actions[0].id));
	const cleanup = r.views[0].mount(container, controller.signal);
	assert.equal(button.options.signal, controller.signal);
	await button.props.onClick();
	assert.equal(dialog.options.signal, controller.signal);
	const content = document.createElement("div");
	dialog.props.content(content, controller.signal);
	assert.match(content.textContent, /standard host dialog/);
	await r.actions[0].run();
	assert.deepEqual(r.opened, ["hello"]);
	controller.abort(); cleanup();
	assert.equal(disposed, true);
	assert.equal(container.childElementCount, 0);
});

test("teaching remains chrome-less and retains custom settings/fence/result mounts", (t) => {
	const { ctx, registrations: r, container, controller } = fixture(t);
	teaching(ctx);
	assert.deepEqual([r.views.length, r.actions.length, r.placements.length], [0, 0, 0]);
	assert.equal(typeof r.settings[0], "function");
	r.settings[0](container, controller.signal)();
	const cleanup = r.fences[0].mount(container, { source: "<safe plain text>", incomplete: false, signal: controller.signal });
	assert.match(container.textContent, /<safe plain text>/);
	assert.equal(container.querySelector("safe"), null);
	cleanup();
	r.tools.find((tool) => tool.toolName === "teaching_extension_note").mount(container, {
		state: "output-available", background: {}, output: { note: "Offline note" }, signal: controller.signal,
	});
	assert.match(container.textContent, /Offline note/);
});

test("managed composer controls model/thinking/draft, creates explicitly, and cleans up", async (t) => {
	const { ctx, registrations: r, container, controller } = fixture(t);
	const calls = [];
	let props, disposed = false, unsubscribed = 0;
	let sessions = [];
	const snapshot = { id: "conversation-1", status: "idle", messages: [], pending: [] };
	ctx.ui = {
		mountStandardComposer: (_container, initial, options) => {
			assert.equal(options.signal, controller.signal);
			props = initial;
			return { update: (next) => { props = { ...props, ...next }; }, dispose: () => { disposed = true; } };
		},
	};
	ctx.call = async (operation, input) => {
		calls.push({ operation, input });
		if (operation === "list") return sessions;
		if (operation === "create") { sessions = [snapshot]; return snapshot; }
		if (operation === "get" || operation === "send") return snapshot;
		throw new Error("Unexpected operation: " + operation);
	};
	ctx.onNotification = ctx.onResync = () => () => { unsubscribed++; };
	managed(ctx);
	assert.deepEqual(r.placements.map((p) => p.location), ["sidebar", "graph"]);
	assert.deepEqual(r.opened, []);
	const cleanup = r.views[0].mount(container, controller.signal);
	await flush();
	assert.deepEqual(calls.map((c) => c.operation), ["list"]);
	assert.equal(props.model.value, undefined);
	assert.equal(props.composer.canSend, false);
	assert.equal(container.querySelector("textarea"), null);
	props.model.onChange({ provider: "offline", id: "fixture" });
	props.thinking.onChange("high");
	await [...container.querySelectorAll("button")].find((b) => b.textContent === "New conversation").onclick();
	assert.deepEqual(calls.find((c) => c.operation === "create").input, {
		model: { provider: "offline", id: "fixture", thinkingLevel: "high" },
	});
	assert.equal(calls.some((c) => c.operation === "send"), false);
	props.composer.onChange("A task");
	props.dictation.onTranscript("with dictation");
	assert.equal(props.composer.value, "A task with dictation");
	assert.equal(props.composer.canSend, true);
	await props.composer.onSend();
	assert.equal(calls.find((c) => c.operation === "send").input.text, "A task with dictation");
	assert.equal(calls.find((c) => c.operation === "send").input.purpose, "user");
	assert.equal(props.composer.value, "");
	props.model.onChange({ provider: "offline", id: "another" });
	assert.equal(props.thinking.value, undefined);
	controller.abort();
	const count = calls.length;
	await props.composer.onSend();
	assert.equal(calls.length, count);
	cleanup();
	assert.equal(disposed, true);
	assert.equal(unsubscribed, 2);
	assert.equal(container.childElementCount, 0);
});

test("managed backend preserves and persists model thinking without inference requests", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "plugin-example-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const { activate } = createRequire(import.meta.url)("./managed-agent/dist/backend.cjs");
	const handlers = new Map(), definitions = new Map();
	let creates = 0;
	const ctx = {
		dataDirectory: directory, signal: new AbortController().signal, cleanup: () => {},
		handle: (name, handler) => handlers.set(name, handler),
		inference: { catalog: async () => ({ models: [{ provider: "offline", id: "fixture" }] }) },
		agents: {
			register: (definition) => { definitions.set(definition.id, definition); return () => {}; },
			create: (id) => { creates++; return { definitionId: id }; },
		},
	};
	activate(ctx);
	assert.equal(creates, 0);
	const model = { provider: "offline", id: "fixture", thinkingLevel: "high" };
	const first = await handlers.get("create")({ model });
	assert.deepEqual(definitions.get(first.definitionId).model, model);
	const second = await handlers.get("create")({ model: { ...model, thinkingLevel: "low" } });
	assert.notEqual(first.definitionId, second.definitionId);
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "definitions.json"), "utf8"))[0].model, model);
	await assert.rejects(handlers.get("create")({ model: { ...model, thinkingLevel: "invalid" } }), /thinkingLevel/);
	definitions.clear();
	activate(ctx);
	assert.equal(definitions.size, 2);
	assert.deepEqual(definitions.get(first.definitionId).model, model);
});
