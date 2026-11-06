/**
 * OpenAI Fast mode (S3/S5/S6/S8/S9): the settings write gate and the
 * catalog projections for `fast: true` pins. A scratch ChatGPT account
 * catalog arrives over the desktop IPC bridge — gpt-5 offers Fast,
 * gpt-5-mini does not.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
const testData = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-fast-data-"));
process.env.LH_DATA_DIR = testData;
const {
	catalogDefaultsFor,
	catalogSlots,
	clampChatLevel,
	clampModelsLevels,
	rolePinsFor,
	validateChatSettings,
	validateModelsSettings,
	validateRoleOverridesFast,
} = await import("../src/server/model-catalog.ts");
const { piModels } = await import("../src/agent/models.ts");
const { refreshChatGPTModels } = await import("../src/agent/chatgpt-bridge.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { writeSettings } = await import("../src/store/settings.ts");

const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
const supported = ["gpt-5", "gpt-5-mini"].map((id) => piModels().getModel("openai", id) as Model<"openai-responses">);
const withFast = () => [{ id: "gpt-5", name: "Scratch Fast model", fast: { description: "2x speed, increased usage" } }, { id: "gpt-5-mini", name: "Scratch plain model" }];
let catalogModels: unknown[] = withFast();
const status = { available: true, pending: false, allowBackgroundUse: false, activeId: "scratch-account", accounts: [{ id: "scratch-account", email: "dummy@example.invalid", registration: "oaiapp_scratch", connected: true, planEnabled: true, background: false }], error: null };

before(async () => {
	assert.ok(supported.every(Boolean), "gpt-5 and gpt-5-mini in pi's openai catalog");
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: { id: string; op: string }, callback?: () => void) => {
		queueMicrotask(() => ipc({ channel: "lh:chatgpt", id: message.id, op: message.op, ok: true, value: { epoch: 1, authorityRevision: 1, revision: 1, status, accountId: "scratch-account", models: catalogModels } }));
		callback?.(); return true;
	} });
	await refreshChatGPTModels(supported);
});
after(() => {
	if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
	if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	fs.rmSync(testData, { recursive: true, force: true });
});

const fastModel = { provider: "chatgpt", id: "gpt-5" };
const plainModel = { provider: "chatgpt", id: "gpt-5-mini" };

describe("the Fast write gate (S8)", () => {
	it("accepts fast on a ChatGPT model whose catalog entry offers Fast", () => {
		assert.deepEqual(validateChatSettings({ model: fastModel, fast: true }), { ok: true });
		assert.deepEqual(validateModelsSettings({ strong: { model: fastModel, fast: true } }), { ok: true });
	});

	it("rejects fast on a model without a Fast tier, naming the model", () => {
		assert.deepEqual(validateChatSettings({ model: plainModel, fast: true }), { ok: false, error: 'No Fast tier for model "gpt-5-mini"' });
		assert.deepEqual(validateModelsSettings({ cheap: { model: plainModel, fast: true } }), { ok: false, error: 'No Fast tier for model "gpt-5-mini"' });
		assert.deepEqual(validateChatSettings({ model: { provider: "openai", id: "gpt-5" }, fast: true }), { ok: false, error: 'No Fast tier for model "gpt-5"' });
	});

	it("a pin without fast validates as before (S9)", () => {
		assert.deepEqual(validateChatSettings({ model: plainModel }), { ok: true });
		assert.deepEqual(validateModelsSettings({ cheap: { model: plainModel, thinkingLevel: "low" } }), { ok: true });
	});

	it("re-saving an unchanged Fast slot passes after the catalog stops offering Fast; a new one does not (S5)", async () => {
		catalogModels = [{ id: "gpt-5", name: "Scratch Fast model" }, { id: "gpt-5-mini", name: "Scratch plain model" }];
		try {
			await refreshChatGPTModels(supported);
			const stored = { strong: { model: fastModel, fast: true as const } };
			assert.deepEqual(validateModelsSettings({ strong: { model: fastModel, fast: true, thinkingLevel: "low" } }, stored), { ok: true });
			assert.deepEqual(validateModelsSettings({ strong: { model: fastModel, fast: true } }), { ok: false, error: 'No Fast tier for model "gpt-5"' });
		} finally {
			catalogModels = withFast();
			await refreshChatGPTModels(supported);
		}
	});

	it("re-saving a session's unchanged Fast pin passes after the catalog stops offering Fast; a new one does not (S5)", async () => {
		catalogModels = [{ id: "gpt-5", name: "Scratch Fast model" }, { id: "gpt-5-mini", name: "Scratch plain model" }];
		try {
			await refreshChatGPTModels(supported);
			assert.deepEqual(validateChatSettings({ model: fastModel, fast: true, thinkingLevel: "low" }, { model: fastModel, fast: true }), { ok: true });
			assert.deepEqual(validateChatSettings({ model: fastModel, fast: true }, { model: fastModel }), { ok: false, error: 'No Fast tier for model "gpt-5"' });
			assert.deepEqual(validateChatSettings({ model: fastModel, fast: true }), { ok: false, error: 'No Fast tier for model "gpt-5"' });
		} finally {
			catalogModels = withFast();
			await refreshChatGPTModels(supported);
		}
	});

	it("role overrides: fast on a model without a Fast tier is rejected, an unchanged stored one passes (S8, S5)", () => {
		assert.deepEqual(validateRoleOverridesFast({ researcher: { model: fastModel, fast: true } }), { ok: true });
		assert.deepEqual(validateRoleOverridesFast({ researcher: { model: plainModel, fast: true } }), { ok: false, error: 'No Fast tier for model "gpt-5-mini"' });
		assert.deepEqual(validateRoleOverridesFast({ researcher: { model: plainModel, fast: true } }, { researcher: { model: plainModel, fast: true } }), { ok: true });
		assert.deepEqual(validateRoleOverridesFast({ researcher: { model: plainModel } }), { ok: true });
		assert.deepEqual(validateRoleOverridesFast(undefined), { ok: true });
	});

	it("turning Fast on for an unchanged slot model is still checked (S8)", () => {
		assert.deepEqual(validateModelsSettings({ cheap: { model: plainModel, fast: true } }, { cheap: { model: plainModel } }), { ok: false, error: 'No Fast tier for model "gpt-5-mini"' });
		assert.deepEqual(validateModelsSettings({ strong: { model: fastModel, fast: true } }, { strong: { model: fastModel } }), { ok: true });
	});

	it("the clamp-on-write helpers keep fast", () => {
		assert.equal(clampModelsLevels({ strong: { model: fastModel, thinkingLevel: "high", fast: true } }).strong?.fast, true);
		assert.equal(clampChatLevel({ model: fastModel, thinkingLevel: "high", fast: true }, null).fast, true);
	});
});

describe("Fast in the catalog projections (S3/S6)", () => {
	it("defaults, role pins and slots carry fast only when the pin has it", () => {
		assert.deepEqual(catalogDefaultsFor({ provider: "chatgpt", id: "gpt-5", fast: true }), { model: fastModel, fast: true });
		assert.deepEqual(catalogDefaultsFor({ provider: "chatgpt", id: "gpt-5-mini" }), { model: plainModel });
		const models = resolveSettings({ version: 1, models: { cheap: { model: fastModel, fast: true } }, agent: { models: { auditor: { model: plainModel } } } }).agent.models;
		const pins = rolePinsFor(models);
		assert.deepEqual(pins.researcher, { model: fastModel, fast: true });
		assert.deepEqual(pins.auditor, { model: plainModel });
		writeSettings({ version: 1, models: { strong: { model: fastModel, fast: true }, cheap: { model: plainModel } } });
		const slots = catalogSlots();
		assert.deepEqual(slots.strong, { model: fastModel, fast: true });
		assert.deepEqual(slots.cheap, { model: plainModel });
	});
});
