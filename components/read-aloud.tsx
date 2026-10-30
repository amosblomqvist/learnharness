"use client";

import { useSyncExternalStore } from "react";
import { SquareIcon, Volume2Icon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { createReadAloudPlayer, type ReadAloudPlayer, type ReadAloudSnapshot } from "@/components/read-aloud-player";
import { isDictationActive, subscribeDictationActive } from "@/components/dictation-state";
import { useReadAloudSettings } from "@/components/read-aloud-preference";
import { keyRowTarget, markdownToSpeechChunks } from "@/src/core";

/**
 * Read aloud, the React side (ElevenLabs voice slice 6). The framework-free
 * player lives in read-aloud-player.ts; this file is the window singleton, the
 * subscription hook and the Listen/Stop button on assistant messages.
 */

/** The ElevenLabs key's id in the keys store (the PUT /api/keys/:id seam). */
export const ELEVENLABS_KEY_ID = "ELEVENLABS_API_KEY";

let windowPlayer: ReadAloudPlayer | undefined;

/** THE read-aloud player of this window: one audio element, one source at a
 *  time. Others (Esc, dictation, auto-read — later slices) call `.stop()` on it. */
export function readAloudPlayer(): ReadAloudPlayer {
	if (!windowPlayer) {
		windowPlayer = createReadAloudPlayer({ isDictationActive });
		stopOnDictation(windowPlayer);
	}
	return windowPlayer;
}

/** Dictation wins (slice 7): the moment it goes live the player stops, before the
 *  mic opens (dictation sets its flag first thing in start()). Nothing resumes
 *  when it ends: only a click on Listen starts playback. Returns the unbind. */
export function stopOnDictation(player: ReadAloudPlayer): () => void {
	return subscribeDictationActive(() => {
		if (isDictationActive()) player.stop();
	});
}

const IDLE: ReadAloudSnapshot = { sourceId: null, error: null };

/** The player's live state: which source is being read, and the last error. */
export function useReadAloud(player: ReadAloudPlayer = readAloudPlayer()): ReadAloudSnapshot {
	return useSyncExternalStore(player.subscribe, player.getSnapshot, () => IDLE);
}

/**
 * Listen/Stop for one assistant message. `markdown` is the message's spoken
 * source (its text parts, never tool cards); it is turned into speech chunks
 * only when clicked, so a long transcript pays nothing per render.
 *
 *   idle      speaker icon, "Listen"
 *   playing   stop icon, "Stop" (while THIS source plays or is being fetched)
 *   error     the failure line beside the button, on this message only;
 *             keyless is a button that opens Settings → Keys → the Read aloud
 *             group's ElevenLabs row and clears the error, like dictation's
 */
export function ListenButton({
	sourceId,
	markdown,
	player,
}: {
	sourceId: string;
	markdown: string;
	/** Defaults to the window's player; tests pass their own. */
	player?: ReadAloudPlayer;
}) {
	const p = player ?? readAloudPlayer();
	const { sourceId: playing, error } = useReadAloud(p);
	const { open: openSettings } = useSettingsDialog();
	const { voiceId, modelId } = useReadAloudSettings();
	const isPlaying = playing === sourceId;
	const failure = error?.sourceId === sourceId ? error : null;

	return (
		<div className="flex min-w-0 items-center gap-2 font-ui text-xs">
			<Hint label={isPlaying ? "Stop reading" : "Listen"} side="bottom">
				<button
					type="button"
					onClick={() => {
						if (isPlaying) p.stop();
						else void p.play(sourceId, markdownToSpeechChunks(markdown), { voiceId, modelId });
					}}
					aria-label={isPlaying ? "Stop reading aloud" : "Read aloud"}
					data-testid="listen-button"
					data-playing={isPlaying ? "true" : undefined}
					className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
				>
					{isPlaying ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3.5" />}
				</button>
			</Hint>
			{failure?.kind === "keyless" && (
				<button
					type="button"
					data-testid="listen-keyless"
					onClick={() => {
						p.clearError();
						openSettings("keys", keyRowTarget(ELEVENLABS_KEY_ID, "read-aloud"));
					}}
					className="truncate text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					{failure.message}
				</button>
			)}
			{failure?.kind === "upstream" && (
				<span role="alert" data-testid="listen-error" className="truncate text-destructive" title={failure.message}>
					{failure.message}
				</span>
			)}
		</div>
	);
}
