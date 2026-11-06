import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NotesChip, NotesPanel } from "../components/notes-panel";
import { NotesController, NotesProvider } from "../components/notes-state";

function memoryStorage() {
	const store = new Map<string, string>();
	return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
}

describe("notes panel", () => {
	it("chip always; panel folded until opened", () => {
		const closed = new NotesController("c1", "", { storage: memoryStorage() });
		let html = renderToStaticMarkup(<NotesProvider controller={closed}><NotesChip /><NotesPanel /></NotesProvider>);
		assert.match(html, /data-testid="notes-chip"/); assert.match(html, /aria-pressed="false"/);
		assert.match(html, /data-testid="notes-panel"[^>]*data-state="folded"/);
		const open = new NotesController("c1", "", { storage: memoryStorage() }); open.setOpen(true);
		html = renderToStaticMarkup(<NotesProvider controller={open}><NotesChip /><NotesPanel /></NotesProvider>);
		assert.match(html, /data-state="open"/); assert.match(html, /aria-pressed="true"/); assert.match(html, /aria-label="Fold notes"/);
	});

	it("panel renders the resize handle and the stored width", () => {
		const c = new NotesController("c1", "", { storage: memoryStorage() }); c.setOpen(true); c.setWidth(420);
		const html = renderToStaticMarkup(<NotesProvider controller={c}><NotesPanel /></NotesProvider>);
		assert.match(html, /role="separator"[^>]*aria-label="Resize notes"/);
		assert.match(html, /width:420px/);
	});
});
