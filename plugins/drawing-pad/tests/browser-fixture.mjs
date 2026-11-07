import React from "react";
import { createRoot } from "react-dom/client";
import { HostMarkdown } from "../../../components/host-markdown.tsx";
import { InteractionLayersProvider } from "../../../components/interaction-layers.tsx";
import { activate } from "../src/main.ts";
import { acceptedPoseKeys } from "../src/poses.ts";
import { referenceFontCSS } from "../src/fonts.ts";

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname === "/fonts/cmunbx.ttf" && window.fixture?.fontFetchMode === "html") return Promise.resolve(new Response("<style>body{background:black}</style>", { headers: { "content-type": "text/html" } }));
  if (url.pathname === "/fonts/cmunbx.ttf" && window.fixture?.fontFetchMode === "hold") return new Promise((_resolve, reject) => {
    window.fixture.pendingFontFetches++;
    const abort = () => { window.fixture.pendingFontFetches--; window.fixture.abortedFontFetches++; reject(init.signal.reason); };
    if (init.signal.aborted) abort(); else init.signal.addEventListener("abort", abort, { once: true });
  });
  return nativeFetch(input, init);
};

const controller = new AbortController(), cleanup = [], notifications = new Set(), events = new Set(), resyncs = new Set();
let action, interceptor, settingsSchema, surface, currentSession = "teach", currentKind = "teaching", input = { type: "text" }, off;
let savedSettings = { revision: 0, inkColor: "#facc15", imageScale: 50 }, pathname = "/opaque/teach", holdExportAck = [];
const histories = new Map(), attempts = [], markdownLog = [], errors = [], calls = [], heldMarkdown = [], heldDecodes = [];
const nativeDecode = HTMLImageElement.prototype.decode;
HTMLImageElement.prototype.decode = function () {
  const decode = nativeDecode.call(this);
  return window.fixture?.holdDecode ? decode.then(() => new Promise(resolve => heldDecodes.push(resolve))) : decode;
};
const topButton = document.querySelector("#draw");
const clone = value => structuredClone(value);
const target = {};
function refresh() { if (action) topButton.textContent = action.name; }
function handleButton(container, initial) {
  let props = initial;
  const button = document.createElement("button"); button.type = "button"; container.append(button);
  const render = () => {
    button.replaceChildren();
    if (props.icon) { const icon = document.createElement("span"); icon.innerHTML = props.icon; button.append(icon); }
    if (!props.iconOnly) button.append(document.createTextNode(props.label));
    if (props.iconOnly) button.setAttribute("aria-label", props.label); else button.removeAttribute("aria-label");
    button.disabled = !!props.disabled; button.title = props.title ?? ""; button.dataset.variant = props.variant ?? "default";
  };
  button.onclick = () => Promise.resolve(props.onClick()).catch(error => errors.push(String(error)));
  render(); return { update(next) { props = { ...props, ...next }; render(); }, dispose() { button.remove(); } };
}
function showSettings() {
  const panel = document.querySelector("#settings"), field = document.querySelector("#ink");
  panel.hidden = false; field.value = settingsSchema.rows[0].value; document.querySelector("#image-scale").value = settingsSchema.rows[1].value; field.focus();
}
function updateSettings(schema) {
  settingsSchema = schema;
  const field = document.querySelector("#ink");
  if (document.activeElement !== field) field.value = schema.rows[0].value;
  const scale = document.querySelector("#image-scale"); if (document.activeElement !== scale) scale.value = schema.rows[1].value;
}
const ctx = {
  manifest: { id: "drawing-pad" }, signal: controller.signal,
  cleanup(fn) { cleanup.push(fn); },
  registerAction(value) { action = value; refresh(); return () => { action = undefined; topButton.textContent = "Disabled"; }; },
  placeAction(value) { window.fixture.placement = value; return () => {}; },
  refreshActions: refresh, refreshSubmissions() {},
  registerSubmissionInterceptor(value) { interceptor = value; return () => { interceptor = undefined; }; },
  registerSettings(schema) { updateSettings(schema); return { update(next) { updateSettings(next); }, dispose() { settingsSchema = undefined; } }; },
  async call(name, value) {
    calls.push({ name, value });
    if (name === "get-settings") return clone(savedSettings);
    if (name === "set-ink-color" || name === "set-image-scale") {
      if (window.fixture.failSetting) throw new Error("Fixture write failure");
      savedSettings = { ...savedSettings, revision: savedSettings.revision + 1,
        ...(name === "set-ink-color" ? { inkColor: value.inkColor.toLowerCase() } : { imageScale: value.imageScale }) };
      for (const fn of notifications) fn({ pluginId: "drawing-pad", topic: "settings-changed", data: clone(savedSettings) });
      return clone(savedSettings);
    }
    if (name === "get-session-poses") {
      if (window.fixture.failLifecycle) throw new Error("Fixture lifecycle read failure");
      return { sessionId: value.sessionId, poses: acceptedPoseKeys(histories.get(value.sessionId) ?? []) };
    }
    throw new Error(`Unexpected operation ${name}`);
  },
  onNotification(fn) { notifications.add(fn); return () => notifications.delete(fn); },
  onAppEvent(fn) { events.add(fn); return () => events.delete(fn); },
  onResync(fn) { resyncs.add(fn); return () => resyncs.delete(fn); },
  app: { pathname: () => pathname },
  ui: {
    mountButton: handleButton,
    mountMarkdown(container, props, options) {
      markdownLog.push(props.text);
      const root = createRoot(container);
      let disposed = false;
      const render = () => { if (!disposed) {
        container.removeAttribute("aria-busy");
        root.render(React.createElement(InteractionLayersProvider, null, React.createElement(HostMarkdown, { text: props.text })));
      } };
      if (window.fixture.holdMarkdown) { container.setAttribute("aria-busy", "true"); heldMarkdown.push(render); }
      else render();
      const observer = new MutationObserver(() => {
        window.fixture.mathSeen ||= !!container.querySelector(".katex");
        window.fixture.diagramSeen ||= [...container.querySelectorAll("svg")].some(svg => svg.textContent.includes("ORANGE_NODE"));
      });
      observer.observe(container, { subtree: true, childList: true });
      const dispose = () => { if (!disposed) { disposed = true; observer.disconnect(); options.signal.removeEventListener("abort", dispose); root.unmount(); } };
      options.signal.addEventListener("abort", dispose, { once: true });
      return { update(next) { root.render(React.createElement(InteractionLayersProvider, null, React.createElement(HostMarkdown, { text: next.text }))); }, dispose };
    },
    openSurface(surfaceTarget, props, options) {
      if (surfaceTarget !== target) throw new Error("wrong opaque target");
      const section = document.createElement("section"); section.id = "pad";
      section.setAttribute("aria-label", props.title);
      const button = document.createElement("button"); button.id = "close-pad"; button.textContent = "×";
      section.append(button); document.body.append(section);
      let disposed = false, contentMount;
      const mountContent = () => {
        const owner = new AbortController(), host = document.createElement("div");
        host.style.height = "100%"; section.append(host);
        let cleaned = false, teardown;
        contentMount = { dispose() {
          if (cleaned) return; cleaned = true; owner.abort(); teardown?.(); host.remove();
        } };
        window.fixture.contentMounts++;
        // Match PluginContent: cleanup may arrive after this mount was already
        // aborted/replaced, because the public mount callback may be async.
        Promise.resolve(props.content(host, owner.signal)).then(result => {
          if (cleaned) result?.(); else teardown = result;
        }).catch(error => errors.push(String(error)));
      };
      const dispose = () => {
        if (disposed) return; disposed = true; contentMount?.dispose(); section.remove();
        options.signal.removeEventListener("abort", dispose); if (surface?.section === section) surface = undefined;
      };
      options.signal.addEventListener("abort", dispose, { once: true });
      button.onclick = () => { props.onClose?.(); dispose(); };
      surface = { section, dispose, close() { props.onClose?.(); dispose(); }, replay() { contentMount.dispose(); if (!disposed) mountContent(); } };
      mountContent();
      if (window.fixture.replayOnOpen) surface?.replay();
      // Match the public synchronous initial-focus marker contract in this fixture.
      section.querySelector("[data-plugin-initial-focus]")?.focus();
      return { update() {}, dispose };
    },
  },
};
function fullInput() {
  return { sessionId: currentSession, sessionKind: currentKind, surfaceTarget: target,
    channels: input.type === "answer" || input.type === "plugin-question-answer" ? ["answer", "thinking", "readingThinking"] :
      input.type === "plugin-problem-submission" ? ["submission", "thinking"] : ["content"], ...clone(input) };
}
function viewContext() {
  return { placement: "top-bar", surface: "session", sessionId: currentSession, kind: currentKind, surfaceTarget: target,
    view: { sessionId: currentSession, kind: currentKind, input: fullInput(), messages: clone(histories.get(currentSession) ?? []),
      title: "Fixture", transcript: [], status: "ready", reconciliation: "ready", busy: false, compacting: false, phase: currentKind === "practice" ? "practice" : "teach",
      contextTokens: null, queuedSteers: [], composer: { text: "" } } };
}
const empty = () => ({ text: "", images: [] });
function submissionFor() {
  if (input.type === "answer") return { type: "answer", answer: { text: "fixture answer", images: [] }, thinking: empty(), readingThinking: empty() };
  if (input.type === "thinking") return { type: "thinking", content: { text: "thinking", images: [] } };
  if (input.type === "plugin-question-answer") return { type: input.type, answer: false, answerImages: [], thinking: empty(), readingThinking: empty() };
  if (input.type === "plugin-problem-submission") return { type: input.type, submission: 0, submissionImages: [], thinking: empty() };
  return { type: "text", content: { text: "message", images: [] } };
}
window.fixture = {
  errors, calls, attempts, markdownLog, mathSeen: false, diagramSeen: false, holdMarkdown: false, placement: undefined, failSetting: false, failLifecycle: false,
  releaseMarkdown() { for (const render of heldMarkdown.splice(0)) render(); },
  fontFetchMode: "normal", pendingFontFetches: 0, abortedFontFetches: 0,
  async fontCssProbe() {
    const root = document.createElement("div"); root.className = "drawing-pad-reference"; root.textContent = "Font probe"; document.body.append(root);
    try { return await referenceFontCSS(root, new AbortController().signal); } finally { root.remove(); }
  },
  replayOnOpen: false, contentMounts: 0,
  replayContent() { surface?.replay(); },
  holdDecode: false,
  pendingDecodes() { return heldDecodes.length; },
  releaseDecodes() { for (const finish of heldDecodes.splice(0)) finish(); },
  async ready() { off = await activate(ctx); refresh(); },
  navigate(session, kind, nextInput = { type: "text" }) { surface?.dispose(); currentSession = session; currentKind = kind; input = clone(nextInput); pathname = `/opaque/${session}`; refresh(); },
  setInput(nextInput) { input = clone(nextInput); },
  setHistory(session, messages) { histories.set(session, clone(messages)); },
  event(type, session = currentSession) { for (const fn of events) fn({ type, chatId: session }); },
  notifySettings(value) { for (const fn of notifications) fn({ pluginId: "drawing-pad", topic: "settings-changed", data: value }); },
  resync() { for (const fn of resyncs) fn(); },
  pending() { return interceptor.hasPendingInput(fullInput()); },
  async submit({ accept = true, defer = false, cancel = false } = {}) {
    const callbacks = [], owner = new AbortController();
    const promise = interceptor.intercept(submissionFor(), { ...fullInput(), messages: clone(histories.get(currentSession) ?? []), signal: owner.signal,
      onAccepted(fn) { callbacks.push(fn); } });
    if (cancel) owner.abort(new DOMException("Fixture cancelled", "AbortError"));
    let result;
    try { result = await promise; } catch (error) { return { error: String(error) }; }
    result ??= submissionFor(); attempts.push(result);
    if (defer) holdExportAck.push(() => { for (const fn of callbacks) fn(); });
    else if (accept) for (const fn of callbacks) fn();
    refresh(); return result;
  },
  ack() { for (const fn of holdExportAck.splice(0)) fn(); refresh(); },
  showSettings,
  saved() { return clone(savedSettings); },
  dispose() { off?.(); for (const fn of cleanup.splice(0)) fn(); controller.abort(); },
};
topButton.onclick = () => { try { action.run(viewContext()); } catch (error) { errors.push(String(error)); } };
document.querySelector("#settings-open").onclick = showSettings;
for (const [index, selector] of [[0, "#ink"], [1, "#image-scale"]]) document.querySelector(selector).onblur = async event => {
  if (!settingsSchema) return;
  const value = index === 0 ? event.target.value : Number(event.target.value), row = settingsSchema.rows[index], error = row.validate?.(value);
  const message = document.querySelector("#setting-error");
  if (error) { message.textContent = error; return; }
  try { await row.onChange(value); message.textContent = ""; event.target.value = settingsSchema.rows[index].value; }
  catch (error) { message.textContent = String(error); }
};
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const settings = document.querySelector("#settings");
  if (!settings.hidden) { event.preventDefault(); settings.hidden = true; return; }
  if (surface) { event.preventDefault(); surface.close(); }
});
await window.fixture.ready();
window.fixtureReady = true;
