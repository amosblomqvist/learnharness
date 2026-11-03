import {
	clonePluginQuestionJson, freezePluginQuestionValue,
	type PluginQuestionAnswerState, type PluginQuestionEditorHandle,
	type PluginQuestionEditorKey, type PluginQuestionEditorProps,
} from "../src/core/index.ts";

export function controlledPluginAnswer(value: PluginQuestionAnswerState): PluginQuestionAnswerState {
	if (!value || !["empty", "ready", "unready"].includes(value.status)) throw new Error("Invalid answer state");
	return value.status === "empty" ? Object.freeze({ status: "empty" }) : freezePluginQuestionValue({ status: value.status, value: clonePluginQuestionJson(value.value) });
}

/** A mount generation is the only holder of its handle/publication authority. */
export function createQuestionEditorLease(options: {
	props: PluginQuestionEditorProps;
	publish(state: PluginQuestionAnswerState): void;
	changed(): void;
	failed(): void;
}) {
	let current = true;
	let handle: PluginQuestionEditorHandle | null = null;
	let publishedReady = false;
	const controller = new AbortController();
	const fail = () => { if (current) { options.failed(); dispose(); } };
	const props: PluginQuestionEditorProps = Object.freeze({ ...options.props, signal: controller.signal, onChange: (state: PluginQuestionAnswerState) => {
		if (!current) return;
		try { const answer = controlledPluginAnswer(state); options.publish(answer); publishedReady = answer.status === "ready"; options.changed(); }
		catch { fail(); }
	} });
	function dispose() {
		if (!current) return;
		current = false; controller.abort();
		const old = handle; handle = null;
		try { old?.dispose(); } catch { /* unavailable host fallback already owns the surface */ }
		options.changed();
	}
	return {
		props,
		adopt(next: PluginQuestionEditorHandle) {
			if (!current) { try { next.dispose(); } catch {} return; }
			if (!next || typeof next.update !== "function" || typeof next.focus !== "function" || typeof next.dispose !== "function" || (next.handleKeyDown !== undefined && typeof next.handleKeyDown !== "function") || (next.appendTranscript !== undefined && typeof next.appendTranscript !== "function")) { try { if (typeof next?.dispose === "function") next.dispose(); } catch {} fail(); return; }
			handle = next; options.changed();
		},
		get ready() { return current && handle !== null && publishedReady; },
		get mounted() { return current && handle !== null; },
		get speech() { return current && !!handle?.appendTranscript; },
		update(answer: PluginQuestionAnswerState, active: boolean) { if (current && handle) try { handle.update({ answer, active }); } catch { fail(); } },
		focus() { if (current && handle) try { handle.focus(); } catch { fail(); } },
		key(key: PluginQuestionEditorKey): "handled" | "pass" { if (current && handle?.handleKeyDown) try { return handle.handleKeyDown(key) === "handled" ? "handled" : "pass"; } catch { fail(); } return "pass"; },
		async append(text: string) { if (current && handle?.appendTranscript) { const adopted = handle; try { await adopted.appendTranscript!(text); } catch { fail(); } } },
		fail, dispose,
	};
}
export type QuestionEditorLease = ReturnType<typeof createQuestionEditorLease>;
