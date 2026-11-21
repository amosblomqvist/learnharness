// Generate the installable web app's icon set from the same flat design
// source as the desktop icons (build/icon-flat.svg — the owner's Affinity
// export, rounded squircle with baked transparency).
//
//   public/icons/icon-192.png          — manifest 192, purpose "any"
//   public/icons/icon-512.png          — manifest 512, purpose "any"
//   public/icons/icon-512-maskable.png — 512 with the mark inset 20% on the
//                                        theme background, so Android's
//                                        adaptive mask never clips it
//   public/icons/apple-touch-icon.png  — 180, iOS home screen (opaque)
//
// Rendered directly from the SVG (resvg) like scripts/make-icons.mjs; the
// outputs are committed. Rerun only when the design changes:
//   node scripts/make-pwa-icons.mjs
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(path.join(root, "build", "icon-flat.svg"), "utf8");
const out = path.join(root, "public", "icons");
mkdirSync(out, { recursive: true });

const render = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render(size, size).asPng();

/** The squircle on an opaque background, inset by `pad` of the canvas. */
function onBackground(size, pad, background) {
	const inner = size * (1 - 2 * pad);
	const body = source.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
		<rect width="${size}" height="${size}" fill="${background}"/>
		<svg x="${size * pad}" y="${size * pad}" width="${inner}" height="${inner}" viewBox="0 0 1024 1024">${body}</svg>
	</svg>`;
}

const BACKGROUND = "#141414";
const files = [
	["icon-192.png", render(source, 192)],
	["icon-512.png", render(source, 512)],
	["icon-512-maskable.png", render(onBackground(512, 0.1, BACKGROUND), 512)],
	["apple-touch-icon.png", render(onBackground(180, 0.08, BACKGROUND), 180)],
];
for (const [name, png] of files) {
	writeFileSync(path.join(out, name), png);
	console.log(`public/icons/${name}  ${(png.length / 1024).toFixed(1)} KB`);
}
