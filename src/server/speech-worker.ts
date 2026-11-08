import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

/** A single persistent catalog-bound worker. Cancellation destroys inference. */
export class SpeechWorker {
 private child?: ChildProcessWithoutNullStreams;
 private active?: { id: number; chunks: Buffer[]; rate: number; resolve: (value: Buffer) => void; reject: (error: Error) => void; cleanup: () => void };
 private pending = Buffer.alloc(0);
 private nextId = 1;
 private idle?: ReturnType<typeof setTimeout>;
 private deadline?: ReturnType<typeof setTimeout>;
 constructor(private resources: string, private modelDirectory: string, private voiceId: string, private launch: typeof spawn = spawn, private deadlineMs = 60_000) {}
 stop() {
  clearTimeout(this.idle); clearTimeout(this.deadline);
  const child = this.child; this.child = undefined; this.pending = Buffer.alloc(0);
  const active = this.active; this.active = undefined;
  active?.cleanup(); active?.reject(new Error("Speech cancelled"));
  if (child?.pid) {
   if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
   else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  } else child?.kill("SIGKILL");
 }
 async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
  if (this.active) throw new Error("Speech is busy");
  if (signal?.aborted) throw new Error("Speech cancelled");
  clearTimeout(this.idle);
  if (!this.child) this.start();
  const id = this.nextId++;
  return new Promise((resolve, reject) => {
   const abort = () => this.stop();
   signal?.addEventListener("abort", abort, { once: true });
   this.active = { id, chunks: [], rate: 0, resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
   const data = Buffer.from(text); const frame = Buffer.alloc(10 + data.length);
   frame.writeUInt32LE(6 + data.length); frame[4] = 1; frame[5] = 1; frame.writeUInt32LE(id, 6); data.copy(frame, 10);
   this.deadline = setTimeout(() => this.stop(), this.deadlineMs); this.deadline.unref();
   this.child!.stdin.write(frame, error => { if (error) this.stop(); });
  });
 }
 private start() {
  const child = this.launch(path.join(this.resources, process.platform === "win32" ? "piper-helper.exe" : "piper-helper"), [path.join(this.modelDirectory, `${this.voiceId}.onnx`), path.join(this.modelDirectory, `${this.voiceId}.onnx.json`), path.join(this.resources, "share", "espeak-ng-data")], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LD_LIBRARY_PATH: path.join(this.resources, "lib") } });
  this.child = child;
  child.stderr.on("data", () => {});
  child.on("error", () => { if (this.child === child) this.stop(); });
  child.on("exit", () => { if (this.child === child) this.stop(); });
  child.stdout.on("data", (data: Buffer) => {
   if (this.child !== child) return;
   this.pending = Buffer.concat([this.pending, data]);
   while (this.pending.length >= 4) {
    const length = this.pending.readUInt32LE(0);
    if (length < 6 || length > 16 * 1024 * 1024) { this.stop(); return; }
    if (this.pending.length < length + 4) return;
    const frame = this.pending.subarray(4, 4 + length); this.pending = this.pending.subarray(4 + length);
    const active = this.active;
    if (frame[0] !== 1 || !active || frame.readUInt32LE(2) !== active.id) { this.stop(); return; }
    if (frame[1] === 2 && frame.length >= 10) {
     const rate = frame.readUInt32LE(6);
     if (rate < 8000 || rate > 192000 || (active.rate && active.rate !== rate) || (frame.length - 10) % 2) { this.stop(); return; }
     active.rate = rate; active.chunks.push(Buffer.from(frame.subarray(10)));
     if (active.chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 32 * 1024 * 1024) { this.stop(); return; }
    } else if (frame[1] === 3) {
     this.active = undefined; clearTimeout(this.deadline); active.cleanup();
     if (!active.rate) active.reject(new Error("Speech produced no audio")); else active.resolve(wav(Buffer.concat(active.chunks), active.rate));
     this.idle = setTimeout(() => this.stop(), 5 * 60_000); this.idle.unref();
    } else if (frame[1] === 4) { this.active = undefined; clearTimeout(this.deadline); active.cleanup(); active.reject(new Error("Speech synthesis failed")); this.stop(); }
    else { this.stop(); return; }
   }
  });
 }
}
export function wav(pcm: Buffer, sampleRate: number): Buffer {
 const header = Buffer.alloc(44); header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40); return Buffer.concat([header, pcm]);
}
