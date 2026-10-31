import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { SessionGuard } from "@/components/auth/session-guard";

/**
 * The signed-in application shell (mobile-web route group, 2026-10-29):
 * every page that needs the sidebar, the activity bus and the appearance
 * preferences lives under this layout. The auth pages (/login, /setup, /join)
 * sit in the (auth) group and never mount it.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
	return (
		<>
			{/* Web sessions: bounce to /login on an expired/revoked cookie. */}
			<SessionGuard />
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</>
	);
}
