import type { Api, Message, Model, ThinkingLevel, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ResolvedAntigravityRuntime } from "./installation.ts";

/** Compare model-visible history, not app IDs, timestamps, usage, or Pi metadata. */
export function conversationForReuse(messages: Message[]): unknown[] {
	return messages.flatMap((message): unknown[] => {
		switch (message.role) {
			case "system":
				return [];
			case "user":
				return [{ role: message.role, content: message.content }];
			case "assistant":
				return [{ role: message.role, content: message.content }];
			case "toolResult":
				return [
					{
						role: message.role,
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						content: message.content,
						isError: message.isError,
					},
				];
		}
	});
}

export function configurationForReuse(
	model: Model<Api>,
	context: TranscriptContext,
	reasoning: ThinkingLevel | undefined,
	runtime?: Pick<ResolvedAntigravityRuntime, "source" | "kind" | "executablePath" | "harnessPath" | "args" | "version">,
	profileDir?: string,
): unknown {
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const tools = getCurrentTools(context.messages);
	return JSON.parse(
		JSON.stringify({
			model,
			reasoning: reasoning ?? null,
			systemPrompt,
			tools,
			runtime: runtime
				? {
						source: runtime.source,
						kind: runtime.kind,
						executablePath: runtime.executablePath,
						harnessPath: runtime.harnessPath ?? null,
						args: runtime.args,
						version: runtime.version,
					}
				: null,
			profileDir: profileDir ?? null,
		}),
	) as unknown;
}
