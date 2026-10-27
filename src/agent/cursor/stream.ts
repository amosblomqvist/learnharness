/** Wait until the loopback proxy is listening, then stream through pi-ai.
 * StreamFunction has to return the event stream immediately, so the wait
 * happens inside the stream rather than before it. */
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { startCursorProxy } from "./proxy.ts";

function failed(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

export function cursorStream(delegate: StreamFunction<Api, SimpleStreamOptions>): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		void (async () => {
			try {
				await startCursorProxy();
				const source = delegate(model, context, options);
				for await (const event of source) output.push(event);
			} catch (err) {
				const message = err instanceof Error && err.message
					? err.message
					: "Cursor proxy failed to start. If the port is taken, set LEARNHARNESS_CURSOR_PORT and restart LearnHarness.";
				const error = failed(model, message);
				output.push({ type: "error", reason: "error", error });
			} finally {
				output.end();
			}
		})();
		return output;
	};
}
