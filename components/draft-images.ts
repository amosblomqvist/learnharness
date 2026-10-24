"use client";

import { useCallback, useRef, useState } from "react";
import {
	IMAGE_MIME_TYPES,
	MAX_IMAGES,
	MAX_IMAGE_BYTES,
	MAX_TOTAL_IMAGE_BYTES,
	imageBytes,
	type DraftImage,
} from "@/src/core";

/**
 * THE IMAGE DRAFT (composer paste): the paste → validate → read path the
 * sending surfaces share (home, the /chat/new draft, a live session). The
 * limits come from the core (images.ts), so the composer's kind refusal and
 * the server's 400 can never drift apart.
 *
 * State + a REF MIRROR: a send that resumes after an await (dictation
 * finish, image reads) must read the live draft, not a render-time closure.
 * Reads are tracked so a paste followed at once by Enter waits for them
 * instead of sending an image the reader had not produced yet.
 */
export function useImageDraft() {
	const [images, setImages] = useState<DraftImage[]>([]);
	const imagesRef = useRef<DraftImage[]>([]);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef<Promise<void>[]>([]);

	const apply = useCallback((next: DraftImage[]) => {
		imagesRef.current = next;
		setImages(next);
	}, []);

	const addFiles = useCallback(
		(files: File[]) => {
			setError(null);
			for (const file of files) {
				if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
					setError("Images must be PNG, JPEG, WebP, or GIF.");
					continue;
				}
				if (file.size > MAX_IMAGE_BYTES) {
					setError(`Each image must be ${MAX_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`);
					continue;
				}
				// FileReader hands back a data: URL — its tail IS the base64 the
				// native message carries, so nothing is encoded twice.
				pending.current.push(
					new Promise<void>((resolve) => {
						const reader = new FileReader();
						reader.onload = () => {
							const url = String(reader.result ?? "");
							const comma = url.indexOf(",");
							if (comma < 0) return resolve();
							if (imagesRef.current.length >= MAX_IMAGES) {
								setError(`You can attach up to ${MAX_IMAGES} images.`);
								return resolve();
							}
							const next: DraftImage[] = [
								...imagesRef.current,
								{
									id: `img_${crypto.randomUUID()}`,
									type: "image",
									mimeType: file.type,
									data: url.slice(comma + 1),
								},
							];
							if (next.reduce((n, i) => n + imageBytes(i.data), 0) > MAX_TOTAL_IMAGE_BYTES) {
								setError(
									`Those images are too large together (${MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)} MB max).`,
								);
								return resolve();
							}
							apply(next);
							resolve();
						};
						reader.onerror = () => {
							setError("That image could not be read.");
							resolve();
						};
						reader.readAsDataURL(file);
					}),
				);
			}
		},
		[apply],
	);

	/** Await the reads already in flight (a send never races a paste). */
	const settle = useCallback(async () => {
		const reads = pending.current;
		pending.current = [];
		await Promise.all(reads);
	}, []);

	return { images, imagesRef, error, setError, addFiles, apply, settle };
}

/**
 * THE FIRST-MESSAGE HANDOFF (composer paste): a session is born from its
 * first message, and that message travels as `?prompt=<text>` — a URL that
 * cannot carry image bytes. When the first message holds images the sending
 * surface creates the session, stashes the draft HERE, and pushes the plain
 * `/chat/<id>`; the chat page takes it once, into the normal send path (so a
 * refusal restores the draft exactly like every other send).
 *
 * In memory on purpose: the navigation is a client-side push, so the module
 * survives it. A hard reload between the two pages drops the draft — the
 * session is already created and empty, nothing partial is persisted.
 */
const firstMessages = new Map<string, { text: string; images: DraftImage[] }>();

export function stashFirstMessage(chatId: string, draft: { text: string; images: readonly DraftImage[] }): void {
	firstMessages.set(chatId, { text: draft.text, images: [...draft.images] });
}

export function takeFirstMessage(chatId: string): { text: string; images: DraftImage[] } | null {
	const draft = firstMessages.get(chatId);
	if (draft) firstMessages.delete(chatId);
	return draft ?? null;
}

/**
 * The clipboard files a paste event carries: `files` covers Chrome's own
 * paste, `items` covers clipboards that expose only item entries (Linux
 * providers, some Electron paths). Pure — the caller decides what to do
 * with them.
 */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
	if (!data) return [];
	const fromFiles = Array.from(data.files ?? []).filter((f) => f.type.startsWith("image/"));
	if (fromFiles.length > 0) return fromFiles;
	return Array.from(data.items ?? [])
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter((f): f is File => f !== null);
}
