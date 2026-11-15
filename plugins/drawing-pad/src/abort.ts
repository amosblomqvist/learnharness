export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
export function frame(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cancelAnimationFrame(id); reject(signal.reason); };
    const id = requestAnimationFrame(() => { signal.removeEventListener("abort", abort); resolve(); });
    signal.addEventListener("abort", abort, { once: true });
  });
}
