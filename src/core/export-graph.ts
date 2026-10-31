/** Selected native assertions, not a renderer graph or an incident-edge traversal. */
export function selectExportGraph(ids: ReadonlyMap<string, ReadonlySet<string>>, nodes: string, chains: string) {
	function lines(raw: string, chain: boolean) {
		if (raw.length > 16_000_000) throw new Error("Graph snapshot exceeds export limit");
		return raw.split("\n").filter(line => line.trim()).map((raw, index) => {
			if (index >= 10_000 || raw.length > 262_144) throw new Error("Graph assertion limit");
			const value = JSON.parse(raw);
			const text = (x: unknown): x is string => typeof x === "string";
			if (!value || !text(value.id) || !value.id || !text(value.createdAt) || !Array.isArray(value.provenance) ||
				!value.provenance.every((p: { chatId?: unknown; messageId?: unknown }) => p && text(p.chatId) && text(p.messageId)))
				throw new Error("Invalid native graph assertion");
			if (chain ? !Array.isArray(value.premises) || !value.premises.length || !value.premises.every(text) || !text(value.conclusion)
				: !text(value.name) || !text(value.statement) || !Array.isArray(value.aliases) || !value.aliases.every(text))
				throw new Error("Invalid native graph shape");
			const provenance = value.provenance as { chatId: string; messageId: string }[];
			for (const p of provenance) if (ids.has(p.chatId) && p.messageId && !ids.get(p.chatId)!.has(p.messageId))
				throw new Error("Graph references a missing selected message");
			const key = chain ? JSON.stringify([[...new Set<string>(value.premises)].sort(), value.conclusion]) : value.id;
			return { raw, value, provenance, key, selected: provenance.some(p => ids.has(p.chatId)) };
		});
	}
	const ns = lines(nodes, false), cs = lines(chains, true);
	const firstNodes = new Map<string, typeof ns[number]>(), firstChains = new Map<string, typeof cs[number]>();
	const chainIds = new Map<string, string>();
	for (const n of ns) if (!firstNodes.has(n.value.id)) firstNodes.set(n.value.id, n);
	for (const c of cs) {
		if (firstNodes.has(c.value.id) || [...c.value.premises, c.value.conclusion].some(id => !firstNodes.has(id)) ||
			(chainIds.has(c.value.id) && chainIds.get(c.value.id) !== c.key)) throw new Error("Conflicting or dangling native chain");
		chainIds.set(c.value.id, c.key);
		if (!firstChains.has(c.key)) firstChains.set(c.key, c);
	}
	const selectedKeys = new Set(cs.filter(c => c.selected).map(c => c.key));
	const keptChains = cs.filter(c => c.selected || (selectedKeys.has(c.key) && firstChains.get(c.key) === c));
	const required = new Set<string>(ns.filter(n => n.selected).map(n => n.value.id));
	for (const c of keptChains) for (const id of [...c.value.premises, c.value.conclusion]) required.add(id);
	const keptNodes = ns.filter(n => required.has(n.value.id) && (n.selected || firstNodes.get(n.value.id) === n));
	const external = new Map<string, { chatId: string; messageId: string }>();
	for (const row of [...keptNodes, ...keptChains]) for (const p of row.provenance)
		if (!ids.has(p.chatId)) external.set(JSON.stringify(p), p);
	const join = (rows: typeof ns) => rows.length ? rows.map(r => r.raw).join("\n") + "\n" : "";
	return { nodes: join(keptNodes), chains: join(keptChains), external: [...external.values()] };
}
