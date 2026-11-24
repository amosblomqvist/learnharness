/** Read the visible matrix rows from the first KaTeX HTML column per matrix. */
export function katexMatrixRows(root: ParentNode): number {
	return [...root.querySelectorAll(".katex-html .mtable")].reduce((total, table) => {
		const column = table.querySelector(':scope > [class^="col-align-"]');
		return total + (column?.querySelector(".vlist-r > .vlist")?.children.length ?? 0);
	}, 0);
}
