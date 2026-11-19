import type { ChatListItem, ChatListResponse } from "../../src/core/index.ts";

export type TestOrg = NonNullable<ChatListResponse["organization"]>;

export const STAMP = "2026-01-01T00:00:00.000Z";

export function chat(id: string, overrides: Partial<ChatListItem> = {}): ChatListItem {
	return {
		id,
		title: id,
		kind: "teach",
		createdAt: STAMP,
		updatedAt: STAMP,
		messageCount: 1,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}
