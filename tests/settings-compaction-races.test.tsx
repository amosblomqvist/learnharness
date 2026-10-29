import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { parseCompactionSettingsBody } from "../src/server/settings-body.ts";

(globalThis as Record<string, unknown>).React = React;

const sol = "chatgpt:a:gpt-6.1-sol";
const astra = "chatgpt:a:gpt-6-astra";
const other = "chatgpt:b:gpt-6.1-sol";
const common = { provider: "chatgpt", input: ["text"], supportedLevels: ["off"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 128_000 };
const models = [
	{ ...common, id: "gpt-6.1-sol", name: "Sol", contextWindow: 500_000, defaultContextWindow: 500_000, maxContextWindow: 872_000, contextWindowKey: sol },
	{ ...common, id: "gpt-6-astra", name: "Astra", contextWindow: 500_000, defaultContextWindow: 500_000, maxContextWindow: 872_000, contextWindowKey: astra },
];

async function withDialog(run: (harness: {
	requests: { body: Record<string, unknown>; finish: (ok?: boolean) => void }[];
	commit: (id: string, value: string) => Promise<void>;
	select: (key: string) => Promise<void>;
	saved: () => Record<string, unknown>;
	reopen: () => Promise<void>;
	reads: () => number;
}) => Promise<void>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const globals = globalThis as Record<string, unknown>;
	let saved: Record<string, unknown> = { thresholdTokens: 150_000, contextWindows: { [other]: 400_000 } };
	let reads = 0;
	const requests: { body: Record<string, unknown>; finish: (ok?: boolean) => void }[] = [];
	const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "PUT") {
			assert.equal(url, "/api/settings/compaction");
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			assert.ok(parseCompactionSettingsBody(body).ok);
			return new Promise<Response>((resolve) => requests.push({ body, finish: (ok = true) => {
				if (ok) saved = body;
				resolve(ok ? Response.json({ settings: { version: 1, compaction: saved } }) : Response.json({ error: "save failed" }, { status: 500 }));
			} }));
		}
		if (url === "/api/settings") { reads++; return Response.json({ settings: { version: 1, compaction: saved } }); }
		if (url === "/api/models") return Response.json({ models, slots: { strong: { model: { provider: "chatgpt", id: "gpt-6.1-sol" } }, cheap: null, vision: null } });
		if (url === "/api/search") return Response.json({ available: false, engine: null, reason: "No search engine" });
		if (url === "/api/keys") return Response.json({ keys: [] });
		if (url === "/api/settings/prompts") return Response.json({ prober: [], teacher: [] });
		throw new Error(`Unexpected request ${url}`);
	};
	for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchStub })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	let root = createRoot(document.getElementById("root")!);
	const render = () => root.render(<SettingsDialogBody initialSection="agent" onClose={() => {}} />);
	const reopen = async () => {
		await act(async () => root.unmount());
		root = createRoot(document.getElementById("root")!);
		await act(async () => render());
	};
	// Linkedom does not dispatch React's input change plugin reliably. Call the
	// mounted input handlers, retaining CommitInput's real draft/blur behavior.
	const reactProps = (el: Element) => {
		const key = Object.keys(el).find((name) => name.startsWith("__reactProps$"));
		assert.ok(key);
		return (el as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void; onBlur: () => void }>)[key]!;
	};
	const commit = async (id: string, value: string) => {
		const input = document.querySelector(`[data-testid='${id}']`);
		assert.ok(input);
		await act(async () => { reactProps(input).onChange({ target: { value } }); });
		await act(async () => { reactProps(input).onBlur(); });
	};
	const select = async (key: string) => {
		const input = document.querySelector<HTMLSelectElement>("[data-testid='context-model']");
		assert.ok(input);
		await act(async () => {
			Object.defineProperty(input, "value", { configurable: true, writable: true, value: key });
			input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
	};
	try {
		await act(async () => render());
		await run({ requests, commit, select, saved: () => saved, reopen, reads: () => reads });
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
}

for (const first of ["window", "threshold"] as const) {
	it(`preserves a context window and threshold when ${first} is saved first and its response is delayed`, async () => {
		await withDialog(async ({ requests, commit, saved }) => {
			const window = () => commit("input-context-window", "872000");
			const threshold = () => commit("input-compaction-threshold", "800000");
			if (first === "window") { await window(); await threshold(); }
			else { await threshold(); await window(); }
			assert.equal(requests.length, 1, "the second section write waits for the first");
			await act(async () => { requests[0]!.finish(); });
			assert.equal(requests.length, 2);
			const expected = { thresholdTokens: 800_000, contextWindows: { [other]: 400_000, [sol]: 872_000 } };
			assert.deepEqual(requests[1]!.body, expected);
			await act(async () => { requests[1]!.finish(); });
			assert.deepEqual(saved(), expected);
		});
	});
}

it("preserves overlapping window edits for different models", async () => {
	await withDialog(async ({ requests, commit, select, saved }) => {
		await commit("input-context-window", "700000");
		await select(astra);
		await commit("input-context-window", "800000");
		assert.equal(requests.length, 1);
		await act(async () => { requests[0]!.finish(); });
		const expected = { thresholdTokens: 150_000, contextWindows: { [other]: 400_000, [sol]: 700_000, [astra]: 800_000 } };
		assert.deepEqual(requests[1]!.body, expected);
		await act(async () => { requests[1]!.finish(); });
		assert.deepEqual(saved(), expected);
	});
});

it("removes a pending window override without losing a threshold edit", async () => {
	await withDialog(async ({ requests, commit, saved }) => {
		await commit("input-context-window", "700000");
		await commit("input-compaction-threshold", "800000");
		await commit("input-context-window", "");
		assert.equal(requests.length, 1);
		await act(async () => { requests[0]!.finish(); });
		await act(async () => { requests[1]!.finish(); });
		assert.deepEqual(requests[2]!.body, { thresholdTokens: 800_000, contextWindows: { [other]: 400_000 } });
		await act(async () => { requests[2]!.finish(); });
		assert.deepEqual(saved(), { thresholdTokens: 800_000, contextWindows: { [other]: 400_000 } });
	});
});

it("applies a later compaction edit after a failed write and reports the failure", async () => {
	await withDialog(async ({ requests, commit, saved }) => {
		await commit("input-context-window", "700000");
		await commit("input-compaction-threshold", "800000");
		assert.equal(requests.length, 1);
		await act(async () => { requests[0]!.finish(false); });
		assert.deepEqual(requests[1]!.body, { thresholdTokens: 800_000, contextWindows: { [other]: 400_000 } });
		await act(async () => { requests[1]!.finish(); });
		assert.deepEqual(saved(), { thresholdTokens: 800_000, contextWindows: { [other]: 400_000 } });
		assert.match(document.querySelector("[data-testid='settings-error']")?.textContent ?? "", /compaction: save failed/);
	});
});

it("waits for a closed dialog's compaction writes before reopening", async () => {
	await withDialog(async ({ requests, commit, saved, reopen, reads }) => {
		await commit("input-context-window", "700000");
		await commit("input-compaction-threshold", "800000");
		await reopen();
		assert.equal(reads(), 1, "the reopened dialog must not read a stale record");
		assert.match(document.body.textContent ?? "", /Loading settings/);
		await act(async () => { requests[0]!.finish(); });
		assert.equal(reads(), 1);
		await act(async () => { requests[1]!.finish(); });
		assert.equal(reads(), 2);
		await commit("input-context-window", "650000");
		assert.deepEqual(requests[2]!.body, { thresholdTokens: 800_000, contextWindows: { [other]: 400_000, [sol]: 650_000 } });
		await act(async () => { requests[2]!.finish(); });
		assert.deepEqual(saved(), { thresholdTokens: 800_000, contextWindows: { [other]: 400_000, [sol]: 650_000 } });
	});
});
