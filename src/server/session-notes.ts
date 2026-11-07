import { createHash } from "node:crypto";
import { noteEvidence } from "../core/note-evidence.ts";
import { emit } from "../core/events.ts";
import { sumSteps } from "../core/prices.ts";
import { noteSectionHeading, type NoteEdition, type NoteMode, type NotePassage, type NotesRun, type NotesView } from "../core/session-notes.ts";
import { accumulateJobUsage, piUsageToStep } from "../core/contracts/jobs.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import type { ChatStore, SessionNotesStore } from "../core/ports.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { connectionBackgroundAllowed } from "../agent/subscription-connections.ts";
import { writeSessionNotes } from "../agent/subagents/notes-writer.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores, effectiveSettings } from "./stores.ts";
import { renderNotesPdf } from "./notes-pdf.ts";

interface Work extends NotesRun {
	abort: AbortController;
	again: boolean;
	fingerprint: string;
}
const host = globalThis as typeof globalThis & { __lhNoteWork?: Map<string, Work> };
const work = (host.__lhNoteWork ??= new Map());
const modes: NoteMode[] = ["live", "final"];
const poke = (chatId: string) => emit("notes-changed", { chatId });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (title: string, passages: NotePassage[]) => hash([title, passages]);
export class NotesRequestError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}
export type NotesAction = { action: "generate" | "retry-pdf" } | { action: "set-live"; enabled: boolean };

function notesEngine(record: ChatRecord, mode: NoteMode): PiEngine {
	const settings = effectiveSettings();
	const spec =
		mode === "live" ? resolveConversationSpec(record.settings, settings.models.strong) : settings.models.strong;
	if (!spec) throw new Error("Choose a Strong model in Settings to generate notes.");
	if (!providerKeyPresent(spec.provider)) throw new Error("Connect the selected notes model’s provider in Settings.");
	if (mode === "live" && !connectionBackgroundAllowed(spec.provider))
		throw new Error("Allow background use for the session model to generate live notes.");
	return piEngineForSpec(spec, mode === "live", undefined, () => effectiveSettings().models.strong?.cacheRetention);
}

interface NotesDependencies {
	chatStore: Pick<ChatStore, "getChat">;
	notesStore: SessionNotesStore;
	engineFor: typeof notesEngine;
	writeNotes: typeof writeSessionNotes;
	printPdf: typeof renderNotesPdf;
}
export function createSessionNotesService(deps: NotesDependencies, work = new Map<string, Work>()) {
	function chat(id: string) {
		const record = /^[\w-]+$/.test(id) && deps.chatStore.getChat(id);
		if (!record) throw new NotesRequestError("Session not found.", 404);
		return record;
	}
	function sessionNotes(id: string, resumeLive = false): NotesView {
		const record = chat(id),
			state = deps.notesStore.read(id);
		const { all, closed } = noteEvidence(record.messages, record.kind);
		if (resumeLive && state.liveEnabled && closed.length && !work.has("live" + id)) {
			const revision = fingerprint(record.title, closed);
			if (state.live?.fingerprint !== revision && state.failedLive !== revision) scheduleNotes(id, "live");
		}
		return {
			liveEnabled: state.liveEnabled,
			live: state.live,
			final: state.final,
			error: state.error,
			pdfPending: !!state.pending,
			eligible: all.length > 0,
			outdated: !!state.final && state.final.fingerprint !== fingerprint(record.title, all),
			running: modes.filter(mode => work.has(mode + id)),
			usage: modes.flatMap(mode => {
				const steps = state.usage.filter(u => u.mode === mode).map(u => u.step);
				if (!steps.length) return [];
				const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = sumSteps(steps);
				const tokens = steps.every(s => s.inputTokens !== undefined && s.outputTokens !== undefined)
					? inputTokens! + outputTokens! + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
					: undefined;
				return [{ mode, calls: steps.length, tokens }];
			}),
		};
	}

	function changeSessionNotes(id: string, raw: unknown) {
		chat(id);
		const req = raw as Partial<{ action: string; enabled: boolean }> | null;
		if (req?.action === "set-live" && typeof req.enabled === "boolean") {
			const enabled = req.enabled;
			deps.notesStore.change(id, s => {
				s.liveEnabled = enabled;
				delete s.failedLive;
				delete s.error.live;
			});
			if (enabled) scheduleNotes(id, "live");
			else work.get("live" + id)?.abort.abort();
		} else if (req?.action === "generate" || req?.action === "retry-pdf") {
			scheduleNotes(id, "final", req.action === "retry-pdf");
		} else throw new NotesRequestError("Unknown session notes action.");
		poke(id);
		return sessionNotes(id);
	}
	async function sessionNotesPdf(id: string) {
		chat(id);
		const bytes = deps.notesStore.pdf(id);
		if (!bytes) throw new NotesRequestError("This session has no finished PDF yet.", 404);
		const document = deps.notesStore.read(id).final?.document;
		// Older PDFs already contain the duplicate numbers. Render their saved text locally.
		if (document?.sections.some(section => noteSectionHeading(section.heading) !== section.heading))
			return deps.printPdf(document);
		return bytes;
	}
	function discardSessionNotes(id: string) {
		for (const mode of modes) work.get(mode + id)?.abort.abort();
		deps.notesStore.delete(id);
		poke(id);
	}
	function runningSessionNotes(): NotesRun[] {
		return [...work.values()].map(task => ({
			id: task.id,
			chatId: task.chatId,
			title: deps.chatStore.getChat(task.chatId)?.title ?? task.title,
			mode: task.mode,
			startedAt: task.startedAt,
			activity: task.activity,
			usage: task.usage,
		}));
	}
	function abortSessionNotes(id: string) {
		const task = work.get(id);
		if (!task || task.abort.signal.aborted) return { ok: false, reason: "not_running" } as const;
		task.again = false;
		if (task.mode === "live" && deps.chatStore.getChat(task.chatId)) {
			// A refresh must not immediately restart the revision the learner just stopped.
			deps.notesStore.change(task.chatId, state => { state.failedLive = task.fingerprint; });
		}
		task.abort.abort();
		poke(task.chatId);
		return { ok: true } as const;
	}
	/** Called after a durable turn. A notes error must never fail teaching settlement. */
	function updateLiveNotes(id: string) {
		try {
			if (deps.notesStore.read(id).liveEnabled) scheduleNotes(id, "live");
		} catch (error) {
			console.error("Could not update live session notes", error);
		}
	}

	function scheduleNotes(id: string, mode: NoteMode, retryPdf = false) {
		const key = mode + id;
		const active = work.get(key);
		if (active) {
			if (mode === "live") active.again = true;
			return;
		}
		const record = chat(id),
			state = deps.notesStore.read(id);
		const evidence = noteEvidence(record.messages, record.kind);
		const passages = mode === "live" ? evidence.closed : evidence.all;
		if (!passages.length && !retryPdf) {
			if (mode === "live") return;
			throw new NotesRequestError("There is no taught material to summarize yet.", 409);
		}
		const revision = fingerprint(record.title, passages);
		const topics = new Map<string, NotePassage[]>();
		for (const passage of passages) {
			if (!topics.has(passage.topic)) topics.set(passage.topic, []);
			topics.get(passage.topic)!.push(passage);
		}
		const topicHashes = Object.fromEntries([...topics].map(([topic, parts]) => [topic, hash(parts)]));
		const changed = new Set([...topics.keys()].filter(topic => topicHashes[topic] !== state.topics[topic]));
		if (mode === "live" && (!state.liveEnabled || !changed.size || state.failedLive === revision)) return;
		const pending =
			mode === "final" && (retryPdf || state.pending?.fingerprint === revision) ? state.pending : undefined;
		if (retryPdf && !pending) throw new NotesRequestError("There is no PDF awaiting a retry.", 409);
		const task: Work = {
			id: key,
			chatId: id,
			title: record.title,
			mode,
			startedAt: Date.now(),
			activity: mode === "live" ? "Updating live notes" : "Composing handout",
			abort: new AbortController(),
			again: false,
			fingerprint: revision,
		};
		work.set(key, task);
		const signal = task.abort.signal;
		const run = async () => {
			await Promise.resolve(); // admission publishes before the worker takes its first step
			signal.throwIfAborted();
			let edition: NoteEdition;
			if (pending) edition = pending;
			else {
				const engine = deps.engineFor(record, mode);
				const document = await deps.writeNotes({
					chatId: id,
					title: record.title,
					mode,
					practice: record.kind === "practice",
					signal,
					engine,
					promptSwitches: effectiveSettings().agent.prompts,
					passages: mode === "live" ? passages.filter(p => changed.has(p.topic)) : passages,
					onUsage: (u, model) => {
						if (!signal.aborted && deps.chatStore.getChat(id)) {
							task.usage = accumulateJobUsage(task.usage, model, piUsageToStep(u));
							deps.notesStore.change(id, s =>
								s.usage.push({
									at: new Date().toISOString(),
									mode,
									model,
									step: {
										inputTokens: u.input,
										outputTokens: u.output,
										reasoningTokens: u.reasoning,
										cacheReadTokens: u.cacheRead,
										cacheWriteTokens: u.cacheWrite,
										cacheWrite1hTokens: u.cacheWrite1h,
									},
								}),
							);
							poke(id);
						}
					},
				});
				signal.throwIfAborted();
				chat(id);
				edition = { document, fingerprint: revision, writtenAt: new Date().toISOString() };
				if (mode === "live") {
					const topicOf = new Map(passages.map(p => [p.messageId, p.topic]));
					const kept =
						state.live?.document.sections.filter(s => !changed.has(topicOf.get(s.sourceIds[0]!) ?? "")) ?? [];
					const order = new Map([...topics.keys()].map((topic, i) => [topic, i]));
					document.sections = [...kept, ...document.sections].sort(
						(a, b) =>
							(order.get(topicOf.get(a.sourceIds[0]!)!) ?? 0) - (order.get(topicOf.get(b.sourceIds[0]!)!) ?? 0),
					);
					// A delta's overview only describes its changed topics. The final handout owns the whole-lesson overview.
					document.overview = "";
					deps.notesStore.change(id, s => {
						s.live = edition;
						s.topics = topicHashes;
						delete s.error.live;
						delete s.failedLive;
					});
					return;
				}
				deps.notesStore.change(id, s => {
					s.pending = edition;
				});
			}
			task.activity = "Preparing PDF";
			poke(id);
			const bytes = await deps.printPdf(edition.document);
			signal.throwIfAborted();
			chat(id);
			deps.notesStore.savePdf(id, edition, bytes);
		};
		poke(id);
		void run()
			.catch(error => {
				if (signal.aborted || !deps.chatStore.getChat(id)) return;
				deps.notesStore.change(id, s => {
					s.error[mode] = error instanceof Error ? error.message : "Could not generate notes.";
					if (mode === "live") s.failedLive = revision;
				});
			})
			.finally(() => {
				work.delete(key);
				poke(id);
				if (task.again && deps.chatStore.getChat(id)) updateLiveNotes(id);
			})
			.catch(error => console.error("Could not save notes status", error));
	}
	return { sessionNotes, changeSessionNotes, sessionNotesPdf, discardSessionNotes, updateLiveNotes, runningSessionNotes, abortSessionNotes };
}
export const { sessionNotes, changeSessionNotes, sessionNotesPdf, discardSessionNotes, updateLiveNotes, runningSessionNotes, abortSessionNotes } =
	createSessionNotesService(
		{ ...stores, engineFor: notesEngine, writeNotes: writeSessionNotes, printPdf: renderNotesPdf },
		work,
	);
