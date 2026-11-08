import type { Metadata } from "next";
import { cookies } from "next/headers";
import { JetBrains_Mono, Source_Sans_3, Vazirmatn } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { LOCALE_COOKIE, dirOf, resolveLocale } from "@/lib/i18n/locales";
import { LocaleProvider } from "@/lib/i18n/provider";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });
// Persian/Arabic script: Vazirmatn (variable, 100–900). It also carries Latin
// glyphs, so in the fa locale it leads the stacks (globals.css); in en it is
// only the fallback that Persian text falls through to.
const persian = Vazirmatn({ subsets: ["arabic", "latin"], variable: "--font-vazirmatn", display: "swap" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);
	return (
		<html lang={locale} dir={dirOf(locale)} className={`dark ${ui.variable} ${prose.variable} ${persian.variable}`}>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<LocaleProvider initialLocale={locale}>
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			</LocaleProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
