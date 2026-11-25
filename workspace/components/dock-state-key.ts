/**
 * The dock shell's variant key (the WAAPI height-morph trigger,
 * components/chat.tsx DockOverlay). Whenever this string CHANGES between
 * renders, the shell morphs its height (120ms) and re-reserves the
 * transcript tail; when it stays the same, height changes are measured
 * only (typing growth never animates).
 *
 * The expanded term (the fold: full form ↔ slim bar) belongs to EVERY
 * docked variant — question AND practice. For two months it keyed on
 * `pending` (the question's tool call) alone, which is null in practice
 * sessions: the practice dock folded and re-expanded with an INSTANT
 * height jump while teaching morphed (owner report 2026-10-06, "opens
 * and closes instantly"). The fold machine itself already treats
 * practice as a dock owner; this key now agrees.
 */
export function dockStateKey(mode: string, docked: boolean, expanded: boolean): string {
	return docked ? `${mode}:${expanded}` : `${mode}:-`;
}
