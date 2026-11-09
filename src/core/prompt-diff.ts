export interface PromptDiffPart {
	text: string;
	changed: boolean;
}

export interface PromptDiffRow {
	kind: "same" | "added" | "removed";
	oldLine: number | null;
	newLine: number | null;
	parts: PromptDiffPart[];
}

type LineChange = { kind: "same" | "added" | "removed"; text: string };

function linesOf(text: string): string[] {
	return text === "" ? [] : text.split(/\r?\n/);
}

function diffLines(before: string[], after: string[]): LineChange[] {
	if (before.length * after.length > 1_000_000) {
		let prefix = 0;
		while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
		let suffix = 0;
		while (suffix < before.length - prefix && suffix < after.length - prefix &&
			before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
		return [
			...before.slice(0, prefix).map((text) => ({ kind: "same" as const, text })),
			...before.slice(prefix, before.length - suffix).map((text) => ({ kind: "removed" as const, text })),
			...after.slice(prefix, after.length - suffix).map((text) => ({ kind: "added" as const, text })),
			...before.slice(before.length - suffix).map((text) => ({ kind: "same" as const, text })),
		];
	}

	const width = after.length + 1;
	const lengths = new Uint32Array((before.length + 1) * width);
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			const index = i * width + j;
			lengths[index] = before[i] === after[j]
				? lengths[(i + 1) * width + j + 1]! + 1
				: Math.max(lengths[(i + 1) * width + j]!, lengths[index + 1]!);
		}
	}

	const result: LineChange[] = [];
	let i = 0;
	let j = 0;
	while (i < before.length && j < after.length) {
		const index = i * width + j;
		if (before[i] === after[j]) {
			result.push({ kind: "same", text: before[i]! });
			i++;
			j++;
		}
		else if (lengths[(i + 1) * width + j]! >= lengths[index + 1]!) result.push({ kind: "removed", text: before[i++]! });
		else result.push({ kind: "added", text: after[j++]! });
	}
	while (i < before.length) result.push({ kind: "removed", text: before[i++]! });
	while (j < after.length) result.push({ kind: "added", text: after[j++]! });
	return result;
}

function wordTokens(text: string): string[] {
	return text.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu) ?? [];
}

function mergeParts(parts: PromptDiffPart[]): PromptDiffPart[] {
	const merged: PromptDiffPart[] = [];
	for (const part of parts) {
		if (!part.text) continue;
		const previous = merged[merged.length - 1];
		if (previous?.changed === part.changed) previous.text += part.text;
		else merged.push({ ...part });
	}
	return merged;
}

function prefixAndSuffixParts(before: string[], after: string[]): [PromptDiffPart[], PromptDiffPart[]] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (suffix < before.length - prefix && suffix < after.length - prefix &&
		before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
	const sharedPrefix = before.slice(0, prefix).join("");
	const sharedSuffix = suffix ? before.slice(before.length - suffix).join("") : "";
	return [
		mergeParts([
			{ text: sharedPrefix, changed: false },
			{ text: before.slice(prefix, before.length - suffix).join(""), changed: true },
			{ text: sharedSuffix, changed: false },
		]),
		mergeParts([
			{ text: sharedPrefix, changed: false },
			{ text: after.slice(prefix, after.length - suffix).join(""), changed: true },
			{ text: sharedSuffix, changed: false },
		]),
	];
}

function diffWords(beforeText: string, afterText: string): [PromptDiffPart[], PromptDiffPart[]] {
	const before = wordTokens(beforeText);
	const after = wordTokens(afterText);
	if (before.length * after.length > 65_536) {
		// ponytail: cap word diff at 65k cells; use prefix/suffix for very long lines.
		return prefixAndSuffixParts(before, after);
	}

	const width = after.length + 1;
	const lengths = new Uint32Array((before.length + 1) * width);
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			const index = i * width + j;
			lengths[index] = before[i] === after[j]
				? lengths[(i + 1) * width + j + 1]! + 1
				: Math.max(lengths[(i + 1) * width + j]!, lengths[index + 1]!);
		}
	}

	const beforeParts: PromptDiffPart[] = [];
	const afterParts: PromptDiffPart[] = [];
	let i = 0;
	let j = 0;
	while (i < before.length && j < after.length) {
		const index = i * width + j;
		if (before[i] === after[j]) {
			beforeParts.push({ text: before[i++]!, changed: false });
			afterParts.push({ text: after[j++]!, changed: false });
		} else if (lengths[(i + 1) * width + j]! >= lengths[index + 1]!) {
			beforeParts.push({ text: before[i++]!, changed: true });
		} else {
			afterParts.push({ text: after[j++]!, changed: true });
		}
	}
	while (i < before.length) beforeParts.push({ text: before[i++]!, changed: true });
	while (j < after.length) afterParts.push({ text: after[j++]!, changed: true });
	return [mergeParts(beforeParts), mergeParts(afterParts)];
}

export function diffPromptText(beforeText: string, afterText: string): PromptDiffRow[] {
	const changes = diffLines(linesOf(beforeText), linesOf(afterText));
	const result: PromptDiffRow[] = [];
	let oldLine = 1;
	let newLine = 1;
	let index = 0;

	while (index < changes.length) {
		const change = changes[index]!;
		if (change.kind === "same") {
			result.push({ kind: "same", oldLine: oldLine++, newLine: newLine++, parts: [{ text: change.text, changed: false }] });
			index++;
			continue;
		}

		const removed: string[] = [];
		const added: string[] = [];
		while (index < changes.length && changes[index]!.kind !== "same") {
			const current = changes[index++]!;
			if (current.kind === "removed") removed.push(current.text);
			else added.push(current.text);
		}
		const inline = removed.map((text, pair) =>
			added[pair] === undefined ? null : diffWords(text, added[pair]!),
		);
		for (let row = 0; row < removed.length; row++) {
			result.push({ kind: "removed", oldLine: oldLine++, newLine: null, parts: inline[row]?.[0] ?? [{ text: removed[row]!, changed: false }] });
		}
		for (let row = 0; row < added.length; row++) {
			result.push({ kind: "added", oldLine: null, newLine: newLine++, parts: inline[row]?.[1] ?? [{ text: added[row]!, changed: false }] });
		}
	}
	return result;
}

export interface PromptDiffPair {
	old: PromptDiffRow | null;
	current: PromptDiffRow | null;
}

export function pairPromptDiffRows(rows: PromptDiffRow[]): PromptDiffPair[] {
	const pairs: PromptDiffPair[] = [];
	let index = 0;

	while (index < rows.length) {
		if (rows[index]!.kind === "same") {
			const row = rows[index++]!;
			pairs.push({ old: row, current: row });
			continue;
		}

		const removed: PromptDiffRow[] = [];
		const added: PromptDiffRow[] = [];
		while (index < rows.length && rows[index]!.kind !== "same") {
			const row = rows[index++]!;
			(row.kind === "removed" ? removed : added).push(row);
		}
		for (let line = 0; line < Math.max(removed.length, added.length); line++) {
			pairs.push({ old: removed[line] ?? null, current: added[line] ?? null });
		}
	}

	return pairs;
}
