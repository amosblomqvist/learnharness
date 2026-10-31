// Port baseline: @earendil-works/pi-coding-agent 1.1.0 image utilities (MIT).
/** Native resize overrides, supplied by the caller for the selected model. */
export interface ModelImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
}

export interface ResizedImage {
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

export interface ProcessImageOptions {
	autoResizeImages?: boolean;
	resizeOptions?: ModelImageResizeOptions;
}

export type ProcessImageResult = {
	ok: true;
	data: string;
	mimeType: string;
	hints: string[];
} | {
	ok: false;
	message: string;
};

export type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp";
