"use client";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";

/** Reading progress only; never changes a saved answer or submits the next one. */
export function useReviewAcknowledgement(chatId: string) {
	const key = `lh:answer-review:${chatId}`;
	const [acknowledged, setAcknowledged] = useState<string | null>(null);
	useEffect(() => {
		const read = () => { try { setAcknowledged(localStorage.getItem(key)); } catch { setAcknowledged(null); } };
		read();
		const onStorage = (event: StorageEvent) => { if (event.key === key) read(); };
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [key]);
	return [acknowledged, (id: string) => {
		setAcknowledged(id);
		try { localStorage.setItem(key, id); } catch { /* Still usable for this mounted view. */ }
	}] as const;
}

export function AnswerReviewActions({ onClarify, onFeynman, onContinue, disabled = false }: {
	onClarify(): void; onFeynman(): void; onContinue(): void; disabled?: boolean;
}) {
	return <section data-testid="answer-review" aria-label="After-answer review" className="mt-2 space-y-3 rounded-xl border bg-card p-5">
		<p className="font-prose text-sm text-muted-foreground">Review the feedback, then choose how to continue.</p>
		<div className="flex flex-wrap items-center gap-2">
			<Button type="button" variant="outline" disabled={disabled} onClick={onClarify}>Ask about this answer</Button>
			<Button type="button" variant="outline" disabled={disabled} onClick={onFeynman}>Explain it to AI</Button>
			<Button type="button" disabled={disabled} onClick={onContinue}>Continue to next question</Button>
		</div>
	</section>;
}
