"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { checkImageMeta, ImageInputError, IMAGE_ERRORS, parseComposerImages, type DraftImage } from "@/src/core";

/**
 * THE IMAGE DRAFT (composer paste): the paste, validate, read path every
 * sending surface shares (home, the /chat/new draft, a live session). The
 * checks are the core's own (images.ts), so the composer's inline refusal
 * and the server's 400 read the same rules and the same words.
 *
 * State + a REF MIRROR: a send that resumes after an await (dictation
 * finish, image reads) must read the live draft, not a render-time closure.
 * Reads are tracked so a paste followed at once by Enter waits for them
 * instead of sending before the reader has produced the image.
 */

/** What a composer needs to show and edit the draft: one object, so the
 *  surfaces pass the draft through as a unit. */
export interface ImageDraftProps {
	images: readonly DraftImage[];
	/** Drafted images, or ones still being read (see useImageDraft). */
	hasImages: boolean;
	error: string | null;
	onChange: (next: DraftImage[]) => void;
	onPaste: (files: File[]) => void;
	/** Show a picture full size (its data URL). */
	onOpen?: (url: string) => void;
}

export function useImageDraft() {
	const [images, setImages] = useState<DraftImage[]>([]);
	const imagesRef = useRef<DraftImage[]>([]);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef<Promise<void>[]>([]);
	// Reads in flight count as draft content: Enter right after a paste must
	// reach the send (which awaits them), not be gated out as "empty".
	const [reading, setReading] = useState(0);

	const setDraftImages = useCallback((next: DraftImage[]) => {
		imagesRef.current = next;
		setImages(next);
	}, []);

	/** Put images back after a refused send WITHOUT dropping the ones pasted
	 *  since: the restored images go first (they were sent first). */
	const restoreSent = useCallback(
		(sent: readonly DraftImage[]) => {
			const ids = new Set(sent.map((i) => i.id));
			setDraftImages([...sent, ...imagesRef.current.filter((i) => !ids.has(i.id))]);
		},
		[setDraftImages],
	);

	const addFiles = useCallback(
		(files: File[]) => {
			setError(null);
			for (const file of files) {
				try {
					checkImageMeta(file.type, file.size);
				} catch (err) {
					setError((err as Error).message);
					continue;
				}
				// FileReader hands back a data: URL. Its tail IS the base64 the
				// native message carries, so nothing is encoded twice.
				setReading((n) => n + 1);
				pending.current.push(
					new Promise<void>((done) => {
						const resolve = () => {
							setReading((n) => n - 1);
							done();
						};
						const reader = new FileReader();
						reader.onload = () => {
							const url = String(reader.result ?? "");
							const comma = url.indexOf(",");
							const candidate: DraftImage = {
								id: `img_${crypto.randomUUID()}`,
								type: "image",
								mimeType: file.type,
								data: comma < 0 ? "" : url.slice(comma + 1),
							};
							const next = [...imagesRef.current, candidate];
							try {
								// The server's own rules: count, sizes, and the bytes'
								// real format (a renamed file is refused here, not later).
								parseComposerImages(next);
								setDraftImages(next);
							} catch (err) {
								setError(err instanceof ImageInputError ? err.message : IMAGE_ERRORS.unreadable);
							}
							resolve();
						};
						reader.onerror = () => {
							setError(IMAGE_ERRORS.unreadable);
							resolve();
						};
						reader.readAsDataURL(file);
					}),
				);
			}
		},
		[setDraftImages],
	);

	/** Await the reads already in flight (a send never races a paste). */
	const awaitReads = useCallback(async () => {
		const reads = pending.current;
		pending.current = [];
		await Promise.all(reads);
	}, []);

	/** Anything to send: drafted images, or ones still being read. */
	const hasImages = images.length > 0 || reading > 0;

	const props = useMemo<Omit<ImageDraftProps, "onOpen">>(
		() => ({ images, hasImages, error, onChange: setDraftImages, onPaste: addFiles }),
		[images, hasImages, error, setDraftImages, addFiles],
	);

	return { images, imagesRef, hasImages, error, setError, addFiles, setImages: setDraftImages, restoreSent, awaitReads, props };
}

/**
 * The paste handler every composer textarea uses: image files (from
 * `files`, or `items` on clipboards that expose only those) go to the
 * draft. A clipboard that also carries text keeps its text: the picture
 * attaches alongside instead of replacing it.
 */
export function handleImagePaste(e: React.ClipboardEvent, onPaste: ((files: File[]) => void) | undefined): void {
	if (!onPaste) return;
	const data = e.clipboardData;
	const files = clipboardImageFiles(data);
	if (files.length === 0) return;
	if (!data || data.getData("text/plain").length === 0) e.preventDefault();
	onPaste(files);
}

/**
 * THE FIRST-MESSAGE HANDOFF (composer paste): a session is born from its
 * first message, and that message travels as `?prompt=<text>`, a URL that
 * cannot carry image bytes. When the first message holds images the sending
 * surface creates the session, stashes the draft HERE, and pushes the plain
 * `/chat/<id>`. The chat page takes it once, into the normal send path (so
 * a refusal restores the draft exactly like every other send).
 *
 * shortcut: in memory, so a hard reload between the two pages drops the
 * draft (the session exists, empty, nothing partial persisted); move to
 * sessionStorage if learners hit it.
 */
const firstMessages = new Map<string, { text: string; images: DraftImage[] }>();

function stashFirstMessage(chatId: string, draft: { text: string; images: readonly DraftImage[] }): void {
	firstMessages.set(chatId, { text: draft.text, images: [...draft.images] });
}

/** Where a newborn session opens with its first message: `?prompt=` for
 *  text, or the stash (above) when pictures ride along. */
export function firstMessageUrl(chatId: string, text: string, images: readonly DraftImage[]): string {
	if (images.length === 0) return `/chat/${chatId}?prompt=${encodeURIComponent(text)}`;
	stashFirstMessage(chatId, { text, images });
	return `/chat/${chatId}`;
}

export function takeFirstMessage(chatId: string): { text: string; images: DraftImage[] } | null {
	const draft = firstMessages.get(chatId);
	if (draft) firstMessages.delete(chatId);
	return draft ?? null;
}

/**
 * The clipboard files a paste event carries: `files` covers Chrome's own
 * paste, `items` covers clipboards that expose only item entries (Linux
 * providers, some Electron paths).
 */
function clipboardImageFiles(data: DataTransfer | null): File[] {
	if (!data) return [];
	const fromFiles = Array.from(data.files ?? []).filter((f) => f.type.startsWith("image/"));
	if (fromFiles.length > 0) return fromFiles;
	return Array.from(data.items ?? [])
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter((f): f is File => f !== null);
}
