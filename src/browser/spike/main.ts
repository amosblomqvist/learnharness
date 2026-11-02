/**
 * Phase 0 proof page: drives the REAL `/api/*` route handlers, running in
 * this page, through the same requests the desktop UI sends — save a key,
 * pick model slots, create a session, run one turn and stream it. Reload
 * the page to see the session come back from IndexedDB.
 */

import { installApiFetch } from "../backend.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string) => ($("status").textContent = text);

type ProviderRow = { id: string; envVar: string; label: string };
type ModelRow = { id: string; name: string; provider: string };

async function json<T>(res: Response): Promise<T> {
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
	return body;
}

async function loadProviders(): Promise<void> {
	const { providers } = await json<{ providers: ProviderRow[] }>(await fetch("/api/keys"));
	const preferred = ["anthropic", "openrouter", "openai", "google"];
	const sorted = [...providers].sort((a, b) => {
		const ia = preferred.indexOf(a.id);
		const ib = preferred.indexOf(b.id);
		return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.label.localeCompare(b.label);
	});
	$<HTMLSelectElement>("provider").replaceChildren(
		...sorted.map((p) => Object.assign(document.createElement("option"), { value: p.envVar, textContent: p.label })),
	);
}

async function loadModels(): Promise<void> {
	const { models, defaults } = await json<{ models: ModelRow[]; defaults: { model: { provider: string; id: string } } | null }>(
		await fetch("/api/models"),
	);
	const select = $<HTMLSelectElement>("model");
	select.replaceChildren(
		...models.map((m) =>
			Object.assign(document.createElement("option"), { value: `${m.provider}\n${m.id}`, textContent: `${m.provider} · ${m.name}` }),
		),
	);
	if (defaults) select.value = `${defaults.model.provider}\n${defaults.model.id}`;
}

async function loadSessions(): Promise<void> {
	const { chats } = await json<{ chats: { id: string; title: string; messageCount: number; phase: string }[] }>(await fetch("/api/chats"));
	$("sessions").replaceChildren(
		...chats.map((c) =>
			Object.assign(document.createElement("li"), { textContent: `${c.title} — ${c.messageCount} messages, phase ${c.phase} (${c.id})` }),
		),
	);
}

type Block = { type: string; text?: string; name?: string; arguments?: unknown };

function render(message: { content?: Block[] | string }): void {
	const out = $("output");
	out.replaceChildren();
	const blocks: Block[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
	for (const block of blocks) {
		if (block.type === "text" && block.text) out.append(block.text);
		if (block.type === "toolCall") {
			const div = Object.assign(document.createElement("div"), { className: "tool" });
			div.textContent = `tool: ${block.name} ${JSON.stringify(block.arguments ?? {}).slice(0, 600)}`;
			out.append(div);
		}
	}
}

/** Same wire as the desktop UI: POST /api/chat acknowledges and closes;
 *  the turn streams from GET /api/chats/:id/stream (replay, then live). */
async function runTurn(chatId: string, text: string): Promise<void> {
	await json(
		await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text } }),
		}),
	);
	const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/stream`);
	if (!res.ok || !res.body) throw new Error((await res.text()) || `HTTP ${res.status}`);
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	let updates = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += value;
		let cut: number;
		while ((cut = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, cut).replace(/^data: /, "");
			buffer = buffer.slice(cut + 2);
			if (frame === "[DONE]") continue;
			const event = JSON.parse(frame) as { type: string; message?: { role?: string; content?: Block[] }; errorText?: string };
			if (event.type === "message_update" && event.message?.role === "assistant") {
				updates++;
				render(event.message);
				status(`Streaming… (${updates} updates)`);
			}
			if (event.type === "error") throw new Error(event.errorText);
		}
	}
}

async function main(): Promise<void> {
	const t0 = performance.now();
	const backend = await installApiFetch();
	(globalThis as { lhBackend?: unknown }).lhBackend = backend;
	await Promise.all([loadProviders(), loadModels(), loadSessions()]);
	status(`Ready — backend booted in ${Math.round(performance.now() - t0)} ms; ${backend.loadedFiles} stored files loaded.`);

	$("save-key").onclick = async () => {
		const id = $<HTMLSelectElement>("provider").value;
		const value = $<HTMLInputElement>("key").value.trim();
		try {
			await json(await fetch(`/api/keys/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }));
			$<HTMLInputElement>("key").value = "";
			await loadModels();
			await backend.flush();
			status(`Saved ${id}. Pick a model next.`);
		} catch (err) {
			status(`Key not saved: ${(err as Error).message}`);
		}
	};

	$("save-model").onclick = async () => {
		const [provider, id] = $<HTMLSelectElement>("model").value.split("\n");
		if (!provider || !id) return status("Save a key first, then pick a model.");
		const slot = { model: { provider, id } };
		try {
			await json(
				await fetch("/api/settings/models", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ strong: slot, cheap: slot, vision: slot }),
				}),
			);
			await backend.flush();
			status(`Using ${provider} · ${id}.`);
		} catch (err) {
			status(`Model not saved: ${(err as Error).message}`);
		}
	};

	$("start").onclick = async () => {
		const button = $<HTMLButtonElement>("start");
		const text = $<HTMLTextAreaElement>("prompt").value.trim();
		if (!text) return;
		button.disabled = true;
		try {
			status("Creating session…");
			const { id } = await json<{ id: string }>(
				await fetch("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: text }) }),
			);
			status("Running the first turn…");
			await runTurn(id, text);
			const chat = await json<{ messages: unknown[] }>(await fetch(`/api/chats/${id}`));
			await backend.flush();
			await loadSessions();
			status(`Turn finished: the session has ${chat.messages.length} messages, saved on this device. Reload to check it persists.`);
		} catch (err) {
			status(`Turn failed: ${(err as Error).message}`);
		} finally {
			button.disabled = false;
		}
	};
}

main().catch((err) => status(`Boot failed: ${(err as Error).stack ?? err}`));
