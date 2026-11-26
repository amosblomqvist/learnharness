export type AgyUsage = {
	input_tokens?: number;
	output_tokens?: number;
	thinking_tokens?: number;
	total_tokens?: number;
	cache_read_tokens?: number;
};

export type AgyInitData = {
	model?: string;
	cwd?: string;
	tools?: string[];
	permission_mode?: string;
	[key: string]: unknown;
};

export type AgyStepUpdateData = {
	conversation_id?: string;
	step_index: number;
	state: "ACTIVE" | "DONE" | string;
	step_type: string;
	text_delta?: string;
	thinking_delta?: string;
	duration_seconds?: number;
	usage?: AgyUsage;
};

export type AgyResultData = {
	conversation_id?: string;
	status: "SUCCESS" | "ERROR" | string;
	response?: string;
	error?: string;
	duration_seconds?: number;
	num_turns?: number;
	usage?: AgyUsage;
};

export type AgyCliEvent =
	| { type: "init"; conversationId: string; init: AgyInitData }
	| { type: "step_update"; stepUpdate: AgyStepUpdateData }
	| { type: "result"; result: AgyResultData };

type RawCliLine = {
	event?: string;
	type?: string;
	conversation_id?: string;
	init?: AgyInitData;
	step_update?: AgyStepUpdateData;
	result?: AgyResultData;
};

export function parseAgyLine(text: string): AgyCliEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;

	const line = parsed as RawCliLine;
	const eventType = line.event ?? line.type;

	switch (eventType) {
		case "init": {
			const conversationId = typeof line.conversation_id === "string" ? line.conversation_id : "";
			const init = typeof line.init === "object" && line.init !== null ? line.init : {};
			return { type: "init", conversationId, init };
		}

		case "step_update": {
			if (typeof line.step_update !== "object" || line.step_update === null) return null;
			return { type: "step_update", stepUpdate: line.step_update };
		}

		case "result": {
			if (typeof line.result !== "object" || line.result === null) return null;
			return { type: "result", result: line.result };
		}

		default:
			return null;
	}
}
