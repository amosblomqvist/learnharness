import { normalizeContext, type StreamFunction } from "@earendil-works/pi-ai";
import type { SearchContext } from "../core/search.ts";
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import { piModels } from "./models.ts";
import { usageWasAdmitted } from "./subscription-request-cycle.ts";
import { workerRequestStream } from "./worker-request-admission.ts";

/** One model call with OpenAI's hosted web search tool, admitted like any
 *  other worker model request. It runs on the calling job's own model and
 *  route, an OpenAI API key or a ChatGPT plan, and never on the other.
 *  Resolves to the response's output items: the search calls and the cited
 *  answer. */
export async function openAIWebSearch(query: string, count: number, { model: job, signal, onUsage }: SearchContext): Promise<unknown[]> {
	const models = piModels();
	const chatgpt = job?.provider === "chatgpt";
	const model = chatgpt ? chatGPTModel(job.id) : job?.provider === "openai" ? models.getModel(job.provider, job.id) : undefined;
	if (!model) throw new Error("OpenAI web search needs a researcher model on an OpenAI API key or ChatGPT connection");
	const route = chatgpt ? chatGPTStream(() => true, undefined, ["web_search"]) : models.streamSimple.bind(models);
	// The lowest effort the model can search at. A model that cannot turn
	// reasoning off would otherwise run at the provider's default; "low",
	// not "minimal", because hosted search is refused at minimal effort.
	const reasoning = model.reasoning && model.thinkingLevelMap?.off === null ? "low" as const : undefined;
	const stream: StreamFunction = (target, context, options) => route(target, context, { ...options, reasoning });
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
			// An answer cut short still carries the pages it had cited.
			if (type === "response.completed" || type === "response.incomplete") output = response?.output;
		},
	}).result();
	// A failed call still reports the usage it has, as in the researcher's own loop.
	if (message.stopReason !== "aborted" && usageWasAdmitted(message.usage)) onUsage?.(message.usage);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		// ChatGPT failures arrive already reduced to safe guidance. An API error
		// body may quote the key, so only its HTTP status is read.
		throw new Error(chatgpt && message.errorMessage ? message.errorMessage : apiFailure(message.errorMessage));
	}
	if (!Array.isArray(output)) throw new Error("OpenAI web search returned an invalid response");
	return output;
}

/** The API-key route's failure, explained from the HTTP status alone. */
function apiFailure(errorMessage: string | undefined): string {
	const status = Number(/^OpenAI API error \((\d{3})\)/.exec(errorMessage ?? "")?.[1]);
	const cause = status === 400 ? "OpenAI rejected the request; the researcher's model may not support web search"
		: status === 404 ? "OpenAI did not find the researcher's model for this API key"
		: status === 401 || status === 403 ? "OpenAI rejected the API key"
		: status === 429 ? "the OpenAI rate limit or quota was reached"
		: status >= 500 ? "OpenAI had a server error"
		: undefined;
	return cause ? `OpenAI web search request failed (${status}): ${cause}` : "OpenAI web search request failed";
}
