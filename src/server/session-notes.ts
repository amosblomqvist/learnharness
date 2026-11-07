import { createHash } from "node:crypto";
import { noteEvidence } from "../core/note-evidence.ts";
import { emit } from "../core/events.ts";
import { sumSteps } from "../core/prices.ts";
import { noteSectionHeading, type NoteEdition, type NoteMode, type NotePassage, type NotesAction, type NotesRun, type NotesView } from "../core/session-notes.ts";
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
	again: false | "automatic" | "manual";
	manual: boolean;
	fingerprint: string;
}
const host = globalThis as typeof globalThis & { __lhNoteWork?: Map<string, Work> };
const work = (host.__lhNoteWork ??= new Map());
const modes: NoteMode[] = ["liveNotes", "handout"];
const poke = (chatId: string) => emit("notes-changed", { chatId });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (title: string, passages: NotePassage[]) => hash([title, passages]);
function fingerprintTopics(passages: NotePassage[]) {
	const topics = new Map<string, NotePassage[]>();
	for (const passage of passages) {
		if (!topics.has(passage.topic)) topics.set(passage.topic, []);
		topics.get(passage.topic)!.push(passage);
	}
	return Object.fromEntries([...topics].map(([topic, parts]) => [topic, hash(parts)]));
}
export class NotesRequestError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

function notesEngine(record: ChatRecord, mode: NoteMode): PiEngine {
	const settings = effectiveSettings();
	const spec =
		mode === "liveNotes" ? resolveConversationSpec(record.settings, settings.models.strong) : settings.models.strong;
	if (!spec) throw new Error("Choose a Strong model in Settings to generate notes.");
	if (!providerKeyPresent(spec.provider)) throw new Error("Connect the selected notes model’s provider in Settings.");
	if (mode === "liveNotes" && !connectionBackgroundAllowed(spec.provider))
		throw new Error("Allow background use for the session model to generate live notes.");
	return piEngineForSpec(spec, mode === "liveNotes", undefined, () => effectiveSettings().models.strong?.cacheRetention);
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
	function sessionNotes(id: string, resumeLiveNotes = false): NotesView {
		const record = chat(id),
			state = deps.notesStore.read(id);
		const { all, closed } = noteEvidence(record.messages, record.kind);
		if (resumeLiveNotes && state.liveNotesEnabled && closed.length && !work.has("liveNotes" + id)) {
			const revision = fingerprint(record.title, closed);
			if (state.liveNotes?.fingerprint !== revision && state.failedLiveNotes !== revision) scheduleNotes(id, "liveNotes");
		}
		return {
			liveNotesEnabled: state.liveNotesEnabled,
			liveNotes: state.liveNotes,
			handout: state.handout,
			error: state.error,
			handoutPdfPending: !!state.pendingHandout,
			eligible: all.length > 0,
			handoutOutdated: !!state.handout && state.handout.fingerprint !== fingerprint(record.title, all),
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
		const req = raw as Partial<NotesAction> | null;
		if (req?.action === "set-live-notes-enabled" && typeof req.enabled === "boolean") {
			const enabled = req.enabled;
			deps.notesStore.change(id, s => {
				s.liveNotesEnabled = enabled;
				delete s.failedLiveNotes;
				delete s.error.liveNotes;
			});
			if (enabled) scheduleNotes(id, "liveNotes");
			else {
				const active = work.get("liveNotes" + id);
				// Pausing automatic work does not cancel an explicitly requested one-time refresh.
				if (active && !active.manual) active.abort.abort();
			}
		} else if (req?.action === "update-live-notes") {
			scheduleNotes(id, "liveNotes", { manual: true });
		} else if (req?.action === "generate-handout" || req?.action === "retry-handout-pdf") {
			scheduleNotes(id, "handout", { retryHandoutPdf: req.action === "retry-handout-pdf" });
		} else throw new NotesRequestError("Unknown session notes action.");
		poke(id);
		return sessionNotes(id);
	}
	async function sessionNotesPdf(id: string) {
		chat(id);
		const bytes = deps.notesStore.handoutPdf(id);
		if (!bytes) throw new NotesRequestError("This session has no handout PDF yet.", 404);
		const document = deps.notesStore.read(id).handout?.document;
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
		if (task.mode === "liveNotes" && deps.chatStore.getChat(task.chatId)) {
			// A refresh must not immediately restart the revision the learner just stopped.
			deps.notesStore.change(task.chatId, state => { state.failedLiveNotes = task.fingerprint; });
		}
		task.abort.abort();
		poke(task.chatId);
		return { ok: true } as const;
	}
	/** Called after a durable turn. A notes error must never fail teaching settlement. */
	function updateLiveNotes(id: string) {
		try {
			if (deps.notesStore.read(id).liveNotesEnabled) scheduleNotes(id, "liveNotes");
		} catch (error) {
			console.error("Could not update live notes", error);
		}
	}

	function scheduleNotes(id: string, mode: NoteMode, { retryHandoutPdf = false, manual = false } = {}) {
		const key = mode + id;
		const active = work.get(key);
		if (active) {
			if (mode === "liveNotes") {
				if (manual && !active.manual) active.again = "manual";
				else if (!manual && active.again !== "manual") active.again = "automatic";
			}
			return;
		}
		const record = chat(id),
			state = deps.notesStore.read(id);
		const evidence = noteEvidence(record.messages, record.kind);
		const passages = mode === "liveNotes" && !manual ? evidence.closed : evidence.all;
		if (!passages.length && !retryHandoutPdf) {
			if (mode === "liveNotes" && !manual) return;
			throw new NotesRequestError("There is no taught material to summarize yet.", 409);
		}
		const revision = fingerprint(record.title, passages);
		const topicHashes = fingerprintTopics(passages);
		const changed = new Set(Object.keys(topicHashes).filter(topic => manual || topicHashes[topic] !== state.topics[topic]));
		if (mode === "liveNotes" && !manual && (!state.liveNotesEnabled || !changed.size || state.failedLiveNotes === revision)) return;
		const pendingHandout =
			mode === "handout" && (retryHandoutPdf || state.pendingHandout?.fingerprint === revision) ? state.pendingHandout : undefined;
		if (retryHandoutPdf && !pendingHandout) throw new NotesRequestError("There is no handout PDF awaiting a retry.", 409);
		const task: Work = {
			id: key,
			chatId: id,
			title: record.title,
			mode,
			startedAt: Date.now(),
			activity: mode === "liveNotes" ? "Updating live notes" : "Composing handout",
			abort: new AbortController(),
			again: false,
			manual,
			// Stopping or failing a manual refresh must also suppress automatic retries of its closed topics.
			fingerprint: mode === "liveNotes" && manual ? fingerprint(record.title, evidence.closed) : revision,
		};
		work.set(key, task);
		const signal = task.abort.signal;
		const run = async () => {
			await Promise.resolve(); // admission publishes before the worker takes its first step
			signal.throwIfAborted();
			let edition: NoteEdition;
			if (pendingHandout) edition = pendingHandout;
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
					// A boundary triggers automatic work, but its topic may also have newer material from a manual refresh.
					passages: mode === "liveNotes" ? evidence.all.filter(p => changed.has(p.topic)) : passages,
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
				if (mode === "liveNotes") {
					const topicOf = new Map(evidence.all.map(p => [p.messageId, p.topic]));
					const kept = manual ? [] :
						state.liveNotes?.document.sections.filter(s => !changed.has(topicOf.get(s.sourceIds[0]!) ?? "")) ?? [];
					const order = new Map([...new Set(evidence.all.map(p => p.topic))].map((topic, i) => [topic, i]));
					document.sections = [...kept, ...document.sections].sort(
						(a, b) =>
							(order.get(topicOf.get(a.sourceIds[0]!)!) ?? 0) - (order.get(topicOf.get(b.sourceIds[0]!)!) ?? 0),
					);
					// A delta's overview only describes its changed topics. The handout owns the whole-lesson overview.
					document.overview = "";
					deps.notesStore.change(id, s => {
						s.liveNotes = edition;
						// Remember automatic boundaries separately from a manual refresh's current-topic content.
						s.topics = manual ? fingerprintTopics(evidence.closed) : topicHashes;
						delete s.error.liveNotes;
						delete s.failedLiveNotes;
					});
					return;
				}
				deps.notesStore.change(id, s => {
					s.pendingHandout = edition;
				});
			}
			task.activity = "Preparing handout PDF";
			poke(id);
			const bytes = await deps.printPdf(edition.document);
			signal.throwIfAborted();
			chat(id);
			deps.notesStore.saveHandoutPdf(id, edition, bytes);
		};
		poke(id);
		void run()
			.catch(error => {
				if (signal.aborted || !deps.chatStore.getChat(id)) return;
				deps.notesStore.change(id, s => {
					s.error[mode] = error instanceof Error ? error.message : "Could not generate notes.";
					if (mode === "liveNotes") s.failedLiveNotes = task.fingerprint;
				});
			})
			.finally(() => {
				work.delete(key);
				poke(id);
				if (task.again && deps.chatStore.getChat(id)) {
					if (task.again === "manual") scheduleNotes(id, "liveNotes", { manual: true });
					else updateLiveNotes(id);
				}
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
