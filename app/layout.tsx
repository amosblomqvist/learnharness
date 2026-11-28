import { ActivityProvider } from "@/components/activity-dock";
import { PluginsProvider } from "@/components/plugins";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import UpdateBanner from "@/components/update-banner";
import { readThemeBoot } from "@/src/server";
import "katex/dist/katex.min.css";
import type { Metadata } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import "./globals.css";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = localFont({
    src: "./fonts/jetbrains-mono-latin-wght-normal.woff2",
    variable: "--font-jetbrains",
    weight: "100 800",
    display: "swap",
});
const prose = localFont({
    src: "./fonts/source-sans-3-latin-wght-normal.woff2",
    variable: "--font-sans3",
    weight: "200 900",
    display: "swap",
});

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
