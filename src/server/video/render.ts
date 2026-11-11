import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { PATHS } from "../../../config.ts";
import { validVideoPlan, videoPaintOrder, videoRuntime, type VideoPlan } from "../../core/video.ts";
import { stores } from "../stores.ts";

const RELEASE = "https://github.com/shinyobjectz/raea/releases/download/v0.1.1-rc2/";
const asset = videoRuntime(process.platform, process.arch);
const root = path.join(PATHS.data, "video");
const runtime = path.join(root, "runtime", "v0.1.1-rc2");
const binary = path.join(runtime, "raea", "bin", process.platform === "win32" ? "raea.exe" : "raea");
const controllers = ((globalThis as typeof globalThis & { __lhVideoControllers?: Map<string, AbortController> }).__lhVideoControllers ??= new Map());
export const videoSupported = () => asset !== undefined;
export const videoEnabled = () => stores.settingsStore.readSettings()?.agent?.tools?.teaching_video !== false;
export const videoDownloadInfo = () => asset ? { downloadMiB: asset.downloadMiB, disk: asset.disk } : null;
export const runtimeInstalled = () => {
  try { return fs.lstatSync(binary).isFile() && !fs.lstatSync(runtime).isSymbolicLink(); } catch { return false; }
};
export const videoIsLive = (id: string) => controllers.has(id);
export function deleteVideo(id: string): void { fs.rmSync(videoFile(id), { force: true }); }
export const videoFile = (id: string) => {
  if (!/^job_[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid video id");
  return path.join(root, "media", `${id}.mp4`);
};
function run(command: string, args: string[], cwd: string, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Cancelled")); return; }
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; let spawnError: Error | undefined;
    const abort = () => child.kill("SIGKILL");
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    child.stderr?.on("data", chunk => { error = (error + String(chunk)).slice(-2000); });
    child.on("error", e => { spawnError = e; });
    child.on("close", code => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(new Error("Cancelled or timed out")); else if (spawnError) reject(spawnError); else if (code === 0) resolve(); else reject(new Error(`Renderer failed (${code}): ${error}`)); });
  });
}
async function install(signal: AbortSignal): Promise<void> {
  if (runtimeInstalled()) return;
  if (!asset) throw new Error("Video rendering is not available on this platform.");
  await fsp.mkdir(path.dirname(runtime), { recursive: true });
  const stage = await fsp.mkdtemp(path.join(path.dirname(runtime), ".install-"));
  const archive = path.join(stage, asset.archive);
  try {
    const response = await fetch(RELEASE + asset.archive, { signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Download failed (${response.status})`); }
    const file = await fsp.open(archive, "wx", 0o600);
    const hash = createHash("sha256"); let size = 0;
    try {
      const reader = response.body.getReader();
      try { while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > asset.size) throw new Error("Runtime download exceeds expected size");
        hash.update(chunk); await file.writeFile(chunk);
      } } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
    } finally { await file.close(); }
    if (size !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("Runtime download checksum mismatch");
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const tar = process.platform === "win32" ? path.join(systemRoot, "System32", "tar.exe") : "/usr/bin/tar";
    const env = process.platform === "win32" ? { NODE_ENV: "production" as const, SystemRoot: systemRoot } : { NODE_ENV: "production" as const };
    await run(tar, [process.platform === "win32" ? "-xf" : "-xzf", archive, "-C", stage], stage, AbortSignal.any([signal, AbortSignal.timeout(120_000)]), env);
    await fsp.rm(archive);
    await fsp.access(path.join(stage, "raea", "bin", process.platform === "win32" ? "raea.exe" : "raea"));
    signal.throwIfAborted();
    try { fs.renameSync(stage, runtime); } catch (error) { if (!runtimeInstalled()) throw error; }
  } finally { await fsp.rm(stage, { recursive: true, force: true }); }
}
export function composition(plan: VideoPlan, theme: "dark" | "light" = "dark"): string {
  // JSON is parsed as data, never interpolated as JSX or JavaScript source.
  const data = JSON.stringify(JSON.stringify({ ...plan, scenes: plan.scenes.map(scene => ({ ...scene, drawOrder: videoPaintOrder(scene.elements) })) }));
  const frames = Math.ceil(plan.scenes.reduce((n, scene) => n + scene.seconds, 0) * 24);
  const palette = theme === "light"
    ? { background: "#f5f7fb", ink: "#142238", text: { blue: "#10498f", yellow: "#654900", white: "#142238", green: "#14532d", red: "#8b2029" }, shape: { blue: "#c6def9", yellow: "#f4e2a8", white: "#d7e0ef", green: "#c6ebd2", red: "#f8d5d8" } }
    : { background: "#10162c", ink: "#f8f9ff", text: { blue: "#9bd1ff", yellow: "#ffe087", white: "#f8f9ff", green: "#a5efbd", red: "#ffb3b9" }, shape: { blue: "#19416c", yellow: "#59410a", white: "#48536b", green: "#16512e", red: "#681f2b" } };
  return `import React from 'react';
import {AbsoluteFill,Composition,registerRoot,useCurrentFrame} from 'raea';
const plan=JSON.parse(${data});
const palette=${JSON.stringify(palette)};
function Scene(){const frame=useCurrentFrame(); let offset=0; let scene=plan.scenes[plan.scenes.length-1]; let local=0; for(const s of plan.scenes){local=frame-offset;offset+=s.seconds*24;if(frame<offset){scene=s;break;}}
return <AbsoluteFill style={{backgroundColor:palette.background,color:palette.ink,fontFamily:'sans-serif'}}><div style={{position:'absolute',left:40,top:25,fontSize:42,fontWeight:700}}>{scene.heading}</div>{scene.drawOrder.map(i=>{const e=scene.elements[i];return <div key={i} style={{position:'absolute',left:e.x*896,top:90+e.y*320,width:e.width*896,height:e.height*320,color:palette.text[e.color],backgroundColor:e.kind==='text'?'transparent':palette.shape[e.color],borderRadius:e.kind==='circle'?'50%':e.kind==='rect'?8:0,fontSize:28,overflow:'hidden',opacity:Math.min(1,Math.max(0,(local-i*(scene.seconds*24*.3/Math.max(1,scene.elements.length)))/8))}}>{e.kind==='text'?e.text:''}</div>})}<div style={{position:'absolute',left:40,bottom:24,fontSize:26}}>{scene.caption}</div></AbsoluteFill>}
registerRoot(()=> <Composition id="lesson" component={Scene} width={896} height={504} fps={24} durationInFrames={${frames}} />);`;
}
export async function startVideo(id: string, chatId: string, download: boolean, retry = false): Promise<void> {
  const job = stores.jobStore.getJob(id);
  if (!job || job.chatId !== chatId || job.kind !== "video" || !stores.chatStore.getChat(chatId)) throw new Error("Video not found");
  const agent = stores.settingsStore.readSettings()?.agent;
  if (agent?.tools?.teaching_video === false) throw new Error("Explainer videos are disabled in Settings.");
  const theme = agent?.video?.theme ?? "dark";
  if (!videoSupported()) throw new Error("Video rendering is not available on this platform.");
  if (!validVideoPlan(job.input)) throw new Error("Invalid saved video plan");
  if (!runtimeInstalled() && !download) throw new Error("Runtime download needs your approval.");
  if (controllers.has(id)) return;
  if (controllers.size >= 1) throw new Error("Another video is rendering. Please retry when it finishes.");
  if (!retry && job.status === "done" && (job.result as {video?: boolean} | undefined)?.video && fs.existsSync(videoFile(id))) return;
  const controller = new AbortController();
  stores.jobStore.updateJob(id, { status: "running", activity: runtimeInstalled() ? "rendering video" : "downloading renderer", error: undefined, result: undefined });
  controllers.set(id, controller);
  void (async () => {
    let work: string | undefined;
    try {
      if (!runtimeInstalled()) {
        await install(controller.signal);
      }
      controller.signal.throwIfAborted();
      stores.jobStore.updateJob(id, { activity: "rendering video" });
      await fsp.mkdir(path.join(root, "media"), { recursive: true });
      work = await fsp.mkdtemp(path.join(root, "render-"));
      const source = path.join(work, "scene.tsx"); const output = path.join(work, "video.mp4");
      await fsp.writeFile(source, composition(job.input as VideoPlan, theme));
      await run(binary, ["render", source, "-o", output], work, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]), { NODE_ENV: "production", RAEA_OFFLINE: "1", RAEA_NO_TREE: "1", RAEA_ENV_FILE: path.join(work, "env"), RAEA_CACHE: path.join(work, "cache"), ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "C:\\Windows", TEMP: work, TMP: work } : {}), ...((process.platform === "win32" || process.platform === "linux") && process.env.WGPU_BACKEND === "vulkan" ? { WGPU_BACKEND: "vulkan" } : {}) });
      controller.signal.throwIfAborted();
      if (controllers.get(id) !== controller || !stores.jobStore.getJob(id)) return;
      const stat = await fsp.lstat(output);
      if (!stat.isFile() || stat.size === 0 || stat.size > 200_000_000) throw new Error("Renderer did not produce a valid video file.");
      controller.signal.throwIfAborted();
      if (stores.jobStore.getJob(id)?.status !== "running") return;
      fs.renameSync(output, videoFile(id));
      try { stores.jobStore.updateJob(id, { status: "done", activity: "video ready", result: { video: true } }); }
      catch (error) { fs.rmSync(videoFile(id), { force: true }); throw error; }
    } catch (error) {
      if (stores.jobStore.getJob(id)) stores.jobStore.updateJob(id, { status: "error", activity: "video failed", error: controller.signal.aborted ? "Cancelled" : error instanceof Error ? error.message : String(error) });
    } finally { controllers.delete(id); if (work) await fsp.rm(work, { recursive: true, force: true }); }
  })().catch(error => console.error("Video cleanup failed:", error));
}
export function cancelVideo(id: string, chatId: string): boolean {
  const job = stores.jobStore.getJob(id);
  if (!job || job.chatId !== chatId || job.kind !== "video") return false;
  controllers.get(id)?.abort();
  return true;
}
