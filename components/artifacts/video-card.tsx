"use client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { JobsContext } from "@/components/jobs-context";
import { ChatActionsContext } from "@/components/chat";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { useSettingsSaved } from "@/components/settings-signal";
import type { ArtifactPartProps, VideoPlan } from "@/src/core";

export function VideoCard({ part }: ArtifactPartProps) {
  const jobs = useContext(JobsContext); const chat = useContext(ChatActionsContext);
  const { open } = useSettingsDialog();
  const job = jobs.find(j => j.toolCallId === part.toolCallId && j.kind === "video");
  const [info, setInfo] = useState<{supported:boolean;enabled:boolean;installed:boolean;download:{downloadMiB:number;disk:string}|null} | null>(null);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const url = job && chat ? `/api/video?id=${encodeURIComponent(job.id)}&chatId=${encodeURIComponent(chat.chatId)}` : "";
  const refresh = useCallback(() => { const version = ++requestVersion.current; if (url) void fetch(url).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(value => { if (version === requestVersion.current) setInfo(value); }).catch(() => { if (version === requestVersion.current) setError("Could not check video renderer."); }); }, [url]);
  useEffect(() => { refresh(); return () => { requestVersion.current++; }; }, [refresh, job?.status]);
  useSettingsSaved(section => { if (section === "agent") refresh(); });
  if (part.state !== "output-available" || !job) return null;
  const plan = job.input as VideoPlan;
  const ready = job.status === "done" && (job.result as {video?:boolean} | undefined)?.video;
  const start = async () => { setError(""); try { const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ download: !info?.installed, retry: Boolean(ready) }) }); if (!response.ok) setError((await response.json()).error); } catch { setError("Could not start video rendering."); } };
  return <div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="video-card">
    <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Explainer video</span><button type="button" className="text-xs underline" onClick={() => open("agent")}>Video settings</button></div>
    <p className="mt-1 font-medium">{plan?.title}</p>
    {ready ? <video className="mt-2 w-full rounded-lg" controls preload="metadata" src={`${url}&media=1`} onError={() => setError("The video could not be played.")} /> : job.status === "running" ? <div><p>{job.activity}…</p><button className="underline" onClick={() => void fetch(url, { method: "DELETE" }).catch(() => setError("Could not cancel rendering."))}>Cancel</button></div> : info && !info.enabled ? <p>Explainer videos are disabled in Settings.</p> : info && !info.supported ? <p>Video rendering is unavailable on this platform. Interactive demos remain available.</p> : info && <button className="mt-2 rounded border px-3 py-1" onClick={() => void start()}>{info.installed ? "Render video" : `Download Raea and render (${info.download?.downloadMiB} MiB download; ${info.download?.disk})`}</button>}
    {ready && error && info?.installed && info.enabled && <button className="mt-2 rounded border px-3 py-1" onClick={() => void start()}>Render again</button>}
    {(error || job.error) && <p role="alert" className="mt-2 text-sm text-error">{error || job.error}</p>}
    <details className="mt-2 text-sm"><summary>Scene transcript</summary>{plan?.scenes?.map((s, i) => <p key={i}><strong>{s.heading}</strong>: {s.caption} {s.elements.filter(e => e.text).map(e => e.text).join(" ")}</p>)}</details>
    <p className="mt-2 text-xs text-muted-foreground">Rendered locally with <a className="underline" href="https://github.com/shinyobjectz/raea/blob/v0.1.1-rc2/LICENSE">Raea</a>.</p>
  </div>;
}
