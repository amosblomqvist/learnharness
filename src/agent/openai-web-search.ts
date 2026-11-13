import { normalizeContext } from "@earendil-works/pi-ai";
import type { SearchContext } from "../core/search.ts";
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import { piModels } from "./models.ts";
import { usageWasAdmitted } from "./subscription-request-cycle.ts";
import { workerRequestStream } from "./worker-request-admission.ts";

/** One model call with OpenAI's hosted web search tool, admitted like any
 *  other worker model request. It runs on the calling job's own model and
 *  route, an OpenAI API key or a ChatGPT plan, and never on the other.
 *  Resolves to the completed response's output items: the search calls and
 *  the cited answer. */
export async function openAIWebSearch(query: string, count: number, { model: job, signal, onUsage }: SearchContext): Promise<unknown[]> {
	const models = piModels();
	const chatgpt = job?.provider === "chatgpt";
	const model = chatgpt ? chatGPTModel(job.id) : job?.provider === "openai" ? models.getModel(job.provider, job.id) : undefined;
	if (!model) throw new Error("OpenAI web search needs a researcher model on an OpenAI API key or ChatGPT connection");
	const stream = chatgpt ? chatGPTStream(() => true, undefined, ["web_search"]) : models.streamSimple.bind(models);
	const prompt = `Search the web for: ${query}\n\nList the ${count} most relevant results, one per line: one sentence on what the page says, followed by its citation.`;
	let output: unknown;
	const message = await workerRequestStream(stream)(model, normalizeContext({ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }), {
		signal,
		onPayload: (payload) => {
			const body = payload as { include?: string[] };
			return { ...body, tools: [{ type: "web_search" }], tool_choice: "required", include: [...(body.include ?? []), "web_search_call.action.sources"] };
		},
		onProviderStreamEvent: (event) => {
			const { type, response } = event as { type?: string; response?: { output?: unknown } };
			if (type === "response.completed") output = response?.output;
		},
	}).result();
	// A dispatched call is billed even when it fails, as in the researcher's own loop.
	if (message.stopReason !== "aborted" && usageWasAdmitted(message.usage)) onUsage?.(message.usage);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		// ChatGPT failures arrive already reduced to safe guidance. An API error
		// body may quote the key, so it is never repeated.
		throw new Error(chatgpt && message.errorMessage ? message.errorMessage : "OpenAI web search request failed");
	}
	if (!Array.isArray(output)) throw new Error("OpenAI web search returned an invalid response");
	return output;
}
