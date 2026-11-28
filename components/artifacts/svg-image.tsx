import { svgImageSource } from "../../lib/svg-image-source";
import { tr } from "@/src/core";

// Preserve the component module's existing public export.
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
	return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgImageSource(svg))}`} alt={tr("插图", "Figure")} className={className} width={width} draggable={false} />;
}
