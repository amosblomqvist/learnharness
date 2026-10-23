/** Connect app-owned adapters to the framework-free model engine. */
import { configureModelConnections } from "../agent/models.ts";
import { SUBSCRIPTION_PROVIDERS, subscriptionProvider } from "../core/provider-connections.ts";
import type { CatalogProvider } from "../core/contracts/models.ts";
import { providerCredentials } from "../store/provider-credentials.ts";
import { readCustomProviders } from "../store/custom-providers.ts";

configureModelConnections({ credentials: providerCredentials, customProviders: readCustomProviders });

export function connectionAvailable(id: string): boolean | undefined {
	if (subscriptionProvider(id)) return providerCredentials.peek(id)?.type === "oauth";
	if (id.startsWith("custom-")) {
		const definition = readCustomProviders().find((p) => p.id === id);
		if (!definition) return false;
		const credential = providerCredentials.peek(id);
		return definition.keyless || (credential?.type === "api_key" && !!credential.key && credential.env?.LH_CUSTOM_PROVIDER_BASE_URL === definition.baseUrl && credential.env?.LH_CUSTOM_PROVIDER_API === definition.api);
	}
	return undefined;
}

export function connectionCatalogProviders(): CatalogProvider[] {
	return [
		...SUBSCRIPTION_PROVIDERS.map((p) => ({ id: p.id, envVar: "", keyPresent: connectionAvailable(p.id) === true, name: p.name, source: "subscription" as const })),
		...readCustomProviders().map((p) => ({ id: p.id, envVar: "", keyPresent: connectionAvailable(p.id) === true, name: p.name, source: "custom" as const })),
	];
}
