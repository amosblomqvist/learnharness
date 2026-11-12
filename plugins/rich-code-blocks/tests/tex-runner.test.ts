import test from "node:test";
import assert from "node:assert/strict";
import { TexRunner, type WorkerLike } from "../src/tex-runner.ts";
import { SVG_LIMIT, TEX_QUEUE_LIMIT } from "../src/contract.ts";

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  onmessageerror: WorkerLike["onmessageerror"] = null;
  messages: { id: number; source: string; resourcesUrl: string }[] = [];
  terminated = 0;
  postMessage(data: { id: number; source: string; resourcesUrl: string }): void { this.messages.push(data); }
  terminate(): void { this.terminated++; }
  reply(value: object): void {
    this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data: { id: this.messages.at(-1)!.id, ...value } }));
  }
}
function fixture(timeout = 1_000) {
  const workers: FakeWorker[] = [];
  const runner = new TexRunner(new URL("http://local/assets/tex-worker.js"), new URL("http://local/assets/tex/"), () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  }, timeout);
  return { runner, workers, render: (source = "TeX", signal = new AbortController().signal) => runner.render(source, signal) };
}

test("TeX is lazy and serial, ignores stale identities, and reuses one worker on success", async () => {
  const host = fixture(); assert.equal(host.workers.length, 0);
  const first = host.render("one"), second = host.render("two");
  const worker = host.workers[0]!;
  assert.equal(worker.messages.length, 1); assert.equal(worker.messages[0]!.resourcesUrl, "http://local/assets/tex/");
  worker.reply({ id: 0, svg: "stale" }); assert.equal(worker.messages.length, 1);
  worker.reply({ svg: "first" }); assert.equal(await first, "first");
  assert.equal(worker.messages.length, 2); worker.reply({ svg: "second" }); assert.equal(await second, "second");
  assert.equal(host.workers.length, 1); host.runner.dispose(); host.runner.dispose(); assert.equal(worker.terminated, 1);
  await assert.rejects(host.render(), { name: "AbortError" });
});

test("active cancellation terminates; queued cancellation removes only its waiter; disposal rejects all", async () => {
  const host = fixture(); const active = new AbortController(), queued = new AbortController();
  const first = assert.rejects(host.render("one", active.signal), { name: "AbortError" });
  const skipped = assert.rejects(host.render("skip", queued.signal), { name: "AbortError" });
  const next = host.render("next"); queued.abort();
  assert.equal(host.workers[0]!.terminated, 0); active.abort(); await first; await skipped;
  assert.equal(host.workers[0]!.terminated, 1); assert.equal(host.workers.length, 2);
  assert.equal(host.workers[1]!.messages[0]!.source, "next"); host.workers[1]!.reply({ svg: "next" }); assert.equal(await next, "next");
  const current = assert.rejects(host.render(), { name: "AbortError" });
  const pending = assert.rejects(host.render(), { name: "AbortError" });
  host.runner.dispose(); await current; await pending;
});

test("deadline forcibly terminates an unresponsive worker; errors/output bounds replace the engine", async () => {
  const host = fixture(15);
  await assert.rejects(host.render(), /exceeded/); assert.equal(host.workers[0]!.terminated, 1);
  const failed = assert.rejects(host.render(), /bad TeX/); host.workers[1]!.reply({ error: "bad TeX" }); await failed;
  assert.equal(host.workers[1]!.terminated, 1);
  const huge = assert.rejects(host.render(), /2 MiB/); host.workers[2]!.reply({ svg: "x".repeat(SVG_LIMIT + 1) }); await huge;
  const valid = host.render(); host.workers[3]!.reply({ svg: "recovered" }); assert.equal(await valid, "recovered");
  host.runner.dispose();
});

test("waiting queue is bounded at 16 and source/aborted inputs don't create workers", async () => {
  const host = fixture(); const aborted = new AbortController(); aborted.abort();
  await assert.rejects(host.render("TeX", aborted.signal)); await assert.rejects(host.render("x".repeat(32 * 1024 + 1)));
  assert.equal(host.workers.length, 0);
  const accepted = Array.from({ length: TEX_QUEUE_LIMIT + 1 }, () => assert.rejects(host.render(), { name: "AbortError" }));
  await assert.rejects(host.render(), /queue is full/); host.runner.dispose(); await Promise.all(accepted);
});
