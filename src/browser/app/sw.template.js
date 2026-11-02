/*
 * LearnHarness phone app — offline service worker (mobile Phase 1).
 * scripts/build-mobile.mjs writes this to dist-mobile/sw.js with the build's
 * version and app-shell file list substituted below.
 *
 * - The app shell (index.html + the scripts the app loads at start) is
 *   cached at install, so the app opens with no network.
 * - Other same-origin files are cached the first time they are fetched;
 *   chunk names carry content hashes, so a cached copy is always right.
 * - Page navigations (/, /chat/…) are answered with the cached index.html:
 *   the app routes on the device.
 * - Google Fonts: served from cache, refreshed in the background.
 * - Nothing else is touched: model providers are always reached directly.
 * - A new version installs in the background and takes over once the app
 *   has been closed (no skipWaiting), so a running app never mixes builds.
 */
const VERSION = "__LH_VERSION__";
const SHELL = __LH_SHELL__;
const CACHE = `lh-app-${VERSION}`;
const FONTS = "lh-fonts";

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k.startsWith("lh-app-") && k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);

	if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
		event.respondWith(
			caches.open(FONTS).then(async (cache) => {
				const cached = await cache.match(req);
				const fresh = fetch(req)
					.then((res) => {
						if (res.ok || res.type === "opaque") cache.put(req, res.clone());
						return res;
					})
					.catch(() => cached);
				return cached ?? fresh;
			}),
		);
		return;
	}

	if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

	if (req.mode === "navigate") {
		event.respondWith(caches.match("/index.html", { cacheName: CACHE }).then((cached) => cached ?? fetch(req)));
		return;
	}

	event.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const cached = await cache.match(req, { ignoreSearch: true });
			if (cached) return cached;
			const res = await fetch(req);
			if (res.ok && !url.pathname.endsWith(".map")) cache.put(req, res.clone());
			return res;
		}),
	);
});
