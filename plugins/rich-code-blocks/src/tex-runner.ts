import { checkSource, checkSvgSize, TEX_QUEUE_LIMIT, TEX_TIMEOUT_MS } from "./contract.ts";

interface Job {
  id: number;
  source: string;
  signal: AbortSignal;
  resolve(svg: string): void;
  reject(error: Error): void;
  abort(): void;
}
export type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror">;
const cancelled = () => new DOMException("Rendering cancelled.", "AbortError");

/** One lazy, serial, forcibly terminable TeX engine per plugin/window activation. */
export class TexRunner {
  private worker?: WorkerLike;
  private queue: Job[] = [];
  private current?: Job;
  private timer?: ReturnType<typeof setTimeout>;
  private nextId = 0;
  private disposed = false;
  constructor(
    private readonly workerUrl: URL,
    private readonly resourcesUrl: URL,
    private readonly createWorker: (url: URL) => WorkerLike = url => new Worker(url, { type: "module" }),
    private readonly timeoutMs = TEX_TIMEOUT_MS,
  ) {}

  render(source: string, signal: AbortSignal): Promise<string> {
    if (this.disposed || signal.aborted) return Promise.reject(cancelled());
    try { checkSource("tikz", source); } catch (error) { return Promise.reject(error); }
    if (this.queue.length >= TEX_QUEUE_LIMIT) return Promise.reject(new Error("The TeX render queue is full (16 waiting jobs)."));
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.nextId, source, signal, resolve, reject, abort: () => {
        if (this.current === job) this.finish(undefined, cancelled(), true);
        else {
          const index = this.queue.indexOf(job);
          if (index >= 0) { this.queue.splice(index, 1); signal.removeEventListener("abort", job.abort); reject(cancelled()); }
        }
      } };
      this.queue.push(job);
      signal.addEventListener("abort", job.abort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    if (this.disposed || this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    this.timer = setTimeout(() => this.finish(undefined, new Error(`TeX rendering exceeded ${this.timeoutMs / 1000} seconds.`), true), this.timeoutMs);
    try {
      if (!this.worker) {
        const worker = this.createWorker(this.workerUrl);
        this.worker = worker;
        worker.onmessage = event => {
          if (this.worker !== worker || !this.current || event.data?.id !== this.current.id) return;
          if (typeof event.data.svg === "string") {
            try { checkSvgSize(event.data.svg); this.finish(event.data.svg); }
            catch (error) { this.finish(undefined, error as Error, true); }
          } else this.finish(undefined, new Error(typeof event.data.error === "string" ? event.data.error : "Invalid TeX worker result."), true);
        };
        worker.onerror = event => { event.preventDefault(); if (this.worker === worker) this.finish(undefined, new Error("The TeX worker failed."), true); };
        worker.onmessageerror = () => { if (this.worker === worker) this.finish(undefined, new Error("The TeX worker returned an unreadable result."), true); };
      }
      this.worker.postMessage({ id: job.id, source: job.source, resourcesUrl: this.resourcesUrl.href });
    } catch (error) { this.finish(undefined, error instanceof Error ? error : new Error("Could not start TeX rendering."), true); }
  }

  private finish(svg?: string, error?: Error, terminate = false): void {
    const job = this.current;
    if (!job) return;
    this.current = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    job.signal.removeEventListener("abort", job.abort);
    if (terminate) this.stopWorker();
    if (error) job.reject(error); else job.resolve(svg!);
    this.pump();
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.current) this.finish(undefined, cancelled(), true);
    for (const job of this.queue.splice(0)) { job.signal.removeEventListener("abort", job.abort); job.reject(cancelled()); }
    this.stopWorker();
  }
}
