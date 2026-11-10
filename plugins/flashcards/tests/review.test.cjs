const assert = require('node:assert/strict');
const test = require('node:test');
const { parseHTML } = require('linkedom');
const { webcrypto } = require('node:crypto');
const flush = () => new Promise(resolve => setImmediate(resolve));
const hiddenTitle = title => { assert.equal(title.textContent, ''); assert.equal(title.hidden, true); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function setup({ delayedMount = false } = {}) {
  const { document, window } = parseHTML('<html><body></body></html>');
  global.document = document;
  if (!global.crypto) global.crypto = webcrypto;
  let focused = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => focused.isConnected ? focused : document.body });
  window.HTMLElement.prototype.focus = function () { focused = this; };
  const { createReviewController } = await import('../src/review.js');
  const view = new AbortController(), plugin = new AbortController();
  const calls = [], surfaces = [], handles = [], markdowns = [];
  const overrides = {};
  let refreshed = 0;
  const ctx = {
    signal: plugin.signal,
    async call(operation, input) {
      calls.push([operation, input]);
      if (overrides[operation]) return overrides[operation](input);
      if (operation === 'next-review') return { ticket: { id: 't1', propositionName: 'Fact', question: 'QUESTION **markdown**' }, remaining: 2 };
      if (operation === 'reveal-review') return { answer: 'SECRET ANSWER', intervals: { 1: 60000, 2: 300000, 3: 600000, 4: 86400000 } };
      if (operation === 'rate-review') return { ok: true };
      throw new Error(`Unexpected operation ${operation}`);
    },
    ui: {
      openSurface(props, { signal }) {
        assert.equal(arguments.length, 2, 'targetless public overload');
        assert.ok(['Flashcard review', 'Flashcard practice'].includes(props.title));
        assert.equal(props.background, 'dimmed');
        const frame = document.createElement('section'); frame.tabIndex = -1;
        const container = document.createElement('div'); frame.append(container); document.body.append(frame);
        let disposed = false;
        const mounts = [];
        const surface = {
          props, frame, container, signal, mounts,
          mount() {
            if (mounts.length && !mounts.at(-1).host.signal.aborted) return;
            const mount = { host: new AbortController(), cleanup: undefined };
            mounts.push(mount);
            if (disposed) mount.host.abort();
            mount.cleanup = props.content(container, mount.host.signal);
            if (disposed) mount.cleanup?.();
          },
          unmountContent() { const mount = mounts.at(-1); mount?.host.abort(); mount?.cleanup?.(); },
          update() {},
          dispose() {
            if (disposed) return;
            disposed = true;
            for (const mount of mounts) { mount.host.abort(); mount.cleanup?.(); }
            frame.remove();
          },
          close() { props.onClose?.(); this.dispose(); },
          get disposed() { return disposed; },
        };
        surfaces.push(surface);
        signal.addEventListener('abort', () => surface.dispose(), { once: true });
        if (!delayedMount) surface.mount();
        return surface;
      },
    },
  };
  function handle(kind, parent, text, signal, options) {
    const node = document.createElement(kind === 'button' ? 'button' : 'div');
    node.textContent = text; parent.append(node);
    let disposed = false;
    const item = { kind, node, signal, options, update(props) { if ('disabled' in props) node.disabled = props.disabled; }, dispose() { if (disposed) return; disposed = true; node.remove(); }, get disposed() { return disposed; } };
    handles.push(item); signal.addEventListener('abort', () => item.dispose(), { once: true });
    return item;
  }
  const controller = createReviewController({
    ctx, signal: view.signal,
    button(parent, label, action, signal, options = {}) {
      const item = handle('button', parent, label, signal, options);
      item.node.addEventListener('click', () => { if (!signal.aborted && !item.node.disabled) void action(); });
      return item;
    },
    markdown(parent, text, signal) { markdowns.push(text); return handle('markdown', parent, text, signal); },
    onRated() { refreshed++; },
  });
  return {
    document, window, controller, calls, surfaces, handles, markdowns, overrides, view, plugin,
    get refreshed() { return refreshed; },
    get surface() { return surfaces.at(-1); },
    get root() { return document.querySelector('.fc-review-surface'); },
    get card() { return document.querySelector('.fc-review-card'); },
    get title() { return document.querySelector('.fc-review-title'); },
    get stage() { return document.querySelector('.fc-review-stage'); },
    get footer() { return document.querySelector('.fc-review-footer'); },
    get bottom() { return document.querySelector('.fc-review-bottom'); },
    click(label) {
      const node = [...document.querySelectorAll('button')].find(node => node.textContent === label);
      assert.ok(node, `Missing button: ${label}`); assert.ok(!node.disabled, `Disabled: ${label}`); node.click();
    },
    key(target, key, extras = {}) {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, { key, code: key === ' ' ? 'Space' : `Digit${key}`, ...extras });
      target.dispatchEvent(event); return event;
    },
    dispose() { controller.dispose(); view.abort(); plugin.abort(); },
  };
}

test('same-handle content replay stays open; late old question and cleanup cannot erase the fresh mount', async () => {
  const h = await setup();
  try {
    const requests = [];
    h.overrides['next-review'] = () => { const request = deferred(); requests.push(request); return request.promise; };
    h.controller.open({ deckIds: ['d1'] });
    const surface = h.surface, oldRoot = h.root, oldTitle = h.title;
    const oldMount = surface.mounts[0];
    surface.unmountContent();
    assert.equal(surface.disposed, false, 'content teardown is not logical close');
    assert.equal(surface.signal.aborted, false);
    assert.equal(oldRoot.isConnected, false);
    surface.mount();
    const freshRoot = h.root;
    assert.ok(freshRoot && freshRoot !== oldRoot);
    assert.notEqual(h.title, oldTitle);
    hiddenTitle(h.title);
    assert.equal(h.card.hidden, true);
    assert.equal(h.card.textContent, '');
    assert.equal(surface.mounts[0].host.signal.aborted, true);
    assert.equal(surface.mounts[1].host.signal.aborted, false);
    assert.equal(requests.length, 2);
    requests[1].resolve({ ticket: { id: 'fresh', propositionName: 'Fresh proposition', question: 'FRESH QUESTION' } });
    await flush();
    requests[0].resolve({ ticket: { id: 'old', propositionName: 'Old proposition', question: 'STALE QUESTION' } });
    await flush(); oldMount.cleanup?.();
    assert.equal(h.root, freshRoot);
    hiddenTitle(h.title);
    assert.equal(h.root.textContent.includes('Fresh proposition'), false);
    assert.equal(h.card.textContent, 'FRESH QUESTION');
    assert.equal(h.markdowns.includes('STALE QUESTION'), false);
    assert.equal(h.surfaces.length, 1);
    assert.equal(h.calls.some(([op]) => op === 'rate-review'), false);
  } finally { h.dispose(); }
});

test('late old reveal after content replay cannot reveal or remove the fresh card', async () => {
  const h = await setup();
  try {
    h.controller.open({}); await flush();
    const reveal = deferred(); h.overrides['reveal-review'] = () => reveal.promise;
    h.click('Reveal answer');
    const surface = h.surface, oldMount = surface.mounts[0];
    surface.unmountContent(); surface.mount(); await flush();
    const freshRoot = h.root;
    assert.ok(freshRoot);
    reveal.resolve({ answer: 'STALE SECRET', intervals: {} }); await flush();
    oldMount.cleanup?.();
    assert.equal(h.root, freshRoot);
    assert.equal(h.markdowns.includes('STALE SECRET'), false);
    assert.equal(h.calls.some(([op]) => op === 'rate-review'), false);
    delete h.overrides['reveal-review'];
    h.key(h.stage, ' '); await flush();
    assert.equal(h.card.textContent.includes('SECRET ANSWER'), true, 'fresh mount retains local shortcuts');
  } finally { h.dispose(); }
});

test('aborted content invocation is inert and does not logically close an existing surface', async () => {
  const h = await setup();
  try {
    h.controller.open({}); await flush();
    const root = h.root, surface = h.surface, aborted = new AbortController(); aborted.abort();
    const stale = h.document.createElement('div');
    surface.props.content(stale, aborted.signal);
    assert.equal(stale.children.length, 0);
    assert.equal(surface.disposed, false);
    assert.equal(surface.signal.aborted, false);
    assert.equal(h.root, root);
    assert.equal(h.calls.filter(([op]) => op === 'next-review').length, 1);
  } finally { h.dispose(); }
});

for (const termination of ['host close', 'view abort', 'plugin abort']) test(`${termination} still tears down every replayed content scope`, async () => {
  const h = await setup();
  try {
    h.controller.open({}); await flush();
    const surface = h.surface;
    surface.unmountContent(); surface.mount(); await flush();
    assert.ok(h.root);
    assert.equal(surface.disposed, false);
    // Even an overlapping host presentation belongs to this same session.
    const extra = h.document.createElement('div'); h.document.body.append(extra);
    const extraHost = new AbortController(), extraCleanup = surface.props.content(extra, extraHost.signal);
    await flush(); assert.equal(extra.children.length, 1);
    if (termination === 'host close') surface.close();
    else if (termination === 'view abort') h.view.abort();
    else h.plugin.abort();
    assert.equal(surface.disposed, true);
    assert.equal(surface.signal.aborted, true);
    assert.ok(surface.mounts.every(mount => mount.host.signal.aborted));
    assert.ok(h.handles.every(handle => handle.disposed && handle.signal.aborted));
    assert.equal(extra.children.length, 0);
    extraCleanup?.();
    assert.equal(h.root, null);
    const calls = h.calls.length;
    surface.mount(); await flush();
    assert.equal(h.root, null);
    assert.equal(h.calls.length, calls, 'disposed surface callbacks cannot revive work');
  } finally { h.dispose(); }
});

test('content replay clears only its own waiting timer; final close clears the fresh timer', async () => {
  const h = await setup();
  const originalSet = global.setTimeout, originalClear = global.clearTimeout;
  const timers = new Map(); let id = 0;
  global.setTimeout = (fn, ms) => { const key = ++id; timers.set(key, { fn, ms }); return key; };
  global.clearTimeout = key => timers.delete(key);
  try {
    h.overrides['next-review'] = async () => ({ ticket: null, remaining: 0, nextDue: Date.now() + 60000 });
    h.controller.open({}); await flush();
    const surface = h.surface, old = surface.mounts[0];
    assert.equal(timers.size, 1);
    surface.unmountContent(); assert.equal(timers.size, 0);
    assert.equal(surface.signal.aborted, false);
    surface.mount(); await flush(); assert.equal(timers.size, 1);
    old.cleanup?.(); assert.equal(timers.size, 1, 'late old cleanup cannot clear a fresh timer');
    surface.close(); assert.equal(timers.size, 0);
  } finally { h.dispose(); global.setTimeout = originalSet; global.clearTimeout = originalClear; }
});

test('host surface opens synchronously; question and answer use scoped host Markdown', async () => {
  const h = await setup();
  try {
    h.controller.open({ deckIds: ['d1'] });
    assert.equal(h.surfaces.length, 1);
    assert.deepEqual(h.calls[0], ['next-review', { deckIds: ['d1'] }]);
    const title = h.title;
    assert.ok(title?.matches('h2'));
    hiddenTitle(title);
    assert.equal(title.parentElement, h.stage);
    assert.equal(h.stage.hidden, false);
    assert.equal(h.stage.tabIndex, -1);
    assert.equal(h.stage.getAttribute('role'), 'group');
    assert.equal(h.stage.getAttribute('aria-label'), 'Flashcard review');
    assert.equal(h.stage.getAttribute('data-plugin-initial-focus'), '');
    assert.equal(h.card.contains(title), false);
    assert.equal(h.card.hidden, true);
    assert.equal(h.card.textContent, '', 'loading status is outside the QA-only card');
    assert.ok(h.footer.textContent.includes('Loading next card…'));
    assert.equal(h.document.activeElement, h.document.body, 'plugin mount does not take focus');
    h.stage.focus(); // The host enters its visible marked target, not a heading.
    assert.equal(h.key(h.stage, ' ').defaultPrevented, true, 'local keys reach the marked stage while loading');
    assert.equal(h.calls.some(([operation]) => operation === 'reveal-review'), false);
    await flush();
    assert.equal(h.document.activeElement, h.stage, 'the pending RPC does not disturb host-owned entry focus');
    assert.equal(h.title, title);
    hiddenTitle(title);
    assert.equal(h.root.textContent.includes('Fact'), false, 'proposition name must not cue the answer');
    assert.deepEqual(h.markdowns, ['QUESTION **markdown**']);
    assert.equal(h.card.hidden, false);
    assert.equal(h.card.textContent, 'QUESTION **markdown**');
    assert.equal(h.card.children.length, 2, 'only question Markdown and answer area belong in the card');
    assert.equal(h.card.lastElementChild.className, 'fc-answer');
    const remaining = h.bottom.querySelector('.fc-review-remaining');
    assert.equal(remaining.textContent, '2 ready');
    assert.equal(h.card.contains(remaining), false);
    assert.equal(h.footer.contains(remaining), false);
    assert.equal(h.card.nextElementSibling, h.bottom);
    assert.equal(h.bottom.nextElementSibling, h.footer);
    assert.equal(h.root.classList.contains('fc-practice-surface'), false);
    const reveal = h.footer.querySelector('.fc-rating');
    assert.equal(reveal.querySelector('button').textContent, 'Reveal answer');
    assert.equal(reveal.querySelector('.fc-shortcut').textContent, 'Space');
    assert.equal(h.handles.find(item => item.node.textContent === 'Reveal answer').options.variant, 'outline');
    assert.equal(reveal.querySelector('button .fc-shortcut'), null);
    assert.equal(h.document.querySelector('header'), null);
    assert.equal(h.document.body.textContent.includes('End review'), false);
    h.click('Reveal answer'); await flush();
    assert.equal(title.textContent, 'Fact', 'proposition name is shown only after reveal');
    assert.equal(title.hidden, false);
    assert.equal(h.card.textContent, 'QUESTION **markdown**SECRET ANSWER');
    assert.deepEqual(h.markdowns, ['QUESTION **markdown**', 'SECRET ANSWER']);
    const ratings = h.handles.filter(item => item.kind === 'button' && /^(Again|Hard|Good|Easy) ·/.test(item.node.textContent));
    assert.deepEqual(ratings.map(item => item.node.textContent), ['Again · 1m', 'Hard · 5m', 'Good · 10m', 'Easy · 1d']);
    assert.ok(ratings.every(item => item.options.variant === 'custom'));
    for (const [index, item] of ratings.entries()) {
      const color = `var(--fc-rating-${['again', 'hard', 'good', 'easy'][index]})`;
      const tint = percent => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
      assert.deepEqual(item.options, { variant: 'custom', colors: {
        background: tint(12), text: color, border: tint(55),
        hover: { background: tint(20), border: tint(75) },
        active: { background: tint(28), border: color },
        focusVisible: { border: color, ring: tint(50) },
      } });
      assert.equal(Object.hasOwn(item.options.colors, 'disabled'), false, 'retain native disabled opacity');
    }
    assert.equal(new Set(ratings.map(item => item.options.colors.text)).size, 4);
    const controls = [...h.footer.querySelectorAll('.fc-rating')];
    assert.deepEqual(controls.map(control => control.querySelector('.fc-shortcut').textContent), ['1', '2', '3', '4']);
    assert.ok(controls.every(control => !control.querySelector('button .fc-shortcut')));
    assert.equal(h.footer.textContent.includes('Space'), false, 'scheduled ratings have no Space binding');
    assert.equal(h.card.querySelector('button,h2,.fc-shortcut,.fc-review-remaining,.fc-error'), null);
    assert.equal(h.handles.find(item => item.node.textContent === 'Reveal answer').disposed, true);
    const question = h.handles.find(item => item.kind === 'markdown');
    h.click('Good · 10m'); await flush();
    assert.equal(h.refreshed, 1);
    assert.equal(question.disposed, true);
    assert.equal(question.signal.aborted, true);
    assert.equal(h.card.textContent.includes('SECRET ANSWER'), false);
    assert.equal(h.title, title, 'heading survives card replacement');
    hiddenTitle(title);
    assert.equal(h.footer.textContent.includes('Space rates Good'), false);
    assert.equal(h.footer.querySelectorAll('.fc-rating').length, 1);
  } finally { h.dispose(); }
});

test('delayed content mount starts no work early and a stale mount cannot revive a closed surface', async () => {
  const h = await setup({ delayedMount: true });
  try {
    h.controller.open({});
    assert.equal(h.calls.length, 0);
    h.surface.mount(); await flush();
    assert.equal(h.calls.length, 1);
    h.controller.open({ propositionIds: ['p2'] });
    const stale = h.surface;
    stale.close(); stale.mount(); await flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.root, null);
    h.controller.open({}); h.surface.mount(); await flush();
    assert.equal(h.calls.length, 2);
  } finally { h.dispose(); }
});

test('reopen and host close suppress late question and reveal responses', async () => {
  const h = await setup();
  try {
    const next = deferred(); h.overrides['next-review'] = () => next.promise;
    h.controller.open({}); const old = h.surface;
    delete h.overrides['next-review']; h.controller.open({ deckIds: ['new'] }); await flush();
    assert.equal(old.disposed, true);
    next.resolve({ ticket: { id: 'late', question: 'LATE QUESTION' } }); await flush();
    assert.equal(h.markdowns.includes('LATE QUESTION'), false);
    const reveal = deferred(); h.overrides['reveal-review'] = () => reveal.promise;
    h.click('Reveal answer'); h.surface.close();
    reveal.resolve({ answer: 'LATE ANSWER', intervals: {} }); await flush();
    assert.equal(h.markdowns.includes('LATE ANSWER'), false);
    assert.equal(h.root, null);
  } finally { h.dispose(); }
});

test('failed ratings preserve diagnostics and stable per-rating transport retry identities', async () => {
  const h = await setup();
  try {
    h.controller.open({}); await flush(); h.click('Reveal answer'); await flush();
    h.overrides['rate-review'] = async () => { throw new Error('Save unavailable'); };
    h.click('Good · 10m'); await flush();
    assert.ok(h.footer.textContent.includes('Save unavailable'));
    assert.equal(h.card.textContent.includes('Save unavailable'), false);
    assert.equal(h.card.contains(h.footer.querySelector('button')), false);
    h.click('Hard · 5m'); await flush();
    h.click('Good · 10m'); await flush();
    const rates = h.calls.filter(([operation]) => operation === 'rate-review').map(([, input]) => input);
    assert.equal(rates[0].requestId, rates[2].requestId);
    assert.notEqual(rates[0].requestId, rates[1].requestId);
    assert.match(rates[0].requestId, /^[0-9a-f-]{36}$/);
    h.click('Retry next card'); await flush();
    assert.equal(h.card.textContent.includes('SECRET ANSWER'), false);
  } finally { h.dispose(); }
});

test('failed next-card and reveal requests retain explicit retry controls', async () => {
  const h = await setup();
  try {
    h.overrides['next-review'] = async () => { throw new Error('Offline'); };
    h.controller.open({}); await flush();
    assert.ok(h.footer.textContent.includes('Offline'));
    assert.equal(h.card.hidden, true);
    assert.equal(h.card.textContent, '');
    hiddenTitle(h.title);
    delete h.overrides['next-review']; h.click('Retry next card'); await flush();
    h.overrides['reveal-review'] = async () => { throw new Error('Card changed elsewhere'); };
    h.click('Reveal answer'); await flush();
    assert.ok(h.footer.textContent.includes('Card changed elsewhere'));
    assert.equal(h.card.textContent.includes('Card changed elsewhere'), false);
    assert.equal(h.root.textContent.includes('Fact'), false);
    assert.equal(h.markdowns.includes('SECRET ANSWER'), false);
    h.click('Retry next card'); await flush();
    assert.equal(h.footer.textContent.includes('Card changed elsewhere'), false);
  } finally { h.dispose(); }
});

test('accepted in-flight grade still refreshes after navigation without rendering another card', async () => {
  const h = await setup();
  try {
    h.controller.open({}); await flush(); h.click('Reveal answer'); await flush();
    const grade = deferred(); h.overrides['rate-review'] = () => grade.promise;
    h.click('Easy · 1d'); h.view.abort();
    grade.resolve({ ok: true }); await flush();
    assert.equal(h.refreshed, 1);
    assert.equal(h.calls.filter(([operation]) => operation === 'next-review').length, 1);
    assert.equal(h.root, null);
    h.controller.open({}); assert.equal(h.surfaces.length, 1);
  } finally { h.dispose(); }
});

test('keyboard ratings are root-local, ignore outside ancestors and filter interactive/modifier/IME events', async () => {
  const h = await setup();
  try {
    h.controller.open({}); await flush();
    const outside = h.document.createElement('aside'); h.document.body.append(outside);
    h.key(outside, ' '); h.key(h.root, ' ', { shiftKey: true }); h.key(h.root, ' ', { isComposing: true });
    assert.equal(h.calls.filter(([operation]) => operation === 'reveal-review').length, 0);
    h.key(h.surface.frame, ' '); h.key(h.surface.container, ' '); h.key(h.document.body, ' '); await flush();
    assert.equal(h.calls.filter(([operation]) => operation === 'reveal-review').length, 0, 'outside ancestor entry is ignored');
    h.stage.focus(); h.key(h.stage, ' '); await flush();
    assert.equal(h.calls.filter(([operation]) => operation === 'reveal-review').length, 1);
    for (const tag of ['input', 'textarea', 'select', 'button', 'a', 'div']) {
      const target = h.document.createElement(tag);
      if (tag === 'div') target.setAttribute('contenteditable', 'plaintext-only');
      h.root.append(target); h.key(target, '1');
    }
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }]) h.key(h.root, '1', extra);
    assert.equal(h.calls.filter(([operation]) => operation === 'rate-review').length, 0);
    h.key(h.root, '2'); await flush();
    assert.equal(h.calls.find(([operation]) => operation === 'rate-review')[1].rating, 2);
    h.key(h.root, ' '); await flush(); h.key(h.root, ' '); await flush();
    assert.equal(h.calls.filter(([operation]) => operation === 'rate-review').length, 1);
    assert.equal(h.calls.filter(([operation]) => operation === 'reveal-review').length, 2);
  } finally { h.dispose(); }
});

test('scheduled revealed Space suppresses root and focused rating-button activation, including repeat, but preserves Enter and clicks', async () => {
  const h = await setup();
  try {
    h.controller.open({}); await flush();
    h.key(h.stage, ' '); await flush();
    assert.equal(h.card.textContent, 'QUESTION **markdown**SECRET ANSWER');
    const ratingButtons = [...h.footer.querySelectorAll('button')];
    assert.equal(ratingButtons.length, 4);
    for (const target of [h.root, h.title, ...ratingButtons]) {
      target.focus();
      for (const repeat of [false, true]) {
        const event = h.key(target, ' ', { repeat });
        assert.equal(event.defaultPrevented, true, 'cancel native Space activation before the button/repeat filters');
        // linkedom has no native keyboard default actions; emulate the browser's
        // button default only when the plugin has not prevented it.
        if (target.tagName === 'BUTTON' && !event.defaultPrevented) target.click();
      }
    }
    const modifiers = [{}, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }];
    for (const target of ratingButtons) {
      target.focus();
      for (const modifier of modifiers) for (const repeat of [false, true]) {
        const event = h.key(target, ' ', { ...modifier, repeat });
        assert.equal(event.defaultPrevented, true, 'every rating suppresses modified and held Space');
        if (!event.defaultPrevented) target.click();
      }
    }
    await flush();
    assert.equal(h.calls.some(([operation]) => operation === 'rate-review'), false);
    const settings = h.document.createElement('input'); h.document.body.append(settings);
    assert.equal(h.key(settings, ' ').defaultPrevented, false);
    for (const modifier of modifiers.slice(1)) for (const repeat of [false, true]) {
      assert.equal(h.key(h.root, ' ', { ...modifier, repeat }).defaultPrevented, false);
      assert.equal(h.key(h.stage, ' ', { ...modifier, repeat }).defaultPrevented, false);
      assert.equal(h.key(settings, ' ', { ...modifier, repeat }).defaultPrevented, false);
    }
    for (const tag of ['input', 'textarea', 'select', 'a', 'div']) {
      const editor = h.document.createElement(tag);
      if (tag === 'div') editor.setAttribute('contenteditable', 'plaintext-only');
      h.footer.querySelector('.fc-rating').append(editor);
      for (const modifier of modifiers) for (const repeat of [false, true]) {
        assert.equal(h.key(editor, ' ', { ...modifier, repeat }).defaultPrevented, false, `leave ${tag} Space alone, even inside a rating wrapper`);
      }
    }
    for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal(h.key(ratingButtons[0], ' ', extra).defaultPrevented, false);
    }
    h.overrides['rate-review'] = async () => { throw new Error('Retryable save failure'); };
    const enter = h.key(ratingButtons[0], 'Enter');
    assert.equal(enter.defaultPrevented, false, 'native Enter activation remains eligible');
    if (!enter.defaultPrevented) ratingButtons[0].click();
    await flush();
    assert.equal(h.calls.filter(([operation]) => operation === 'rate-review').at(-1)[1].rating, 1);
    h.click('Easy · 1d'); await flush();
    assert.equal(h.calls.filter(([operation]) => operation === 'rate-review').at(-1)[1].rating, 4);
    h.key(h.root, '3'); await flush();
    assert.equal(h.calls.filter(([operation]) => operation === 'rate-review').at(-1)[1].rating, 3);
  } finally { h.dispose(); }
});

test('async results never steal focus from Settings, but replacing owned focused content preserves local focus', async () => {
  const h = await setup();
  try {
    const next = deferred(); h.overrides['next-review'] = () => next.promise;
    h.controller.open({});
    const settings = h.document.createElement('input'); h.document.body.append(settings); settings.focus();
    next.resolve({ ticket: { id: 't1', propositionName: 'Fact', question: 'Question' } }); await flush();
    assert.equal(h.document.activeElement, settings);
    const reveal = deferred(); h.overrides['reveal-review'] = () => reveal.promise;
    h.click('Reveal answer'); settings.focus();
    hiddenTitle(h.title);
    assert.equal(h.stage.getAttribute('data-plugin-initial-focus'), '');
    reveal.resolve({ answer: 'Answer', intervals: { 1: 60000, 2: 300000, 3: 600000, 4: 86400000 } }); await flush();
    assert.equal(h.document.activeElement, settings);
    delete h.overrides['next-review']; h.controller.open({}); await flush();
    delete h.overrides['reveal-review'];
    const revealButton = h.document.querySelector('button'); revealButton.focus(); h.click('Reveal answer'); await flush();
    assert.equal(h.document.activeElement, h.root);
  } finally { h.dispose(); }
});

test('actions move currently owned focus before disabling controls and never reclaim historical focus', async () => {
  const h = await setup();
  try {
    const intervals = { 1: 60000, 2: 300000, 3: 600000, 4: 86400000 };
    h.controller.open({}); await flush();
    const reveal = deferred(); h.overrides['reveal-review'] = () => reveal.promise;
    const revealHandle = h.handles.find(item => item.node.textContent === 'Reveal answer');
    const originalUpdate = revealHandle.update;
    revealHandle.update = props => {
      if (props.disabled) assert.equal(h.document.activeElement, h.root, 'focus moves before disabling');
      originalUpdate(props);
    };
    revealHandle.node.focus(); h.click('Reveal answer');
    assert.equal(h.document.activeElement, h.root, 'focus is preserved synchronously, before response');
    reveal.resolve({ answer: 'Answer', intervals }); await flush();
    assert.equal(h.document.activeElement, h.root);
    const grade = deferred(); h.overrides['rate-review'] = () => grade.promise;
    const gradeButton = [...h.document.querySelectorAll('button')].find(node => node.textContent === 'Good · 10m');
    gradeButton.focus(); h.click('Good · 10m');
    assert.equal(h.document.activeElement, h.root);
    grade.resolve({ ok: true }); await flush();
    assert.equal(h.document.activeElement, h.root);
    h.controller.open({}); await flush();
    const second = deferred(); h.overrides['reveal-review'] = () => second.promise;
    h.document.querySelector('button').focus(); h.click('Reveal answer');
    h.document.body.focus(); // Leaving owned focus must never be undone by a late result.
    second.resolve({ answer: 'Answer', intervals }); await flush();
    assert.equal(h.document.activeElement, h.document.body);
  } finally { h.dispose(); }
});

test('waiting review owns one timer only, clears on reopen/close/navigation and never polls when closed', async () => {
  const h = await setup();
  const realSet = global.setTimeout, realClear = global.clearTimeout;
  const timers = new Map(); let sequence = 0;
  global.setTimeout = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; };
  global.clearTimeout = id => timers.delete(id);
  try {
    h.overrides['next-review'] = async () => ({ ticket: null, nextDue: Date.now() + 60000 });
    h.controller.open({}); await flush(); assert.equal(timers.size, 1);
    assert.ok(h.footer.textContent.includes('Next due'));
    hiddenTitle(h.title);
    assert.equal(h.card.hidden, true);
    assert.equal(h.card.textContent, '');
    assert.equal(h.bottom.querySelector('.fc-review-remaining'), null);
    const staleTimer = [...timers.values()][0];
    h.controller.open({}); await flush(); assert.equal(timers.size, 1);
    h.surface.close(); assert.equal(timers.size, 0);
    const before = h.calls.length; staleTimer.callback(); await flush(); assert.equal(h.calls.length, before);
    h.controller.open({}); await flush(); assert.equal(timers.size, 1);
    h.view.abort(); assert.equal(timers.size, 0);
  } finally { global.setTimeout = realSet; global.clearTimeout = realClear; h.dispose(); }
});

const practiceCards = () => Object.freeze([
  Object.freeze({ propositionId: 'p1', cueId: 'c1', propositionName: 'Practice fact one', question: 'PRACTICE Q1', answer: 'PRACTICE A1' }),
  Object.freeze({ propositionId: 'p1', cueId: 'c2', propositionName: 'Practice fact one', question: 'PRACTICE Q2', answer: 'PRACTICE A2' }),
  Object.freeze({ propositionId: 'p2', cueId: 'c3', propositionName: 'Practice fact two', question: 'PRACTICE Q3', answer: 'PRACTICE A3' }),
]);

test('practice visits snapshot cues once in order, reveals before Next, counts other cues, and never calls RPCs or timers', async () => {
  const h = await setup();
  const cards = practiceCards(), snapshot = JSON.stringify(cards), originalSet = global.setTimeout;
  let timers = 0;
  global.setTimeout = (...args) => { timers++; return originalSet(...args); };
  try {
    h.controller.openPractice(cards);
    const title = h.title;
    assert.equal(h.surface.props.title, 'Flashcard practice');
    hiddenTitle(title);
    assert.equal(title.matches('h2'), true);
    assert.equal(h.stage.getAttribute('aria-label'), 'Flashcard practice');
    assert.equal(h.stage.getAttribute('role'), 'group');
    assert.equal(h.stage.getAttribute('data-plugin-initial-focus'), '');
    assert.equal(h.stage.tabIndex, -1);
    assert.equal(h.stage.hidden, false);
    assert.equal(h.document.activeElement, h.document.body, 'host owns surface entry focus');
    const note = h.root.querySelector('.fc-practice-note');
    assert.equal(note.textContent, 'Practice mode does not change your review schedule.');
    assert.equal(note.parentElement, h.root);
    assert.equal(h.stage.nextElementSibling, note);
    assert.equal(h.stage.contains(note), false);
    assert.equal(h.root.classList.contains('fc-practice-surface'), true);
    assert.equal(h.card.nextElementSibling, h.bottom);
    assert.equal(h.bottom.nextElementSibling, h.footer);
    for (let index = 0; index < cards.length; index++) {
      const cue = cards[index], questionHandle = h.handles.findLast(item => item.kind === 'markdown');
      assert.equal(h.title, title);
      hiddenTitle(title);
      assert.equal(h.card.textContent, cue.question);
      assert.equal(h.root.textContent.includes(cue.propositionName), false);
      assert.equal(h.markdowns.includes(cue.answer), false, 'snapshot answers are not mounted early');
      const remaining = cards.length - index - 1;
      assert.equal(h.bottom.querySelector('.fc-review-remaining').textContent, `${remaining} ${remaining === 1 ? 'card' : 'cards'} remaining`);
      assert.equal(h.bottom.children.length, 1);
      assert.equal(h.bottom.firstElementChild.className, 'fc-review-remaining');
      assert.equal(h.footer.querySelector('.fc-review-remaining'), null);
      assert.deepEqual([...h.footer.querySelectorAll('button')].map(node => node.textContent), ['Reveal answer']);
      assert.equal(h.footer.querySelector('.fc-shortcut').textContent, 'Space');
      assert.equal(h.handles.findLast(item => item.kind === 'button').options.variant, 'outline');
      assert.equal(h.card.querySelector('button,h2,.fc-shortcut,.fc-review-remaining,.fc-error'), null);
      h.click('Reveal answer');
      assert.equal(title.textContent, cue.propositionName);
      assert.equal(title.hidden, false);
      assert.equal(h.card.textContent, cue.question + cue.answer);
      assert.deepEqual([...h.footer.querySelectorAll('button')].map(node => node.textContent), ['Next']);
      assert.equal(h.footer.querySelector('.fc-rating .fc-shortcut').textContent, 'Space');
      assert.equal(h.handles.findLast(item => item.kind === 'button').options.variant, 'outline');
      assert.equal(h.root.textContent.includes('Space rates Good'), false);
      assert.equal(h.root.querySelector('.fc-practice-note'), note);
      h.click('Next');
      assert.equal(questionHandle.disposed, true);
      assert.equal(questionHandle.signal.aborted, true);
    }
    assert.deepEqual(h.markdowns, cards.flatMap(cue => [cue.question, cue.answer]));
    assert.equal(h.title, title);
    hiddenTitle(title);
    assert.equal(h.card.hidden, true);
    assert.equal(h.card.textContent, '');
    assert.equal(h.footer.textContent, 'Practice complete.');
    assert.equal(h.bottom.querySelector('.fc-review-remaining'), null);
    assert.equal(h.bottom.children.length, 0);
    assert.equal(h.root.querySelector('.fc-practice-note'), note);
    assert.equal(h.stage.nextElementSibling, note);
    assert.equal(note.parentElement, h.root);
    assert.deepEqual(h.calls, []);
    assert.equal(h.refreshed, 0);
    assert.equal(timers, 0);
    assert.equal(JSON.stringify(cards), snapshot, 'practice must not mutate the supplied snapshot');
  } finally { global.setTimeout = originalSet; h.dispose(); }
});

test('empty practice completes locally with a marked visible stage and no heading, widgets or work', async () => {
  const h = await setup();
  try {
    h.controller.openPractice(Object.freeze([]));
    hiddenTitle(h.title);
    assert.equal(h.stage.hasAttribute('data-plugin-initial-focus'), true);
    assert.equal(h.root.querySelector('.fc-practice-note').textContent, 'Practice mode does not change your review schedule.');
    assert.equal(h.stage.nextElementSibling, h.root.querySelector('.fc-practice-note'));
    assert.equal(h.bottom.children.length, 0);
    assert.equal(h.card.hidden, true);
    assert.equal(h.card.textContent, '');
    assert.equal(h.footer.textContent, 'Practice complete.');
    assert.equal(h.handles.length, 0);
    h.stage.focus(); h.key(h.stage, ' ');
    assert.equal(h.footer.textContent, 'Practice complete.');
    assert.deepEqual(h.calls, []);
    assert.equal(h.refreshed, 0);
  } finally { h.dispose(); }
});

test('practice Space reveals or advances, never rates; numeric and outside shortcuts are ignored', async () => {
  const h = await setup();
  try {
    h.controller.openPractice(practiceCards());
    h.stage.focus();
    for (const key of ['1', '2', '3', '4']) assert.equal(h.key(h.stage, key).defaultPrevented, false);
    h.key(h.surface.frame, ' '); h.key(h.document.body, ' ');
    h.key(h.stage, ' ', { isComposing: true }); h.key(h.stage, ' ', { repeat: true });
    h.key(h.stage, ' ', { ctrlKey: true });
    assert.equal(h.card.textContent, 'PRACTICE Q1');
    assert.equal(h.key(h.stage, ' ').defaultPrevented, true);
    assert.equal(h.card.textContent, 'PRACTICE Q1PRACTICE A1');
    for (const key of ['1', '2', '3', '4']) assert.equal(h.key(h.root, key).defaultPrevented, false);
    const next = h.footer.querySelector('button');
    assert.equal(h.key(next, ' ').defaultPrevented, false, 'button keeps native key semantics');
    assert.equal(h.card.textContent, 'PRACTICE Q1PRACTICE A1');
    h.key(h.root, ' ');
    assert.equal(h.card.textContent, 'PRACTICE Q2');
    hiddenTitle(h.title);
    assert.equal(h.bottom.querySelector('.fc-review-remaining').textContent, '1 card remaining');
    assert.deepEqual(h.calls, []);
    assert.equal(h.refreshed, 0);
  } finally { h.dispose(); }
});

test('practice replay preserves logical progress, hides the current answer again, and ignores stale controls', async () => {
  const h = await setup();
  try {
    h.controller.openPractice(practiceCards()); h.click('Reveal answer');
    const firstNext = h.footer.querySelector('button'), surface = h.surface, firstMount = surface.mounts[0];
    surface.unmountContent(); surface.mount();
    assert.equal(h.card.textContent, 'PRACTICE Q1', 'unadvanced cue remains current after replay');
    hiddenTitle(h.title);
    firstNext.click(); firstMount.cleanup?.();
    assert.equal(h.card.textContent, 'PRACTICE Q1');
    h.click('Reveal answer'); h.click('Next');
    const oldMount = surface.mounts.at(-1), oldRoot = h.root, oldTitle = h.title;
    surface.unmountContent();
    assert.equal(surface.disposed, false);
    assert.equal(surface.signal.aborted, false);
    assert.equal(oldRoot.isConnected, false);
    surface.mount();
    const freshRoot = h.root;
    assert.notEqual(freshRoot, oldRoot);
    assert.notEqual(h.title, oldTitle);
    assert.equal(h.card.textContent, 'PRACTICE Q2', 'consumed cue must not return after replay');
    hiddenTitle(h.title);
    assert.equal(h.bottom.querySelector('.fc-review-remaining').textContent, '1 card remaining');
    assert.equal(h.root.querySelector('.fc-practice-note').textContent, 'Practice mode does not change your review schedule.');
    assert.equal(h.stage.contains(h.root.querySelector('.fc-practice-note')), false);
    assert.equal(h.stage.nextElementSibling, h.root.querySelector('.fc-practice-note'));
    oldMount.cleanup?.(); firstNext.click(); h.key(oldRoot, ' ');
    assert.equal(h.root, freshRoot);
    assert.equal(h.card.textContent, 'PRACTICE Q2');
    assert.equal(surface.disposed, false);
    h.key(h.stage, ' ');
    assert.equal(h.card.textContent, 'PRACTICE Q2PRACTICE A2');
    const aborted = new AbortController(); aborted.abort();
    const container = h.document.createElement('div');
    surface.props.content(container, aborted.signal);
    assert.equal(container.children.length, 0);
    assert.equal(h.root, freshRoot);
    assert.deepEqual(h.calls, []);
  } finally { h.dispose(); }
});

test('overlapping practice presentations cannot reveal consumed cues or advance an already consumed index', async () => {
  const h = await setup();
  try {
    h.controller.openPractice(practiceCards());
    const surface = h.surface, extra = h.document.createElement('div'); h.document.body.append(extra);
    const firstHost = new AbortController(), firstCleanup = surface.props.content(extra, firstHost.signal);
    extra.querySelector('button').click(); // Both presentations reveal cue 1.
    h.click('Reveal answer'); h.click('Next');
    assert.equal(h.card.textContent, 'PRACTICE Q2');
    extra.querySelector('button').click(); // Stale Next from cue 1 must not skip cue 2.
    firstCleanup?.(); surface.unmountContent(); surface.mount();
    assert.equal(h.card.textContent, 'PRACTICE Q2');
    const secondHost = new AbortController(), secondCleanup = surface.props.content(extra, secondHost.signal);
    h.click('Reveal answer'); h.click('Next');
    assert.equal(h.card.textContent, 'PRACTICE Q3');
    extra.querySelector('button').click(); // Unrevealed stale cue 2 must stay unrevealed.
    assert.equal(extra.querySelector('.fc-answer').textContent, '');
    hiddenTitle(extra.querySelector('.fc-review-title'));
    secondCleanup?.(); firstCleanup?.(); surface.unmountContent(); surface.mount();
    assert.equal(h.card.textContent, 'PRACTICE Q3');
    assert.deepEqual(h.calls, []);
  } finally { h.dispose(); }
});

test('completed practice stays complete on replay; an explicit new practice session resets the snapshot queue', async () => {
  const h = await setup();
  try {
    const cards = practiceCards(); h.controller.openPractice(cards);
    for (const cue of cards) {
      assert.equal(h.card.textContent, cue.question);
      h.click('Reveal answer'); h.click('Next');
    }
    const surface = h.surface;
    surface.unmountContent(); surface.mount();
    assert.equal(h.footer.textContent, 'Practice complete.');
    assert.equal(h.stage.nextElementSibling?.textContent, 'Practice mode does not change your review schedule.');
    assert.equal(h.stage.nextElementSibling?.parentElement, h.root);
    assert.equal(h.bottom.children.length, 0);
    assert.equal(h.card.hidden, true);
    assert.equal(h.card.textContent, '');
    h.controller.openPractice(cards);
    assert.equal(surface.disposed, true);
    assert.equal(h.card.textContent, 'PRACTICE Q1');
    hiddenTitle(h.title);
    assert.equal(h.bottom.querySelector('.fc-review-remaining').textContent, '2 cards remaining');
    assert.deepEqual(h.calls, []);
  } finally { h.dispose(); }
});

for (const termination of ['host close', 'view abort', 'plugin abort']) test(`practice ${termination} disposes every replayed scope and prevents revival`, async () => {
  const h = await setup();
  try {
    h.controller.openPractice(practiceCards()); h.click('Reveal answer');
    const surface = h.surface;
    surface.unmountContent(); surface.mount();
    const extra = h.document.createElement('div'); h.document.body.append(extra);
    const host = new AbortController(), cleanup = surface.props.content(extra, host.signal);
    assert.equal(extra.children.length, 1);
    if (termination === 'host close') surface.close();
    else if (termination === 'view abort') h.view.abort();
    else h.plugin.abort();
    assert.equal(surface.disposed, true);
    assert.equal(surface.signal.aborted, true);
    assert.equal(h.root, null);
    assert.equal(extra.children.length, 0);
    assert.ok(h.handles.every(item => item.disposed && item.signal.aborted));
    cleanup?.(); surface.mount();
    assert.equal(h.root, null);
    assert.deepEqual(h.calls, []);
    assert.equal(h.refreshed, 0);
  } finally { h.dispose(); }
});

test('practice and scheduled review share one active surface and suppress responses from the replaced mode', async () => {
  const h = await setup();
  try {
    const late = deferred(); h.overrides['next-review'] = () => late.promise;
    h.controller.open({});
    const review = h.surface;
    h.controller.openPractice(practiceCards());
    const practice = h.surface;
    assert.equal(review.disposed, true);
    assert.equal(h.root.querySelectorAll('.fc-practice-note').length, 1);
    late.resolve({ ticket: { id: 'late', propositionName: 'Stale name', question: 'STALE SCHEDULED QUESTION' } });
    await flush();
    assert.equal(h.markdowns.includes('STALE SCHEDULED QUESTION'), false);
    assert.equal(h.card.textContent, 'PRACTICE Q1');
    delete h.overrides['next-review']; h.controller.open({}); await flush();
    assert.equal(practice.disposed, true);
    assert.equal(h.surface.props.title, 'Flashcard review');
    hiddenTitle(h.title);
    assert.equal(h.card.textContent, 'QUESTION **markdown**');
    assert.equal(h.root.querySelector('.fc-practice-note'), null);
    assert.equal(h.calls.filter(([operation]) => operation === 'next-review').length, 2);
    assert.equal(h.calls.some(([operation]) => operation !== 'next-review'), false);
    assert.equal(h.refreshed, 0);
  } finally { h.dispose(); }
});

test('delayed practice mounts do no early work and cannot revive a closed session', async () => {
  const h = await setup({ delayedMount: true });
  try {
    h.controller.openPractice(practiceCards());
    assert.equal(h.root, null);
    assert.equal(h.handles.length, 0);
    h.surface.close(); h.surface.mount();
    assert.equal(h.root, null);
    h.controller.openPractice(practiceCards()); h.surface.mount();
    hiddenTitle(h.title);
    assert.equal(h.card.textContent, 'PRACTICE Q1');
    assert.equal(h.document.activeElement, h.document.body);
    assert.deepEqual(h.calls, []);
  } finally { h.dispose(); }
});

test('practice preserves currently owned focus without stealing focus from Settings', async () => {
  const h = await setup();
  try {
    h.controller.openPractice(practiceCards());
    h.footer.querySelector('button').focus(); h.click('Reveal answer');
    assert.equal(h.document.activeElement, h.root);
    const title = h.title;
    h.footer.querySelector('button').focus(); h.click('Next');
    assert.equal(h.document.activeElement, h.root);
    assert.equal(h.title, title);
    const settings = h.document.createElement('input'); h.document.body.append(settings); settings.focus();
    h.click('Reveal answer'); assert.equal(h.document.activeElement, settings);
    h.click('Next'); assert.equal(h.document.activeElement, settings);
    assert.equal(h.title, title);
    assert.deepEqual(h.calls, []);
  } finally { h.dispose(); }
});
