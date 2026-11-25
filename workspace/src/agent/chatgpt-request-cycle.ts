/** Compatibility surface: ChatGPT keeps its scope/behavior while all subscription
 * connections share the same provider-neutral request-admission state machine. */
export { SubscriptionRequestCycle as ChatGPTRequestCycle } from "./subscription-request-cycle.ts";
export type { AdmissionScope, NoDispatchKind, SubscriptionDispatchLifecycle as ChatGPTDispatchLifecycle } from "./subscription-request-cycle.ts";
