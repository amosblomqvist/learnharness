import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { PluginsProvider } from "@/components/plugins";
import { readThemeBoot } from "@/src/server";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

/**
 * The phone viewport (narrow-viewport pass, 2026-11-14). width/initialScale
 * restate Next's defaults; the two additions are:
 *
 * - interactiveWidget: Android Chrome shrinks the LAYOUT viewport when the
 *   keyboard opens, so the sticky composer stays above it. The default
 *   (resizes-visual) leaves the dock hidden behind the keyboard.
 * - themeColor + colorScheme: the active theme's background and mode, so
 *   the browser's status bar matches the app. Read per request like the
 *   first-paint theme (connection() keeps it out of prerenders) — a theme
 *   switch is a reload, exactly as the appearance settings already behave.
 *
 * viewportFit stays unset on purpose: extending under the notch would make
 * the shell own the safe-area insets (body + three page roots), and that
 * needs a real-device pass before it is worth the layout change.
 */
export async function generateViewport(): Promise<Viewport> {
	await connection();
	const { theme, vars } = readThemeBoot();
	return {
		width: "device-width",
		initialScale: 1,
		interactiveWidget: "resizes-content",
		colorScheme: theme.mode,
		themeColor: vars["--background"],
	};
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, vars } = readThemeBoot();
	return (
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
						<SidebarProvider>
							<ActivityProvider>
								<AppShell>{children}</AppShell>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
