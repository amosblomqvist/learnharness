// SCRATCH DIAGNOSTIC ENTRY ONLY. Never ship/import from the product.
// Observe the unchanged --browser-service entry. No window show/focus, frame
// subscription, GPU switch, throttling change, or preload/renderer privilege.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
assert.equal(process.versions.electron, '44.9.3');
assert.ok(process.argv.includes('--browser-service'));
assert.ok(process.connected && process.send, 'requires owned parent IPC');
const home = fs.realpathSync(process.env.SVG_DIAG_HOME);
const source = fs.realpathSync(process.env.SVG_DIAG_SOURCE_MAIN);
const nonce = process.env.SVG_DIAG_NONCE;
assert.ok(nonce && /^[a-f0-9]{32}$/.test(nonce));
const started = performance.now();
let window, captureUsed = false, eventCount = 0;
function emit(event, data = {}) {
  if (++eventCount > 120) return;
  fs.appendFileSync(path.join(home, 'native-window.ndjson'), JSON.stringify({ event, ms: Math.round(performance.now() - started), ...data }) + '\n');
}
function state() {
  assert.ok(window && !window.isDestroyed(), 'owned helper window missing');
  const contents = window.webContents;
  const gpu = app.getGPUFeatureStatus();
  return {
    isVisible: window.isVisible(), isMinimized: window.isMinimized(),
    bounds: window.getBounds(), contentBounds: window.getContentBounds(),
    backgroundThrottling: contents.backgroundThrottling,
    loading: contents.isLoading(), destroyed: contents.isDestroyed(),
    gpu: Object.fromEntries(['gpu_compositing', 'rasterization', 'opengl'].filter(k => typeof gpu[k] === 'string').map(k => [k, gpu[k]])),
  };
}
async function documentState() {
  assert.ok(window && !window.isDestroyed());
  return window.webContents.executeJavaScript(`(() => {
    const svg = document.querySelector('svg[data-native-probe]');
    return { matches: !!svg && svg.getAttribute('data-native-probe') === ${JSON.stringify(nonce)},
      origin: location.origin, ready: document.readyState, width: innerWidth, height: innerHeight };
  })()`, false);
}
function reply(id, result, error) {
  if (!process.connected) return;
  try { process.send({ namespace: 'svg-native-readback', id, ...(error ? { error: String(error) } : { result }) }, () => {}); } catch {}
}
// Attach BEFORE requiring the real helper. These callbacks only record event
// names/times, not window getters or GPU queries before the original failure.
app.on('browser-window-created', (_event, owned) => {
  assert.ok(!window, 'diagnostic expects exactly one helper window');
  window = owned;
  emit('browser-window-created');
  for (const event of ['ready-to-show', 'show', 'hide', 'resize', 'minimize', 'restore', 'closed']) {
    owned.on(event, () => emit('window:' + event));
  }
  for (const event of ['dom-ready', 'did-finish-load', 'destroyed']) {
    owned.webContents.on(event, () => emit('contents:' + event));
  }
  owned.webContents.on('render-process-gone', (_event, details) => emit('render-process-gone', { reason: details.reason, exitCode: details.exitCode }));
});
process.on('message', async message => {
  if (!message || message.namespace !== 'svg-native-readback' || typeof message.id !== 'string') return;
  if (!['state', 'capture'].includes(message.command)) return;
  try {
    const before = state(), document = await documentState();
    assert.equal(before.isVisible, false, 'never capture a shown window');
    assert.equal(document.matches, true, 'not the owned synthetic SVG');
    assert.equal(document.origin, 'null', 'expected isolated memory document');
    if (message.command === 'state') {
      emit('state', { before, document });
      reply(message.id, { before, document });
      return;
    }
    assert.equal(captureUsed, false, 'at most one native capture');
    captureUsed = true;
    emit('native-capture-start', { before, document, stayHidden: true, stayAwake: false });
    // This is an explicitly ACTIVE readback probe, not a passive frame observer.
    const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: false });
    const result = { before, after: state(), empty: image.isEmpty(), size: image.getSize() };
    assert.equal(result.after.isVisible, false, 'native probe unexpectedly showed window');
    if (!result.empty) {
      const png = image.toPNG();
      const file = path.join(home, 'native-capture.png');
      fs.writeFileSync(file, png);
      Object.assign(result, { bytes: png.length, pngWidth: png.readUInt32BE(16), pngHeight: png.readUInt32BE(20), file });
    }
    emit('native-capture-result', result);
    reply(message.id, result);
  } catch (error) {
    emit('ipc-error', { command: message.command, error: String(error) });
    reply(message.id, null, error);
  }
});
emit('observer-registered', { electron: process.versions.electron });
require(source); // exact existing electron/main.cjs; its IPC-disconnect cleanup owns lifetime
