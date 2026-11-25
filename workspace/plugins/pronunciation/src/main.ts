import type { PluginButtonProps, PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import { BLOCKED_TEXT, LICENSE_TEXT, PREPARING_TEXT, describeInstall, megabytes, parseSpeakResult, parseState, type PluginState } from "./contract.ts";
import { INTERACTIVE_SELECTOR, MAX_MOVE_PX, TOUCH_CLICK_MS, isCleanClick, isCleanTap, isRepeatTap, pointInRects, type Press, type Tap } from "./gesture.ts";
import { hanAt, hanRunAt } from "./han.ts";
import { encodeWav } from "./wav.ts";

const HIGHLIGHT = "lh-pronounce";
const NOTICE_MS = 5000;
const PREPARING_MS = 600;

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

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 10 ms of silence, played inside the tap to unlock the audio element. */
const SILENCE = `data:audio/wav;base64,${bytesBase64(encodeWav(new Float32Array(240), 24_000))}`;

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
  /** `lasting` keeps the notice until it is replaced or hidden. */
  function showNotice(message: string, x: number, y: number, lasting = false): void {
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
    if (!lasting) noticeTimer = setTimeout(hideNotice, NOTICE_MS);
  }

  // ---- Playback ----------------------------------------------------------
  // One media element, not Web Audio: iPhone plays media even on silent, and a
  // media element unlocked by a play() inside the tap may play again later,
  // when the clip arrives, without another gesture.
  let player: HTMLAudioElement | undefined;
  let clip: string | undefined;
  let generation = 0;
  let preparing: ReturnType<typeof setTimeout> | undefined;
  const releaseClip = () => { if (clip) URL.revokeObjectURL(clip); clip = undefined; };
  const stop = () => {
    clearTimeout(preparing);
    player?.pause();
    releaseClip();
  };
  function speak(text: string, x: number, y: number): void {
    const request = ++generation;
    stop(); hideNotice();
    const element = player ??= new Audio();
    element.preload = "auto";
    element.src = SILENCE;
    // Superseded by the real clip (AbortError) or refused; either way the real play() reports.
    void element.play().catch(() => {});
    preparing = setTimeout(() => { if (request === generation && !disposed) showNotice(PREPARING_TEXT, x, y, true); }, PREPARING_MS);
    ctx.call("speak", { text }).then(parseSpeakResult).then(async ({ wav }) => {
      if (request !== generation || disposed) return;
      const url = URL.createObjectURL(new Blob([base64Bytes(wav)], { type: "audio/wav" }));
      releaseClip();
      clip = url;
      element.src = url;
      element.onended = () => { if (clip === url) releaseClip(); };
      try { await element.play(); }
      catch (error) {
        if ((error as { name?: string }).name === "NotAllowedError") throw new Error(BLOCKED_TEXT);
        throw error;
      }
      if (request !== generation || disposed) return;
      clearTimeout(preparing);
      hideNotice();
    }).catch((error: unknown) => {
      if (request !== generation || disposed) return;
      clearTimeout(preparing);
      // A newer clip replacing this one aborts its play(); that is not an error.
      if ((error as { name?: string }).name === "AbortError") return;
      showNotice(error instanceof Error ? error.message : String(error), x, y);
    });
  }

  /** Common checks for a click or tap at a point; plays when it hits Chinese. */
  function activateAt(target: EventTarget | null, x: number, y: number): void {
    if (!state) return;
    if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;
    const hit = hanHitAt(x, y);
    if (hit) speak(hit.node.data.slice(hit.start, hit.end), x, y);
  }
  const selectionCollapsed = () => { const selection = document.getSelection(); return !selection || selection.isCollapsed; };

  // ---- Touch taps --------------------------------------------------------
  // iPhone Safari often sends no click for a tap on plain text, so taps are
  // read from touch events. Listeners are passive: scrolling, selection and
  // links behave exactly as before.
  let touch: (Press & { moved: boolean }) | undefined;
  let lastTap: Tap | undefined;
  let lastTouchEnd = -Infinity;
  const onTouchStart = (event: TouchEvent) => {
    const point = event.touches.length === 1 ? event.touches[0] : undefined;
    touch = point && { x: point.clientX, y: point.clientY, time: event.timeStamp, moved: false };
  };
  const onTouchMove = (event: TouchEvent) => {
    const point = event.touches.length === 1 ? event.touches[0] : undefined;
    if (!touch || !point) { touch = undefined; return; }
    if (Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > MAX_MOVE_PX) touch.moved = true;
  };
  const onTouchCancel = () => { touch = undefined; };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch;
    touch = undefined;
    lastTouchEnd = event.timeStamp;
    const point = event.changedTouches[0];
    if (!start || !point || event.touches.length) return;
    const tap = { x: point.clientX, y: point.clientY, time: event.timeStamp };
    if (!isCleanTap(start, tap, start.moved, selectionCollapsed())) return;
    const repeat = isRepeatTap(lastTap, tap);
    lastTap = tap;
    if (!repeat) activateAt(event.target, tap.x, tap.y);
  };

  // ---- Clicks and hover --------------------------------------------------
  let press: Press | undefined;
  const onPointerDown = (event: PointerEvent) => {
    press = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, time: event.timeStamp } : undefined;
  };
  const onClick = (event: MouseEvent) => {
    const down = press;
    press = undefined;
    // A tap was already handled from its touch events.
    if (event.timeStamp - lastTouchEnd < TOUCH_CLICK_MS) return;
    if (!state) return;
    const clean = isCleanClick(down, {
      x: event.clientX, y: event.clientY, time: event.timeStamp, button: event.button, detail: event.detail,
      modified: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
    }, selectionCollapsed());
    if (clean) activateAt(event.target, event.clientX, event.clientY);
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

  document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
  document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  document.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });
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
    const license = document.createElement("p");
    license.className = "lh-pronounce-license";
    license.textContent = LICENSE_TEXT;
    root.append(status, progress, actions, license);
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
    let button: PluginWidgetHandle<PluginButtonProps> | undefined;
    const render = (current: PluginState) => {
      status.textContent = describeInstall(current.install, current.downloadBytes);
      const download = current.install.kind === "downloading" ? current.install : undefined;
      progress.hidden = !download;
      if (download) { progress.max = download.total; progress.value = download.received; }
      if (button) button.update(buttonProps(current)); else button = ctx.ui.mountButton(actions, buttonProps(current), { signal });
    };
    views.add(render);
    if (state) render(state);
    else status.textContent = "Loading…";
    return () => { views.delete(render); button?.dispose(); root.remove(); };
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
    unregisterSettings();
    document.removeEventListener("touchstart", onTouchStart, { capture: true });
    document.removeEventListener("touchmove", onTouchMove, { capture: true });
    document.removeEventListener("touchend", onTouchEnd, { capture: true });
    document.removeEventListener("touchcancel", onTouchCancel, { capture: true });
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    document.removeEventListener("click", onClick);
    document.removeEventListener("pointermove", onPointerMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("blur", onLeave);
    if (hoverFrame) cancelAnimationFrame(hoverFrame);
    clearHover(); hideNotice(); stop();
    player?.removeAttribute("src");
    player?.load();
    player = undefined;
  };
  ctx.cleanup(dispose);
  subscriptions.push(ctx.onNotification(event => { if (event.topic === "state-changed") apply(event.data); }));
  subscriptions.push(ctx.onResync(() => { void refresh().catch(error => { if (!disposed) console.error("Chinese pronunciation: state resync failed.", error); }); }));
  try { await refresh(); }
  catch (error) { dispose(); throw error; }
  return dispose;
}
