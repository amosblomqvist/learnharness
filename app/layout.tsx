import type { Metadata } from "next";
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
import { I18nProvider } from "@/components/i18n";
import { readSettingsRecord, readThemeBoot } from "@/src/server";
import { htmlLangFor, resolveSettings } from "@/src/core";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, vars } = readThemeBoot();
	// The UI language (i18n foundation, 2026-11-19): read the record on the
	// server like the theme, so the first frame is already in the user's
	// language and <html lang> matches what is on screen.
	const language = resolveSettings(readSettingsRecord() ?? null).general.language;
	return (
		<html
			lang={htmlLangFor(language)}
			className={`${theme.mode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<I18nProvider language={language}>
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
			</I18nProvider>
		</body>
		</html>
	);
}
