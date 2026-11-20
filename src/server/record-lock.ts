/** Process-wide FIFO for writes to one plugin record kind. Extraction batches
 * and deletion hooks share this queue even across Next route modules. */
interface RecordLocks { __lhRecordWriteLocks?: Map<string, Promise<void>> }

export async function withRecordLock<T>(recordKindId: string, signal: AbortSignal, write: () => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	const g = globalThis as typeof globalThis & RecordLocks;
	const locks = (g.__lhRecordWriteLocks ??= new Map());
	const previous = locks.get(recordKindId) ?? Promise.resolve();
	const slot = Promise.withResolvers<void>();
	const tail = previous.then(() => slot.promise);
	locks.set(recordKindId, tail);
	// A canceled waiter releases its own slot immediately, but must not
	// remove the queue while its predecessor is still writing.
	void tail.then(() => { if (locks.get(recordKindId) === tail) locks.delete(recordKindId); });
	try {
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			void previous.then(() => { signal.removeEventListener("abort", onAbort); resolve(); });
		});
		signal.throwIfAborted();
		// Once admitted, hold the slot until the writer actually settles, even
		// if canceled. An abort signal can't force plugin code to stop writing.
		return await write();
	} finally {
		slot.resolve();
	}
}
