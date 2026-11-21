import type { MetadataRoute } from "next";

/**
 * The installable web app (narrow-viewport series, 2026-11-14).
 *
 * Browser mode is a self-hosted page people want on their phone's home
 * screen; this is the manifest that makes that install, with no service
 * worker and no offline story (deliberately out of scope).
 *
 * The colors are the Default theme's — a manifest is static, while the
 * runtime `<meta name="theme-color">` follows the ACTIVE theme
 * (generateViewport in app/layout.tsx). An installed icon therefore uses
 * the default palette; the running app keeps its own.
 *
 * Icons are committed outputs of scripts/make-pwa-icons.mjs, rendered from
 * the same source as the desktop icons (build/icon-flat.svg).
 */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Learning Harness",
		short_name: "LearnHarness",
		description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#141414",
		theme_color: "#141414",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
