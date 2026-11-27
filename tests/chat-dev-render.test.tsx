import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { Chat } from "../components/chat.tsx";
import { ActivityProvider } from "../components/activity-dock.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { PluginsProvider } from "../components/plugins.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { AppearanceProvider } from "../components/settings/appearance.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { SidebarProvider } from "../components/sidebar.tsx";
import { DEFAULT_THEME } from "../src/core/themes.ts";

// `next dev` server-renders every chat page with React's development build,
// which seals each useRef object (Object.seal). A property assigned to a ref
// afterwards throws "object is not extensible" and the page returns 500.
// Production builds skip the seal, so only dev broke. This renders the chat
// the same way, inside the providers app/layout.tsx and AppShell give it.
describe("chat server render (React development build)", () => {
	it("renders an empty teaching chat without throwing", () => {
		const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
		const html = renderToString(
			<AppRouterContext.Provider value={router}>
			<PathnameContext.Provider value="/chat/chat_dev_render">
			<ServerEventsProvider>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={undefined} initialTheme={DEFAULT_THEME}>
						<SidebarProvider>
							<ActivityProvider>
								<InteractionLayersProvider>
									<SettingsDialogProvider>
										<Chat chatId="chat_dev_render" title="Dev render" kind="teach" initialMessages={[]} initialConfigured={false} />
									</SettingsDialogProvider>
								</InteractionLayersProvider>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
			</PathnameContext.Provider>
			</AppRouterContext.Provider>,
		);
		assert.match(html, /Dev render/);
	});
});
