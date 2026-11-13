import type { PlaybackRate } from "./speech/limits.ts";

/** What happened to one pending question's audio in this window. */
export interface PlaybackRecord {
  /** At least one full playback ended naturally. */
  readonly completed: boolean;
  /** Speeds at which playback started, in order of first use. */
  readonly rates: readonly PlaybackRate[];
  /** Failed audio attempts; Continue another way appears after two. */
  readonly failures: number;
  /** The learner chose Continue another way. */
  readonly audioUnavailable: boolean;
}

const EMPTY: PlaybackRecord = { completed: false, rates: [], failures: 0, audioUnavailable: false };

/**
 * In-memory, keyed by question ID. The question mount (audio) and the answer editor mount
 * separately, so they share state here. It survives remounts while this activation lives,
 * not reloads; nothing is persisted.
 */
export function createPlaybackStore() {
  const records = new Map<string, PlaybackRecord>();
  const listeners = new Map<string, Set<(record: PlaybackRecord) => void>>();
  return {
    get(questionId: string): PlaybackRecord { return records.get(questionId) ?? EMPTY; },
    update(questionId: string, change: (record: PlaybackRecord) => PlaybackRecord): void {
      const next = change(records.get(questionId) ?? EMPTY);
      records.set(questionId, next);
      for (const listener of [...(listeners.get(questionId) ?? [])]) listener(next);
    },
    subscribe(questionId: string, listener: (record: PlaybackRecord) => void): () => void {
      const set = listeners.get(questionId) ?? new Set();
      set.add(listener);
      listeners.set(questionId, set);
      return () => { set.delete(listener); if (set.size === 0) listeners.delete(questionId); };
    },
    clear(): void { records.clear(); listeners.clear(); },
  };
}
export type PlaybackStore = ReturnType<typeof createPlaybackStore>;

export function startedAt(record: PlaybackRecord, rate: PlaybackRate): PlaybackRecord {
  return record.rates.includes(rate) ? record : { ...record, rates: [...record.rates, rate] };
}
/** A finished playback also clears an earlier Continue another way: the audio works after all. */
export function finished(record: PlaybackRecord): PlaybackRecord {
  return { ...record, completed: true, audioUnavailable: false };
}
export function failed(record: PlaybackRecord): PlaybackRecord {
  return { ...record, failures: record.failures + 1 };
}
