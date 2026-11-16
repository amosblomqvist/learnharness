import { piModels } from "../agent/models.ts";
import { ANTIGRAVITY_PROVIDER } from "../agent/antigravity/constants.ts";
import {
	resolveAntigravityRuntimeSync,
	type ResolvedAntigravityRuntime,
} from "../agent/antigravity/installation.ts";
import {
	discoverAntigravityModels,
	hasCachedAntigravityModels,
	readAntigravityModelsCache,
	type AntigravityModelsCache,
	type DiscoverAntigravityModelsOptions,
} from "../agent/antigravity/models-discovery.ts";
import { configureAntigravitySource } from "../agent/models.ts";
import { isAntigravityProfileSignedIn } from "../agent/antigravity/profile.ts";
import { createAntigravityProvider } from "../agent/antigravity/provider.ts";
import { createAntigravityStream } from "../agent/antigravity/stream.ts";
import type { AntigravityModelsStatus } from "../core/contracts/antigravity.ts";
import { antigravityBinaryPath, antigravityEnabled } from "./antigravity-config.ts";

export interface AntigravityAvailabilityDeps {
	enabled?: () => boolean;
	isSignedIn?: () => boolean;
	hasModels?: () => boolean;
	readCache?: () => AntigravityModelsCache | null;
	binaryPath?: () => string | undefined;
	resolveRuntimeSync?: (binaryPath?: string) => ResolvedAntigravityRuntime | null;
}

/** Strict 4-part readiness gate: Antigravity must be enabled, signed in with
 *  Google, backed by a non-empty discovered `models.json`, and have a
 *  synchronously resolvable runtime. Never spawns ACP. */
export function antigravityAvailable(deps: AntigravityAvailabilityDeps = {}): boolean {
	const enabled = deps.enabled ?? antigravityEnabled;
	if (!enabled()) return false;

	const signedIn = deps.isSignedIn ?? (() => isAntigravityProfileSignedIn());
	if (!signedIn()) return false;

	const hasModels = deps.hasModels ?? (() => hasCachedAntigravityModels());
	if (!hasModels()) return false;

	const binaryPath = (deps.binaryPath ?? antigravityBinaryPath)();
	const resolveSync =
		deps.resolveRuntimeSync ?? ((bin?: string) => resolveAntigravityRuntimeSync({ binaryPath: bin }));
	return resolveSync(binaryPath) !== null;
}

/** Installs the Antigravity catalog synchronization source into `piModels()`.
 *  Syncs purely from disk/settings (no ACP spawning on boot or `GET /api/models`). */
export function installAntigravityProviderSource(deps: AntigravityAvailabilityDeps = {}): void {
	const enabled = deps.enabled ?? antigravityEnabled;
	const isSignedIn = deps.isSignedIn ?? (() => isAntigravityProfileSignedIn());
	const readCache = deps.readCache ?? (() => readAntigravityModelsCache());
	const getBinaryPath = deps.binaryPath ?? antigravityBinaryPath;
	const resolveSync =
		deps.resolveRuntimeSync ?? ((bin?: string) => resolveAntigravityRuntimeSync({ binaryPath: bin }));

	const streamSimple = createAntigravityStream({
		isEnabled: enabled,
		binaryPath: getBinaryPath,
		isSignedIn,
		resolveRuntime: resolveSync,
	});

	let fingerprint: string | undefined;

	configureAntigravitySource((models) => {
		const isEnabled = enabled();
		const signedIn = isEnabled && isSignedIn();
		const cache = signedIn ? readCache() : null;
		const binaryPath = getBinaryPath() ?? null;
		const runtime =
			isEnabled && signedIn && cache && cache.models.length > 0 ? resolveSync(binaryPath ?? undefined) : null;
		const ready = Boolean(isEnabled && signedIn && cache && cache.models.length > 0 && runtime);

		const next = ready
			? JSON.stringify([
					true,
					cache!.updatedAt,
					cache!.models.map((m) => [
						m.id,
						m.name,
						m.reasoning,
						m.supportedThinkingLevels,
						m.input,
						m.contextWindow,
						m.maxTokens,
					]),
				])
			: "disabled";

		if (next === fingerprint) return;
		if (ready) {
			models.setProvider(createAntigravityProvider(streamSimple, cache!.models));
		} else {
			models.deleteProvider(ANTIGRAVITY_PROVIDER);
		}
		fingerprint = next;
	});
}

export interface AntigravityModelsManagerDeps {
	discover?: (runtime: ResolvedAntigravityRuntime, options?: DiscoverAntigravityModelsOptions) => Promise<AntigravityModelsCache>;
	readCache?: () => AntigravityModelsCache | null;
	onUpdated?: () => void;
}

export type AntigravityModelsRefreshResult =
	| { ok: true; status: AntigravityModelsStatus; cache: AntigravityModelsCache }
	| { ok: false; error: string; status: AntigravityModelsStatus };

/** Single-flight coordinator for Antigravity ACP model discovery. */
export function createAntigravityModelsManager(deps: AntigravityModelsManagerDeps = {}) {
	const discover = deps.discover ?? discoverAntigravityModels;
	const readCache = deps.readCache ?? (() => readAntigravityModelsCache());
	const onUpdated = deps.onUpdated ?? (() => void piModels());

	let discovering = false;
	let lastError: string | null = null;
	let inFlight: Promise<AntigravityModelsRefreshResult> | null = null;

	function getStatus(): AntigravityModelsStatus {
		const cache = readCache();
		return {
			count: cache?.models.length ?? 0,
			updatedAt: cache?.updatedAt ?? null,
			discovering,
			error: lastError,
		};
	}

	function clearError(): void {
		lastError = null;
	}

	async function refresh(
		runtime: ResolvedAntigravityRuntime,
		options?: DiscoverAntigravityModelsOptions,
	): Promise<AntigravityModelsRefreshResult> {
		if (inFlight) return inFlight;
		discovering = true;
		lastError = null;

		inFlight = (async (): Promise<AntigravityModelsRefreshResult> => {
			try {
				const cache = await discover(runtime, options);
				lastError = null;
				discovering = false;
				onUpdated();
				return { ok: true, status: getStatus(), cache };
			} catch (err) {
				const message = err instanceof Error ? err.message : "Could not discover Antigravity models.";
				lastError = message;
				discovering = false;
				onUpdated();
				return { ok: false, error: message, status: getStatus() };
			} finally {
				inFlight = null;
			}
		})();

		return inFlight;
	}

	return {
		getStatus,
		clearError,
		refresh,
	};
}
