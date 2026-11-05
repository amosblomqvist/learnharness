"use client";

import { clampNotesWidth, NOTES_AUTOFOLD_BELOW, NOTES_DEFAULT_WIDTH, NOTES_WIDTH_KEY } from "@/components/notes-layout";
import { appendBlockText, quoteAsMarkdown } from "@/src/core";
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";

export const NOTES_OPEN_KEY = "lh-notes-open";
const SAVE_ERROR = "Notes not saved";
// Browsers refuse keepalive bodies over 64 KiB.
const KEEPALIVE_MAX_BYTES = 60_000;

export interface NotesEditorPort {
	append(block: string): void;
	/** Replace the whole doc without undo history or an edit. */
	reset(text: string): void;
}

export interface NotesSnapshot {
	open: boolean;
	width: number;
	/** `open`, unless auto-folded for a narrow window. */
	visible: boolean;
	saveError: string | null;
}

type NotesStorage = Pick<Storage, "getItem" | "setItem">;

const CLOSED: NotesSnapshot = { open: false, width: NOTES_DEFAULT_WIDTH, visible: false, saveError: null };

export class NotesController {
	private current: string;
	private version = 0;
	private savedVersion = 0;
	private snapshot: NotesSnapshot;
	private listeners = new Set<() => void>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inflight: Promise<boolean> | null = null;
	private port: NotesEditorPort | null = null;
	private narrow = false;
	private openedWhileNarrow = false;
	private readonly delay: number;
	private readonly storage: NotesStorage | undefined;

	constructor(
		private readonly chatId: string,
		initialText: string,
		opts: { saveDelayMs?: number; storage?: NotesStorage } = {},
	) {
		this.current = initialText;
		this.delay = opts.saveDelayMs ?? 600;
		this.storage = opts.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
		let open = false;
		try {
			open = this.storage?.getItem(NOTES_OPEN_KEY) === "1";
		} catch {}
		let width = NOTES_DEFAULT_WIDTH;
		try {
			const raw = this.storage?.getItem(NOTES_WIDTH_KEY);
			if (raw != null) width = clampNotesWidth(Number(raw));
		} catch {}
		this.snapshot = { open, width, visible: open, saveError: null };
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	getSnapshot(): NotesSnapshot {
		return this.snapshot;
	}

	text(): string {
		return this.current;
	}

	setOpen(open: boolean): void {
		if (open && this.narrow) this.openedWhileNarrow = true;
		if (!open) this.openedWhileNarrow = false;
		if (open !== this.snapshot.open) {
			try {
				this.storage?.setItem(NOTES_OPEN_KEY, open ? "1" : "0");
			} catch {}
		}
		this.update({ open });
	}

	setWidth(px: number): void {
		const width = clampNotesWidth(px);
		try {
			this.storage?.setItem(NOTES_WIDTH_KEY, String(width));
		} catch {}
		this.update({ width });
	}

	setNarrow(narrow: boolean): void {
		if (narrow === this.narrow) return;
		if (narrow) this.openedWhileNarrow = false;
		this.narrow = narrow;
		this.update({});
	}

	attach(port: NotesEditorPort | null): void {
		this.port = port;
	}

	/** Append a tutor quote to the notes and open the panel. */
	appendQuote(quote: string): void {
		if (!quote.trim()) return;
		const block = quoteAsMarkdown(quote);
		this.setOpen(true);
		if (this.port) this.port.append(block);
		else this.onEdit(appendBlockText(this.current, block));
	}

	onEdit(text: string): void {
		if (text === this.current) return;
		this.current = text;
		this.version++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), this.delay);
	}

	/** Re-read the saved text (Back/Forward can mount stale props); local edits always win. */
	async refresh(): Promise<void> {
		const version = this.version;
		if (this.dirty()) return;
		let text: unknown;
		try {
			const res = await fetch(`/api/chats/${this.chatId}/notes`, { cache: "no-store" });
			if (!res.ok) return;
			text = ((await res.json()) as { text?: unknown }).text;
		} catch {
			return;
		}
		if (typeof text !== "string" || this.dirty() || this.version !== version || text === this.current) return;
		this.current = text;
		this.port?.reset(text);
	}

	flush(opts: { keepalive?: boolean } = {}): Promise<boolean> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.inflight) return this.inflight.then(() => this.flush(opts));
		if (this.version === this.savedVersion) return Promise.resolve(true);
		return this.save(!!opts.keepalive);
	}

	dispose(): void {
		void this.flush({ keepalive: true });
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.port = null;
	}

	private dirty(): boolean {
		return this.version !== this.savedVersion || this.inflight !== null;
	}

	private save(keepalive: boolean): Promise<boolean> {
		const version = this.version;
		const body = JSON.stringify({ text: this.current });
		let request: Promise<Response>;
		try {
			request = fetch(`/api/chats/${this.chatId}/notes`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body,
				keepalive: keepalive && new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES,
			});
		} catch (err) {
			request = Promise.reject(err);
		}
		const run: Promise<boolean> = request.then(
			(res) => {
				if (!res.ok) return false;
				this.savedVersion = version;
				return true;
			},
			() => false,
		).then((ok) => {
			if (this.inflight === run) this.inflight = null;
			this.update({ saveError: ok ? null : SAVE_ERROR });
			return ok;
		});
		this.inflight = run;
		return run;
	}

	private update(patch: Partial<NotesSnapshot>): void {
		const next = { ...this.snapshot, ...patch };
		next.visible = next.open && (!this.narrow || this.openedWhileNarrow);
		const prev = this.snapshot;
		if (next.open === prev.open && next.width === prev.width && next.visible === prev.visible && next.saveError === prev.saveError) return;
		this.snapshot = next;
		for (const l of [...this.listeners]) l();
	}
}

const NotesContext = createContext<NotesController | null>(null);

export function NotesProvider({ controller, children }: { controller: NotesController; children: ReactNode }) {
	useEffect(() => {
		if (typeof window === "undefined") return;
		void controller.refresh();
		const onResize = () => controller.setNarrow(window.innerWidth < NOTES_AUTOFOLD_BELOW);
		onResize();
		window.addEventListener("resize", onResize);
		const onHide = () => void controller.flush({ keepalive: true });
		window.addEventListener("pagehide", onHide);
		return () => {
			window.removeEventListener("pagehide", onHide);
			window.removeEventListener("resize", onResize);
			controller.dispose();
		};
	}, [controller]);
	return <NotesContext.Provider value={controller}>{children}</NotesContext.Provider>;
}

export function useNotesController(): NotesController | null {
	return useContext(NotesContext);
}

const noSubscribe = () => () => {};

export function useNotesSnapshot(): NotesSnapshot {
	const c = useNotesController();
	return useSyncExternalStore(
		c ? (cb) => c.subscribe(cb) : noSubscribe,
		() => (c ? c.getSnapshot() : CLOSED),
		// In the browser, hydrate as the server rendered (it reads no storage).
		() => (c && typeof window === "undefined" ? c.getSnapshot() : CLOSED),
	);
}
