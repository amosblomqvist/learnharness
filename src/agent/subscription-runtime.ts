/** Server-injected private web transport. The agent layer never imports a
 * filesystem owner or server composition root. Desktop IPC remains separate. */
export type SubscriptionRuntimeChannel = "lh:chatgpt" | "lh:subscriptions";
export type SubscriptionRuntimePacket = Record<string, unknown>;
interface Runtime {
	request?: <T>(channel: SubscriptionRuntimeChannel, op: string, fields: Record<string, unknown>) => Promise<T>;
	listeners: Map<SubscriptionRuntimeChannel, Set<(packet: SubscriptionRuntimePacket) => void>>;
}
const KEY = Symbol.for("lh.webSubscriptionRuntime");
function runtime(): Runtime {
	const global = globalThis as typeof globalThis & { [KEY]?: Runtime };
	return global[KEY] ??= { listeners: new Map() };
}
export function configureWebSubscriptionRuntime(request: NonNullable<Runtime["request"]>): void { runtime().request = request; }
export function webSubscriptionsEnabled(): boolean {
	return process.env.LH_DESKTOP_SERVER !== "1" && !process.env.LH_DESKTOP_API_SECRET && !!runtime().request;
}
export function onWebSubscriptionPacket(channel: SubscriptionRuntimeChannel, listener: (packet: SubscriptionRuntimePacket) => void): void {
	const state = runtime(); const listeners = state.listeners.get(channel) ?? new Set();
	listeners.add(listener); state.listeners.set(channel, listeners);
}
export function publishWebSubscriptionPacket(channel: SubscriptionRuntimeChannel, packet: SubscriptionRuntimePacket): void {
	for (const listener of runtime().listeners.get(channel) ?? []) {
		try { listener(packet); } catch { /* observer isolation */ }
	}
}
export function webSubscriptionRequest<T>(channel: SubscriptionRuntimeChannel, op: string, fields: Record<string, unknown>): Promise<T> {
	if (!webSubscriptionsEnabled()) return Promise.reject(new Error("The web subscription owner is unavailable."));
	return runtime().request!<T>(channel, op, fields);
}
