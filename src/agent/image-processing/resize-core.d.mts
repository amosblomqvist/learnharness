import type { ModelImageResizeOptions, ResizedImage } from "./types.ts";
export const IMAGE_RESIZE_WORKER_RESPONSE_TYPE: "pi:image-resize-response";
export function resizeImageInProcess(inputBytes: Uint8Array, mimeType: string, options?: ModelImageResizeOptions): Promise<ResizedImage | null>;
export type ResizeImageWorkerResponse = {
	type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE;
	result: ResizedImage | null;
} | {
	type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE;
	error: string;
};
