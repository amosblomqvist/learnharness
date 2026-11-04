/** Human labels for model providers (client-safe). Model menus, tooltips
 * and key refusals show these instead of raw pi-ai provider ids, so rows
 * that share a model id across providers (opencode and opencode-go, the
 * moonshotai pair) stay distinguishable. */
import { AUTH_PROVIDER_KEYS, CUSTOM_PROVIDER } from "./auth-keys.ts";
import { CLAUDE_CODE_LABEL, CLAUDE_CODE_PROVIDER } from "./contracts/claude-code.ts";
import { subscriptionLabel } from "./prices.ts";

/** The provider's human label; an unknown id falls back to itself. */
export function providerLabel(provider: string): string {
	if (provider === CLAUDE_CODE_PROVIDER) return CLAUDE_CODE_LABEL;
	if (provider === CUSTOM_PROVIDER.id) return CUSTOM_PROVIDER.label;
	return subscriptionLabel(`${provider}:`) ?? AUTH_PROVIDER_KEYS.find((p) => p.id === provider)?.label ?? provider;
}

/** "<label> · <id>", with "(subscription)" after the label for
 * subscription models. Shared by the model menu row and the model
 * tooltips. */
export function modelLabel(provider: string, id: string): string {
	const subscription = subscriptionLabel(`${provider}:${id}`);
	return `${subscription ? `${subscription} (subscription)` : providerLabel(provider)} · ${id}`;
}
