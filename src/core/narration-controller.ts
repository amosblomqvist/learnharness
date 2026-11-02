import { markdownNarration, narrationSentences } from "./narration.ts";

export interface NarrationSource {
	/** Native message id + content-block identity, never a projected group id. */
	id: string;
	markdown: string;
	complete: boolean;
	failed?: boolean;
}
export interface NarrationAdapters<Audio> {
	synthesize(text: string, signal: AbortSignal): Promise<Audio>;
	play(audio: Audio, signal: AbortSignal): Promise<void>;
	pause(): void;
	resume(): void;
	stop(): void;
	release?(audio: Audio): void;
}
export interface NarrationState { sourceId: string | null; status: "idle" | "loading" | "playing" | "paused" | "error"; error?: string; readAgain: readonly string[] }
interface Progress { text: string; consumed: number; spoken: number; baseline: number; suppressed: boolean }
interface Segment { sourceId: string; text: string; end: number; retried?: boolean }

/** One session's deterministic queue owner. All async completions are generation-checked. */
export class NarrationController<Audio> {
	private progress = new Map<string, Progress>();
	private sources = new Map<string, NarrationSource>();
	private snapshotIds = new Set<string>();
	private queue: Segment[] = [];
	private abort = new AbortController();
	private generation = 0;
	private pumping = false;
	private playingAudio = false;
	private paused = false;
	private dictating = false;
	private dictationGeneration: number | null = null;
	private automatic = false;
	private current: Segment | null = null;
	/** The next sentence, already synthesizing while the current one plays. */
	private lookahead: { segment: Segment; audio: Promise<Audio> }[] = [];
	private listeners = new Set<() => void>();
	private rewritten = new Set<string>();
	private suppressedRoots = new Set<string>();
	private responseRunning = false;
	private suppressCurrentResponse = false;
	private snapshot: NarrationState = { sourceId: null, status: "idle", readAgain: [] };
	constructor(private adapters: NarrationAdapters<Audio>) {}
	getSnapshot = (): NarrationState => this.snapshot;
	subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
	private emit(status: NarrationState["status"], error?: string) {
		this.snapshot = { sourceId: this.current?.sourceId ?? null, status, error, readAgain: [...this.rewritten] };
		for (const listener of this.listeners) listener();
	}
	baseline(sources: readonly NarrationSource[], trackSnapshot = true) {
		if (trackSnapshot) this.responseRunning = sources.some(source => !source.complete);
		for (const source of sources) {
			this.sources.set(source.id, source);
			const text = markdownNarration(source.markdown, source.complete);
			this.progress.set(source.id, { text, consumed: text.length, spoken: 0, baseline: text.length, suppressed: false });
			if (trackSnapshot) this.snapshotIds.add(source.id);
		}
	}
	setAutomatic(value: boolean, preserveAttachmentBaseline = false) {
		if (this.automatic === value) return;
		this.automatic = value;
		if (!value) this.halt();
		if (value && preserveAttachmentBaseline) {
			for (const source of this.sources.values()) this.updateSource(source, true);
			return;
		}
		// Enabling starts from NOW, never reads the existing transcript.
		for (const [id, source] of this.sources) {
			const text = markdownNarration(source.markdown, source.complete);
			this.progress.set(id, { text, consumed: text.length, spoken: 0, baseline: text.length, suppressed: false });
		}
	}
	update(sources: readonly NarrationSource[], responseRunning = sources.some(source => !source.complete)) {
		if (responseRunning && !this.responseRunning) this.suppressCurrentResponse = false;
		this.responseRunning = responseRunning;
		const present = new Set(sources.map(source => source.id));
		for (const id of this.snapshotIds) if (!present.has(id)) this.remove(id);
		this.snapshotIds = present;
		for (const source of sources) this.updateSource(source);
		if (!responseRunning) this.suppressCurrentResponse = false;
	}
	/** Questions enter only after the dock validates and reveals the visible projection. */
	updateSource(source: NarrationSource, recheck = false) {
		const previous = this.sources.get(source.id);
		if (!recheck && previous?.markdown === source.markdown && previous.complete === source.complete && previous.failed === source.failed) return;
		this.sources.set(source.id, source);
		const text = markdownNarration(source.markdown, source.complete);
		let progress = this.progress.get(source.id);
		if (!progress) { progress = { text: "", consumed: 0, spoken: 0, baseline: 0, suppressed: this.suppressCurrentResponse || this.suppressedRoots.has(this.root(source.id)) }; this.progress.set(source.id, progress); }
		if (source.failed) { this.removeAudio(source.id); progress.suppressed = true; progress.text = text; return; }
		if (progress.consumed > 0 && text.slice(0, progress.consumed) !== progress.text.slice(0, progress.consumed)) {
			if (progress.spoken > 0 && text.slice(0, progress.spoken) !== progress.text.slice(0, progress.spoken)) {
				const root = this.root(source.id);
				this.suppressedRoots.add(root);
				if (this.responseRunning) this.suppressCurrentResponse = true;
				for (const [id, sibling] of this.progress) if (this.root(id) === root) sibling.suppressed = true;
				this.rewritten.add(source.id);
				this.queue = this.queue.filter(segment => this.root(segment.sourceId) !== root);
				this.lookahead = this.lookahead.filter(item => this.root(item.segment.sourceId) !== root);
				if (this.current && this.root(this.current.sourceId) === root) this.cancelCurrent();
				this.emit(this.current ? this.snapshot.status : "idle");
			} else {
				// A queued or synthesizing sentence has not reached playback: replace
				// its pending text without treating it as an audible rewrite.
				this.removeAudio(source.id);
				if (progress.baseline > 0 && text.slice(0, progress.baseline) !== progress.text.slice(0, progress.baseline)) progress.baseline = text.length;
				progress.consumed = Math.max(progress.spoken, progress.baseline);
			}
		}
		progress.text = text;
		if (!this.automatic || progress.suppressed) return;
		const rest = text.slice(progress.consumed);
		for (const sentence of narrationSentences(rest, source.complete)) this.queue.push({ sourceId: source.id, text: sentence.text, end: progress.consumed + sentence.end });
		const sentences = narrationSentences(rest, source.complete);
		if (sentences.length) progress.consumed += sentences.at(-1)!.end;
		void this.pump();
	}
	manual(source: NarrationSource) {
		this.silence();
		this.sources.set(source.id, source);
		this.rewritten.delete(source.id);
		this.queue = narrationSentences(markdownNarration(source.markdown), true).map(sentence => ({ sourceId: source.id, text: sentence.text, end: sentence.end }));
		this.paused = false;
		void this.pump();
	}
	private cancelCurrent() {
		this.generation++;
		this.abort.abort();
		this.abort = new AbortController();
		this.adapters.stop();
		this.current = null;
		this.lookahead = [];
		this.pumping = false;
		this.playingAudio = false;
	}
	stop() {
		if (this.responseRunning) this.suppressCurrentResponse = true;
		for (const [id, source] of this.sources) if (!source.complete) {
			this.suppressedRoots.add(this.root(id));
			const progress = this.progress.get(id);
			if (progress) progress.suppressed = true;
		}
		for (const segment of [...this.queue, ...(this.current ? [this.current] : [])]) {
			this.suppressedRoots.add(this.root(segment.sourceId));
			const progress = this.progress.get(segment.sourceId);
			if (progress) progress.suppressed = true;
		}
		this.silence();
	}
	/** Silence audio and drop the queue. Spoken and suppression bookkeeping is untouched. */
	private silence() {
		this.queue = [];
		this.cancelCurrent();
		this.paused = false;
		this.emit("idle");
	}
	/** Another window took playback: stop here and drop what was queued. Nothing is re-queued, so two windows cannot interrupt each other back and forth. */
	yieldPlayback() {
		this.silence();
	}
	/** An interruption that is not the learner's Stop (voice change, another window claimed playback, narration turned off):
	 *  silence now, then return every unspoken sentence to the queue so nothing is silently lost. */
	halt() {
		this.silence();
		for (const progress of this.progress.values()) {
			if (!progress.suppressed) progress.consumed = Math.max(progress.spoken, progress.baseline);
		}
		for (const source of this.sources.values()) this.updateSource(source, true);
	}
	private removeAudio(id: string) {
		this.queue = this.queue.filter(segment => segment.sourceId !== id);
		this.lookahead = this.lookahead.filter(item => item.segment.sourceId !== id);
		if (this.current?.sourceId === id) { this.cancelCurrent(); this.emit("idle"); void this.pump(); }
	}
	remove(id: string) { this.removeAudio(id); this.sources.delete(id); this.progress.delete(id); this.rewritten.delete(id); }
	retire(id: string) {
		const progress = this.progress.get(id);
		if (progress) progress.suppressed = true;
		this.removeAudio(id);
		this.sources.delete(id);
	}
	pause() { this.paused = true; this.adapters.pause(); this.emit("paused"); }
	resume() { this.paused = false; if (!this.dictating) { this.adapters.resume(); if (this.pumping) this.emit("playing"); else void this.pump(); } }
	setDictating(active: boolean) {
		if (this.dictating === active) return;
		this.dictating = active;
		if (active) {
			if (this.playingAudio) {
				this.dictationGeneration = this.generation;
				this.adapters.pause();
				this.emit("paused");
				return;
			}
			// Keep text references, cancel inference, and never build audio while recording.
			for (const item of [...this.lookahead].reverse()) this.queue.unshift(item.segment);
			if (this.current) this.queue.unshift(this.current);
			this.cancelCurrent();
			this.dictationGeneration = this.generation;
			this.emit("paused");
		} else {
			const valid = this.dictationGeneration === this.generation;
			this.dictationGeneration = null;
			if (valid && !this.paused && (this.pumping || this.queue.length)) { this.adapters.resume(); if (this.pumping) this.emit("playing"); else void this.pump(); }
		}
	}
	private root(id: string) { return id.startsWith("question:") || !id.includes(":") ? id : id.slice(0, id.lastIndexOf(":")); }
	/** Sentences synthesized ahead of playback. Two is the plan's limit; the server serializes the actual inference. */
	private static readonly LOOKAHEAD = 2;
	private prefetch(generation: number, signal: AbortSignal) {
		while (generation === this.generation && this.lookahead.length < NarrationController.LOOKAHEAD && this.queue.length) {
			const segment = this.queue.shift()!;
			const audio = this.adapters.synthesize(segment.text, signal);
			// Awaited by the playback loop; a discarded prefetch must not raise unhandled.
			audio.catch(() => {});
			this.lookahead.push({ segment, audio });
		}
	}
	private async pump() {
		if (this.pumping || this.paused || this.dictating || (!this.queue.length && !this.lookahead.length)) return;
		this.pumping = true;
		const generation = this.generation;
		const signal = this.abort.signal;
		try {
			this.prefetch(generation, signal);
			while (this.lookahead.length && !this.paused && !this.dictating && generation === this.generation) {
				const item = this.lookahead.shift()!;
				this.current = item.segment;
				this.emit("loading");
				let audio: Audio;
				try { audio = await item.audio; } catch (error) {
					if (generation !== this.generation || signal.aborted) return;
					if (!item.segment.retried) {
						// A transient failure is retried once before the sentence is given up.
						item.segment.retried = true;
						const retry = this.adapters.synthesize(item.segment.text, signal);
						retry.catch(() => {});
						this.lookahead.unshift({ segment: item.segment, audio: retry });
						continue;
					}
					// One unspeakable or failed sentence must not silence the rest of the response.
					this.emit("error", error instanceof Error ? error.message : "Speech playback failed.");
					this.prefetch(generation, signal);
					continue;
				}
				if (generation !== this.generation) { this.adapters.release?.(audio); return; }
				// Gapless: the next sentence synthesizes while this one plays.
				this.prefetch(generation, signal);
				this.emit(this.paused ? "paused" : "playing");
				this.playingAudio = true;
				const progress = this.progress.get(item.segment.sourceId);
				if (progress) progress.spoken = Math.max(progress.spoken, item.segment.end);
				try { await this.adapters.play(audio, signal); } finally { this.adapters.release?.(audio); if (generation === this.generation) this.playingAudio = false; }
				this.prefetch(generation, signal);
			}
			if (generation === this.generation && !this.paused) { this.current = null; this.emit("idle"); }
		} catch (error) {
			if (generation === this.generation && !signal.aborted) { this.queue = []; this.lookahead = []; this.emit("error", error instanceof Error ? error.message : "Speech playback failed."); }
		} finally { if (generation === this.generation) this.pumping = false; }
	}
	dispose() { this.silence(); this.listeners.clear(); }
}
