import { chatGPTBackgroundAllowed, chatGPTConnected, chatGPTScopeCurrent, onChatGPTChange } from "./chatgpt-bridge.ts";
import { nativeSubscriptionId, nativeSubscriptionConnected, nativeSubscriptionBackgroundAllowed, nativeAdmissionCurrent, onNativeSubscriptionChange } from "./subscription-bridge.ts";
import { claudeLocalAdmissionCurrent, claudeLocalBackgroundAllowed, claudeLocalConnected, onClaudeLocalChange } from "./claude-local/bridge.ts";
import { isClaudeLocalProvider } from "../core/contracts/claude-local.ts";
import type { AdmissionScope } from "./subscription-request-cycle.ts";

/** Every plan-billed route: ChatGPT, the Pi-backed native connections and
 *  Local Claude (the user's own Claude Code; owner, 2026-10-27). They share
 *  the consent gate, the admission cycle and the no-API-key-fallback law. */
export function isSubscriptionProvider(provider: string | undefined): boolean { return provider === "chatgpt" || isClaudeLocalProvider(provider) || !!(provider && nativeSubscriptionId(provider)); }
export function subscriptionConnected(provider: string): boolean {
	if (provider === "chatgpt") return chatGPTConnected();
	if (isClaudeLocalProvider(provider)) return claudeLocalConnected();
	const native = nativeSubscriptionId(provider); return !!native && nativeSubscriptionConnected(native);
}
/** Ordinary API connections have no subscription background-consent gate. */
export function connectionBackgroundAllowed(provider: string | undefined): boolean {
	if (provider === "chatgpt") return chatGPTBackgroundAllowed();
	if (isClaudeLocalProvider(provider)) return claudeLocalBackgroundAllowed();
	const native = provider ? nativeSubscriptionId(provider) : undefined;
	return native ? nativeSubscriptionBackgroundAllowed(native) : true;
}
export function connectionScopeCurrent(provider: string, scope: AdmissionScope): boolean {
	if (provider === "chatgpt") return chatGPTScopeCurrent(scope);
	if (isClaudeLocalProvider(provider)) return claudeLocalAdmissionCurrent(scope);
	const native = nativeSubscriptionId(provider); return !!native && nativeAdmissionCurrent(native, scope);
}
export function onSubscriptionChange(listener: () => void): () => void {
	const stopChatGPT = onChatGPTChange(listener), stopNative = onNativeSubscriptionChange(listener), stopLocal = onClaudeLocalChange(listener);
	return () => { stopChatGPT(); stopNative(); stopLocal(); };
}
