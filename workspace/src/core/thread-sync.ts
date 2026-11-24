/** Three-way reconciliation uses acknowledged revisions, never wall clocks. */
export interface SyncHead { revision: string; digest: string | null; updatedAt: number }
export type SyncDecision = "equal" | "push" | "pull";
export function reconcileThread(local: string | null, base: SyncHead | undefined, remote: SyncHead | undefined, modifiedAt: number): SyncDecision {
	if (local === (remote?.digest ?? null)) return "equal";
	const localChanged = local !== (base?.digest ?? null);
	const remoteChanged = (remote?.revision ?? null) !== (base?.revision ?? null);
	// Last update wins. At equal timestamps the already-committed version wins.
	if (localChanged && remoteChanged) return modifiedAt > (remote?.updatedAt ?? 0) ? "push" : "pull";
	return localChanged ? "push" : "pull";
}
