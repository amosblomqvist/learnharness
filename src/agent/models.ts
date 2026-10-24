import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	type Api,
	type CredentialStore,
	type Model,
	type Models,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

interface PiSlot {
	store?: CredentialStore;
	collection?: {
		models: ReturnType<typeof createModels>;
		store: CredentialStore | null;
	};
}

const PI_KEY = Symbol.for("lh.piModels");

function piSlot(): PiSlot {
	const g = globalThis as Record<symbol, PiSlot | undefined>;
	if (!g[PI_KEY]) g[PI_KEY] = {};
	return g[PI_KEY];
}

export function bindPiCredentials(credentials: CredentialStore): void {
	const slot = piSlot();
	if (slot.store === credentials) {
		if (slot.collection && slot.collection.store !== credentials) {
			throw new Error("piModels() was already created without this credential store");
		}
		return;
	}
	if (slot.collection) {
		throw new Error("piModels() was already created without this credential store");
	}
	if (slot.store && slot.store !== credentials) {
		throw new Error("A different credential store is already bound");
	}
	slot.store = credentials;
}

export interface XaiAuthHooks {
	onProviderError(providerId: string, rawMessage: string): string | undefined;
	onProviderSuccess(providerId: string): void;
}

const HOOKS_KEY = Symbol.for("lh.xaiAuthHooks");

export function bindXaiAuthHooks(hooks: XaiAuthHooks): void {
	(globalThis as Record<symbol, XaiAuthHooks>)[HOOKS_KEY] = hooks;
}

export function settleXaiProviderMessage(message: { provider: string; stopReason: string; errorMessage?: string }): void {
	const hooks = (globalThis as Record<symbol, XaiAuthHooks | undefined>)[HOOKS_KEY];
	if (!hooks) return;
	if (message.stopReason === "aborted") return;
	if (message.stopReason === "error") {
		if (message.errorMessage === undefined) return;
		const rewritten = hooks.onProviderError(message.provider, message.errorMessage);
		if (rewritten !== undefined) message.errorMessage = rewritten;
		return;
	}
	hooks.onProviderSuccess(message.provider);
}

export function noteXaiProviderError(providerId: string, rawMessage: string): void {
	const hooks = (globalThis as Record<symbol, XaiAuthHooks | undefined>)[HOOKS_KEY];
	hooks?.onProviderError(providerId, rawMessage);
}

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. */
export function piModels() {
	const slot = piSlot();
	if (!slot.collection) {
		const store = slot.store ?? null;
		const models = store
			? createModels({ identity: APP_IDENTITY, credentials: store })
			: createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) models.setProvider(provider);
		slot.collection = { models, store };
	}
	return slot.collection.models;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec): PiEngine {
	const models: Models = piModels();
	const model = models.getModel(spec.provider, spec.id);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	return {
		model,
		level,
		// bound streamSimple: the agent loop forwards state.thinkingLevel as
		// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
		// the pin honest even when config or settings drift off the map.
		streamFn: (requestModel, context, options) =>
			models.streamSimple(requestModel, context, {
				...options,
				reasoning: level === "off" ? undefined : level,
			}),
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
