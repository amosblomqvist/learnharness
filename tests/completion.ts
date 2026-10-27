/** Bound an actual fixture completion signal, not a count of event-loop
 * turns. Always clear the watchdog, and preserve real fixture failures. */
export async function completedWithin<T>(completion: Promise<T>, description: string, timeoutMs = 10_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			completion,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
