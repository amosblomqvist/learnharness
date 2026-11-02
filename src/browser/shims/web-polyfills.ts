/**
 * Small fallbacks for web APIs the bundled server code relies on that older
 * iOS Safari versions lack (Response.json: Safari 17; AbortSignal.any and
 * Promise.withResolvers: Safari 17.4). Each installs only when missing.
 */

if (typeof Response.json !== "function") {
	Object.defineProperty(Response, "json", {
		configurable: true,
		writable: true,
		value: (data: unknown, init: ResponseInit = {}) => {
			const headers = new Headers(init.headers);
			if (!headers.has("content-type")) headers.set("content-type", "application/json");
			return new Response(JSON.stringify(data), { ...init, headers });
		},
	});
}

if (typeof AbortSignal.any !== "function") {
	Object.defineProperty(AbortSignal, "any", {
		configurable: true,
		writable: true,
		value: (signals: AbortSignal[]) => {
			const controller = new AbortController();
			for (const signal of signals) {
				if (signal.aborted) {
					controller.abort(signal.reason);
					break;
				}
				signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true, signal: controller.signal });
			}
			return controller.signal;
		},
	});
}

if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== "function") {
	Object.defineProperty(Promise, "withResolvers", {
		configurable: true,
		writable: true,
		value: function withResolvers<T>() {
			let resolve!: (value: T | PromiseLike<T>) => void;
			let reject!: (reason?: unknown) => void;
			const promise = new Promise<T>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			return { promise, resolve, reject };
		},
	});
}

export {};
