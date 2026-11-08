import type { SpeechStatus, SpeechVoiceState } from "@/src/core";

export const SPEECH_STATE_LABELS: Record<SpeechVoiceState, string> = {
	unavailable: "Unavailable", "not-installed": "Not installed", downloading: "Downloading", verifying: "Verifying", ready: "Ready", removing: "Removing", failed: "Failed",
};

const ACTIVE_STATES = new Set(["downloading", "verifying", "removing"]);
export function speechWorkActive(status: SpeechStatus | null): boolean {
	return !!status && ((!!status.operation && ACTIVE_STATES.has(status.operation.state)) || status.voices.some(voice => ACTIVE_STATES.has(voice.state)));
}

/** Settings owns observation, while installation belongs to the server and survives closure. */
export class SpeechStatusMonitor {
	private live = true;
	private inFlight = false;
	private refreshQueued = false;
	private queuedReaders: (() => void)[] = [];
	private status: SpeechStatus | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private abort = new AbortController();
	constructor(private dependencies: {
		fetch: typeof fetch;
		onStatus(status: SpeechStatus): void;
		onError(message: string): void;
		onAvailabilityChanged(): void;
		schedule?: typeof setTimeout;
		clearSchedule?: typeof clearTimeout;
	}) {}
	refresh = async (): Promise<void> => {
		if (!this.live) return;
		if (this.inFlight) { this.refreshQueued = true; return new Promise<void>(resolve => this.queuedReaders.push(resolve)); }
		(this.dependencies.clearSchedule ?? clearTimeout)(this.timer);
		this.inFlight = true;
		try {
			const response = await this.dependencies.fetch("/api/speech/status", { signal: this.abort.signal });
			const body = await response.json() as SpeechStatus & { error?: string };
			if (!response.ok) throw new Error(body.error ?? "Speech is unavailable.");
			if (!this.live) return;
			const previous = this.status;
			this.status = body;
			this.dependencies.onStatus(body);
			if (previous && (previous.voices.some(voice => (voice.state === "ready") !== (body.voices.find(next => next.id === voice.id)?.state === "ready")) || body.voices.some(voice => voice.state === "ready" && !previous.voices.some(old => old.id === voice.id && old.state === "ready")))) this.dependencies.onAvailabilityChanged();
		} catch (cause) {
			if (this.live) this.dependencies.onError(cause instanceof Error ? cause.message : "Speech is unavailable.");
		} finally {
			this.inFlight = false;
			if (this.live && this.refreshQueued) {
				this.refreshQueued = false;
				const readers = this.queuedReaders.splice(0);
				void this.refresh().finally(() => { for (const resolve of readers) resolve(); });
			}
			else if (this.live && speechWorkActive(this.status)) this.timer = (this.dependencies.schedule ?? setTimeout)(() => void this.refresh(), 750);
		}
	};
	stop() {
		this.live = false;
		this.abort.abort();
		(this.dependencies.clearSchedule ?? clearTimeout)(this.timer);
		for (const resolve of this.queuedReaders.splice(0)) resolve();
	}
}
