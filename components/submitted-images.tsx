import type { ImageContent } from "@earendil-works/pi-ai";

/** Explicit native image data only. Paths are never interpreted here. */
export function SubmittedImages({ images }: { images?: readonly Readonly<ImageContent>[] }) {
	if (!images?.length) return null;
	return <div className="w-full space-y-3" data-testid="submitted-images">
		{images.map((image, index) => <figure key={index} className="mx-auto my-3 w-fit max-w-full">
			{/* Native accepted bytes have no remote optimization or image controls. */}
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={`data:${image.mimeType};base64,${image.data}`} alt="Submitted image" className="block h-auto max-w-full opacity-100" />
		</figure>)}
	</div>;
}
