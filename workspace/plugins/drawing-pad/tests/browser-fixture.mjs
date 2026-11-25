import React from "react";
import { createRoot } from "react-dom/client";
import { KeyboardSection } from "../../../components/settings/keyboard-section.tsx";
import { HostMarkdown } from "../../../components/host-markdown.tsx";
import { InteractionLayersProvider, createInteractionLayers } from "../../../components/interaction-layers.tsx";
import { PluginFrontendManager } from "../../../components/plugin-manager.ts";
import { dispatchPluginActionShortcut } from "../../../components/plugin-shortcuts.tsx";
import { registerSurfaceBoundary } from "../../../components/plugin-surface-targets.ts";
import { createPluginSessionActionContext, saveOverrides, loadOverrides, eventBinding } from "../../../src/core/index.ts";
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
let savedSettings = { revision: 0, darkInkColor: "#ffffff", lightInkColor: "#000000", imageScale: 50 }, pathname = "/opaque/teach", holdExportAck = [];
const palettes = {
  dark: { background: "#141414", foreground: "#e6e6e6", card: "#1c1c1c", border: "#434343", "muted-foreground": "#8d8d8d", accent: "#2a2a2a" },
  light: { background: "#eff1f5", foreground: "#4c4f69", card: "#e6e9ef", border: "#ccd0da", "muted-foreground": "#6c6f85", accent: "#dce0e8" },
};
function setTheme(mode, colors = {}) {
  if (!(mode in palettes)) throw new Error(`Unknown fixture theme ${mode}`);
  const html = document.documentElement, palette = { "lh-accent": "#8d8d8d", "lh-error": "#ef4444", "lh-success": "#22c55e", "lh-warning": "#f59e0b", ...palettes[mode], ...colors };
  html.classList.remove("dark", "light"); html.classList.add(mode);
  for (const [key, value] of Object.entries(palette)) html.style.setProperty(`--${key}`, value);
  for (const key of ["card-foreground", "popover-foreground", "primary", "secondary-foreground", "accent-foreground", "lh-line-strong", "lh-ink-strong", "lh-ink-italic", "lh-ink-code"]) html.style.setProperty(`--${key}`, palette.foreground);
  for (const key of ["popover", "secondary", "muted"]) html.style.setProperty(`--${key}`, palette.card);
  html.style.setProperty("--primary-foreground", palette.background);
  html.style.setProperty("--input", palette.border);
  html.style.setProperty("--ring", palette["muted-foreground"]);
}
setTheme("dark");
const histories = new Map(), attempts = [], markdownLog = [], errors = [], calls = [], heldMarkdown = [], heldDecodes = [], heldPoseReads = [];
const nativeDecode = HTMLImageElement.prototype.decode;
HTMLImageElement.prototype.decode = function () {
  const decode = nativeDecode.call(this);
  return window.fixture?.holdDecode ? decode.then(() => new Promise(resolve => heldDecodes.push(resolve))) : decode;
};
const topButton = document.querySelector("#draw");
const clone = value => structuredClone(value);
const layers = createInteractionLayers();
const region = document.createElement("div"), mounts = document.createElement("div");
region.setAttribute("data-session-surface-region", ""); mounts.setAttribute("data-session-surface-mounts", "");
region.append(mounts); document.body.append(region);
const target = registerSurfaceBoundary(document.body, controller.signal, layers).target;
let manager, shortcutPageOff, settingsLayerOff, blockerOff, keyboardOff;
const bindPage = () => { shortcutPageOff?.(); shortcutPageOff = manager.registerShortcutPage(pathname, () => viewContext()); };
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
  const panel = document.querySelector("#settings"), field = document.querySelector("#dark-ink");
  if (panel.hidden) settingsLayerOff = layers.register({ id: "settings", kind: "modal", rootRef: { current: panel } });
  panel.hidden = false;
  for (const [index, selector] of [[0, "#dark-ink"], [1, "#light-ink"], [2, "#image-scale"]]) document.querySelector(selector).value = settingsSchema.rows[index].value;
  field.focus();
}
function updateSettings(schema) {
  settingsSchema = schema;
  for (const [index, selector] of [[0, "#dark-ink"], [1, "#light-ink"], [2, "#image-scale"]]) {
    const field = document.querySelector(selector);
    if (document.activeElement !== field) field.value = schema.rows[index].value;
  }
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
      let change;
      if (name === "set-ink-color") {
        const keys = Object.keys(value ?? {}), key = keys[0];
        if (keys.length !== 1 || !["darkInkColor", "lightInkColor"].includes(key) || !/^#[0-9a-f]{6}$/i.test(value[key])) throw new Error("Expected exactly one theme ink color");
        change = { [key]: value[key].toLowerCase() };
      } else change = { imageScale: value.imageScale };
      savedSettings = { ...savedSettings, ...change, revision: savedSettings.revision + 1 };
      for (const fn of notifications) fn({ pluginId: "drawing-pad", topic: "settings-changed", data: clone(savedSettings) });
      return clone(savedSettings);
    }
    if (name === "get-session-poses") {
      if (window.fixture.failLifecycle) throw new Error("Fixture lifecycle read failure");
      const response = { sessionId: value.sessionId, poses: acceptedPoseKeys(histories.get(value.sessionId) ?? []) };
      if (window.fixture.holdPoseReads) return new Promise(resolve => heldPoseReads.push(() => resolve(response)));
      return response;
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
      section.setAttribute("data-plugin-shortcut-owner", "drawing-pad");
      section.append(button); mounts.append(section);
      const removeLayer = layers.register({ id: "drawing-pad-surface", kind: "view", rootRef: { current: section } });
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
        if (disposed) return; disposed = true; contentMount?.dispose(); removeLayer(); section.remove();
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
  return createPluginSessionActionContext({ placement: "top-bar", surface: "session", sessionId: currentSession, kind: currentKind, surfaceTarget: target },
    () => ({ sessionId: currentSession, kind: currentKind, input: fullInput(), messages: clone(histories.get(currentSession) ?? []),
      title: "Fixture", transcript: [], status: "ready", reconciliation: "ready", busy: false, compacting: false, phase: currentKind === "practice" ? "practice" : "teach",
      contextTokens: null, queuedSteers: [], composer: { text: "" } }));
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
  pendingMarkdown() { return heldMarkdown.length; },
  holdPoseReads: false,
  pendingPoseReads() { return heldPoseReads.length; },
  releasePoseReads() { window.fixture.holdPoseReads = false; for (const resolve of heldPoseReads.splice(0)) resolve(); },
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
  async ready() {
    const info = { id: "drawing-pad", enabled: true, status: "active", revision: "fixture", manifest: { apiVersion: 1, id: "drawing-pad", name: "Drawing Pad", version: "0.1.0", minAppVersion: "0.4.1", main: "main.js" } };
    manager = new PluginFrontendManager({ pathname: () => pathname, navigate() {},
      fetch: async () => Response.json({ plugins: [info], directory: "/disposable-fixture" }),
      importModule: async () => ({ async activate(actual) {
        off = await activate({ ...ctx, registerAction: actual.registerAction,
          refreshActions() { actual.refreshActions(); refresh(); } });
        return off;
      } }),
    });
    manager.subscribe(() => {
      const plugin = manager.getSnapshot().plugins.find(plugin => plugin.info.id === "drawing-pad");
      action = plugin?.actions.find(action => action.id === "draw");
      if (plugin?.error && !errors.includes(plugin.error)) errors.push(plugin.error);
      refresh();
    });
    bindPage();
    await new Promise((resolve, reject) => {
      const stop = manager.subscribe(() => {
        const plugin = manager.getSnapshot().plugins.find(plugin => plugin.info.id === "drawing-pad");
        if (plugin?.phase === "active") { stop(); resolve(); }
        else if (plugin?.phase === "error") { stop(); reject(new Error(plugin.error)); }
      });
      manager.start();
    });
  },
  navigate(session, kind, nextInput = { type: "text" }) { surface?.dispose(); currentSession = session; currentKind = kind; input = clone(nextInput); pathname = `/opaque/${session}`; bindPage(); refresh(); },
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
  showSettings, setTheme,
  saved() { return clone(savedSettings); },
  actionManager() { return manager; },
  showKeyboard() {
    keyboardOff?.(); const panel = document.createElement("section"); panel.id = "keyboard-panel"; panel.setAttribute("role", "dialog");
    panel.style.cssText = "position:fixed;inset:60px 30px 30px 260px;overflow:auto;background:var(--card);color:var(--foreground);padding:24px;z-index:100";
    document.body.append(panel); const root = createRoot(panel);
    const unregister = layers.register({ id: "fixture-keyboard", kind: "modal", rootRef: { current: panel } });
    root.render(React.createElement(KeyboardSection));
    keyboardOff = () => { root.unmount(); unregister(); panel.remove(); keyboardOff = undefined; };
  },
  hideKeyboard() { keyboardOff?.(); },
  actions() { return manager.getSnapshot().plugins.flatMap(plugin => plugin.actions.map(action => ({ id: action.id, shortcut: action.shortcut }))); },
  rebind(actionId, binding) { saveOverrides({ ...loadOverrides(), [`plugin:drawing-pad:${actionId}`]: binding }); },
  resetBindings() { saveOverrides({}); },
  blockShortcut(kind) {
    blockerOff?.(); const root = document.createElement("div"); root.textContent = "Fixture foreground blocker";
    root.style.cssText = "position:fixed;top:100px;left:400px;width:250px;height:80px;background:var(--card);color:var(--foreground);z-index:100";
    root.setAttribute("data-plugin-shortcut-owner", "foreign-plugin"); mounts.append(root);
    const unregister = layers.register({ id: "fixture-blocker", kind, rootRef: { current: root } });
    blockerOff = () => { unregister(); root.remove(); blockerOff = undefined; };
  },
  unblockShortcut() { blockerOff?.(); },
  keyEvents: [],
  dispose() { off?.(); for (const fn of cleanup.splice(0)) fn(); shortcutPageOff?.(); blockerOff?.(); keyboardOff?.(); controller.abort(); return manager.dispose(); },
};
topButton.onclick = () => { void manager.runAction("drawing-pad", action, () => viewContext()); };
window.addEventListener("keydown", event => { layers.getEventOwner(event); }, { capture: true, signal: controller.signal });
window.addEventListener("keydown", event => {
  const invoked = dispatchPluginActionShortcut(event, manager, layers);
  window.fixture.keyEvents.push({ binding: eventBinding(event), invoked, prevented: event.defaultPrevented });
}, { signal: controller.signal });
document.querySelector("#settings-open").onclick = showSettings;
for (const [index, selector] of [[0, "#dark-ink"], [1, "#light-ink"], [2, "#image-scale"]]) document.querySelector(selector).onblur = async event => {
  if (!settingsSchema) return;
  const value = index === 2 ? Number(event.target.value) : event.target.value, row = settingsSchema.rows[index], error = row.validate?.(value);
  const message = document.querySelector("#setting-error");
  if (error) { message.textContent = error; return; }
  try { await row.onChange(value); message.textContent = ""; event.target.value = settingsSchema.rows[index].value; }
  catch (error) { message.textContent = String(error); }
};
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const settings = document.querySelector("#settings");
  if (!settings.hidden) { event.preventDefault(); settings.hidden = true; settingsLayerOff?.(); settingsLayerOff = undefined; return; }
  if (surface) { event.preventDefault(); surface.close(); }
});
await window.fixture.ready();
window.fixtureReady = true;
