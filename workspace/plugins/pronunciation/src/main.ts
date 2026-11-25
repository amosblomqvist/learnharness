import type { PluginButtonProps, PluginFrontendContext, PluginSettingsSchema, PluginWidgetHandle } from "learnharness-plugin-api";
import { VOICES, describeInstall, megabytes, parseSpeakResult, parseState, type PluginState } from "./contract.ts";
import { INTERACTIVE_SELECTOR, isCleanClick, pointInRects, type Press } from "./gesture.ts";
import { hanAt, hanRunAt } from "./han.ts";

const HIGHLIGHT = "lh-pronounce";
const NOTICE_MS = 5000;

interface Hit { node: Text; start: number; end: number }

type CaretDocument = Document & {
  caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?(x: number, y: number): Range | null;
};
type HighlightRegistry = { set(name: string, highlight: unknown): void; delete(name: string): void };

function caretAt(x: number, y: number): { node: Node; offset: number } | undefined {
  const doc = document as CaretDocument;
  if (doc.caretPositionFromPoint) {
    const caret = doc.caretPositionFromPoint(x, y);
    return caret ? { node: caret.offsetNode, offset: caret.offset } : undefined;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : undefined;
}

/** The Han run under a client point, only when the point is on a character. */
function hanHitAt(x: number, y: number): Hit | undefined {
  const caret = caretAt(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return undefined;
  const node = caret.node as Text;
  if (node.parentElement?.closest(INTERACTIVE_SELECTOR)) return undefined;
  const text = node.data;
  // The caret can sit on either side of the character under the pointer.
  for (const index of [caret.offset, caret.offset - 1, caret.offset - 2]) {
    const character = hanAt(text, index);
    if (!character) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + character.length);
    if (!pointInRects(x, y, range.getClientRects())) continue;
    const run = hanRunAt(text, index);
    return run && { node, ...run };
  }
  return undefined;
}

function base64Bytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function activate(ctx: PluginFrontendContext): Promise<() => void> {
  let state: PluginState | undefined;
  let disposed = false;
  const views = new Set<(state: PluginState) => void>();
  const subscriptions: (() => void)[] = [];

  function apply(value: unknown): void {
    if (disposed || ctx.signal.aborted) return;
    const next = parseState(value);
    if (state && state.epoch === next.epoch && next.sequence <= state.sequence) return;
    state = next;
    views.forEach(render => render(next));
  }
  let resync: Promise<void> = Promise.resolve();
  function refresh(): Promise<void> {
    const task = resync.catch(() => {}).then(async () => { if (!disposed && !ctx.signal.aborted) apply(await ctx.call("get-state")); });
    resync = task;
    return task;
  }

  // ---- Notices -----------------------------------------------------------
  let notice: HTMLElement | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const hideNotice = () => { clearTimeout(noticeTimer); notice?.remove(); notice = undefined; };
  function showNotice(message: string, x: number, y: number): void {
    hideNotice();
    const element = document.createElement("div");
    element.className = "lh-pronounce-notice";
    element.setAttribute("role", "status");
    element.textContent = message;
    document.body.append(element);
    const width = element.offsetWidth, height = element.offsetHeight;
    element.style.left = `${Math.max(16, Math.min(x - width / 2, window.innerWidth - width - 16))}px`;
    element.style.top = `${y + 18 + height <= window.innerHeight - 8 ? y + 18 : Math.max(8, y - 18 - height)}px`;
    notice = element;
    noticeTimer = setTimeout(hideNotice, NOTICE_MS);
  }

  // ---- Playback ----------------------------------------------------------
  let audio: AudioContext | undefined;
  let playing: AudioBufferSourceNode | undefined;
  let generation = 0;
  const stop = () => { try { playing?.stop(); } catch { /* already ended */ } playing = undefined; };
  function speak(text: string, x: number, y: number): void {
    const request = ++generation;
    stop(); hideNotice();
    // Create/resume inside the click so phones allow the later playback.
    audio ??= new AudioContext();
    void audio.resume().catch(() => {});
    const context = audio;
    ctx.call("speak", { text }).then(parseSpeakResult).then(async ({ wav }) => {
      const buffer = await context.decodeAudioData(base64Bytes(wav));
      if (request !== generation || disposed) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => { if (playing === source) playing = undefined; };
      playing = source;
      source.start();
    }).catch((error: unknown) => {
      if (request === generation && !disposed) showNotice(error instanceof Error ? error.message : String(error), x, y);
    });
  }

  // ---- Clicks and hover --------------------------------------------------
  let press: Press | undefined;
  const onPointerDown = (event: PointerEvent) => {
    press = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, time: event.timeStamp } : undefined;
  };
  const onClick = (event: MouseEvent) => {
    const down = press;
    press = undefined;
    if (!state) return;
    const selection = document.getSelection();
    const clean = isCleanClick(down, {
      x: event.clientX, y: event.clientY, time: event.timeStamp, button: event.button, detail: event.detail,
      modified: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
    }, !selection || selection.isCollapsed);
    if (!clean) return;
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return;
    const hit = hanHitAt(event.clientX, event.clientY);
    if (hit) speak(hit.node.data.slice(hit.start, hit.end), event.clientX, event.clientY);
  };

  const highlights = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  let hoverFrame = 0, hoverPoint: { x: number; y: number; target: EventTarget | null } | undefined;
  const clearHover = () => highlights?.delete(HIGHLIGHT);
  const updateHover = () => {
    hoverFrame = 0;
    const point = hoverPoint;
    if (!point || !highlights || !Highlight || !state || (point.target instanceof Element && point.target.closest(INTERACTIVE_SELECTOR))) { clearHover(); return; }
    const hit = hanHitAt(point.x, point.y);
    if (!hit) { clearHover(); return; }
    const range = document.createRange();
    range.setStart(hit.node, hit.start);
    range.setEnd(hit.node, hit.end);
    highlights.set(HIGHLIGHT, new Highlight(range));
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    hoverPoint = { x: event.clientX, y: event.clientY, target: event.target };
    if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
  };
  const onLeave = () => { hoverPoint = undefined; clearHover(); };

  document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  document.addEventListener("click", onClick);
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  window.addEventListener("blur", onLeave);

  // ---- Settings ----------------------------------------------------------
  const unregisterSettings = ctx.registerSettings((container, signal) => {
    const root = document.createElement("div");
    root.className = "lh-pronounce-settings";
    const status = document.createElement("p");
    status.className = "lh-pronounce-status";
    status.setAttribute("role", "status");
    const progress = document.createElement("progress");
    progress.className = "lh-pronounce-progress";
    const actions = document.createElement("div");
    actions.className = "lh-pronounce-actions";
    const rows = document.createElement("div");
    root.append(status, progress, actions, rows);
    container.append(root);

    const run = (operation: "download" | "remove") => async () => {
      try { apply(await ctx.call(operation)); }
      catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    };
    const buttonProps = (current: PluginState): PluginButtonProps => {
      switch (current.install.kind) {
        case "installed": return { label: "Remove downloaded files", variant: "outline", size: "sm", onClick: run("remove") };
        case "downloading": return { label: "Downloading…", variant: "secondary", size: "sm", disabled: true, onClick: () => {} };
        case "unsupported": return { label: "Download", variant: "secondary", size: "sm", disabled: true, onClick: () => {} };
        default: return { label: `Download (~${megabytes(current.downloadBytes)})`, variant: "default", size: "sm", onClick: run("download") };
      }
    };
    const rowsFor = (current: PluginState): PluginSettingsSchema => ({
      rows: [{
        key: "voice", type: "dropdown", label: "Voice", value: current.settings.voice,
        description: "The Kokoro voice used for every phrase.",
        options: VOICES.map(voice => ({ value: voice.id, label: voice.label })),
        async onChange(voice: string) { apply(await ctx.call("set-voice", { voice })); },
      }],
    });
    let button: PluginWidgetHandle<PluginButtonProps> | undefined;
    let voice: PluginWidgetHandle<PluginSettingsSchema> | undefined;
    const render = (current: PluginState) => {
      status.textContent = describeInstall(current.install, current.downloadBytes);
      const download = current.install.kind === "downloading" ? current.install : undefined;
      progress.hidden = !download;
      if (download) { progress.max = download.total; progress.value = download.received; }
      if (button) button.update(buttonProps(current)); else button = ctx.ui.mountButton(actions, buttonProps(current), { signal });
      if (voice) voice.update(rowsFor(current)); else voice = ctx.ui.mountSettingsRows(rows, rowsFor(current), { signal });
    };
    views.add(render);
    if (state) render(state);
    else status.textContent = "Loading…";
    return () => { views.delete(render); button?.dispose(); voice?.dispose(); root.remove(); };
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
    unregisterSettings();
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    document.removeEventListener("click", onClick);
    document.removeEventListener("pointermove", onPointerMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("blur", onLeave);
    if (hoverFrame) cancelAnimationFrame(hoverFrame);
    clearHover(); hideNotice(); stop();
    void audio?.close().catch(() => {});
    audio = undefined;
  };
  ctx.cleanup(dispose);
  subscriptions.push(ctx.onNotification(event => { if (event.topic === "state-changed") apply(event.data); }));
  subscriptions.push(ctx.onResync(() => { void refresh().catch(error => { if (!disposed) console.error("Chinese pronunciation: state resync failed.", error); }); }));
  try { await refresh(); }
  catch (error) { dispose(); throw error; }
  return dispose;
}
