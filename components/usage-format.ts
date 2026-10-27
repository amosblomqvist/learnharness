/**
 * Money/token presentation helpers (wave-4 observability UI) — shared by the
 * activity dock and the stats bar. Pure; exported for tests.
 */

/** USD for cent-scale money: >= $1 keeps two decimals, smaller keeps four. */
export function formatUsd(c: number): string {
	return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
}

export function planCostLabel(dollars: number | null, subscription: boolean | string | readonly string[] | undefined, format = formatUsd): string {
	const labels = subscription === true ? ["ChatGPT"] : typeof subscription === "string" ? [subscription] : Array.isArray(subscription) ? [...new Set(subscription)] : [];
	return [...(dollars === null ? [] : [format(dollars)]), ...labels].join(" + ") || "—";
}

/** 38000 → "38k", 1234567 → "1.2M" — trimmed, never "38.0k". */
export function formatTokens(n: number): string {
	if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
	return String(n);
}

/** Split a provider-qualified stamp "provider:id" (the usage contracts'
 *  qualification, model-slots wave 2026-09-20) into its two coordinates.
 *  No colon = no provider qualification (a bare catalog id). */
export function splitQualified(id: string): { provider: string | null; id: string } {
	const colon = id.indexOf(":");
	if (colon === -1) return { provider: null, id };
	return { provider: id.slice(0, colon), id: id.slice(colon + 1) };
}

/** Model-only labels omit the vendor path, never versions, dates or variants.
 * Only usage callers pass `qualified`: a bare catalog id's colon belongs to
 * the model (e.g. :free), not a provider. Usage retains its provider suffix. */
export function prettyModel(id: string, qualified = false): string {
	const { provider, id: bare } = qualified ? splitQualified(id) : { provider: null, id };
	const short = bare.includes("/") ? bare.slice(bare.lastIndexOf("/") + 1) : bare;
	return provider ? `${short} · ${provider}` : short;
}