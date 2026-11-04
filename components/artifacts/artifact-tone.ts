/**
 * Figure tone measurement (auto-invert, 2026-10-29): was this SVG drawn
 * light? Rasterized off-screen at ~64 px wide over white (the figure
 * holder is bg-white), then the perimeter decides (core toneFromPixels).
 * Browser-only; results are cached per SVG string for the page's lifetime,
 * so remounts and the fullscreen overlay never re-measure. Any decode or
 * canvas failure reads "unknown" — never auto-flipped.
 */
import { toneFromPixels, type ArtifactTone } from "@/src/core";
import { chartSize } from "@/components/session-overlay";

const MEASURE_WIDTH = 64;
const cache = new Map<string, ArtifactTone>();

export function cachedSvgTone(svg: string): ArtifactTone | undefined {
	return cache.get(svg);
}

/** Test seam: render tests run without a DOM, so they prime the cache. */
export function primeSvgTone(svg: string, tone: ArtifactTone): void {
	cache.set(svg, tone);
}

export async function measureSvgTone(svg: string): Promise<ArtifactTone> {
	const hit = cache.get(svg);
	if (hit) return hit;
	const tone = await rasterTone(svg).catch((): ArtifactTone => "unknown");
	cache.set(svg, tone);
	return tone;
}

async function rasterTone(svg: string): Promise<ArtifactTone> {
	const { w, h } = chartSize(svg);
	const width = MEASURE_WIDTH;
	const height = Math.max(1, Math.round((MEASURE_WIDTH * h) / w));
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	try {
		const img = new Image(width, height);
		img.src = url;
		await img.decode();
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) return "unknown";
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(img, 0, 0, width, height);
		return toneFromPixels(ctx.getImageData(0, 0, width, height).data, width, height);
	} finally {
		URL.revokeObjectURL(url);
	}
}
