import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, after } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { validVideoPlan, videoPaintOrder, videoRuntime } from "../src/core/video.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lh-video-test-"));
process.env.LH_DATA_DIR = path.join(profile, "data");
process.env.LH_AUTH_FILE = path.join(profile, "auth.json");
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const { stores } = await import("../src/server/stores.ts");
const { startVideo, cancelVideo, runtimeInstalled, videoFile, videoIsLive, composition } = await import("../src/server/video/render.ts");
const { GET } = await import("../app/api/video/route.ts");
const { parseAgentSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const plan = { title: "Slopes", scenes: [
  { heading: "Average", caption: "Two points", seconds: 2, elements: [{ kind: "text", x: 0, y: 0, width: 1, height: .2, color: "white", text: "<script>${hostile}</script>" }] },
  { heading: "Instantaneous", caption: "A limit", seconds: 2, elements: [] },
] };
const chat = stores.chatStore.createChat("Video test");
function draft() { const job = stores.jobStore.createJob({ kind: "video", chatId: chat.id, toolCallId: crypto.randomUUID(), input: plan }); stores.jobStore.updateJob(job.id, { status: "done", activity: "ready to render" }); return job; }
async function settled(id: string) { for (let i = 0; i < 200; i++) { const job = stores.jobStore.getJob(id); if (job?.status !== "running" && !videoIsLive(id)) return job; await pause(10); } throw new Error("job did not settle"); }

test("scene plans reject paths, unbounded values and non-finite coordinates", () => {
  assert(validVideoPlan(plan));
  assert(!validVideoPlan({ ...plan, scenes: [{ ...plan.scenes[0], elements: [{ ...plan.scenes[0]!.elements[0], src: "/etc/passwd" }] }, plan.scenes[1]] }));
  assert(!validVideoPlan({ ...plan, scenes: [{ ...plan.scenes[0], seconds: NaN }, plan.scenes[1]] }));
  assert(!validVideoPlan({ ...plan, scenes: Array(6).fill(plan.scenes[0]) }));
});

test("runtime selection pins official platform-specific assets and rejects unsupported hosts", () => {
  assert.equal(videoRuntime("darwin", "arm64")?.size, 317870789);
  assert.equal(videoRuntime("linux", "x64")?.sha256, "cbcc68d9c671414114429b33110d914730414a2884fa1eb081523ef65115f4fe");
  assert.equal(videoRuntime("win32", "x64")?.archive, "raea-0.1.1-rc2-windows-x86_64.zip");
  assert.equal(videoRuntime("darwin", "x64"), undefined);
  assert.equal(videoRuntime("linux", "arm64"), undefined);
});

test("background shapes cannot cover labels even when the teacher puts text first", () => {
  const label = { ...plan.scenes[0]!.elements[0]!, kind: "text" as const, color: "white" as const };
  const shape = { kind: "rect" as const, x: 0, y: 0, width: 1, height: .2, color: "blue" as const };
  const source = [label, shape];
  assert.deepEqual(videoPaintOrder(source), [1, 0]);
  assert.deepEqual(source, [label, shape]);
});

test("teacher video dispatch persists one local plan without a background model or delivery", async () => {
  let calls = 0;
  const tools = jobTools({ chatId: chat.id, jobStore: stores.jobStore, spawn: () => { calls++; } });
  await tools.teaching_video!.execute("video-call", plan);
  await tools.teaching_video!.execute("video-call", plan);
  const job = stores.jobStore.findJobByToolCallId(chat.id, "video-call");
  assert.equal(calls, 1); assert.equal(job?.status, "done"); assert.equal(job?.delivery, undefined); assert.deepEqual(job?.input, plan);
});

test("video settings validate, sanitize and preserve defaults", () => {
  assert.deepEqual(parseAgentSettingsBody({ tools: { teaching_video: false }, video: { maxDurationSeconds: 10, theme: "light" } }), { ok: true, settings: { tools: { teaching_video: false }, video: { maxDurationSeconds: 10, theme: "light" } } });
  assert.equal(parseAgentSettingsBody({ video: { maxDurationSeconds: 11 } }).ok, false);
  assert.equal(parseAgentSettingsBody({ video: { theme: "custom" } }).ok, false);
  assert.deepEqual(sanitizeUserSettings({ version: 1, agent: { video: { maxDurationSeconds: 99, theme: "bad" } } })?.agent?.video, {});
});

test("new video plans respect current enable and duration settings", async () => {
  let options = { enabled: true, maxDurationSeconds: 10 }; let spawned = 0;
  const tool = jobTools({ chatId: chat.id, jobStore: stores.jobStore, spawn: () => { spawned++; }, videoOptions: () => options }).teaching_video!;
  assert.match(tool.description, /10 seconds total/);
  const longPlan = { ...plan, scenes: Array(3).fill({ ...plan.scenes[0], seconds: 5 }) };
  await assert.rejects(tool.execute("too-long", longPlan), /10-second limit/);
  options = { enabled: false, maxDurationSeconds: 25 };
  await assert.rejects(tool.execute("disabled", plan), /disabled/);
  assert.equal(spawned, 0);
  options = { enabled: true, maxDurationSeconds: 25 };
  await tool.execute("allowed", longPlan); assert.equal(spawned, 1);
});

test("fixed dark and light themes keep text readable on every shape", () => {
  const rgbLuminance = (hex: string) => {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
  };
  for (const theme of ["dark", "light"] as const) {
    const source = composition(plan as never, theme);
    const encoded = source.match(/const palette=(\{[^\n]+\});/)?.[1]; assert.ok(encoded);
    const palette = JSON.parse(encoded) as { background: string; ink: string; text: Record<string, string>; shape: Record<string, string> };
    for (const text of [palette.ink, ...Object.values(palette.text)]) for (const background of [palette.background, ...Object.values(palette.shape)]) {
      const [a, b] = [rgbLuminance(text), rgbLuminance(background)].sort((x, y) => y - x);
      assert.ok((a! + 0.05) / (b! + 0.05) >= 4.5, `${theme} ${text} on ${background}`);
    }
  }
});

test("download requires consent, cancellation stops it, bad bytes cannot install", { skip: !videoRuntime(process.platform, process.arch) }, async () => {
  const oldFetch = globalThis.fetch; let count = 0; let bad = false;
  globalThis.fetch = (async (_url, options) => { count++; if (bad) return new Response("bad bytes"); return new Response(new ReadableStream({ start(c) { options?.signal?.addEventListener("abort", () => c.error(new Error("aborted")), { once: true }); } })); }) as typeof fetch;
  try {
    const job = draft(); await assert.rejects(startVideo(job.id, chat.id, false), /approval/i); assert.equal(count, 0);
    await startVideo(job.id, chat.id, true); for (let i = 0; i < 200 && count === 0; i++) await pause(10); assert.equal(count, 1); assert(cancelVideo(job.id, chat.id));
    assert.equal((await settled(job.id))?.status, "error"); assert(!runtimeInstalled()); assert(!fs.existsSync(videoFile(job.id)));
    bad = true; await startVideo(job.id, chat.id, true); assert.match((await settled(job.id))?.error ?? "", /checksum/i); assert(!runtimeInstalled());
  } finally { globalThis.fetch = oldFetch; }
});

test("media is chat-scoped, supports seeking, and refuses symlinks", async () => {
  const job = draft(); const file = videoFile(job.id); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(64, 42)); stores.jobStore.updateJob(job.id, { result: { video: true } });
  const req = (id: string, owner: string, range?: string) => new Request(`http://localhost/api/video?id=${id}&chatId=${owner}&media=1`, { headers: range ? { range } : undefined });
  const res = await GET(req(job.id, chat.id, "bytes=4-11")); assert.equal(res.status, 206); assert.equal(res.headers.get("content-range"), "bytes 4-11/64"); assert.equal((await res.arrayBuffer()).byteLength, 8);
  assert.equal((await GET(req(job.id, chat.id, "bytes=100-"))).status, 416); assert.equal((await GET(req(job.id, "other"))).status, 404);
  const other = draft(); stores.jobStore.updateJob(other.id, { result: { video: true } }); if (process.platform !== "win32") { fs.symlinkSync(file, videoFile(other.id)); assert.equal((await GET(req(other.id, chat.id))).status, 404); }
});

test("disabling videos blocks new renders but leaves saved media playable", async () => {
  const job = draft(); const file = videoFile(job.id);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(64, 7));
  stores.jobStore.updateJob(job.id, { result: { video: true } });
  stores.settingsStore.writeSettings({ version: 1, agent: { tools: { teaching_video: false }, video: { theme: "light", maxDurationSeconds: 10 } } });
  try {
    await assert.rejects(startVideo(job.id, chat.id, true, true), /disabled/i);
    assert.equal(stores.jobStore.getJob(job.id)?.status, "done");
    const status = await GET(new Request(`http://localhost/api/video?id=${job.id}&chatId=${chat.id}`));
    assert.equal((await status.json()).enabled, false);
    const media = await GET(new Request(`http://localhost/api/video?id=${job.id}&chatId=${chat.id}&media=1`, { headers: { Range: "bytes=0-7" } }));
    assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 8);
  } finally { stores.settingsStore.writeSettings({ version: 1 }); }
});
