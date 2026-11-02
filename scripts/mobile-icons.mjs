/**
 * mobile-icons.mjs — regenerate the native apps' icons and splash screens
 * (mobile/native/android, mobile/native/ios) from the LearnHarness mark in
 * components/lh-mark.tsx. Every image keeps the file name and pixel size the
 * Capacitor template gave it; only the artwork changes. Run after
 * `npx cap add` or when the mark changes:
 *
 *   node scripts/mobile-icons.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const ROOT = path.resolve(import.meta.dirname, "..");
const NATIVE = path.join(ROOT, "mobile", "native");
const BG = "#141414";

// The mark's SVG body, lifted from the React component (806×806 viewBox).
const tsx = fs.readFileSync(path.join(ROOT, "components", "lh-mark.tsx"), "utf-8");
const mark = tsx
	.slice(tsx.indexOf("<g transform"), tsx.lastIndexOf("</svg>"))
	.replace(/style=\{\{\s*fill:\s*"([^"]+)"\s*\}\}/g, 'fill="$1"');

/** The mark centered on a w×h canvas at `scale` of the shorter side. */
function svg(w, h, scale, { background = BG, circle = false } = {}) {
	const size = Math.min(w, h) * scale;
	const k = size / 806;
	const clip = circle ? `<clipPath id="c"><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}"/></clipPath>` : "";
	const bg = background ? `<rect width="${w}" height="${h}" fill="${background}"${circle ? ' clip-path="url(#c)"' : ""}/>` : "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${clip}</defs>${bg}<g transform="translate(${(w - size) / 2},${(h - size) / 2}) scale(${k})" fill-rule="evenodd" clip-rule="evenodd">${mark}</g></svg>`;
}

function render(file, source) {
	const png = new Resvg(source, { fitTo: { mode: "original" } }).render().asPng();
	fs.writeFileSync(file, png);
}

/** PNG width/height from its IHDR chunk. */
function pngSize(file) {
	const b = fs.readFileSync(file);
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function each(dir, name, fn) {
	if (!fs.existsSync(dir)) return 0;
	let n = 0;
	for (const sub of fs.readdirSync(dir)) {
		const file = path.join(dir, sub, name);
		if (fs.existsSync(file)) {
			fn(file, pngSize(file));
			n++;
		}
	}
	return n;
}

const res = path.join(NATIVE, "android", "app", "src", "main", "res");
let count = 0;
// Legacy square + round launcher icons: full-bleed, mark at 62%.
count += each(res, "ic_launcher.png", (f, { w, h }) => render(f, svg(w, h, 0.62)));
count += each(res, "ic_launcher_round.png", (f, { w, h }) => render(f, svg(w, h, 0.62, { circle: true })));
// Adaptive foreground: transparent, mark inside the 66% safe zone.
count += each(res, "ic_launcher_foreground.png", (f, { w, h }) => render(f, svg(w, h, 0.42, { background: null })));
// Splash screens: dark, small centered mark.
count += each(res, "splash.png", (f, { w, h }) => render(f, svg(w, h, 0.22)));
const bgXml = path.join(res, "values", "ic_launcher_background.xml");
if (fs.existsSync(bgXml)) {
	fs.writeFileSync(bgXml, fs.readFileSync(bgXml, "utf-8").replace(/#[0-9A-Fa-f]{6}/, BG.toUpperCase()));
}

const assets = path.join(NATIVE, "ios", "App", "App", "Assets.xcassets");
// iOS rounds the corners itself: full-bleed, opaque.
count += each(assets, "AppIcon-512@2x.png", (f, { w, h }) => render(f, svg(w, h, 0.62)));
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
	count += each(assets, name, (f, { w, h }) => render(f, svg(w, h, 0.12)));
}

console.log(`[mobile-icons] ${count} images regenerated`);
