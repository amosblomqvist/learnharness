import type { SearchHit } from "../core/search.ts";
import { chatGPTAbortController, chatGPTBackgroundAllowed, chatGPTLease, chatGPTScope, chatGPTScopeCurrent } from "./chatgpt-bridge.ts";
import type { AdmissionScope } from "./chatgpt-request-cycle.ts";

const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_STREAM_BYTES = 1_000_000;
const MAX_RESULTS = 10;
const TIMEOUT_MS = 45_000;

class SafeSearchError extends Error {}

function safeUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : undefined;
	} catch { return undefined; }
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseSseEvent(raw: string): unknown | undefined {
	let data = "";
	for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) data += `${data ? "\n" : ""}${line.slice(5).trimStart()}`;
	if (!data || data === "[DONE]") return undefined;
	try { return JSON.parse(data) as unknown; }
	catch { throw new SafeSearchError("ChatGPT web search returned an invalid response stream."); }
}
function waitForLease<T>(lease: Promise<T>, signal: AbortSignal): Promise<T> {
	void lease.then(() => undefined, () => undefined);
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		lease.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
function resultsFrom(output: unknown, count: number): SearchHit[] {
	if (!Array.isArray(output)) throw new SafeSearchError("ChatGPT web search returned no completed search results.");
	const hits = new Map<string, SearchHit>();
	let searched = false;
	const add = (urlValue: unknown, titleValue?: unknown, snippetValue?: unknown) => {
		const url = safeUrl(urlValue); if (!url) return;
		const existing = hits.get(url);
		const title = typeof titleValue === "string" && titleValue ? titleValue.slice(0, 500) : undefined;
		const snippet = typeof snippetValue === "string" && snippetValue ? snippetValue.slice(0, 2_000) : undefined;
		if (existing) { if (existing.title === existing.url && title) existing.title = title; if (!existing.snippet && snippet) existing.snippet = snippet; return; }
		hits.set(url, { title: title ?? url, url, snippet: snippet ?? "" });
	};
	for (const item of output) {
		if (!isRecord(item)) continue;
		if (item.type === "web_search_call") {
			const action = isRecord(item.action) ? item.action : undefined;
			if (item.status === "completed" && action && ["search", "open_page", "find_in_page"].includes(String(action.type))) searched = true;
			for (const source of item.status === "completed" && action && Array.isArray(action.sources) ? action.sources : []) {
				if (isRecord(source)) add(source.url, source.title, source.snippet);
			}
		}
		if (item.type === "message" && Array.isArray(item.content)) for (const content of item.content) {
			if (!isRecord(content) || !Array.isArray(content.annotations)) continue;
			for (const annotation of content.annotations) if (isRecord(annotation) && annotation.type === "url_citation") add(annotation.url, annotation.title);
		}
	}
	if (!searched) throw new SafeSearchError("ChatGPT web search did not complete a web search.");
	return [...hits.values()].slice(0, count);
}

/** Searches using only the selected ChatGPT subscription model; API-key fallback is never used. */
export async function searchChatGPT(query: string, count: number, modelId: string, callerSignal?: AbortSignal): Promise<SearchHit[]> {
	if (!query.trim() || !modelId.trim()) throw new Error("A query and researcher model are required for ChatGPT web search.");
	let scope: AdmissionScope | undefined;
	const { controller, release } = chatGPTAbortController(true);
	const signals = [controller.signal, AbortSignal.timeout(TIMEOUT_MS)];
	if (callerSignal) signals.push(callerSignal);
	const signal = AbortSignal.any(signals);
	let dispatched = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let abortListener: (() => void) | undefined;
	const check = () => {
		if (signal.aborted || !scope || !chatGPTScopeCurrent(scope) || !chatGPTBackgroundAllowed()) throw new Error("ChatGPT authority, connection, or background consent changed.");
	};
	try {
		scope = chatGPTScope(modelId);
		check();
		const lease = await waitForLease(chatGPTLease(scope, true), signal);
		check();
		let response: Response;
		try {
			dispatched = true;
			response = await fetch(ENDPOINT, {
				method: "POST", redirect: "error", cache: "no-store", signal,
				headers: { authorization: `Bearer ${lease.accessToken}`, "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify({ model: modelId, store: false, stream: true, input: [{ role: "user", content: [{ type: "input_text", text: `Search the web for the following query and cite the sources: ${query}` }] }], tools: [{ type: "web_search" }], tool_choice: "required", include: ["web_search_call.action.sources"] }),
			});
		} catch { throw new SafeSearchError("ChatGPT web search request failed or was cancelled."); }
		check();
		if (!response.ok || !response.body) throw new SafeSearchError(`ChatGPT web search request failed (${response.status || "no response"}).`);
		reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "", bytes = 0;
		let completed: Record<string, unknown> | undefined;
		while (true) {
			check();
			const abortPromise = new Promise<never>((_resolve, reject) => {
				abortListener = () => reject(new Error("aborted"));
				signal.addEventListener("abort", abortListener, { once: true });
			});
			const readPromise = reader.read();
			const readResult = await Promise.race([readPromise, abortPromise]);
			if (abortListener) signal.removeEventListener("abort", abortListener);
			abortListener = undefined;
			if (readResult.done) break;
			bytes += readResult.value.byteLength;
			if (bytes > MAX_STREAM_BYTES) throw new SafeSearchError("ChatGPT web search response exceeded its size limit.");
			buffer += decoder.decode(readResult.value, { stream: true });
			let boundary: number;
			while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
				const event = buffer.slice(0, boundary);
				const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length ?? 2;
				buffer = buffer.slice(boundary + separator);
				const payload = parseSseEvent(event);
				if (!isRecord(payload) || typeof payload.type !== "string") continue;
				if (["error", "response.failed", "response.incomplete"].includes(payload.type)) throw new SafeSearchError("ChatGPT web search did not complete successfully.");
				if (payload.type === "response.completed" && isRecord(payload.response)) completed = payload.response;
			}
		}
		check();
		if (signal.aborted) throw new Error("ChatGPT web search request timed out or was cancelled.");
		if (buffer.trim()) throw new SafeSearchError("ChatGPT web search stream ended before its final event.");
		if (!completed || completed.status !== "completed" || completed.error) throw new SafeSearchError("ChatGPT web search stream ended without a completed response.");
		check();
		const hits = resultsFrom(completed.output, Math.max(1, Math.min(MAX_RESULTS, Math.floor(Number.isFinite(count) ? count : MAX_RESULTS))));
		check();
		return hits;
	} catch (error) {
		if (abortListener) signal.removeEventListener("abort", abortListener);
		if (reader) { void reader.cancel().catch(() => undefined); }
		if (signal.aborted) throw new Error("ChatGPT web search request timed out or was cancelled.");
		if (error instanceof SafeSearchError) throw error;
		if (!dispatched) throw new Error("ChatGPT subscription access is unavailable or no longer authorized.");
		throw new SafeSearchError("ChatGPT web search stream failed.");
	} finally { release(); }
}
