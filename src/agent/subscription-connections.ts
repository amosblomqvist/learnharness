import { chatGPTBackgroundAllowed, chatGPTConnected, chatGPTScopeCurrent, onChatGPTChange } from "./chatgpt-bridge.ts";
import { nativeSubscriptionId, nativeSubscriptionConnected, nativeSubscriptionBackgroundAllowed, nativeAdmissionCurrent, onNativeSubscriptionChange } from "./subscription-bridge.ts";
import type { AdmissionScope } from "./subscription-request-cycle.ts";
import { isLocalAgentProvider, localAgentAdmissionCurrent, localAgentBackgroundAllowed, localAgentConnected, onLocalAgentChange } from "./local-agents/index.ts";

/** Subscription-backed routes: app-owned sign-ins (ChatGPT, Copilot, Grok) and local agent connections (Claude Code, Antigravity). */
export function isSubscriptionProvider(provider: string | undefined): boolean { return provider === "chatgpt" || !!(provider && nativeSubscriptionId(provider)) || isLocalAgentProvider(provider); }
export function subscriptionConnected(provider: string): boolean {
	if (provider === "chatgpt") return chatGPTConnected();
	if (isLocalAgentProvider(provider)) return localAgentConnected(provider);
	const native = nativeSubscriptionId(provider); return !!native && nativeSubscriptionConnected(native);
}
/** Ordinary API connections have no subscription background-consent gate. */
export function connectionBackgroundAllowed(provider: string | undefined): boolean {
	if (provider === "chatgpt") return chatGPTBackgroundAllowed();
	if (isLocalAgentProvider(provider)) return localAgentBackgroundAllowed(provider);
	const native = provider ? nativeSubscriptionId(provider) : undefined;
	return native ? nativeSubscriptionBackgroundAllowed(native) : true;
}
export function connectionScopeCurrent(provider: string, scope: AdmissionScope): boolean {
	if (provider === "chatgpt") return chatGPTScopeCurrent(scope);
	if (isLocalAgentProvider(provider)) return localAgentAdmissionCurrent(provider, scope);
	const native = nativeSubscriptionId(provider); return !!native && nativeAdmissionCurrent(native, scope);
}
export function onSubscriptionChange(listener: () => void): () => void {
	const stopChatGPT = onChatGPTChange(listener), stopNative = onNativeSubscriptionChange(listener), stopLocal = onLocalAgentChange(listener);
	return () => { stopChatGPT(); stopNative(); stopLocal(); };
}
