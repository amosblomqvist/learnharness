/**
 * Settings → Providers → Dictation → Local (on this device): the engine choice, the
 * language rows, the recommended picks and the model list with its download flow.
 * The model routes are a fake server (huggingface.co is never contacted), and the
 * poll runs on a fake timer.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DictationEngineSettings, DictationSetupHint } from "../components/dictation-engine.tsx";
import { DictationLanguageRows } from "../components/settings/dictation-local.tsx";
import { formatWait, licenseInfo, matchesModelSearch, showsChineseOutput } from "../components/settings/dictation-local-model.ts";
import { setDictationActive } from "../components/dictation-state.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import {
	CATALOG_MODELS, GROQ_DICTATION_HEADER, LANGUAGE_DETECTION_MODEL, autoLanguagePolicy, getCatalogModel, languageAccuracyGrade,
	modelMatchesLanguage, modelWaitSeconds, recommendModels, requiresLanguageDetector, speedMeterLevel,
	type LocalModelStatus, type MachineTier, type UserSettings,
} from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout,
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 900 });
Object.assign(dom.document, { oninput: null });
let focused: Element = dom.document.body;
Object.defineProperty(dom.document, "activeElement", { get: () => focused });
dom.window.HTMLElement.prototype.focus = function () { focused = this; };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

type Server = ReturnType<typeof fixture>;

const idle = (id: string): LocalModelStatus => ({ id, installed: false, partialBytes: 0, download: null });

function fixture(options: {
	dictation?: UserSettings["dictation"]; tier?: MachineTier; installed?: string[]; detectorInstalled?: boolean;
	engineError?: string; failWrite?: boolean; failList?: boolean;
} = {}) {
	const state = {
		record: { version: 1, ...(options.dictation ? { dictation: options.dictation } : {}) } as UserSettings,
		puts: [] as Record<string, unknown>[],
		lists: 0,
		posts: [] as { id: string; body: unknown; headers: Record<string, string> }[],
		deletes: [] as string[],
		tier: options.tier ?? "cpu",
		engineError: options.engineError,
		failWrite: options.failWrite ?? false,
		failList: options.failList ?? false,
		failPost: undefined as { status: number; message: string } | undefined,
		statuses: new Map<string, LocalModelStatus>([
			...CATALOG_MODELS.map((model): [string, LocalModelStatus] => [model.id, { ...idle(model.id), installed: (options.installed ?? []).includes(model.id) }]),
			[LANGUAGE_DETECTION_MODEL.id, { ...idle(LANGUAGE_DETECTION_MODEL.id), installed: options.detectorInstalled ?? false }],
		]),
		snapshot() {
			return {
				hardwareTier: this.tier, engineAvailable: !this.engineError, ...(this.engineError ? { engineError: this.engineError } : {}),
				models: CATALOG_MODELS.map((model) => this.statuses.get(model.id)!), languageDetector: this.statuses.get(LANGUAGE_DETECTION_MODEL.id)!,
			};
		},
	};
	const headersOf = (init?: RequestInit) => Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url === "/api/settings") return Response.json({ settings: state.record });
		if (url === "/api/settings/dictation") {
			state.puts.push(JSON.parse(init!.body as string));
			if (state.failWrite) return Response.json({}, { status: 500 });
			state.record = { ...state.record, dictation: state.puts.at(-1) as UserSettings["dictation"] };
			return Response.json({ settings: state.record });
		}
		if (url === "/api/stt/local/models") {
			assert.equal(headersOf(init)[GROQ_DICTATION_HEADER], "1", "the same-origin header travels with every read");
			state.lists++;
			if (state.failList) return Response.json({ message: "nope", retryable: true }, { status: 500 });
			return Response.json(state.snapshot());
		}
		if (url.startsWith("/api/stt/local/models/")) {
			const id = decodeURIComponent(url.slice("/api/stt/local/models/".length));
			const status = state.statuses.get(id)!;
			if (init?.method === "DELETE") {
				state.deletes.push(id);
				state.statuses.set(id, idle(id));
				return Response.json({ model: state.statuses.get(id) });
			}
			const body = JSON.parse(init!.body as string) as { action: string };
			state.posts.push({ id, body, headers: headersOf(init) });
			if (state.failPost) return Response.json({ message: state.failPost.message, retryable: false }, { status: state.failPost.status });
			const total = getCatalogModel(id)?.size ?? LANGUAGE_DETECTION_MODEL.size;
			if (body.action === "download") state.statuses.set(id, { ...status, download: { state: "downloading", bytes: Math.ceil(total / 10), total } });
			if (body.action === "cancel") state.statuses.set(id, { ...status, partialBytes: status.download?.bytes ?? 0, download: null });
			return Response.json({ model: state.statuses.get(id) });
		}
		throw new Error(`unexpected fetch ${url}`);
	}) as typeof fetch;
	return state;
}

async function mount(element: React.ReactNode) {
	const { createRoot } = await import("react-dom/client");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(element));
	await act(async () => { notifySettingsSaved("dictation"); });
	await settle();
}

/** Let the fake server's replies and the state they trigger land. */
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); });

afterEach(async () => {
	mock.timers.reset();
	await act(async () => { setDictationActive(false); root?.unmount(); });
	host?.remove();
	root = host = undefined;
	globalThis.fetch = realFetch;
	focused = document.body;
});

/** What has focus, by test id: a failed assertion on the element itself would print the whole DOM. */
const focusedId = () => document.activeElement?.getAttribute?.("data-testid") ?? null;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string) => { const element = byTest(id); assert.ok(element, `${id} is rendered`); return element; };
const select = (id: string) => byTest(id) as HTMLSelectElement;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); await settle(); };
const rowOf = (id: string) => must(`local-model-${id}`);
const within = (element: Element, id: string) => element.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function choose(id: string, value: string) {
	const element = select(id);
	await act(async () => {
		Object.defineProperty(element, "value", { configurable: true, writable: true, value });
		element.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
	await settle();
}
async function typeInto(id: string, value: string) {
	const element = must(id) as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}
async function key(element: Element, value: string) {
	await act(async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: value });
		element.dispatchEvent(event);
	});
	await settle();
}
/** A controlled checkbox: this DOM does not toggle `checked` on a click, so flip it as a browser would first. */
async function toggleCheckbox(id: string) {
	const box = must(id) as HTMLInputElement;
	await act(async () => {
		box.checked = !box.checked;
		box.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
	await settle();
}

const Rows = () => <><DictationEngineSettings /><DictationLanguageRows /><DictationSetupHint /></>;
const local = (extra: NonNullable<UserSettings["dictation"]> extends infer D ? Partial<D> : never = {}) =>
	({ language: "en", provider: "local", ...extra }) as UserSettings["dictation"];

const modelIds = (container: Element) => [...container.querySelectorAll<HTMLElement>('[data-testid^="local-model-"][data-phase]')].map((el) => el.getAttribute("data-testid")!.slice("local-model-".length));

// ── engine choice and which rows show ───────────────────────────────────────

test("the engine select offers Local, and the Local rows show only for Local", async () => {
	const f = fixture({ dictation: { language: "pl" } });
	await mount(<Rows />);
	assert.deepEqual([...select("select-dictation-engine").options].map((o) => [o.value, o.textContent]),
		[["deepgram", "Deepgram"], ["groq", "Groq (Whisper)"], ["local", "Local (on this device)"]]);
	assert.equal(select("select-dictation-engine").value, "deepgram", "Deepgram stays the default");
	assert.ok(byTest("row-dictation-language"), "Deepgram keeps the single Language row");
	for (const id of ["row-local-languages", "local-models", "row-local-language", "row-local-chinese"]) assert.equal(byTest(id), null, id);
	assert.equal(f.lists, 0, "no model list is read for engines that do not use it");

	await choose("select-dictation-engine", "groq");
	assert.ok(byTest("row-dictation-language"));
	assert.equal(byTest("row-local-languages"), null);

	await choose("select-dictation-engine", "local");
	assert.deepEqual(f.puts.at(-1), { language: "pl", provider: "local" });
	assert.ok(byTest("row-local-languages"));
	assert.ok(byTest("local-models"));
	assert.equal(byTest("row-dictation-language"), null, "Local replaces the single Language row with its own rows");
	assert.equal(byTest("dictation-setup-hint")!.getAttribute("data-engine"), "local");
	assert.equal(f.lists >= 1, true);
});

test("the preferred languages follow the dictation language until changed, and Multilingual starts at English", async () => {
	fixture({ dictation: local({ language: "de" }) });
	await mount(<Rows />);
	assert.equal(must("local-languages-toggle").textContent, "German▾");
	await act(async () => { root!.unmount(); });
	fixture({ dictation: local({ language: "multi" }) });
	await mount(<Rows />);
	assert.equal(must("local-languages-toggle").textContent, "English▾");
});

// ── recommendations, filter and rows ────────────────────────────────────────

test("the recommended picks for the preferred languages come first, tagged Best, Fast and Accurate", async () => {
	fixture({ dictation: local({ localPreferredLanguages: ["en", "de"] }) });
	await mount(<Rows />);
	const picks = recommendModels(CATALOG_MODELS, ["en", "de"]);
	assert.ok(picks.length > 0 && picks.every((pick) => pick.status === "eligible"));
	const section = must("local-recommended");
	assert.deepEqual(modelIds(section), picks.map((pick) => pick.model.id));
	assert.match(section.textContent!, /Recommended for English \+ German/);
	for (const pick of picks) {
		const tag = within(rowOf(pick.model.id), "local-model-roles")!.textContent!;
		for (const role of pick.roles) assert.ok(tag.toLowerCase().includes(role), `${pick.model.id} is tagged ${role}`);
	}
	const all = modelIds(must("local-all-models"));
	for (const pick of picks) assert.equal(all.includes(pick.model.id), false, "a pick is listed once");
	assert.equal(new Set(all).size, all.length);
});

test("an experimental, unsupported or unbenchmarked language gets a plain note, and only the experimental one gets a pick", async () => {
	// Welsh: Whisper is the best we measured, but not good enough to recommend plainly.
	// Irish: nothing we tested is usable. Basque: model cards claim it, nothing is measured.
	for (const [language, status, picks, note] of [
		["cy", "experimental", true, /Experimental: this is the best option we found for Welsh, but it may make frequent mistakes in Welsh\./],
		["ga", "unsupported", false, /No model we tested is likely to give a usable transcript for Irish/],
		["eu", "unbenchmarked", false, /we have no accuracy measurements for it/],
	] as const) {
		assert.equal(recommendModels(CATALOG_MODELS, [language])[0]!.status, status);
		fixture({ dictation: local({ localPreferredLanguages: [language] }) });
		await mount(<Rows />);
		assert.match(must("local-pick-notice").textContent!, note, language);
		assert.equal(byTest("local-recommended") !== null, picks, language);
		if (picks) assert.match(must("local-recommended").textContent!, /Experimental option for Welsh/);
		assert.ok(byTest("local-all-models"), "the full list is still there to browse");
		await act(async () => { root!.unmount(); });
		host!.remove();
	}
});

test("the speed meter shows the wait for the machine's tier", async () => {
	const model = CATALOG_MODELS.find((m) => modelWaitSeconds(m, "cpu") !== undefined && modelWaitSeconds(m, "accelerated") !== undefined
		&& speedMeterLevel(modelWaitSeconds(m, "cpu")!) !== speedMeterLevel(modelWaitSeconds(m, "accelerated")!) && modelMatchesLanguage(m, "en"))!;
	assert.ok(model, "the catalog has a model whose bars differ by tier");
	for (const tier of ["cpu", "accelerated"] as const) {
		fixture({ dictation: local(), tier });
		await mount(<Rows />);
		await typeInto("local-model-filter", model.id);
		const meter = within(rowOf(model.id), "local-model-speed")!;
		const wait = modelWaitSeconds(model, tier)!;
		assert.equal(meter.getAttribute("data-level"), String(speedMeterLevel(wait)), tier);
		assert.match(meter.getAttribute("aria-label")!, new RegExp(`${formatWait(wait).replace(/[~.]/g, "\\$&")} for 30 seconds`));
		await act(async () => { root!.unmount(); });
		host!.remove();
	}
});

test("the filter searches the whole catalog by name and family", async () => {
	fixture({ dictation: local() });
	await mount(<Rows />);
	const total = CATALOG_MODELS.length;
	await typeInto("local-model-filter", "whisper");
	const expected = CATALOG_MODELS.filter((m) => matchesModelSearch(m, "whisper"));
	assert.ok(expected.length >= 4);
	assert.deepEqual(new Set(modelIds(must("local-all-models"))), new Set(expected.map((m) => m.id)));
	assert.equal(must("local-model-count").textContent!.trim(), `${expected.length} of ${total} models match`);
	// Every word has to match: a name plus its family narrows, nonsense finds nothing.
	await typeInto("local-model-filter", "whisper turbo");
	assert.deepEqual(modelIds(must("local-all-models")), ["whisper-large-v3-turbo"]);
	await typeInto("local-model-filter", "zzzz");
	assert.match(must("local-all-models").textContent!, /No models match/);
	await key(must("local-model-filter"), "Escape");
	assert.equal(byTest("local-model-count"), null, "Escape clears the filter");
	assert.equal((must("local-model-filter") as HTMLInputElement).value, "");
});

test("a model that lacks one of the languages is folded away until asked for, and found by the filter", async () => {
	fixture({ dictation: local({ localPreferredLanguages: ["en", "de"] }) });
	await mount(<Rows />);
	const english = CATALOG_MODELS.find((m) => m.languages.length === 1 && m.languages[0] === "en")!;
	assert.equal(byTest(`local-model-${english.id}`), null, "an English-only model is not listed for English and German");
	await click(must("local-folded-toggle"));
	assert.ok(within(must("local-folded-models"), `local-model-${english.id}`));
	assert.match(within(rowOf(english.id), "local-model-missing")!.textContent!, /Doesn't cover German/);
	await click(must("local-folded-toggle"));
	assert.equal(byTest("local-folded-models"), null);
	await typeInto("local-model-filter", english.name);
	assert.ok(byTest(`local-model-${english.id}`), "the filter reaches models that are folded");
});

test("a row shows the grade, speed, size and licence, and none of them where there is no benchmark", async () => {
	fixture({ dictation: local() });
	await mount(<Rows />);
	const model = getCatalogModel("whisper-large-v3-turbo")!;
	await typeInto("local-model-filter", model.id);
	const row = rowOf(model.id);
	const grade = languageAccuracyGrade(model, "en")!;
	assert.equal(within(row, "local-model-grade")!.getAttribute("data-letter"), grade.letter);
	assert.match(within(row, "local-model-grade")!.getAttribute("aria-label")!, new RegExp(`English accuracy ${grade.label}`));
	assert.ok(within(row, "local-model-speed"));
	assert.match(within(row, "local-model-size")!.textContent!, /^\d+(\.\d)? (MiB|GiB)$/);
	assert.equal(within(row, "local-model-license")!.textContent, "Apache 2.0");
	assert.equal(within(row, "local-model-license")!.querySelector("a"), null);
	assert.match(row.textContent!, new RegExp(model.description.slice(0, 20)));

	// A model with no benchmark for the language shows no grade (and no speed it was never measured at).
	const unmeasured = getCatalogModel("Breeze-ASR-25")!;
	assert.ok(modelMatchesLanguage(unmeasured, "ru") && languageAccuracyGrade(unmeasured, "ru") === undefined);
	await act(async () => { root!.unmount(); });
	host!.remove();
	fixture({ dictation: local({ localPreferredLanguages: ["ru"] }) });
	await mount(<Rows />);
	await typeInto("local-model-filter", unmeasured.id);
	assert.equal(within(rowOf(unmeasured.id), "local-model-grade"), null);
	assert.ok(within(rowOf(unmeasured.id), "local-model-size"), "size and licence still show");
});

test("licences read as names, and a custom one links to the model's page in a new tab", async () => {
	assert.deepEqual(licenseInfo({ license: "apache-2.0", repository: "a/b" }), { label: "Apache 2.0" });
	assert.deepEqual(licenseInfo({ license: "cc-by-4.0", repository: "a/b" }), { label: "CC-BY 4.0" });
	assert.deepEqual(licenseInfo({ license: "mit", repository: "a/b" }), { label: "MIT" });
	assert.deepEqual(licenseInfo({ license: "other", repository: "nvidia/medasr" }), { label: "Custom licence", href: "https://huggingface.co/nvidia/medasr" });
	assert.deepEqual(licenseInfo({ license: "gpl-3.0", repository: "a/b" }), { label: "gpl-3.0" }, "an unknown id is shown as it is");

	fixture({ dictation: local() });
	await mount(<Rows />);
	const custom = CATALOG_MODELS.find((m) => m.license === "other" && modelMatchesLanguage(m, "en"))!;
	await typeInto("local-model-filter", custom.id);
	const link = within(rowOf(custom.id), "local-model-license")!.querySelector("a")!;
	assert.equal(link.textContent, "Custom licence");
	assert.equal(link.getAttribute("href"), `https://huggingface.co/${custom.repository}`);
	assert.equal(link.getAttribute("target"), "_blank");
	assert.match(link.getAttribute("rel")!, /noreferrer/);
	for (const [license, label] of [["cc-by-4.0", "CC-BY 4.0"], ["mit", "MIT"]] as const) {
		const other = CATALOG_MODELS.find((m) => m.license === license)!;
		await typeInto("local-model-filter", other.id);
		assert.equal(within(rowOf(other.id), "local-model-license")!.textContent, label);
	}
});

test("the rating guide opens from a button that says it is expanded", async () => {
	fixture({ dictation: local(), tier: "accelerated" });
	await mount(<Rows />);
	const toggle = must("local-ratings-toggle");
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(byTest("local-ratings-help"), null);
	await click(toggle);
	assert.equal(toggle.getAttribute("aria-expanded"), "true");
	const help = must("local-ratings-help").textContent!;
	assert.match(help, /Very few mistakes/);
	assert.match(help, /30 seconds of audio/);
	assert.match(help, /graphics acceleration/);
	assert.match(help, /Best.*Fast.*Accurate/);
});

// ── download, progress, cancel, use, delete ─────────────────────────────────

test("download shows progress from the poll, Cancel keeps the partial, Use sets the model and Delete clears it", async () => {
	const model = getCatalogModel("whisper-small")!;
	const f = fixture({ dictation: local() });
	await mount(<Rows />);
	await typeInto("local-model-filter", model.id);
	const row = () => rowOf(model.id);
	assert.equal(row().getAttribute("data-phase"), "idle");

	mock.timers.enable({ apis: ["setTimeout"] });
	await click(within(row(), `local-model-${model.id}-download`)!);
	assert.deepEqual(f.posts.map(({ id, body }) => [id, body]), [[model.id, { action: "download" }]]);
	assert.equal(f.posts[0]!.headers[GROQ_DICTATION_HEADER], "1");
	assert.equal(row().getAttribute("data-phase"), "downloading");
	const bar = within(row(), `local-model-${model.id}-progress`)!;
	assert.equal(bar.getAttribute("role"), "progressbar");
	assert.equal(bar.getAttribute("aria-valuenow"), "10");
	assert.equal(focusedId(), `local-model-${model.id}-cancel`, "focus moves to Cancel when Download goes away");

	// The server makes progress; the next poll shows it.
	const lists = f.lists;
	f.statuses.set(model.id, { ...idle(model.id), download: { state: "downloading", bytes: Math.floor(model.size / 2), total: model.size } });
	await act(async () => { mock.timers.tick(750); });
	await settle();
	assert.equal(f.lists, lists + 1);
	assert.equal(within(row(), `local-model-${model.id}-progress`)!.getAttribute("aria-valuenow"), "50");
	assert.match(within(row(), `local-model-${model.id}-progress-text`)!.textContent!, /of/);

	// Cancel: the partial stays, so the row offers Resume with what is left.
	await click(within(row(), `local-model-${model.id}-cancel`)!);
	assert.deepEqual(f.posts.at(-1)!.body, { action: "cancel" });
	assert.equal(row().getAttribute("data-phase"), "idle");
	assert.equal(within(row(), `local-model-${model.id}-download`)!.textContent, "Resume");
	assert.match(within(row(), `local-model-${model.id}-left`)!.textContent!, /^\d+ MiB left$/);
	const afterCancel = f.lists;
	await act(async () => { mock.timers.tick(5000); });
	assert.equal(f.lists, afterCancel, "nothing is polled once no download runs");

	// Resume, then the server finishes the file: verifying, then installed.
	await click(within(row(), `local-model-${model.id}-download`)!);
	f.statuses.set(model.id, { ...idle(model.id), download: { state: "verifying", bytes: model.size, total: model.size } });
	await act(async () => { mock.timers.tick(750); });
	await settle();
	assert.equal(row().getAttribute("data-phase"), "verifying");
	assert.equal(within(row(), `local-model-${model.id}-progress`)!.getAttribute("aria-valuenow"), null, "verifying has no percentage");
	assert.equal(within(row(), `local-model-${model.id}-cancel`), null);
	f.statuses.set(model.id, { ...idle(model.id), installed: true });
	await act(async () => { mock.timers.tick(750); });
	await settle();
	assert.equal(row().getAttribute("data-phase"), "installed");
	assert.equal(f.puts.length, 0, "downloading alone changes no setting");

	// Use: saves the model with a language that suits it.
	await click(within(row(), `local-model-${model.id}-use`)!);
	assert.deepEqual(f.puts.at(-1), { language: "en", provider: "local", localModel: model.id });
	assert.equal(row().getAttribute("data-phase"), "in-use");
	const inUse = within(row(), `local-model-${model.id}-in-use`)!;
	assert.equal(inUse.textContent, "✓ In use");
	assert.equal(inUse.getAttribute("aria-disabled"), "true", "focusable, so pressing Use does not drop focus");
	assert.equal(focusedId(), `local-model-${model.id}-in-use`);

	// Delete asks first; Keep backs out, Delete removes it and clears the setting.
	await click(within(row(), `local-model-${model.id}-delete`)!);
	assert.match(within(row(), `local-model-${model.id}-confirm`)!.textContent!, /Delete Whisper Small\?.*no model until you choose another/);
	assert.equal(focusedId(), `local-model-${model.id}-delete-keep`);
	assert.deepEqual(f.deletes, []);
	await click(within(row(), `local-model-${model.id}-delete-keep`)!);
	assert.equal(row().getAttribute("data-phase"), "in-use");
	assert.equal(focusedId(), `local-model-${model.id}-delete`);
	await click(within(row(), `local-model-${model.id}-delete`)!);
	await click(within(row(), `local-model-${model.id}-delete-confirm`)!);
	assert.deepEqual(f.deletes, [model.id]);
	assert.deepEqual(f.puts.at(-1), { language: "en", provider: "local" }, "the deleted model is no longer chosen");
	assert.equal(row().getAttribute("data-phase"), "idle");
	assert.equal(focusedId(), `local-model-${model.id}-download`);
});

test("Escape leaves the delete confirmation and returns to the Delete button", async () => {
	const model = getCatalogModel("whisper-small")!;
	const f = fixture({ dictation: local({ localModel: model.id }), installed: [model.id] });
	await mount(<Rows />);
	await typeInto("local-model-filter", model.id);
	await click(within(rowOf(model.id), `local-model-${model.id}-delete`)!);
	assert.ok(within(rowOf(model.id), `local-model-${model.id}-confirm`));
	await key(within(rowOf(model.id), `local-model-${model.id}-delete-keep`)!, "Escape");
	assert.equal(within(rowOf(model.id), `local-model-${model.id}-confirm`), null);
	assert.equal(focusedId(), `local-model-${model.id}-delete`);
	assert.deepEqual(f.deletes, []);
});

test("a download error shows inline with Retry, and the row's own failure is not lost", async () => {
	const model = getCatalogModel("whisper-small")!;
	const f = fixture({ dictation: local() });
	f.statuses.set(model.id, { ...idle(model.id), partialBytes: 1000, download: { state: "error", bytes: 1000, total: model.size, message: "The connection dropped. Try again." } });
	await mount(<Rows />);
	await typeInto("local-model-filter", model.id);
	assert.equal(within(rowOf(model.id), `local-model-${model.id}-error`)!.getAttribute("role"), "alert");
	assert.match(within(rowOf(model.id), `local-model-${model.id}-error`)!.textContent!, /connection dropped/);
	assert.equal(within(rowOf(model.id), `local-model-${model.id}-download`)!.textContent!.startsWith("Retry"), true);
	// A refused request (the server's own sentence) shows too.
	f.failPost = { status: 403, message: "Dictation requests must come from the LearnHarness window." };
	await click(within(rowOf(model.id), `local-model-${model.id}-download`)!);
	assert.match(within(rowOf(model.id), `local-model-${model.id}-error`)!.textContent!, /must come from the LearnHarness window/);
});

test("polling stops when the Settings section unmounts", async () => {
	const model = getCatalogModel("whisper-small")!;
	const f = fixture({ dictation: local() });
	f.statuses.set(model.id, { ...idle(model.id), download: { state: "downloading", bytes: 100, total: model.size } });
	mock.timers.enable({ apis: ["setTimeout"] });
	await mount(<Rows />);
	await act(async () => { mock.timers.tick(750); });
	await settle();
	const seen = f.lists;
	assert.ok(seen >= 2, "the download is being polled");
	await act(async () => { root!.unmount(); });
	root = undefined;
	await act(async () => { mock.timers.tick(10_000); });
	await settle();
	assert.equal(f.lists, seen, "no request after unmount");
});

test("an unavailable engine, a failed list and a model that is no longer on disk are all said plainly", async () => {
	const model = getCatalogModel("whisper-small")!;
	const f = fixture({ dictation: local({ localModel: model.id }), engineError: "The native library did not load." });
	await mount(<Rows />);
	assert.match(must("local-engine-error").textContent!, /can't run on this computer: The native library did not load\./);
	assert.match(must("local-missing-model").textContent!, /Whisper Small, isn't downloaded/);
	await act(async () => { root!.unmount(); });
	host!.remove();
	const g = fixture({ dictation: local(), failList: true });
	await mount(<Rows />);
	assert.match(must("local-models-error").textContent!, /Could not load the model list/);
	assert.equal(byTest("local-all-models"), null);
	g.failList = false;
	await click(must("local-models-retry"));
	assert.equal(byTest("local-models-error"), null);
	assert.ok(byTest("local-all-models"));
	void f;
});

// ── language rows ───────────────────────────────────────────────────────────

test("the transcription language offers Auto only where the language policy allows it", async () => {
	const native = getCatalogModel("whisper-small")!;
	const external = CATALOG_MODELS.find((m) => !m.capabilities.languageDetection && modelMatchesLanguage(m, "en") && modelMatchesLanguage(m, "de")
		&& autoLanguagePolicy(m, ["en", "de"]).kind === "detect")!;
	const options = () => [...select("select-local-language").options].map((o) => o.value);

	// No model yet: nothing to choose a language for.
	fixture({ dictation: local() });
	await mount(<Rows />);
	assert.equal(byTest("row-local-language"), null);
	await act(async () => { root!.unmount(); });
	host!.remove();

	// Native detection: Auto even for one language.
	fixture({ dictation: local({ localModel: native.id }), installed: [native.id] });
	await mount(<Rows />);
	assert.equal(options()[0], "auto");
	assert.equal(select("select-local-language").options[0]!.textContent, "Auto detect");
	assert.equal(options().length, 1 + new Set(native.languages).size);
	await act(async () => { root!.unmount(); });
	host!.remove();

	// The detector needs two or more of the learner's languages: with one, Auto is hidden.
	fixture({ dictation: local({ localModel: external.id, localPreferredLanguages: ["en"], localLanguage: "en" }), installed: [external.id] });
	await mount(<Rows />);
	assert.equal(options().includes("auto"), false);
	assert.equal(select("select-local-language").value, "en");
	assert.equal(byTest("local-detector"), null);
	await act(async () => { root!.unmount(); });
	host!.remove();

	// With two it is offered.
	fixture({ dictation: local({ localModel: external.id, localPreferredLanguages: ["en", "de"], localLanguage: "en" }), installed: [external.id] });
	await mount(<Rows />);
	assert.equal(options()[0], "auto");
	assert.match(must("row-local-language").textContent!, /Auto picks English or German for each recording\./);

	await act(async () => { root!.unmount(); });
	host!.remove();

	// A language the detector cannot identify takes Auto away, and the row says why.
	const irish = getCatalogModel("Fun-ASR-MLT-Nano-2512")!;
	fixture({ dictation: local({ localModel: irish.id, localPreferredLanguages: ["en", "ga"], localLanguage: "en" }), installed: [irish.id] });
	await mount(<Rows />);
	assert.equal(options().includes("auto"), false);
	await typeInto("local-model-filter", irish.id);
	assert.match(rowOf(irish.id).textContent!, /Auto detect is unavailable for your preferred languages because it can't detect Irish\./);
});

test("the transcription language lists the learner's languages first and saves the choice", async () => {
	const external = CATALOG_MODELS.find((m) => !m.capabilities.languageDetection && modelMatchesLanguage(m, "en") && modelMatchesLanguage(m, "pl")
		&& autoLanguagePolicy(m, ["pl", "en"]).kind === "detect")!;
	const f = fixture({ dictation: local({ localModel: external.id, localPreferredLanguages: ["pl", "en"] }), installed: [external.id], detectorInstalled: true });
	await mount(<Rows />);
	const values = [...select("select-local-language").options].map((o) => o.value);
	assert.deepEqual(values.slice(0, 3), ["auto", "en", "pl"], "Auto, then the preferred languages, alphabetically");
	await choose("select-local-language", "pl");
	assert.deepEqual(f.puts.at(-1), { language: "en", provider: "local", localModel: external.id, localPreferredLanguages: ["pl", "en"], localLanguage: "pl" });
	assert.equal(select("select-local-language").value, "pl");
});

test("Auto that needs the language detector offers its download, with progress", async () => {
	const external = CATALOG_MODELS.find((m) => requiresLanguageDetector(m) && autoLanguagePolicy(m, ["en", "de"]).kind === "detect")!;
	const f = fixture({ dictation: local({ localModel: external.id, localPreferredLanguages: ["en", "de"] }), installed: [external.id] });
	await mount(<Rows />);
	const panel = must("local-detector");
	assert.match(panel.textContent!, /small language detector \(\d+ MiB\)/);
	assert.match(panel.textContent!, /Until it is downloaded, dictation uses English/);

	mock.timers.enable({ apis: ["setTimeout"] });
	await click(must("local-detector-download"));
	assert.deepEqual(f.posts.map(({ id, body }) => [id, body]), [[LANGUAGE_DETECTION_MODEL.id, { action: "download" }]]);
	assert.equal(must("local-detector-progress").getAttribute("aria-valuenow"), "10");
	f.statuses.set(LANGUAGE_DETECTION_MODEL.id, { ...idle(LANGUAGE_DETECTION_MODEL.id), installed: true });
	await act(async () => { mock.timers.tick(750); });
	await settle();
	assert.equal(byTest("local-detector"), null, "installed: nothing left to ask for");
});

test("the detector download is not offered when Auto is not what is chosen, or the model detects itself", async () => {
	const external = CATALOG_MODELS.find((m) => requiresLanguageDetector(m) && autoLanguagePolicy(m, ["en", "de"]).kind === "detect")!;
	fixture({ dictation: local({ localModel: external.id, localPreferredLanguages: ["en", "de"], localLanguage: "de" }), installed: [external.id] });
	await mount(<Rows />);
	assert.equal(byTest("local-detector"), null);
	await act(async () => { root!.unmount(); });
	host!.remove();
	const native = getCatalogModel("whisper-small")!;
	fixture({ dictation: local({ localModel: native.id, localPreferredLanguages: ["en", "de"] }), installed: [native.id] });
	await mount(<Rows />);
	assert.equal(byTest("local-detector"), null);
});

test("the Chinese output row shows only when Chinese can come out, and saves the script", async () => {
	for (const [name, record, shown] of [
		["English only", local(), false],
		["Mandarin preferred", local({ localPreferredLanguages: ["en", "zh"] }), true],
		["Cantonese preferred", local({ localPreferredLanguages: ["yue"] }), true],
	] as const) {
		fixture({ dictation: record });
		await mount(<Rows />);
		assert.equal(byTest("row-local-chinese") !== null, shown, name);
		await act(async () => { root!.unmount(); });
		host!.remove();
	}
	// Also when the chosen language is Chinese, whatever the preferences say.
	const model = getCatalogModel("whisper-small")!;
	fixture({ dictation: local({ localModel: model.id, localLanguage: "zh" }), installed: [model.id] });
	await mount(<Rows />);
	assert.ok(byTest("row-local-chinese"));
	assert.equal(showsChineseOutput(["en"], "auto"), false);
	assert.equal(showsChineseOutput(["en"], "zh"), true);
	await act(async () => { root!.unmount(); });
	host!.remove();

	const f = fixture({ dictation: local({ localPreferredLanguages: ["zh"] }) });
	await mount(<Rows />);
	assert.deepEqual([...select("select-local-chinese").options].map((o) => [o.value, o.textContent]), [["simplified", "Simplified"], ["traditional", "Traditional (Taiwan)"]]);
	assert.equal(select("select-local-chinese").value, "simplified");
	await choose("select-local-chinese", "traditional");
	assert.deepEqual(f.puts.at(-1), { language: "en", provider: "local", localPreferredLanguages: ["zh"], localChineseOutput: "traditional" });
	await choose("select-local-chinese", "simplified");
	assert.equal("localChineseOutput" in f.puts.at(-1)!, false, "the default is not stored");
});

// ── saving ──────────────────────────────────────────────────────────────────

test("preferred languages save with the language re-resolved for the chosen model", async () => {
	const external = CATALOG_MODELS.find((m) => requiresLanguageDetector(m) && autoLanguagePolicy(m, ["en", "de"]).kind === "detect")!;
	const f = fixture({ dictation: local({ localModel: external.id, localPreferredLanguages: ["en", "de"], localLanguage: "auto" }), installed: [external.id], detectorInstalled: true });
	await mount(<Rows />);
	assert.match(must("local-languages-toggle").textContent!, /English and German/);
	await click(must("local-languages-toggle"));
	// Dropping German leaves one language: Auto no longer applies to this model, so a language is fixed.
	await toggleCheckbox("local-language-de");
	assert.deepEqual(f.puts.at(-1), { language: "en", provider: "local", localModel: external.id, localLanguage: "en" });
	assert.equal(must("local-languages-toggle").textContent, "English▾");
	assert.equal(select("select-local-language").value, "en");
	// Adding one saves the new list.
	await toggleCheckbox("local-language-fr");
	assert.deepEqual(f.puts.at(-1)!.localPreferredLanguages, ["en", "fr"]);
});

test("a save that fails keeps what was confirmed and says so", async () => {
	const f = fixture({ dictation: local(), failWrite: true });
	await mount(<Rows />);
	await click(must("local-languages-toggle"));
	await toggleCheckbox("local-language-fr");
	assert.match(must("dictation-local-error").textContent!, /Could not save on-device dictation settings/);
	assert.match(must("local-languages-toggle").textContent!, /^English▾$/);
	f.failWrite = false;
	await toggleCheckbox("local-language-fr");
	assert.equal(byTest("dictation-local-error"), null);
	assert.match(must("local-languages-toggle").textContent!, /English and French/);
});

test("the Local settings survive changing the engine and the dictation language", async () => {
	const model = getCatalogModel("whisper-small")!;
	const f = fixture({ dictation: local({ localModel: model.id, localPreferredLanguages: ["en", "fr"], localLanguage: "fr" }), installed: [model.id] });
	await mount(<Rows />);
	await choose("select-dictation-engine", "groq");
	assert.deepEqual(f.puts.at(-1), { language: "en", provider: "groq", localModel: model.id, localPreferredLanguages: ["en", "fr"], localLanguage: "fr" },
		"switching away does not forget the model, so switching back finds it");
	await choose("select-dictation-engine", "local");
	assert.equal(f.puts.at(-1)!.localModel, model.id);
});

test("a language change keeps an unset preferred list following the dictation language", async () => {
	const { DictationLanguageSetting } = await import("../components/dictation-language.tsx");
	const f = fixture({ dictation: { language: "en" } });
	await mount(<><DictationEngineSettings /><DictationLanguageSetting /></>);
	await act(async () => { must("dictation-language").click(); });
	await act(async () => { must("dictation-language-fr").click(); });
	await settle();
	assert.deepEqual(f.puts.at(-1), { language: "fr" }, "no stale English list written back");
});

test("the rows lock while a dictation run is live, but a download can still be cancelled", async () => {
	const model = getCatalogModel("whisper-small")!;
	const f = fixture({ dictation: local({ localPreferredLanguages: ["zh"], localModel: model.id }), installed: [model.id] });
	f.statuses.set("whisper-large-v3", { ...idle("whisper-large-v3"), download: { state: "downloading", bytes: 10, total: 100 } });
	await mount(<Rows />);
	for (const id of ["row-local-languages", "row-local-language", "row-local-chinese"]) assert.doesNotMatch(must(id).className, /opacity-40/, `${id} is not dimmed while idle`);
	await act(async () => { setDictationActive(true); });
	await settle();
	for (const id of ["row-local-languages", "row-local-language", "row-local-chinese"]) assert.match(must(id).className, /opacity-40/, `${id} dims with the engine row`);
	assert.equal((must("local-languages-toggle") as HTMLButtonElement).disabled, true);
	assert.equal(select("select-local-chinese").disabled, true);
	assert.equal(select("select-local-language").disabled, true);
	await typeInto("local-model-filter", "whisper");
	assert.equal((within(rowOf(model.id), `local-model-${model.id}-delete`) as HTMLButtonElement).disabled, true);
	assert.equal((within(rowOf("whisper-large-v3"), "local-model-whisper-large-v3-cancel") as HTMLButtonElement).disabled, false);
});

// ── keyboard, focus and narrow dialogs ──────────────────────────────────────

test("the language list opens with the search focused, toggles checkboxes, keeps one, and Escape returns to the button", async () => {
	const f = fixture({ dictation: local() });
	await mount(<Rows />);
	const toggle = must("local-languages-toggle");
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	await click(toggle);
	assert.equal(toggle.getAttribute("aria-expanded"), "true");
	assert.equal(must("local-languages-panel").getAttribute("role"), "group");
	assert.equal(focusedId(), "local-languages-search");
	assert.equal((must("local-language-en") as HTMLInputElement).checked, true);
	assert.equal(must("local-language-en").tagName, "INPUT", "a native checkbox: Space and the label work");
	// The only language cannot be removed.
	await toggleCheckbox("local-language-en");
	assert.equal(f.puts.length, 0);
	assert.equal(must("local-language-en").getAttribute("aria-disabled"), "true");
	// Search narrows the list, and Enter in it does not submit anything.
	await typeInto("local-languages-search", "germ");
	assert.equal(document.querySelectorAll('[data-testid^="local-language-"]:not([data-testid="local-languages-list"]):not([data-testid="local-languages-search"]):not([data-testid="local-languages-panel"]):not([data-testid="local-languages-toggle"])').length, 1);
	await key(must("local-languages-search"), "Enter");
	assert.equal(f.puts.length, 0);
	await key(must("local-languages-search"), "Escape");
	assert.equal(byTest("local-languages-panel"), null);
	assert.equal(focusedId(), "local-languages-toggle");
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("Local's rows and list fit a narrow dialog and every control shows keyboard focus", async () => {
	const model = getCatalogModel("whisper-small")!;
	fixture({ dictation: local({ localModel: model.id, localPreferredLanguages: ["en", "zh"] }), installed: [model.id] });
	await mount(<Rows />);
	for (const id of ["row-local-languages", "row-local-language", "row-local-chinese"]) {
		assert.match(must(id).getAttribute("class")!, /\bflex-wrap\b/, id);
	}
	for (const id of ["select-local-language", "select-local-chinese"]) {
		const classes = select(id).getAttribute("class")!;
		for (const token of ["min-w-0", "max-w-full", "focus-visible:ring-1", "focus-visible:ring-ring", "focus-visible:border-ring"]) assert.ok(classes.split(" ").includes(token), `${id} ${token}`);
	}
	await click(must("local-languages-toggle"));
	for (const id of ["local-languages-search", "local-language-en", "local-model-filter", "local-ratings-toggle", "local-folded-toggle"]) {
		assert.match(must(id).getAttribute("class")!, /focus-visible:ring-1/, id);
	}
	// A row wraps instead of overflowing: its text can shrink and its groups wrap.
	const row = rowOf(model.id);
	assert.match(row.getAttribute("class")!, /\bmin-w-0\b/);
	for (const element of row.querySelectorAll<HTMLElement>("div")) {
		const classes = element.getAttribute("class") ?? "";
		if (/\bflex\b/.test(classes) && /\bflex-row\b|\bitems-center\b|\bitems-baseline\b/.test(classes)) assert.match(classes, /\bflex-wrap\b/, classes);
	}
	for (const button of row.querySelectorAll<HTMLElement>("button")) assert.match(button.getAttribute("class")!, /focus-visible:ring-1/);
	for (const list of document.querySelectorAll<HTMLElement>('[data-testid="local-models"] ul')) assert.match(list.getAttribute("class")!, /\bmin-w-0\b|\bmax-h-56\b/);
});
