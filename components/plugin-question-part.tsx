"use client";

import type { LhViewPart } from "@/src/core";
import { readPluginQuestionAnswer, readPluginQuestionCancellation } from "@/src/core";
import { usePlugins } from "./plugins";
import { SubmittedImages } from "./submitted-images";
import { ThinkingBlock } from "./thinking-block";
import { PluginQuestionAnswered } from "./plugin-question-slots";

/** Visibility boundary precedes all generic tool/input/error rendering. */
export function PluginQuestionPart({ part, chatId }: { part: LhViewPart; chatId: string }) {
	const { snapshot: plugins } = usePlugins();
	const annotation = part.pluginQuestion;
	if (!annotation) return null;
	if (annotation.status === "posed") {
		const snapshot = annotation.snapshot;
		const answer = readPluginQuestionAnswer(part.result?.details ?? part.output, snapshot);
		if (answer) {
			const registration = plugins.questionRenderers?.find(entry => entry.pluginId === snapshot.pluginId && entry.renderer.id === snapshot.typeId && entry.renderer.supportedContractVersions.includes(snapshot.contractVersion));
			return <>
				{answer.images?.readingThinking?.length ? <ThinkingBlock text="" label="THINKING WHILE READING" images={answer.images.readingThinking} defaultOpen /> : null}
				<PluginQuestionAnswered snapshot={snapshot} answer={answer} chatId={chatId} registration={registration} />
				<SubmittedImages images={answer.images?.answer} />
				{answer.images?.thinking?.length ? <ThinkingBlock text="" images={answer.images.thinking} defaultOpen /> : null}
			</>;
		}
		const cancellation = readPluginQuestionCancellation(part.result?.details ?? part.output, snapshot);
		if (cancellation) return <p className="py-1 text-xs text-muted-foreground">Question dismissed</p>;
	}
	return <p role="status" className="py-1 text-xs text-muted-foreground">{annotation.status === "unreadable" || part.state === "output-error" ? "Question unavailable" : "Preparing question…"}</p>;
}
