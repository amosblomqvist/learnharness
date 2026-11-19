import type { ChatListResponse } from "@/src/core";

/** Queue one follow-up read and protect local edits from in-flight responses. */
export function createSidebarRefresh(
	readSnapshot: () => Promise<ChatListResponse | null>,
	acceptResult: (result: ChatListResponse | null) => void,
): { request(): Promise<void>; invalidate(): void } {
	let current: Promise<void> | null = null;
	let stale = false;
	let again = false;

	const run = async (): Promise<void> => {
		try {
			for (;;) {
				stale = false;
				const result = await readSnapshot();
				if (!stale) acceptResult(result);
				if (!again) break;
				again = false;
			}
		} finally {
			current = null;
		}
	};

	return {
		request() {
			if (current) {
				again = true;
				return current;
			}
			current = run();
			return current;
		},
		invalidate() {
			if (!current) return;
			stale = true;
			again = true;
		},
	};
}
