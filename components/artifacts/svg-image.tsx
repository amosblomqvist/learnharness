import { svgImageSource } from "@/src/core";

export { svgImageSource };

/** Keep generated SVG in an image document, outside the app's CSS and ID scope.
 * This is a display boundary, not a sanitizer for the original SVG download. */
export function SvgImage({
	svg,
	className,
	width,
}: {
	svg: string;
	className?: string;
	width?: number;
}) {
	// The source is already an in-memory vector image; no Next image optimization.
	// eslint-disable-next-line @next/next/no-img-element
	return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgImageSource(svg))}`} alt="Figure" className={className} width={width} draggable={false} />;
}
