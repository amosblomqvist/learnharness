import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
	applicationName: "Learning Harness",
	manifest: "/manifest.webmanifest",
	icons: {
		icon: "/icons/icon-192.png",
		apple: "/icons/apple-touch-icon.png",
	},
	appleWebApp: {
		capable: true,
		title: "Harness",
		statusBarStyle: "black-translucent",
	},
};

/**
 * Mobile web (mobile-web, 2026-10-29): `viewportFit: cover` lets the CSS read
 * the safe-area insets on notched phones; zoom is left enabled (accessibility)
 * and the app itself never relies on double-tap.
 */
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 5,
	viewportFit: "cover",
	// Phones: the on-screen keyboard shrinks the layout instead of covering the
	// composer, so the field and the sheet stay reachable while typing.
	interactiveWidget: "resizes-content",
	themeColor: "#0b0b0c",
	colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">{children}</body>
		</html>
	);
}
