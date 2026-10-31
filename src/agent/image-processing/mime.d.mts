import type { SupportedImageMimeType } from "./types.ts";
export function detectSupportedImageMimeType(buffer: Uint8Array): SupportedImageMimeType | null;
export function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<SupportedImageMimeType | null>;
