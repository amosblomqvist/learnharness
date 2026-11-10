import { useSyncExternalStore } from "react";

let pending = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const imagePastePending = () => pending > 0;
export const useImagePastePending = () => useSyncExternalStore(subscribe, imagePastePending, () => false);

export async function savePastedImages(files: readonly File[]): Promise<string[]> {
	pending++;
	notify();
	try {
		const paths: string[] = [];
		for (const file of files) {
			if (file.size > 25 * 1024 * 1024) throw new Error("Image exceeds 25 MiB. Paste a smaller image.");
			const response = await fetch("/api/clipboard-images", { method: "POST", headers: { "x-learnharness-image-paste": "1" }, body: file });
			const result = await response.json();
			if (!response.ok || typeof result.path !== "string") throw new Error(result.error ?? "Could not save pasted image.");
			paths.push(result.path);
		}
		return paths;
	} finally { pending--; notify(); }
}

export function clipboardImages(data: DataTransfer | null): File[] {
	if (!data) return [];
	const items = Array.from(data.items ?? []).filter((item) => item.kind === "file" && item.type.startsWith("image/"));
	return items.length ? items.map((item) => item.getAsFile()).filter((file): file is File => file !== null)
		: Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
}
