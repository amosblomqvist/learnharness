import {
	clonePluginQuestionJson, freezePluginQuestionValue,
	type PluginQuestionAnswerState, type PluginQuestionEditorHandle,
	type PluginQuestionEditorKey, type PluginQuestionEditorProps,
	type PluginProblemEditorHandle, type PluginProblemEditorProps,
} from "../src/core/index.ts";

export function controlledPluginAnswer(value: PluginQuestionAnswerState): PluginQuestionAnswerState {
	if (!value || !["empty", "ready", "unready"].includes(value.status)) throw new Error("Invalid answer state");
	return value.status === "empty" ? Object.freeze({ status: "empty" }) : freezePluginQuestionValue({ status: value.status, value: clonePluginQuestionJson(value.value) });
}
type EditorHandle = Pick<PluginQuestionEditorHandle, "focus" | "dispose" | "handleKeyDown" | "appendTranscript"> & { update: unknown };
/** Both question and practice editors use one generation/cleanup authority. */
function createEditorLease<P, H extends EditorHandle>(options: {
	props(signal: AbortSignal, onChange: (state: PluginQuestionAnswerState) => void): P;
	update(handle: H, state: PluginQuestionAnswerState, active: boolean): void;
	publish(state: PluginQuestionAnswerState): void;
	changed(): void;
	failed(): void;
}) {
	let current = true;
	let handle: H | null = null;
	let publishedReady = false;
	const controller = new AbortController();
	const fail = () => { if (current) { options.failed(); dispose(); } };
	const props = options.props(controller.signal, state => {
		if (!current) return;
		try { const value = controlledPluginAnswer(state); options.publish(value); publishedReady = value.status === "ready"; options.changed(); }
		catch { fail(); }
	});
	function dispose() {
		if (!current) return;
		current = false; controller.abort();
		const old = handle; handle = null;
		try { old?.dispose(); } catch { /* unavailable host fallback already owns the surface */ }
		options.changed();
	}
	return {
		props,
		adopt(next: H) {
			if (!current) { try { next.dispose(); } catch {} return; }
			if (!next || typeof next.update !== "function" || typeof next.focus !== "function" || typeof next.dispose !== "function" || (next.handleKeyDown !== undefined && typeof next.handleKeyDown !== "function") || (next.appendTranscript !== undefined && typeof next.appendTranscript !== "function")) { try { if (typeof next?.dispose === "function") next.dispose(); } catch {} fail(); return; }
			handle = next; options.changed();
		},
		get ready() { return current && handle !== null && publishedReady; },
		get mounted() { return current && handle !== null; },
		get speech() { return current && !!handle?.appendTranscript; },
		update(state: PluginQuestionAnswerState, active: boolean) { if (current && handle) try { options.update(handle, state, active); } catch { fail(); } },
		focus() { if (current && handle) try { handle.focus(); } catch { fail(); } },
		key(key: PluginQuestionEditorKey): "handled" | "pass" { if (current && handle?.handleKeyDown) try { return handle.handleKeyDown(key) === "handled" ? "handled" : "pass"; } catch { fail(); } return "pass"; },
		async append(text: string) { if (current && handle?.appendTranscript) { const adopted = handle; try { await adopted.appendTranscript!(text); } catch { fail(); } } },
		fail, dispose,
	};
}
export function createQuestionEditorLease(options: {
	props: PluginQuestionEditorProps;
	publish(state: PluginQuestionAnswerState): void;
	changed(): void;
	failed(): void;
}) {
	return createEditorLease<PluginQuestionEditorProps, PluginQuestionEditorHandle>({ ...options,
		props: (signal, onChange) => Object.freeze({ ...options.props, signal, onChange }),
		update: (handle, answer, active) => handle.update({ answer, active }),
	});
}
export function createProblemEditorLease(options: {
	props: PluginProblemEditorProps;
	publish(state: PluginQuestionAnswerState): void;
	changed(): void;
	failed(): void;
}) {
	return createEditorLease<PluginProblemEditorProps, PluginProblemEditorHandle>({ ...options,
		props: (signal, onChange) => Object.freeze({ ...options.props, signal, onChange }),
		update: (handle, submission, active) => handle.update({ submission, active }),
	});
}
export type QuestionEditorLease = ReturnType<typeof createQuestionEditorLease>;
export type ProblemEditorLease = ReturnType<typeof createProblemEditorLease>;
