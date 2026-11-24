"use client";

import { useContext, useEffect, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import type { ImageSnapshot } from "@/src/core";

export function useImageSnapshot(snapshotId?: string): { image?: ImageSnapshot; failed: boolean } {
	const chatId = useContext(ChatActionsContext)?.chatId;
	const key = chatId && snapshotId ? `${chatId}/${snapshotId}` : undefined;
	const [loaded, setLoaded] = useState<{ key: string; image?: ImageSnapshot; failed: boolean }>();
	useEffect(() => {
		if (!key) return;
		const controller = new AbortController();
		void fetch(`/api/chats/${encodeURIComponent(chatId!)}/images/${encodeURIComponent(snapshotId!)}`, { signal: controller.signal, cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) throw new Error("Image snapshot unavailable");
				const image = await response.json() as ImageSnapshot;
				if ((image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") || typeof image.data !== "string" || !Number.isInteger(image.width) || image.width <= 0 || !Number.isInteger(image.height) || image.height <= 0) throw new Error("Invalid image snapshot");
				if (!controller.signal.aborted) setLoaded({ key, image, failed: false });
			})
			.catch(() => { if (!controller.signal.aborted) setLoaded({ key, failed: true }); });
		return () => controller.abort();
	}, [key, chatId, snapshotId]);
	return loaded && loaded.key === key ? loaded : { failed: Boolean(snapshotId && !chatId) };
}
