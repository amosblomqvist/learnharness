"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
	checkImageDimensions,
	checkSourceImageMeta,
	ImageInputError,
	inspectImageBytes,
	IMAGE_ERRORS,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_DIMENSION,
	parseComposerImages,
	type DraftImage,
} from "@/src/core";

/** Shared draft controller with serial decoding and stale-read cancellation.
 * Normalized browser bytes are sent unchanged. The plain controller keeps
 * async ordering testable without a DOM harness. */

/** What a composer needs to show and edit the draft: one object, so the
 *  surfaces pass the draft through as a unit. */
export interface ImageDraftProps {
	images: readonly DraftImage[];
	/** Drafted images, or ones still being read (see useImageDraft). */
	hasImages: boolean;
	error: string | null;
	onChange: (next: DraftImage[]) => void;
	/** Files from a paste, the picker or a drop: all take this one door. */
	onPaste: (files: File[]) => void;
	/** Show a picture full size (its data URL). */
	onOpen?: (url: string) => void;
}

// ── normalization ───────────────────────────────────────────────────────────

export interface DecodedRaster {
	width: number;
	height: number;
	/** Draw the first frame at `scale` and encode it as a PNG. */
	encodePng(scale: number): Promise<Blob>;
	close(): void;
}

export interface RasterDeps {
	/** The file's leading bytes (header inspection, before any decode). */
	head(file: File): Promise<Uint8Array>;
	decode(file: File): Promise<DecodedRaster>;
	toBase64(blob: Blob): Promise<string>;
}

function readBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result ?? "");
			const comma = url.indexOf(",");
			if (comma < 0) reject(new Error("empty"));
			else resolve(url.slice(comma + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error("read"));
		reader.readAsDataURL(blob);
	});
}

async function decodeInBrowser(file: File): Promise<DecodedRaster> {
	let source: CanvasImageSource;
	let width: number;
	let height: number;
	let release = () => {};
	if (typeof createImageBitmap === "function") {
		// An animated GIF/WebP decodes to its first frame.
		const bitmap = await createImageBitmap(file);
		source = bitmap;
		width = bitmap.width;
		height = bitmap.height;
		release = () => bitmap.close();
	} else {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.src = url;
		await img.decode();
		source = img;
		width = img.naturalWidth;
		height = img.naturalHeight;
		release = () => URL.revokeObjectURL(url);
	}
	return {
		width,
		height,
		close: release,
		encodePng(scale) {
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) return Promise.reject(new Error("canvas"));
			ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
			return new Promise((resolve, reject) =>
				canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/png"),
			);
		},
	};
}

async function headOf(file: File): Promise<Uint8Array> {
	return new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
}

export const browserRaster: RasterDeps = { head: headOf, decode: decodeInBrowser, toBase64: readBase64 };

/** One source file → the {mimeType, data} the draft (and the wire) carries. */
export async function normalizeImageFile(file: File, deps: RasterDeps = browserRaster): Promise<{ mimeType: string; data: string }> {
	checkSourceImageMeta(file.type, file.size); // type + 20 MiB, before any decode
	// Strict header inspection (core): real format and bounded dimensions
	// BEFORE the browser is asked to decode anything.
	const info = inspectImageBytes(await deps.head(file).catch(() => new Uint8Array()));
	if (!info || info.mimeType !== file.type) throw new ImageInputError(IMAGE_ERRORS.content);
	checkImageDimensions(info.width, info.height);
	let raster: DecodedRaster;
	try {
		raster = await deps.decode(file);
	} catch {
		throw new ImageInputError(IMAGE_ERRORS.unreadable);
	}
	try {
		const { width, height } = raster;
		checkImageDimensions(width, height);
		const longest = Math.max(width, height);
		const keepsBytes = (file.type === "image/png" || file.type === "image/jpeg") && file.size <= MAX_IMAGE_BYTES && longest <= MAX_IMAGE_DIMENSION;
		if (keepsBytes) return { mimeType: file.type, data: await deps.toBase64(file) };
		let scale = Math.min(1, MAX_IMAGE_DIMENSION / longest);
		for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
			const png = await raster.encodePng(scale);
			if (png.size <= MAX_IMAGE_BYTES) return { mimeType: "image/png", data: await deps.toBase64(png) };
		}
		throw new ImageInputError(IMAGE_ERRORS.size);
	} catch (err) {
		throw err instanceof ImageInputError ? err : new ImageInputError(IMAGE_ERRORS.unreadable);
	} finally {
		raster.close();
	}
}

// ── the controller ──────────────────────────────────────────────────────────

export interface ImageDraftState {
	images: readonly DraftImage[];
	reading: number;
	error: string | null;
}

export class ImageDraftController {
	images: DraftImage[] = [];
	private reading = 0;
	private error: string | null = null;
	private epoch = 0;
	private disposed = false;
	private queue: Promise<void> = Promise.resolve();
	private listeners = new Set<() => void>();
	private snap: ImageDraftState = { images: [], reading: 0, error: null };

	constructor(private readonly normalize: (file: File) => Promise<{ mimeType: string; data: string }> = normalizeImageFile) {}

	subscribe = (fn: () => void): (() => void) => {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	};
	getState = (): ImageDraftState => this.snap;

	private emit(): void {
		this.snap = { images: this.images, reading: this.reading, error: this.error };
		for (const fn of this.listeners) fn();
	}

	setError = (message: string | null): void => {
		if (this.disposed) return;
		this.error = message;
		this.emit();
	};

	/** Replace the drafted images (remove a thumbnail, programmatic edit).
	 *  Reads in flight are NOT cancelled; use clear() for that. */
	setImages = (next: DraftImage[]): void => {
		if (this.disposed) return;
		this.images = next;
		this.emit();
	};

	/** Empty the draft (a send took it): pending reads are invalidated. */
	clear = (): void => {
		this.epoch++;
		this.reading = 0;
		this.images = [];
		this.error = null;
		if (!this.disposed) this.emit();
	};

	/** Unmount: no late decode may touch state or resurrect anything. */
	dispose = (): void => {
		this.epoch++;
		this.disposed = true;
	};

	/** Strict-mode remount: the same instance is re-armed (its draft was
	 *  invalidated by the dispose in between). */
	revive = (): void => {
		this.disposed = false;
	};

	/** Drop exactly these images (an ACKed send), keeping any added since. */
	removeImages = (ids: readonly string[]): void => {
		const gone = new Set(ids);
		this.setImages(this.images.filter((i) => !gone.has(i.id)));
	};

	/** Put a refused send's images back WITHOUT dropping later ones. */
	restoreSent = (sent: readonly DraftImage[]): void => {
		const ids = new Set(sent.map((i) => i.id));
		this.setImages([...sent, ...this.images.filter((i) => !ids.has(i.id))]);
	};

	addFiles = (files: readonly File[]): void => {
		if (this.disposed || files.length === 0) return;
		this.error = null;
		const epoch = this.epoch;
		this.reading += files.length;
		this.emit();
		const batch = [...files];
		this.queue = this.queue.then(async () => {
			for (const file of batch) {
				if (epoch !== this.epoch) return; // cleared or unmounted: stale
				let failure: string | null = null;
				let added: DraftImage | null = null;
				try {
					const { mimeType, data } = await this.normalize(file);
					if (epoch !== this.epoch) return;
					const candidate: DraftImage = { id: `img_${crypto.randomUUID()}`, type: "image", mimeType, data };
					// The server's own rules: count, sizes, real format.
					parseComposerImages([...this.images, candidate]);
					added = candidate;
				} catch (err) {
					if (epoch !== this.epoch) return;
					failure = err instanceof ImageInputError ? err.message : IMAGE_ERRORS.unreadable;
				}
				this.reading = Math.max(0, this.reading - 1);
				if (added) this.images = [...this.images, added];
				if (failure) this.error = failure;
				this.emit();
			}
		});
	};

	/** Await the reads already in flight (a send never races a paste). */
	awaitReads = async (): Promise<void> => {
		await this.queue;
	};
}

export function useImageDraft() {
	const ref = useRef<ImageDraftController | null>(null);
	if (!ref.current) ref.current = new ImageDraftController();
	const c = ref.current;
	useEffect(() => {
		c.revive();
		const paste = (event: ClipboardEvent) => {
			if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
			const target = event.target instanceof Element ? event.target : null;
			if (imagePasteAllowed(target, document.activeElement)) handleImagePaste(event, c.addFiles);
		};
		document.addEventListener("paste", paste);
		return () => { document.removeEventListener("paste", paste); c.dispose(); };
	}, [c]);
	const state = useSyncExternalStore(c.subscribe, c.getState, c.getState);
	// Live mirror: a send resuming after an await reads the draft, not a closure.
	const imagesRef = useMemo(
		() => ({
			get current() {
				return c.images;
			},
		}),
		[c],
	);
	const hasImages = state.images.length > 0 || state.reading > 0;
	const props = useMemo<Omit<ImageDraftProps, "onOpen">>(
		() => ({ images: state.images, hasImages, error: state.error, onChange: c.setImages, onPaste: c.addFiles }),
		[state, hasImages, c],
	);
	return {
		imagesRef,
		hasImages,
		setError: c.setError,
		restoreSent: c.restoreSent,
		removeImages: c.removeImages,
		awaitReads: c.awaitReads,
		props,
	};
}

// ── DOM handlers ────────────────────────────────────────────────────────────

/** Other editors own their paste; non-editable page/composer controls do not. */
export function imagePasteAllowed(target: Element | null, active: Element | null): boolean {
 const blocked = (element: Element | null) => {
  if (element?.closest('[role="dialog"], [role="alertdialog"]')) return true;
  const field = element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  return !!field && !field.closest("[data-image-composer]");
 };
 return !blocked(target) && !blocked(active);
}

type ImagePasteEvent = Pick<ClipboardEvent, "clipboardData" | "preventDefault" | "defaultPrevented"> & { nativeEvent?: object };
const handledImagePastes = new WeakSet<object>();

/** Textarea and page listeners share one claim, including mixed text/image pastes. */
export function handleImagePaste(e: ImagePasteEvent, onPaste: ((files: File[]) => void) | undefined): void {
 const native = e.nativeEvent ?? e;
 if (!onPaste || e.defaultPrevented || handledImagePastes.has(native)) return;
 const data = e.clipboardData;
 const files = clipboardImageFiles(data);
 if (files.length === 0) return;
 handledImagePastes.add(native);
 if (!data || data.getData("text/plain").length === 0) e.preventDefault();
 onPaste(files);
}

function hasFiles(data: DataTransfer | null): boolean {
	return Array.from(data?.types ?? []).includes("Files");
}

/** Drag-over / drop handlers for a composer. EVERY file drop is claimed (the
 *  browser must never navigate to a dropped file); files go to the draft,
 *  which refuses unsupported types with its friendly error. */
export function imageDropHandlers(onFiles: ((files: File[]) => void) | undefined) {
	return {
		onDragOver(e: React.DragEvent) {
			if (hasFiles(e.dataTransfer)) e.preventDefault();
		},
		onDrop(e: React.DragEvent) {
			if (!hasFiles(e.dataTransfer)) return;
			e.preventDefault();
			const files = Array.from(e.dataTransfer.files ?? []);
			if (files.length > 0) onFiles?.(files);
		},
	};
}

/** The picker's change handler: hand the files over, then reset the input so
 *  choosing the SAME file again (after removing it) fires change. */
export function handlePickedFiles(input: { files: FileList | null; value: string }, onFiles: ((files: File[]) => void) | undefined): void {
	const files = Array.from(input.files ?? []);
	input.value = "";
	if (files.length > 0) onFiles?.(files);
}

function clipboardImageFiles(data: DataTransfer | null): File[] {
	if (!data) return [];
	const fromFiles = Array.from(data.files ?? []).filter((f) => f.type.startsWith("image/"));
	if (fromFiles.length > 0) return fromFiles;
	return Array.from(data.items ?? [])
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter((f): f is File => f !== null);
}
