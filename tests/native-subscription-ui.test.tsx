import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CLAUDE_POLICY_NOTICE, LegacySubscriptionConnection, LegacySubscriptionsUIProvider } from "../components/settings/legacy-subscription-connections.tsx";
import { NativeSubscriptionUIProvider, SubscriptionConnections } from "../components/settings/subscription-connections.tsx";
import { ChatGPTUIProvider } from "../components/settings/chatgpt-connection.tsx";

test("upstream subscription UI owns ChatGPT, Copilot, and Grok while legacy UI exposes Claude only", () => {
 const native = renderToStaticMarkup(<ChatGPTUIProvider><NativeSubscriptionUIProvider><SubscriptionConnections /></NativeSubscriptionUIProvider></ChatGPTUIProvider>);
 assert(native.includes('data-testid="chatgpt-connection"'));
 assert(native.includes('data-testid="github-copilot-connection"'));
 assert(native.includes('data-testid="xai-connection"'));
 const legacy = renderToStaticMarkup(<LegacySubscriptionsUIProvider><LegacySubscriptionConnection /></LegacySubscriptionsUIProvider>);
 assert(legacy.includes('data-testid="native-claude-connection"'));
 assert(CLAUDE_POLICY_NOTICE.includes("Anthropic does not permit third-party Claude.ai login"));
 assert(!legacy.includes("Grok"));
});
