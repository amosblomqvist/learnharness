import { textPartMessageId, type LhViewMessage, type LhViewPart } from "@/src/core";

/** Rendering boundaries only. The canonical grouped view and native history
 * stay intact; a long assistant run must not become one enormous DOM row. */
export interface TranscriptRow {
	key: string;
	message: LhViewMessage;
	messageIndex: number;
	start: number;
	end: number;
	sourceIds: readonly string[];
	gapAfter: number;
}

export function transcriptRows(messages: readonly LhViewMessage[]): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	messages.forEach((message, messageIndex) => {
		const starts = [0];
		if (message.role === "assistant") message.parts.forEach((part, index) => {
			if (index > 0 && part.type === "step-start") starts.push(index);
		});
		starts.forEach((start, step) => {
			const end = starts[step + 1] ?? message.parts.length;
			const sourceIds = new Set<string>();
			if (start === 0 && message.id) sourceIds.add(message.id);
			for (let index = start; index < end; index++) {
				const part = message.parts[index]!;
				const id = part.sourceMessageId ?? textPartMessageId(part.id);
				if (id) sourceIds.add(id);
			}
			rows.push({ key: `${message.id || `message-${messageIndex}`}:${message.parts[start]?.sourceMessageId ?? start}`,
				message, messageIndex, start, end, sourceIds: [...sourceIds], gapAfter: end === message.parts.length ? 16 : 8 });
		});
	});
	return rows;
}

function estimatePart(part: LhViewPart, width: number): number {
	if (part.type === "step-start") return 25;
	if (part.type === "reasoning") return 32;
	if (part.type === "text") {
		const text = part.text ?? "";
		const columns = Math.max(24, Math.floor((width - 48) / 8));
		// Line breaks, paragraph spacing and block math matter as well as length.
		return text.split("\n").reduce((height, line) => height + Math.max(1, Math.ceil(line.length / columns)) * 24, 0)
			+ (text.match(/\$\$|\\\[/g)?.length ?? 0) * 24;
	}
	if (part.pluginProblem || part.type === "data-plan-block") return 240;
	if (part.pluginQuestion || /^tool-(quiz|probe|ask_user_question|explain|recall)$/.test(part.type)) return part.state === "output-available" ? 240 : 0;
	if (part.type.startsWith("tool-")) return part.type === "tool-plan_init" ? 0 : 40;
	return 80;
}

export function estimateTranscriptRow(row: TranscriptRow, width = 900): number {
	let height = row.gapAfter;
	for (let index = row.start; index < row.end; index++) height += estimatePart(row.message.parts[index]!, width);
	return Math.max(32, height);
}
