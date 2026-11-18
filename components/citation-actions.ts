import { Quote } from "lucide-react";
import { CITATION_MAX_TEXT_LENGTH, serializeCitation, type TutorCitation } from "@/src/core";
import { INSERT_CITATION_EVENT, type CitationInsertedRange, type InsertCitationDetail } from "./path-input";
import type { SelectionAction } from "./selection-toolbar";

/** A citation chip in the composer whose comment is being edited. `fresh`
 *  marks one inserted just now: Cancel removes it with the spaces it added. */
export interface CitationEditTarget {
	citation: TutorCitation;
	link: string;
	start: number;
	host?: HTMLElement;
	/** Exact editable host: also supports reading/question/practice thinking. */
	input?: HTMLElement;
	fresh?: CitationInsertedRange;
}

/** The toolbar's Cite button: quote the selection into the composer and
 *  open the comment editor on the new chip. */
export function createCiteAction({ chatId, composer, openEditor }: {
	chatId: string;
	/** The intended editable root: composer or the active thinking field. */
	composer: () => HTMLElement | null;
	openEditor: (target: CitationEditTarget) => void;
}): SelectionAction {
	return {
		id: "cite",
		label: "Cite",
		ariaLabel: "Cite selection in your input",
		icon: Quote,
		disabledLabel: (capture) => (capture.selector.text.length > CITATION_MAX_TEXT_LENGTH ? "Shorten selection" : null),
		visible: () => composer() !== null,
		onSelect: (capture) => {
			const root = composer();
			if (!root) return false;
			const citation: TutorCitation = { version: 1, chatId, messageId: capture.messageId, ...capture.selector };
			const link = serializeCitation(citation);
			const detail: InsertCitationDetail = {
				link,
				onInserted: (fresh) => openEditor({ citation, link, start: fresh.start, fresh, input: root }),
			};
			const View = root.ownerDocument.defaultView;
			root.dispatchEvent(new (View?.CustomEvent ?? CustomEvent)(INSERT_CITATION_EVENT, { detail }));
			return true;
		},
	};
}
