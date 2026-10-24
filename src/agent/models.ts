import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type Models,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import { localServerKeyVar, type LocalServer } from "../core/local-servers.ts";
import { buildLocalModel, localProvider, type DiscoveredModel } from "./local-models.ts";
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

let collection: ReturnType<typeof createModels> | undefined;

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
	}
	return collection;
}

// ─── Local model servers (local-models wave, 2026-10-24) ─────────────────────
// The server layer (src/server/local-servers.ts) owns WHICH servers exist
// (the settings record) and when to ask them for models; it pushes each
// into the collection here. This registry remembers the configs so an
// engine can still be built for a pinned local model before its server
// has been asked (a cold process, an unreachable server).

const localServers = new Map<string, LocalServer>();

/** Register (or replace) one local server's provider with its discovered
 *  models — called again after every successful discovery. */
export function registerLocalServer(server: LocalServer, models: readonly DiscoveredModel[]): void {
	localServers.set(server.id, server);
	piModels().setProvider(localProvider(server, models, localServerKeyVar(server.id)));
}

export function unregisterLocalServer(id: string): void {
	if (!localServers.delete(id)) return;
	piModels().deleteProvider(id);
}

/** The registered local server for a provider id (undefined = not local). */
export function registeredLocalServer(id: string): LocalServer | undefined {
	return localServers.get(id);
}

export function registeredLocalServers(): LocalServer[] {
	return [...localServers.values()];
}

/** The catalog model for a pin — and, for a registered LOCAL provider whose
 *  list does not (yet) hold the id, the model built from the server's
 *  config alone (default context, text-only): the pin stays runnable and
 *  the server itself answers honestly if the model is gone. */
export function resolveModel(provider: string, id: string): Model<Api> | undefined {
	const model = piModels().getModel(provider, id);
	if (model) return model;
	const server = localServers.get(provider);
	return server ? buildLocalModel(server, { id }) : undefined;
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
	const model = resolveModel(spec.provider, spec.id);
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
