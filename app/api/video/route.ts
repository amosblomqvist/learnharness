import { Readable } from "node:stream";
import * as fs from "node:fs";
import { stores, cancelVideo, runtimeInstalled, startVideo, videoFile, videoSupported } from "@/src/server";

export const dynamic = "force-dynamic";
function lookup(req: Request) {
  const url = new URL(req.url); const id = url.searchParams.get("id") ?? ""; const chatId = url.searchParams.get("chatId") ?? "";
  const job = stores.jobStore.getJob(id);
  return job?.kind === "video" && job.chatId === chatId && stores.chatStore.getChat(chatId) ? { id, chatId, job } : null;
}
export async function GET(req: Request) {
  const item = lookup(req); if (!item) return new Response("Not found", { status: 404 });
  if (new URL(req.url).searchParams.get("media") !== "1") return Response.json({ supported: videoSupported(), installed: runtimeInstalled() });
  if (item.job.status !== "done" || !(item.job.result as {video?: boolean} | undefined)?.video) return new Response("Not found", { status: 404 });
  let fd: number;
  try { fd = fs.openSync(videoFile(item.id), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); } catch { return new Response("Not found", { status: 404 }); }
  const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size === 0 || stat.size > 200_000_000) { fs.closeSync(fd); return new Response("Not found", { status: 404 }); }
  let start = 0, end = stat.size - 1; let status = 200;
  const range = req.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { fs.closeSync(fd); return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } }); }
    if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, stat.size - suffix); } else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { fs.closeSync(fd); return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } }); }
    status = 206;
  }
  const headers: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Cache-Control": "private, no-store" };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  const stream = fs.createReadStream("", { fd, start, end, autoClose: true });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
}
export async function POST(req: Request) {
  const item = lookup(req); if (!item) return new Response("Not found", { status: 404 });
  const body = await req.json().catch(() => ({}));
  try { await startVideo(item.id, item.chatId, body.download === true, body.retry === true); return Response.json({ ok: true }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
export async function DELETE(req: Request) {
  const item = lookup(req); if (!item || !cancelVideo(item.id, item.chatId)) return new Response("Not found", { status: 404 });
  return Response.json({ ok: true });
}
