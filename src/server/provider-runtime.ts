/** Wire app-owned Codex credentials into the shared model engine. */
import { configureModelConnections } from "../agent/models.ts";
import { SUBSCRIPTION_PROVIDERS, subscriptionProvider } from "../core/provider-connections.ts";
import type { CatalogProvider } from "../core/contracts/models.ts";
import { providerCredentials } from "../store/provider-credentials.ts";

configureModelConnections({ credentials: providerCredentials });

export function connectionAvailable(id: string): boolean | undefined {
	if (subscriptionProvider(id)) return providerCredentials.peek(id)?.type === "oauth";
	return undefined;
}

export function connectionCatalogProviders(): CatalogProvider[] {
	return SUBSCRIPTION_PROVIDERS.map((p) => ({ id: p.id, envVar: "", keyPresent: connectionAvailable(p.id) === true, name: p.name, source: "subscription" as const }));
}
