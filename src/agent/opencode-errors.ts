import type { Api, SimpleStreamOptions, StreamFunction } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const PLAN_HINT: Record<string, string> = {
	"opencode-go": "This is an OpenCode Go model. It needs a Go subscription.",
	opencode: "This is an OpenCode Zen model. It uses your Zen balance, not Go.",
};

/** OpenCode Zen and Go share one key, so a 402/403 usually means the model
 *  belongs to the plan the key doesn't cover (#147). Keep the upstream text
 *  and add one line naming the model's plan. pi-ai formats HTTP failures as
 *  "403: …", "… (403): …" or "403 …". */
export function withOpenCodePlanHint(provider: string, errorMessage: string | undefined): string | undefined {
	const hint = PLAN_HINT[provider];
	if (!hint || !errorMessage || !/(?:^|\()40[23]\b/.test(errorMessage)) return errorMessage;
	return `${errorMessage}\n${hint}`;
}

/** Pass every event through, adding the plan hint to the terminal error. */
export function openCodeStream(source: StreamFunction<Api, SimpleStreamOptions>): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		const upstream = source(model, context, options);
		void (async () => {
			try {
				for await (const event of upstream) {
					if (event.type === "error") {
						output.push({ ...event, error: { ...event.error, errorMessage: withOpenCodePlanHint(model.provider, event.error.errorMessage) } });
					} else output.push(event);
				}
			} finally { output.end(); }
		})();
		return output;
	};
}
