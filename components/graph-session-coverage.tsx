"use client";

import { useEffect, useState } from "react";
import type { ChatSummary } from "@/src/core";
import { CoverageRing } from "@/components/extraction-coverage";

/** Coverage is per teaching session, not a percentage of the whole graph. */
export function GraphSessionCoverage() {
	const [sessions, setSessions] = useState<ChatSummary[]>([]);
	const [selected, setSelected] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		void fetch("/api/chats", { signal: controller.signal })
			.then(async response => response.ok ? (await response.json()).chats : [])
			.then((rows: ChatSummary[]) => setSessions(rows.filter(row => row.kind !== "practice" && row.messageCount > 0)))
			.catch(() => {});
		return () => controller.abort();
	}, []);
	const id = sessions.find(row => row.id === selected)?.id ?? sessions[0]?.id;
	if (!id) return null;
	return <CoverageRing key={id} chatId={id} sessionPicker={
		<label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
			<span className="shrink-0">Graph coverage</span>
			<select aria-label="Session for graph coverage" value={id} onChange={e => setSelected(e.target.value)}
				className="min-w-0 max-w-40 truncate rounded-md border bg-background px-1 py-1 text-foreground">
				{sessions.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
			</select>
		</label>
	} />;
}
