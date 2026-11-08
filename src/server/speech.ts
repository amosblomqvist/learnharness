import { emit } from "../core/events.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import https from "node:https";
import { Readable } from "node:stream";
import { PATHS } from "../../config.ts";
import { SPEECH_VOICES, isSpeechVoiceId, type SpeechOperation, type SpeechQuality, type SpeechStatus, type SpeechVoiceId, type SpeechVoiceState } from "../core/speech.ts";
import { SpeechWorker } from "./speech-worker.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import lock from "../../docs/piper-artifacts.lock.json";
import { SpeechAudioCache } from "./speech-cache.ts";

const REVISION = lock.revision;

/** Hosts a voice download may reach, directly or through redirects. Only HTTPS to these hosts is followed. */
const DOWNLOAD_HOSTS = /(^|\.)(huggingface\.co|hf\.co)$/;

/** Node's fetch (undici) sustains only ~1.7 MB/s for these downloads; node:https reaches the link's speed. */
export function httpsDownload(input: string | URL, init: { signal?: AbortSignal } = {}): Promise<Response> {
 return new Promise((resolve, reject) => {
  const request = (url: URL, redirects: number) => {
   if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.test(url.hostname)) { reject(new Error("Voice download refused an untrusted address.")); return; }
   let req: ReturnType<typeof https.get>;
   try {
    req = https.get(url, { signal: init.signal }, (res) => {
     const status = res.statusCode ?? 0;
     if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
      res.resume();
      try { request(new URL(res.headers.location, url), redirects + 1); } catch (error) { reject(error); }
      return;
     }
     resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status }));
    });
   } catch (error) { reject(error); return; }
   req.on("error", reject);
  };
  try { request(new URL(String(input)), 0); } catch (error) { reject(error); }
 });
}

export function speechAuthorized(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
 return env.LH_DESKTOP_SERVER === "1" && !!env.LH_DESKTOP_API_SECRET && desktopAPIAuthorized(headers, env);
}

type LockVoice = (typeof lock.voices)[number];
type LockFile = LockVoice["files"][number];

export interface SpeechServiceOptions {
 /** Test seam: replaces every voice's artifact list. */
 files?: readonly LockFile[];
 /** Test seam: replaces the catalog entirely. */
 voices?: readonly LockVoice[];
 selfTest?: (directory: string, signal: AbortSignal, voiceId: string) => Promise<void>;
}

export class SpeechService {
 private operation: SpeechOperation | null = null;
 private abort?: AbortController;
 private work?: Promise<void>;
 private worker?: SpeechWorker;
 private workerVoice?: string;
 private recovered = false;
 private admitting = false;
 private readyCache = new Map<string, boolean>();
 private cache: SpeechAudioCache;
 /** Inference runs one request at a time; overlapping requests wait their turn instead of failing. */
 private synthesisTurn: Promise<unknown> = Promise.resolve();
 constructor(private root: string, private resources?: string, private fetcher: typeof fetch = httpsDownload as unknown as typeof fetch, private options: SpeechServiceOptions = {}) {
  this.cache = new SpeechAudioCache(path.join(root, "cache"));
 }
 private get voices(): readonly LockVoice[] { return this.options.voices ?? lock.voices; }
 private voice(id: string): LockVoice {
  const voice = this.voices.find(candidate => candidate.id === id);
  if (!voice || !isSpeechVoiceId(id)) throw new Error("Unknown speech voice");
  return voice;
 }
 private files(voice: LockVoice): readonly LockFile[] { return this.options.files ?? voice.files; }
 private total(voice: LockVoice) { return this.files(voice).reduce((sum, file) => sum + file.bytes, 0); }
 private directory(id: string) { return path.join(this.root, id); }
 private backup(id: string) { return path.join(this.root, `${id}.previous`); }
 private staging(id: string) { return path.join(this.root, `${id}.staging`); }
 private async available() {
  if (!this.resources) return false;
  try { await fs.access(path.join(this.resources, process.platform === "win32" ? "piper-helper.exe" : "piper-helper")); return true; } catch { return false; }
 }
 private async recover() {
  if (this.recovered) return;
  await fs.mkdir(this.root, {recursive:true});
  for (const voice of this.voices) {
   try { await fs.access(this.directory(voice.id)); } catch { try { await fs.rename(this.backup(voice.id), this.directory(voice.id)); } catch { /* No prior activation. */ } }
  }
  // Staging is never activated by restart; verified files remain for retry.
  this.recovered = true;
 }
 private async verified(directory: string, file: LockFile) {
  try { const data = await fs.readFile(path.join(directory,file.name)); return data.length === file.bytes && createHash("sha256").update(data).digest("hex") === file.sha256; } catch { return false; }
 }
 private async ready(voice: LockVoice) {
  const cached = this.readyCache.get(voice.id);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
   const manifest = JSON.parse(await fs.readFile(path.join(this.directory(voice.id),"installed.json"),"utf8"));
   ok = manifest.revision === REVISION && manifest.engineVersion === lock.engineVersion && (await Promise.all(this.files(voice).map(file=>this.verified(this.directory(voice.id),file)))).every(Boolean);
  } catch { ok = false; }
  this.readyCache.set(voice.id, ok);
  return ok;
 }
 async status(): Promise<SpeechStatus> {
  await this.recover();
  const operation = this.operation ? {...this.operation} : null;
  const available = await this.available();
  const voices = await Promise.all(this.voices.map(async (voice) => {
   const ready = await this.ready(voice);
   const busy = operation?.voiceId === voice.id;
   let repair = false;
   if (!ready && !busy) { try { await fs.access(this.directory(voice.id)); repair = true; } catch { /* Not installed yet. */ } }
   const state: SpeechVoiceState = !available ? "unavailable" : busy ? operation!.state : ready ? "ready" : repair ? "failed" : "not-installed";
   return {
    id: voice.id as SpeechVoiceId,
    engine: "piper" as const,
    name: SPEECH_VOICES.find(known => known.id === voice.id)?.name ?? voice.id,
    quality: voice.quality as SpeechQuality,
    license: voice.license,
    downloadBytes: this.total(voice),
    state,
    ...(repair && state === "failed" ? {reason:"The installed voice is incompatible or damaged. Install again to repair it."} : {}),
   };
  }));
  return {engines:[{id:"piper",available,...(!available?{reason:"Local speech runtime is unavailable for this desktop build."}:{})}], voices, operation};
 }
 async install(voiceId:string) {
  if (this.admitting || this.work) throw new Error("A voice operation is already running");
  this.admitting = true;
  try { return await this.installInner(voiceId); } finally { this.admitting = false; }
 }
 private async installInner(voiceId:string) {
  const voice = this.voice(voiceId);
  if(this.work) throw new Error("A voice operation is already running");
  if(!await this.available()) throw new Error("Local speech runtime is unavailable");
  await this.recover();
  if(await this.ready(voice)) return null;
  const controller=new AbortController(); this.abort=controller;
  this.operation={id:randomUUID(),voiceId,state:"downloading",downloadedBytes:0,totalBytes:this.total(voice)};
  const operation=this.operation;
  this.work=this.performInstall(voice,controller.signal).catch(error=>{ operation.state="failed";operation.error=controller.signal.aborted?"Installation cancelled. Retry to continue.":error instanceof Error && /^(Voice (download|checksum)|Installation)/.test(error.message)?error.message:"Voice installation failed. Check disk space and retry."; }).finally(()=>{this.work=undefined;this.abort=undefined;this.readyCache.delete(voiceId);emit("speech-changed", {});});
  emit("speech-changed", {});
  return {...operation};
 }
 private async performInstall(voice: LockVoice, signal:AbortSignal) {
  const staging = this.staging(voice.id);
  await fs.mkdir(staging,{recursive:true});
  for(const file of this.files(voice)) {
   if(signal.aborted) throw new Error("Cancelled");
   if(await this.verified(staging,file)) {this.operation!.downloadedBytes+=file.bytes;continue;}
   const partial=path.join(staging,`${file.name}.partial`);
   const response=await this.fetcher(`https://huggingface.co/rhasspy/piper-voices/resolve/${REVISION}/${voice.directory}/${file.name}`,{signal});
   if(!response.ok||!response.body) throw new Error("Voice download failed. Retry the installation.");
   const handle=await fs.open(partial,"w"); const hash=createHash("sha256"); let bytes=0;
   // Network chunks are small; batching writes keeps disk I/O from capping the download.
   const WRITE_BATCH = 1024 * 1024;
   let pending: Buffer[] = []; let pendingBytes = 0;
   const flush = async () => { if (!pendingBytes) return; const data = Buffer.concat(pending); pending = []; pendingBytes = 0; await handle.writeFile(data); };
   const reader = response.body.getReader();
   try {
    while (true) {
     const next = await reader.read(); if (next.done) break; const chunk = next.value;
     if(signal.aborted)throw new Error("Cancelled");
     bytes+=chunk.length;if(bytes>file.bytes)throw new Error("Voice download size mismatch");
     hash.update(chunk); pending.push(Buffer.from(chunk)); pendingBytes+=chunk.length;
     this.operation!.downloadedBytes+=chunk.length;
     if (pendingBytes >= WRITE_BATCH) await flush();
    }
    await flush();
   } finally {await reader.cancel().catch(()=>{});reader.releaseLock();await handle.close();}
   if(bytes!==file.bytes||hash.digest("hex")!==file.sha256) throw new Error("Voice checksum verification failed");
   await fs.rename(partial,path.join(staging,file.name));
  }
  this.operation!.state="verifying";
  const testWorker=new SpeechWorker(this.resources!,staging,voice.id);
  try {if (this.options.selfTest) await this.options.selfTest(staging,signal,voice.id); else await testWorker.synthesize("Your lesson voice is ready.",signal);} finally {testWorker.stop();}
  if(signal.aborted)throw new Error("Cancelled");
  await fs.writeFile(path.join(staging,"installed.json"),JSON.stringify({revision:REVISION,engineVersion:lock.engineVersion}));
  const directory = this.directory(voice.id), backup = this.backup(voice.id);
  await fs.rm(backup,{recursive:true,force:true});
  let backedUp = false;
  try {await fs.rename(directory,backup);backedUp=true;} catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
  try {await fs.rename(staging,directory);} catch(error) {if(backedUp)await fs.rename(backup,directory);throw error;}
  await fs.rm(backup,{recursive:true,force:true}); this.operation=null;
 }
 cancel(id:string) {if(this.operation?.id!==id||!this.abort)throw new Error("Unknown installation operation");this.abort.abort();}
 async remove(voiceId:string) {
  const voice = this.voice(voiceId);
  if(this.work || this.admitting)throw new Error("A voice operation is already running");
  if(this.workerVoice===voiceId){this.worker?.stop();this.worker=undefined;this.workerVoice=undefined;}
  this.readyCache.delete(voiceId);
  this.operation={id:randomUUID(),voiceId,state:"removing",downloadedBytes:0,totalBytes:this.total(voice)};
  this.work=(async()=>{await fs.rm(this.directory(voiceId),{recursive:true,force:true});await fs.rm(this.staging(voiceId),{recursive:true,force:true});await this.cache.removeVoice(voiceId);this.operation=null;})().catch(()=>{this.operation!.state="failed";this.operation!.error="Voice removal failed. Retry.";}).finally(()=>{this.work=undefined;this.readyCache.delete(voiceId);emit("speech-changed", {});});
  emit("speech-changed", {});
  await this.work;
 }
 async synthesize(voiceId:string,text:string,signal?:AbortSignal) {
  const voice = this.voices.find(candidate => candidate.id === voiceId);
  if(!voice||!text.trim()||Buffer.byteLength(text)>16384)throw new Error("Invalid speech segment");
  if(this.work||this.admitting||!await this.available()||!await this.ready(voice))throw new Error("Install the lesson voice in Speech settings first");
  // A sentence heard before is served from disk: no inference, no model load.
  const cached = await this.cache.get(voiceId, REVISION, text);
  if (cached) return cached;
  const audio = await this.inferInTurn(voiceId, text, signal);
  // A failed cache write must never fail the playback that already has its audio.
  await this.cache.put(voiceId, REVISION, text, audio).catch(() => {});
  return audio;
 }
 private inferInTurn(voiceId: string, text: string, signal?: AbortSignal): Promise<Buffer> {
  const turn = this.synthesisTurn.then(() => {
   if (signal?.aborted) throw new Error("Speech cancelled");
   // One resident model at a time: switching voices stops the previous worker.
   if(this.workerVoice!==voiceId){this.worker?.stop();this.worker=new SpeechWorker(this.resources!,this.directory(voiceId),voiceId);this.workerVoice=voiceId;}
   return this.worker!.synthesize(text,signal);
  });
  this.synthesisTurn = turn.catch(() => {});
  return turn;
 }
 shutdown(){this.abort?.abort();this.worker?.stop();}
}

const globalSpeech=globalThis as typeof globalThis & {lessonSpeech?:SpeechService; lessonSpeechShutdownHooks?: boolean};
export const speechService=globalSpeech.lessonSpeech??=new SpeechService(path.join(PATHS.data,"speech"),process.env.LH_SPEECH_RESOURCES);
if (!globalSpeech.lessonSpeechShutdownHooks) {
globalSpeech.lessonSpeechShutdownHooks = true;
process.once("exit",()=>speechService.shutdown());
// Run before Next's graceful server-close handler, so waiting HTTP synthesis
// cannot keep inference alive during shutdown. Preserve Node's default signal
// behavior when this module is used outside a Next server.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
 process.prependOnceListener(signal, () => {
  speechService.shutdown();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
 });
}
process.once("disconnect", () => {
 speechService.shutdown();
 if (process.env.LH_DESKTOP_SERVER === "1") process.kill(process.pid, "SIGTERM");
});
process.on("message", (message: unknown) => {
 if (!message || typeof message !== "object" || (message as {channel?:unknown}).channel !== "lh:speech-shutdown") return;
 speechService.shutdown();
 if (process.connected) process.send?.({channel:"lh:speech-shutdown-complete"});
});
}
export async function speechResponse(request:Request,action:"status"|"install"|"cancel"|"remove"|"synthesize",voiceId?:string) {
 if(!speechAuthorized(request.headers))return Response.json({error:"Local speech requires a verified desktop connection."},{status:403});
 try {
  if(action==="status")return Response.json(await speechService.status());
  if(action==="remove"){await speechService.remove(voiceId!);return Response.json({ok:true});}
  const reader=request.body?.getReader(); let raw=""; let size=0;
  if (reader) {const decoder=new TextDecoder();try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>32768){await reader.cancel();throw new Error("Speech request is too large");}raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}}
  const body=(()=>{try{return JSON.parse(raw);}catch{return null;}})() as Record<string,unknown>|null;
  if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("Invalid JSON body");
  if(action==="cancel"){if(typeof body.operationId!=="string")throw new Error("Invalid operation ID");speechService.cancel(body.operationId);return Response.json({ok:true});}
  if(typeof body.voiceId!=="string")throw new Error("Invalid voice ID");
  if(action==="install")return Response.json({operation:await speechService.install(body.voiceId)},{status:202});
  if(typeof body.text!=="string")throw new Error("Invalid speech text");
  const audio=await speechService.synthesize(body.voiceId,body.text,request.signal);
  return new Response(new Uint8Array(audio),{headers:{"content-type":"audio/wav","cache-control":"no-store"}});
 }catch(error){return Response.json({error:error instanceof Error?error.message:"Speech request failed"},{status:400});}
}
