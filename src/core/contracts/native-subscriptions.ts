/** Client-safe local connection status. OAuth data and authorization URLs stay in main. */
export type NativeSubscriptionProviderId = "subscription-anthropic" | "subscription-xai";
export interface NativeSubscriptionStatus {
	available: boolean;
	pending: boolean;
	allowBackgroundUse: boolean;
	activeId: string | null;
	/** Labels identify local saved connections, not provider-verified identities. */
	accounts: { id: string; label: string; connected: boolean }[];
	error: string | null;
	catalogError?: string | null;
}
export interface NativeSubscriptionControlBridge {
	status(provider: NativeSubscriptionProviderId): Promise<NativeSubscriptionStatus>;
	login(provider: NativeSubscriptionProviderId, id?: string, allowBackgroundUse?: boolean): Promise<NativeSubscriptionStatus>;
	cancel(provider: NativeSubscriptionProviderId): Promise<NativeSubscriptionStatus>;
	select(provider: NativeSubscriptionProviderId, id: string): Promise<NativeSubscriptionStatus>;
	disconnect(provider: NativeSubscriptionProviderId, id: string): Promise<NativeSubscriptionStatus>;
	logout(provider: NativeSubscriptionProviderId, id: string): Promise<NativeSubscriptionStatus>;
	consent(provider: NativeSubscriptionProviderId, enabled: boolean): Promise<NativeSubscriptionStatus>;
	onChange(callback: () => void): () => void;
}
