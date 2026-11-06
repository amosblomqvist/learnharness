"use client";

import { useEffect, useRef, useState } from "react";
import { clonePluginQuestionJson, freezePluginQuestionValue, readPluginProblemSubmission,
  type PluginProblemSnapshot, type PluginProblemSubmission, type PluginCleanup } from "@/src/core";
import type { ProblemRendererRegistration } from "./plugin-manager";
import { usePlugins } from "./plugins";
import { problemMountContext } from "./plugin-problem-dock";
import { ThinkingBlock } from "./thinking-block";
import { SubmittedImages } from "./submitted-images";

export function PluginProblemSubmitted(props: { data: unknown; snapshot?: PluginProblemSnapshot | null; chatId: string }) {
  const { snapshot } = usePlugins();
  const registration = props.snapshot ? snapshot.problemRenderers?.find(entry => entry.pluginId === props.snapshot!.pluginId && entry.renderer.id === props.snapshot!.typeId && entry.renderer.supportedContractVersions.includes(props.snapshot!.contractVersion)) : undefined;
  return <PluginProblemSubmittedContent {...props} registration={registration} />;
}
export function PluginProblemSubmittedContent({ data, snapshot, chatId, registration }: {
  data: unknown; snapshot?: PluginProblemSnapshot | null; chatId: string; registration?: ProblemRendererRegistration;
}) {
  const submitted = readPluginProblemSubmission(data);
  return submitted ? <SubmittedBody submitted={submitted} snapshot={snapshot} chatId={chatId} registration={registration} /> : <p role="status">Problem unavailable</p>;
}
function SubmittedBody({ submitted, snapshot, chatId, registration }: { submitted: PluginProblemSubmission; snapshot?: PluginProblemSnapshot | null; chatId: string; registration?: ProblemRendererRegistration }) {
  const root = useRef<HTMLDivElement>(null), header = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);
  const bound = snapshot?.problemId === submitted.problemId && snapshot.pluginId === submitted.pluginId && snapshot.typeId === submitted.typeId && snapshot.contractVersion === submitted.contractVersion;
  const mount = bound ? registration?.renderer.mountSubmitted : undefined;
  useEffect(() => {
    setFailed(false);
    if (!mount || !snapshot || !root.current) return;
    const controller = new AbortController(), container = root.current.ownerDocument.createElement("div"), suffix = root.current.ownerDocument.createElement("span");
    suffix.className = "inline-flex items-center"; root.current.append(container); header.current?.append(suffix);
    let cleanup: void | PluginCleanup;
    const dispose = (fn: void | PluginCleanup) => { try { if (fn) void Promise.resolve(fn()).catch(() => {}); } catch {} };
    const release = () => { controller.abort(); const fn = cleanup; cleanup = undefined; dispose(fn); container.remove(); suffix.remove(); };
    const fail = () => { if (!controller.signal.aborted) { release(); setFailed(true); } };
    try {
      Promise.resolve(mount(container, Object.freeze({ ...problemMountContext(snapshot, chatId, controller.signal),
        submission: freezePluginQuestionValue(clonePluginQuestionJson(submitted.submission)),
        ...(snapshot.requiresProcessing && submitted.processing ? { processing: freezePluginQuestionValue(clonePluginQuestionJson(submitted.processing)) as PluginProblemSubmission["processing"] } : {}), headerContainer: suffix,
      }))).then(value => { if (controller.signal.aborted) dispose(value); else cleanup = value; }, fail);
    } catch { fail(); }
    return release;
  }, [mount, snapshot?.problemId, chatId, submitted.submittedAt]);
  return <div data-testid="plugin-problem-submitted" className="rounded-2xl border bg-card px-4 py-3">
    <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{snapshot?.label ?? "Problem"}<span ref={header} className="inline-flex items-center" /></div>
    <div ref={root} hidden={!mount || failed} />
    {(!mount || failed) && <div className="whitespace-pre-wrap text-sm">{typeof submitted.submission === "string" ? submitted.submission : JSON.stringify(submitted.submission, null, 2)}
      {submitted.processing && <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(submitted.processing, null, 2)}</pre>}
    </div>}
    <SubmittedImages images={submitted.images?.submission} />
    {(submitted.thinking !== "" || !!submitted.images?.thinking?.length) && <ThinkingBlock label="YOUR THINKING" text={submitted.thinking} images={submitted.images?.thinking} inCard />}
  </div>;
}
