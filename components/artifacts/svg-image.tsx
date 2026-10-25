/** Image documents are inert: generated SVG cannot execute scripts, navigate
 * the app, load external resources, or add HTML/event handlers to its DOM. Use
 * the same boundary in cards and fullscreen; regex sanitizing is insufficient. */
export function SvgImage({ svg, className, width }: { svg: string; className?: string; width?: number }) {
	// next/image optimizes remote/raster resources; this is an in-memory vector.
	// eslint-disable-next-line @next/next/no-img-element
	return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt="Generated figure" className={className} width={width} draggable={false} />;
}
