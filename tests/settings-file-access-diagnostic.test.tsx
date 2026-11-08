import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";

type Write = (section: string, body: Record<string, unknown>) => Promise<Response> | Response;

async function withDialog(
	initial: object,
	write: Write,
	run: (host: HTMLElement, click: (selector: string) => Promise<void>) => Promise<void>,
) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "PUT") return write(url.split("/").at(-1)!, JSON.parse(String(init.body)));
		if (url === "/api/settings") return Response.json(initial);
		if (url === "/api/models") return Response.json({ models: [], slots: { strong: null, cheap: null, vision: null } });
		if (url === "/api/search") return Response.json({ available: false, engine: null, reason: "No search engine" });
		if (url === "/api/keys") return Response.json({ keys: [] });
		if (url === "/api/settings/prompts") return Response.json({ prober: [], teacher: [], practice: [] });
		throw new Error(`Unexpected request ${url}`);
	};
	for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchStub })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const host = document.getElementById("root")!;
	const root = createRoot(host);
	const click = async (selector: string) => {
		const target = host.querySelector<HTMLElement>(selector);
		assert.ok(target, `Missing ${selector}`);
		await act(async () => { target.click(); });
	};
	try {
		await act(async () => { root.render(<SettingsDialogBody initialSection="agent" onClose={() => {}} />); });
		await run(host, click);
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
}

const warning = "File access settings are invalid";
const restriction = "[aria-label='Restrict to listed folders']";

test("an unrelated save preserves the server's repaired, restricted file policy", async () => {
	await withDialog({ settings: null, fileAccessError: warning }, (section, body) => {
		assert.equal(section, "graph");
		return Response.json({ settings: { version: 1, graph: body, agent: { fileAccess: { restricted: true, folders: [] } } } });
	}, async (host, click) => {
		assert.equal(host.querySelector("[data-testid='file-access-config-error']")?.textContent, warning);
		assert.equal(host.querySelector(restriction)?.getAttribute("aria-checked"), "true");
		await click("[data-testid='settings-nav-graph']");
		await click("[data-testid='toggle-extraction-enabled']");
		await click("[data-testid='settings-nav-agent']");
		assert.equal(host.querySelector("[data-testid='file-access-config-error']"), null);
		assert.equal(host.querySelector(restriction)?.getAttribute("aria-checked"), "true");
	});
});

test("a successful agent repair clears the file-access diagnostic", async () => {
	await withDialog({ settings: null, fileAccessError: warning }, (section, body) => {
		assert.equal(section, "agent");
		return Response.json({ settings: { version: 1, agent: body } });
	}, async (host, click) => {
		assert.ok(host.querySelector("[data-testid='file-access-config-error']"));
		await click(restriction);
		assert.equal(host.querySelector("[data-testid='file-access-config-error']"), null);
		assert.equal(host.querySelector(restriction)?.getAttribute("aria-checked"), "false");
	});
});

test("an older unrelated response cannot restore stale file-access state", async () => {
	let finishGraph!: (response: Response) => void;
	const previousAgent = { fileAccess: { restricted: true, folders: [] } };
	await withDialog({ settings: { version: 1, agent: previousAgent } }, (section, body) => {
		if (section === "graph") return new Promise<Response>((resolve) => { finishGraph = resolve; });
		assert.equal(section, "agent");
		return Response.json({ settings: { version: 1, agent: body } });
	}, async (host, click) => {
		await click("[data-testid='settings-nav-graph']");
		await click("[data-testid='toggle-extraction-enabled']");
		await click("[data-testid='settings-nav-agent']");
		await click(restriction);
		assert.equal(host.querySelector(restriction)?.getAttribute("aria-checked"), "false");
		await act(async () => { finishGraph(Response.json({ settings: { version: 1, agent: previousAgent, graph: { enabled: false } }, fileAccessError: warning })); });
		assert.equal(host.querySelector("[data-testid='file-access-config-error']"), null);
		assert.equal(host.querySelector(restriction)?.getAttribute("aria-checked"), "false");
	});
});

test("an agent edit cannot drop a fail-closed policy while an unrelated repair is pending", async () => {
	let finishGraph!: (response: Response) => void;
	let agentWrite: Record<string, unknown> | undefined;
	await withDialog({ settings: null, fileAccessError: warning }, (section, body) => {
		if (section === "graph") return new Promise<Response>((resolve) => { finishGraph = resolve; });
		assert.equal(section, "agent");
		agentWrite = body;
		return Response.json({ settings: { version: 1, agent: body } });
	}, async (host, click) => {
		await click("[data-testid='settings-nav-graph']");
		await click("[data-testid='toggle-extraction-enabled']");
		await click("[data-testid='settings-nav-agent']");
		await click("[aria-label='tool pdf']");
		assert.deepEqual(agentWrite?.fileAccess, { restricted: true, folders: [] });
		await act(async () => { finishGraph(Response.json({ settings: { version: 1, agent: { fileAccess: { restricted: true, folders: [] } }, graph: { enabled: false } } })); });
		assert.equal(host.querySelector(restriction)?.getAttribute("aria-checked"), "true");
	});
});

test("a later agent edit preserves a pending restriction change", async () => {
	const requests: { body: Record<string, unknown>; finish: () => void }[] = [];
	await withDialog({ settings: { version: 1, agent: { fileAccess: { restricted: false, folders: [] } } } }, (section, body) => {
		assert.equal(section, "agent");
		return new Promise<Response>((resolve) => requests.push({ body, finish: () => resolve(Response.json({ settings: { version: 1, agent: body } })) }));
	}, async (host, click) => {
		await click(restriction);
		await click("[aria-label='tool pdf']");
		assert.equal(requests.length, 1);
		await act(async () => { requests[0]!.finish(); });
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[1]!.body.fileAccess, { restricted: true, folders: [] });
		assert.deepEqual(requests[1]!.body.tools, { pdf: false });
		await act(async () => { requests[1]!.finish(); });
		assert.equal(host.querySelector(restriction)?.getAttribute("aria-checked"), "true");
	});
});

test("a queued agent edit respects an explicit repair that turns restriction off", async () => {
	const requests: { body: Record<string, unknown>; finish: () => void }[] = [];
	await withDialog({ settings: null, fileAccessError: warning }, (section, body) => {
		assert.equal(section, "agent");
		return new Promise<Response>((resolve) => requests.push({ body, finish: () => resolve(Response.json({ settings: { version: 1, agent: body } })) }));
	}, async (host, click) => {
		await click(restriction);
		await click("[aria-label='tool pdf']");
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0]!.body.fileAccess, { restricted: false, folders: [] });
		await act(async () => { requests[0]!.finish(); });
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[1]!.body.fileAccess, { restricted: false, folders: [] });
		await act(async () => { requests[1]!.finish(); });
		assert.equal(host.querySelector(restriction)?.getAttribute("aria-checked"), "false");
	});
});

test("a queued folder addition is rebased after a pending removal", async () => {
	const requests: { body: Record<string, unknown>; finish: () => void }[] = [];
	await withDialog({ settings: { version: 1, agent: { fileAccess: { restricted: true, folders: ["~/Study"] } } } }, (section, body) => {
		assert.equal(section, "agent");
		return new Promise<Response>((resolve) => requests.push({ body, finish: () => resolve(Response.json({ settings: { version: 1, agent: body } })) }));
	}, async (host, click) => {
		await click("[data-testid='file-access-remove']");
		const input = host.querySelector<HTMLInputElement>("[data-testid='file-access-add']")!;
		const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"));
		assert.ok(key);
		const props = (input as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!;
		await act(async () => { props.onChange({ target: { value: "~/Study" } }); });
		await click("[data-testid='file-access-add-button']");
		assert.equal(requests.length, 1);
		await act(async () => { requests[0]!.finish(); });
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[1]!.body.fileAccess, { restricted: true, folders: ["~/Study"] });
		await act(async () => { requests[1]!.finish(); });
		assert.equal(host.querySelector("[data-testid='file-access-folder']")?.textContent?.includes("~/Study"), true);
	});
});
