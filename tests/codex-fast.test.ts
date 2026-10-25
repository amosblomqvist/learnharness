import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { resolveConversationSpec, resolveModelSpec, resolveSettings, resolveSlot } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAgentSettingsBody, parseModelsSettingsBody, parseSettingsBody } from "../src/server/settings-body.ts";
import { clampModelsLevels, catalogDefaultsFor, rolePinsFor, toModelDto, validateChatSettings, validateModelsSettings } from "../src/server/model-catalog.ts";
import { canonicalSubscriptionProvider, supportsCodexFastMode } from "../src/core/model-speed.ts";
import { piModels } from "../src/agent/models.ts";
import { chatGPTModels, refreshChatGPTModels } from "../src/agent/chatgpt-bridge.ts";

// Fast mode (service_tier) policy tests. Fully offline. Runtime request tests
// for native ChatGPT live in native-chatgpt-fast.test.ts.

const CODEX = "chatgpt";
const LEGACY = "subscription-openai-codex";
const FAST_ID = "gpt-6-sol";

/** Known fast-capable native model id (private allowlist, docs checked 2026-10-24). */
function fastId(): string { return FAST_ID; }
/** A native model id outside the allowlist. */
function slowCodexId(): string | undefined { return "gpt-5"; }
// Synthetic ChatGPT IPC catalog so connectionModel("chatgpt", id) resolves offline.
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
const status = { available: true, pending: false, allowBackgroundUse: false, activeId: "scratch-account", accounts: [{ id: "scratch-account", email: "dummy@example.invalid", registration: "oaiapp_scratch", connected: true, planEnabled: true, background: false }], error: null };
before(async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		queueMicrotask(() => ipc({ channel: "lh:chatgpt", id: message.id, op: message.op, ok: true, value: { epoch: 1, authorityRevision: 1, revision: 1, status, accountId: "scratch-account", models: [{ id: FAST_ID, name: "Fast" }, { id: "gpt-5", name: "Standard" }] } }));
		callback?.(); return true;
	} });
	const base = piModels().getModel("openai", "gpt-5") as any;
	await refreshChatGPTModels([base, { ...base, id: FAST_ID }]);
});
after(() => {
	if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
	if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
});
const OTHER = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
process.env.OPENROUTER_API_KEY ??= "test-key-codex-fast";

// ─── predicate ───────────────────────────────────────────────────────────────

describe("supportsCodexFastMode", () => {
	it("is true only for known native chatgpt models", () => {
		const supports = supportsCodexFastMode;
		const id = fastId();
		assert.equal(supports(CODEX, id), true);
		assert.equal(supports(CODEX, "no-such-model"), false);
		assert.equal(supports(CODEX, ""), false);
		for (const provider of ["openai-codex", "openai", "subscription-anthropic", "subscription-xai", "custom-local", "openrouter", ""]) {
			assert.equal(supports(provider, id), false, `${provider}/${id}`);
		}
	});
	it("recognizes the retired duplicate id only through the canonical alias", () => {
		assert.equal(canonicalSubscriptionProvider(LEGACY), "chatgpt");
		assert.equal(canonicalSubscriptionProvider("chatgpt"), "chatgpt");
		assert.equal(canonicalSubscriptionProvider("openai"), "openai");
		assert.equal(supportsCodexFastMode(LEGACY, fastId()), true);
		assert.equal(supportsCodexFastMode(LEGACY, "no-such-model"), false);
	});
	it("is reflected on the picker DTO and never true for other providers", async () => {
				const native = chatGPTModels().find((m) => m.id === fastId());
		assert.ok(native, "synthetic catalog exposes the fast model");
		assert.equal(toModelDto(native!).supportsFastMode, true);
		const other = piModels().getModel(OTHER.provider, OTHER.id)!;
		assert.notEqual(toModelDto(other).supportsFastMode, true);
		assert.equal(supportsCodexFastMode(OTHER.provider, OTHER.id), false);
	});
});

// ─── parsers ─────────────────────────────────────────────────────────────────

describe("service tier parsing", () => {
	const model = { provider: CODEX, id: "m" };
	it("chat settings accept default and priority", () => {
		for (const tier of ["default", "priority"]) {
			const r = parseSettingsBody({ model, serviceTier: tier });
			assert.ok(r.ok);
			if (r.ok) assert.equal(r.settings.serviceTier, tier);
		}
	});
	it("chat settings reject non-string and unknown tiers", () => {
		for (const tier of [true, 1, null, {}, [], "fast", "flex", "PRIORITY", ""]) {
			assert.equal(parseSettingsBody({ model, serviceTier: tier }).ok, false, JSON.stringify(tier));
		}
	});
	it("absent tier adds no key", () => {
		const r = parseSettingsBody({ model, thinkingLevel: "low" });
		assert.ok(r.ok);
		if (r.ok) assert.equal("serviceTier" in r.settings, false);
	});
	it("slots and role overrides parse and validate the tier", () => {
		const slots = parseModelsSettingsBody({ strong: { model, serviceTier: "priority" } });
		assert.ok(slots.ok);
		if (slots.ok) assert.equal(slots.settings.strong?.serviceTier, "priority");
		assert.equal(parseModelsSettingsBody({ strong: { model, serviceTier: "fast" } }).ok, false);
		const agent = parseAgentSettingsBody({ models: { researcher: { serviceTier: "default" } } });
		const role = agent.ok ? (agent.settings.models as Record<string, { serviceTier?: string }> | undefined) : undefined;
		assert.ok(agent.ok, agent.ok ? "" : agent.error);
		assert.equal(role?.researcher?.serviceTier, "default");
		assert.equal(parseAgentSettingsBody({ models: { researcher: { serviceTier: 3 } } }).ok, false);
	});
});

// ─── sanitizer persistence ──────────────────────────────────────────────────

describe("sanitizer", () => {
	it("persists valid tiers on slots and role overrides and drops invalid ones", () => {
		const m = { provider: CODEX, id: "m" };
		const out = sanitizeUserSettings({
			models: { strong: { model: m, serviceTier: "priority" }, cheap: { model: m, serviceTier: "turbo" }, vision: { model: m } },
			agent: { models: { researcher: { model: m, serviceTier: "default" }, extractor: { thinkingLevel: "low", serviceTier: 7 } } },
		});
		assert.equal(out?.models?.strong?.serviceTier, "priority");
		assert.equal("serviceTier" in (out?.models?.cheap ?? {}), false);
		assert.equal("serviceTier" in (out?.models?.vision ?? {}), false);
		assert.equal(out?.agent?.models?.researcher?.serviceTier, "default");
		assert.equal("serviceTier" in (out?.agent?.models?.extractor ?? {}), false);
	});
	it("a tier alone does not create an otherwise empty override", () => {
		const out = sanitizeUserSettings({ agent: { models: { researcher: { serviceTier: "bogus" } } } });
		assert.equal(out?.agent?.models?.researcher, undefined);
	});
});

// ─── resolution ──────────────────────────────────────────────────────────────

describe("resolution", () => {
	it("slot carries tier on a supported model; absent tier adds no key", () => {
		const id = fastId();
		const withTier = resolveSlot({ model: { provider: CODEX, id }, serviceTier: "priority" });
		assert.equal(withTier?.serviceTier, "priority");
		const without = resolveSlot({ model: { provider: CODEX, id } });
		assert.equal(without && "serviceTier" in without, false);
	});
	it("unsupported model omits the tier everywhere", () => {
		const p = { provider: OTHER.provider, id: OTHER.id };
		assert.equal("serviceTier" in (resolveSlot({ model: p, serviceTier: "priority" })!), false);
		const spec = resolveModelSpec("researcher", undefined, { cheap: { model: p, serviceTier: "priority" } });
		assert.ok(spec);
		assert.equal("serviceTier" in spec!, false);
		const conv = resolveConversationSpec({ model: p, serviceTier: "priority" }, null);
		assert.equal("serviceTier" in conv!, false);
		const slow = slowCodexId();
		if (slow) assert.equal("serviceTier" in (resolveSlot({ model: { provider: CODEX, id: slow }, serviceTier: "priority" })!), false);
	});
	it("role override inherits thinking and speed from the slot independently", () => {
		const id = fastId();
		const slot = { model: { provider: CODEX, id }, thinkingLevel: "high" as const, serviceTier: "priority" as const };
		const slots = { cheap: slot };
		const speedOnly = resolveModelSpec("researcher", { serviceTier: "default" }, slots);
		assert.equal(speedOnly?.thinkingLevel, "high");
		assert.notEqual(speedOnly?.serviceTier, "priority");
		const thinkOnly = resolveModelSpec("researcher", { thinkingLevel: "low" }, slots);
		assert.equal(thinkOnly?.thinkingLevel, "low");
		assert.equal(thinkOnly?.serviceTier, "priority");
		const inherited = resolveModelSpec("researcher", undefined, slots);
		assert.equal(inherited?.serviceTier, "priority");
		const explicit = resolveModelSpec("researcher", { serviceTier: "priority", thinkingLevel: "low" }, { cheap: { model: slot.model } });
		assert.equal(explicit?.serviceTier, "priority");
		assert.equal(explicit?.thinkingLevel, "low");
	});
	it("explicit role default overrides an inherited priority; override to unsupported model drops it", () => {
		const id = fastId();
		const slots = { cheap: { model: { provider: CODEX, id }, serviceTier: "priority" as const } };
		assert.notEqual(resolveModelSpec("researcher", { serviceTier: "default" }, slots)?.serviceTier, "priority");
		const moved = resolveModelSpec("researcher", { model: OTHER }, slots);
		assert.equal(moved && "serviceTier" in moved, false);
	});
	it("resolveSettings threads tiers into slots and role specs without adding keys when absent", () => {
		const id = fastId();
		const model = { provider: CODEX, id };
		const eff = resolveSettings({ models: { strong: { model, serviceTier: "priority" }, cheap: { model } } } as never);
		assert.equal(eff.models.strong?.serviceTier, "priority");
		assert.equal(eff.models.cheap && "serviceTier" in eff.models.cheap, false);
		const bare = resolveSettings({ models: { strong: { model } } } as never);
		for (const spec of Object.values(bare.agent.models)) if (spec) assert.equal("serviceTier" in spec, false);
	});
	it("chat conversation chain: tier and thinking are independent", () => {
		const id = fastId();
		const strong = { provider: CODEX, id, thinkingLevel: "high" as const, serviceTier: "priority" as const };
		const own = { provider: CODEX, id };
		assert.equal(resolveConversationSpec({ model: own, serviceTier: "priority" }, null)?.serviceTier, "priority");
		assert.notEqual(resolveConversationSpec({ model: own, serviceTier: "default" }, strong)?.serviceTier, "priority");
		const explicitDefault = resolveConversationSpec({ serviceTier: "default" }, strong);
		assert.equal(explicitDefault?.id, id);
		assert.notEqual(explicitDefault?.serviceTier, "priority");
		assert.equal(explicitDefault?.thinkingLevel, "high");
	});
	it("a pinned existing chat with its own model but no tier stays Standard (no inheritance from a changed strong)", () => {
		const id = fastId();
		const strong = { provider: CODEX, id, serviceTier: "priority" as const };
		const pinned = resolveConversationSpec({ model: { provider: CODEX, id } }, strong);
		assert.notEqual(pinned?.serviceTier, "priority");
		const pinnedOther = resolveConversationSpec({ model: OTHER, thinkingLevel: "low" }, strong);
		assert.equal(pinnedOther && "serviceTier" in pinnedOther, false);
	});
	it("a truly unpinned legacy chat follows the strong slot, including its tier", () => {
		const id = fastId();
		const strong = { provider: CODEX, id, serviceTier: "priority" as const };
		for (const chat of [undefined, {}]) {
			const spec = resolveConversationSpec(chat, strong);
			assert.equal(spec?.id, id);
			assert.equal(spec?.serviceTier, "priority");
		}
		const plain = resolveConversationSpec(undefined, { provider: CODEX, id });
		assert.equal(plain && "serviceTier" in plain, false);
	});
});

// ─── catalog projection and validation ──────────────────────────────────────

describe("catalog", () => {
	it("pins project the tier only when present", () => {
		const id = fastId();
		const withTier = catalogDefaultsFor({ provider: CODEX, id, serviceTier: "priority" } as never);
		assert.equal(withTier?.serviceTier, "priority");
		const bare = catalogDefaultsFor({ provider: CODEX, id });
		assert.equal(bare && "serviceTier" in bare, false);
		const pins = rolePinsFor({ researcher: { provider: CODEX, id, serviceTier: "priority" } } as never);
		assert.equal(pins.researcher?.serviceTier, "priority");
	});
	it("accepts priority on a supported model and rejects it on an explicit unsupported one", () => {
		const id = fastId();
		assert.equal(validateChatSettings({ model: { provider: CODEX, id }, serviceTier: "priority" }).ok, true);
		assert.equal(validateChatSettings({ model: OTHER, serviceTier: "priority" }).ok, false);
		assert.equal(validateChatSettings({ model: OTHER, serviceTier: "default" }).ok, true);
		assert.equal(validateChatSettings({ model: OTHER }).ok, true);
		assert.equal(validateModelsSettings({ strong: { model: { provider: CODEX, id }, serviceTier: "priority" } }).ok, true);
		// Slots reject explicit unsupported priority; clamp strips a stored one.
		assert.equal(validateModelsSettings({ strong: { model: OTHER, serviceTier: "priority" } }).ok, false);
		const stored = { strong: { model: OTHER, serviceTier: "priority" as const } };
		const clamped = clampModelsLevels(stored);
		assert.equal("serviceTier" in (clamped.strong ?? {}), false);
		assert.equal(stored.strong.serviceTier, "priority", "clamp does not mutate its input");
		assert.equal(clampModelsLevels({ strong: { model: { provider: CODEX, id }, serviceTier: "priority" } }).strong?.serviceTier, "priority");
		const slow = slowCodexId();
		if (slow) assert.equal(validateChatSettings({ model: { provider: CODEX, id: slow }, serviceTier: "priority" }).ok, false);
	});
});
