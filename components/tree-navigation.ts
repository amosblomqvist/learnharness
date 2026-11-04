/** Pure visible-row navigation shared by native Chains and embedded trees.
 * Adapters own event routing, focus, disclosure changes and optional selection. */
export interface TreeNavigationRow { key: string; depth: number; expanded?: boolean }

function parentIndices(rows: TreeNavigationRow[]): number[] {
	const ancestors: { depth: number; index: number }[] = [];
	return rows.map((row, index) => {
		let ancestor = ancestors.at(-1);
		while (ancestor && ancestor.depth >= row.depth) { ancestors.pop(); ancestor = ancestors.at(-1); }
		const parent = ancestor?.index ?? -1;
		ancestors.push({ depth: row.depth, index });
		return parent;
	});
}
/** Visible DOM order is the navigation order, including the current sort/filter.
 * Up/Down visit siblings, not every row of an expanded subtree. */
export function navigateTreeRows(rows: TreeNavigationRow[], active: string | null, key: string): {
	key?: string; toggle?: string; enter?: boolean;
} {
	const first = rows[0];
	if (!first) return {};
	const index = rows.findIndex((row) => row.key === active);
	const row = rows[index];
	if (!row) return { key: first.key };
	const parents = parentIndices(rows), parent = parents[index] ?? -1;
	if (key === "ArrowLeft") {
		const target = rows[parent] ?? row;
		return { key: target.key, ...(target.expanded ? { toggle: target.key } : {}) };
	}
	if (key === "ArrowRight") {
		if (row.expanded === false) return { key: row.key, toggle: row.key, enter: true };
		const child = rows[index + 1];
		return { key: row.expanded && child && child.depth > row.depth ? child.key : row.key };
	}
	const siblings = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => r.depth === row.depth && parents[i] === parent);
	const position = siblings.findIndex(({ i }) => i === index);
	const next = Math.max(0, Math.min(siblings.length - 1, position + (key === "ArrowDown" ? 1 : -1)));
	return { key: siblings[next]?.r.key ?? row.key };
}
