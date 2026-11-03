"use client";

import { useEffect, useRef, useState } from "react";
import { freezePluginQuestionValue, clonePluginQuestionJson, type PluginQuestionMountContext, type PluginQuestionAnswer, type PluginQuestionSnapshot } from "@/src/core";
import type { PluginCleanup } from "@/src/core";
import type { QuestionRendererRegistration } from "./plugin-manager";
import { ToolContentResponse } from "./ai-elements/message";
import { ThinkingBlock } from "./thinking-block";

export function questionMountContext(snapshot: PluginQuestionSnapshot, chatId: string, signal: AbortSignal): PluginQuestionMountContext {
	return Object.freeze({ input: freezePluginQuestionValue(clonePluginQuestionJson(snapshot.input)) as unknown as PluginQuestionSnapshot["input"], chatId, questionId: snapshot.questionId, contractVersion: snapshot.contractVersion, variant: snapshot.variant, signal });
}

export function PluginQuestionPresentation({ snapshot, chatId, registration, answer, failed }: {
	snapshot: PluginQuestionSnapshot; chatId: string; registration?: QuestionRendererRegistration; answer?: PluginQuestionAnswer; failed?: () => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const [unavailable, setUnavailable] = useState(false);
	const mount = answer ? registration?.renderer.mountAnswered : registration?.renderer.mountQuestion;
	const failure = useRef(failed); failure.current = failed;
	useEffect(() => {
		setUnavailable(false);
		if (!mount || !root.current) return;
		const controller = new AbortController();
		const container = root.current.ownerDocument.createElement("div");
		root.current.append(container);
		let cleanup: void | PluginCleanup;
		const dispose = (value: void | PluginCleanup) => { try { if (value) void Promise.resolve(value()).catch(() => {}); } catch {} };
		const context = questionMountContext(snapshot, chatId, controller.signal);
		try {
			Promise.resolve(mount(container, answer ? Object.freeze({ ...context, answer: freezePluginQuestionValue(clonePluginQuestionJson(answer.answer)) }) : context as never)).then(value => {
				if (controller.signal.aborted) dispose(value); else cleanup = value;
			}, () => { if (!controller.signal.aborted) { setUnavailable(true); failure.current?.(); } });
		} catch { setUnavailable(true); failure.current?.(); }
		return () => { controller.abort(); dispose(cleanup); container.remove(); };
		// Stable saved identity: canonical adoption does not remount slots.
	}, [mount, snapshot.questionId, chatId]);
	const fallback = !mount || unavailable;
	return <>
		{/* Keep the host root attached even during fallback so a replacement
		    generation can mount immediately; each mount still owns its child. */}
		<div ref={root} hidden={fallback} />
		{fallback && (answer
			? <div className="whitespace-pre-wrap text-sm">{typeof answer.answer === "string" ? answer.answer : JSON.stringify(answer.answer, null, 2)}</div>
			: <ToolContentResponse>{snapshot.input.question}</ToolContentResponse>)}
	</>;
}

export function PluginQuestionAnswered({ snapshot, answer, chatId, registration }: { snapshot: PluginQuestionSnapshot; answer: PluginQuestionAnswer; chatId: string; registration?: QuestionRendererRegistration }) {
	return <>
		{/* Reading precedes the question, exactly as in native answered cards.
		    Presence remains authoritative, including defined empty channels. */}
		{(answer.readingThinking !== undefined || !!answer.images?.readingThinking?.length) && <ThinkingBlock
			testId="reading-thinking-block" label="YOUR THINKING" text={answer.readingThinking ?? ""} images={answer.images?.readingThinking} defaultOpen
		/>}
		<div data-testid="plugin-question-answered" className="rounded-2xl border bg-card px-4 py-3">
			<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{snapshot.label}</div>
			<PluginQuestionPresentation snapshot={snapshot} answer={answer} chatId={chatId} registration={registration} />
			{(answer.thinking !== undefined || !!answer.images?.thinking?.length) && <ThinkingBlock
				testId="your-thinking" label="YOUR THINKING" text={answer.thinking ?? ""} images={answer.images?.thinking} inCard
			/>}
		</div>
	</>;
}
