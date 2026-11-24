/**
 * Fuzzy search scoring (model-control wave, 2026-09-12) — pi's `/model`
 * picker pattern: space-separated tokens, each token must match SOME field
 * (case-insensitive substring), ranked so exact field matches beat
 * prefixes beat buried substrings. Pure core; the picker sorts by score.
 */

/** Score one candidate, or null when any token matches no field.
 *  Higher is better; ties break naturally by list order (stable sort).
 *
 *  Per-token points: exact field equality 100 · field startsWith 60 ·
 *  substring 30 minus a depth penalty (earlier finds win). Whole-query
 *  contiguity in one field adds +50 (query "glm flash" vs the id
 *  "z-ai/glm-5.3-flash" loses to a model whose id contains "glm flash"
 *  verbatim — as it should). */
export function fuzzyScore(query: string, ...fields: string[]): number | null {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return 0;
	const hay = fields.map((f) => f.toLowerCase());

	let total = 0;
	for (const token of tokens) {
		let best = -1;
		for (const f of hay) {
			if (f === token) best = Math.max(best, 100);
			else if (f.startsWith(token)) best = Math.max(best, 60);
			else {
				const at = f.indexOf(token);
				if (at !== -1) best = Math.max(best, 30 - Math.min(at, 27));
			}
		}
		if (best < 0) return null;
		total += best;
	}
	const joined = tokens.join(" ");
	if (hay.some((f) => f.includes(joined))) total += 50;
	return total;
}