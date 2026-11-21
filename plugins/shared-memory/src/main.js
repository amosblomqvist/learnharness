const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const message = error => (error instanceof Error ? error.message : String(error));
const shareIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg>';
// Display names for the backend's states. The backend decides the state; an unknown one is shown as given.
const stateLabels = { unsent: 'Unsent', changed: 'Changed', removed: 'Removed from graph' };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function activate(ctx) {
  if (typeof ctx.ui?.mountButton !== 'function') {
    throw new Error('Shared Memory requires a newer LearnHarness host with ctx.ui.mountButton. Please update LearnHarness.');
  }
  const registrations = [], observers = new Set();
  const view = { items: [], progress: { sending: false }, loaded: false, error: '', summary: '' };
  const emit = () => { for (const observer of observers) observer(); };
  const aborted = () => ctx.signal.aborted;
  let loading = null, loadAgain = false, sendInFlight = false;

  // Reads the backend's list; the result (states, failure reasons, progress) is shown as given.
  function load() {
    if (aborted() || !observers.size) return Promise.resolve();
    if (loading) { loadAgain = true; return loading; }
    loading = (async () => {
      do {
        loadAgain = false;
        try {
          const result = await ctx.call('list');
          if (aborted()) return;
          view.items = Array.isArray(result?.items) ? result.items : [];
          view.progress = isObject(result?.progress) ? result.progress : { sending: false };
          view.loaded = true; view.error = '';
        } catch (error) {
          if (aborted()) return;
          view.error = message(error);
        }
        emit();
      } while (loadAgain && observers.size && !aborted());
    })().finally(() => { loading = null; });
    return loading;
  }

  const sendSummary = result => {
    const results = Array.isArray(result?.results) ? result.results : [];
    const count = outcome => results.filter(entry => entry?.outcome === outcome).length;
    const parts = [`${count('written')} of ${result?.total ?? results.length} written`];
    if (count('failed')) parts.push(`${count('failed')} failed`);
    if (count('skipped')) parts.push(`${count('skipped')} skipped`);
    if (result?.stopped) parts.push(`stopped, ${count('not-sent')} not sent`);
    return `${parts.join(', ')}.`;
  };

  async function send(ids) {
    if (sendInFlight || aborted()) return;
    sendInFlight = true; view.summary = ''; view.error = ''; emit();
    try {
      const result = await ctx.call('send', { ids });
      if (!aborted()) view.summary = sendSummary(result);
    } catch (error) {
      if (!aborted()) view.error = message(error);
    } finally {
      sendInFlight = false;
      if (!aborted()) { emit(); void load(); }
    }
  }

  // Stopping returns at once; the stop itself is reported by the send result or the finished notification.
  async function stop() {
    try { await ctx.call('stop'); }
    catch (error) { if (!aborted()) { view.error = message(error); emit(); } }
  }

  function mountView(container, hostSignal) {
    const scope = new AbortController(), signal = scope.signal;
    const abort = () => scope.abort();
    if (hostSignal.aborted || aborted()) abort();
    else { hostSignal.addEventListener('abort', abort, { once: true }); ctx.signal.addEventListener('abort', abort, { once: true }); }

    const selected = new Set();
    const root = el('div', 'sm-root');
    const note = el('p', 'sm-muted', 'Sends only the propositions you select, one memory each. Writes to shared memory cannot be undone.');
    const toolbar = el('div', 'sm-toolbar');
    const selectAllLabel = el('label', 'sm-check');
    const selectAll = el('input'); selectAll.type = 'checkbox';
    selectAllLabel.append(selectAll, el('span', undefined, 'Select all'));
    const sendSlot = el('span', 'sm-button'), stopSlot = el('span', 'sm-button');
    toolbar.append(selectAllLabel, sendSlot, stopSlot);
    const status = el('p', 'sm-status'), error = el('p', 'sm-error'), summary = el('p', 'sm-summary'), list = el('ul', 'sm-list');
    status.setAttribute('role', 'status'); error.setAttribute('role', 'alert');
    root.append(note, toolbar, status, error, summary, list);
    container.append(root);

    let stopPending = false;
    const sendButton = ctx.ui.mountButton(sendSlot, { label: 'Send selected', size: 'sm', variant: 'default', disabled: true, onClick: () => send(view.items.filter(item => selected.has(item.id)).map(item => item.id)) }, { signal });
    const stopButton = ctx.ui.mountButton(stopSlot, {
      label: 'Stop', size: 'sm', variant: 'outline', disabled: true,
      onClick: async () => { stopPending = true; render(); try { await stop(); } finally { stopPending = false; if (!signal.aborted) render(); } },
    }, { signal });
    for (const handle of [sendButton, stopButton]) signal.addEventListener('abort', () => handle.dispose(), { once: true });

    const sending = () => sendInFlight || view.progress.sending === true;
    function render() {
      if (signal.aborted) return;
      for (const id of [...selected]) if (!view.items.some(item => item.id === id)) selected.delete(id);
      const busy = sending();
      selectAll.disabled = busy || !view.items.length;
      selectAll.checked = view.items.length > 0 && selected.size === view.items.length;
      selectAll.indeterminate = selected.size > 0 && selected.size < view.items.length;
      sendButton.update({ label: `Send selected (${selected.size})`, disabled: busy || !selected.size });
      stopButton.update({ disabled: !view.progress.sending || view.progress.stopping === true || stopPending });
      status.textContent = view.progress.sending
        ? `Sending ${view.progress.done ?? 0} of ${view.progress.total ?? '?'}${view.progress.stopping ? ' (stopping after the current one)' : ''}`
        : sendInFlight ? 'Sending…' : '';
      error.textContent = view.error;
      summary.textContent = view.summary;
      if (!view.loaded) { list.replaceChildren(el('li', 'sm-muted', 'Loading…')); return; }
      if (!view.items.length) { list.replaceChildren(el('li', 'sm-muted', 'Nothing to send.')); return; }
      list.replaceChildren(...view.items.map(item => {
        const row = el('li', 'sm-item');
        const label = el('label', 'sm-item-label');
        const box = el('input'); box.type = 'checkbox'; box.checked = selected.has(item.id); box.disabled = busy;
        box.addEventListener('change', () => { if (box.checked) selected.add(item.id); else selected.delete(item.id); render(); });
        const head = el('span', 'sm-item-head');
        head.append(el('span', 'sm-item-name', item.name ?? item.id), el('span', 'sm-state', stateLabels[item.state] ?? String(item.state ?? '')));
        label.append(box, head);
        row.append(label);
        if (item.statement) row.append(el('p', 'sm-statement', item.statement));
        if (item.reason) row.append(el('p', 'sm-error', `Failed (${item.reason.kind}): ${item.reason.message}`));
        return row;
      }));
    }

    selectAll.addEventListener('change', () => {
      selected.clear();
      if (selectAll.checked) for (const item of view.items) selected.add(item.id);
      render();
    });
    observers.add(render);
    signal.addEventListener('abort', () => { observers.delete(render); hostSignal.removeEventListener('abort', abort); ctx.signal.removeEventListener('abort', abort); }, { once: true });
    render(); void load();
    return () => { abort(); root.remove(); };
  }

  // Settings: values come from get-settings, saves go through set-settings, and only a saved value is shown.
  let settings = null, settingsError = '', settingsHandle = null;
  const settingsRows = () => {
    const ready = settings !== null;
    const row = (key, label, description, value) => ({
      key, label, type: 'text', value, disabled: !ready,
      description: ready ? description : settingsError ? `Could not load settings: ${settingsError}` : 'Loading…',
      onChange: async next => {
        const saved = await ctx.call('set-settings', { [key]: next });
        if (aborted()) return;
        settings = saved; settingsError = '';
        settingsHandle?.update({ rows: settingsRows() });
      },
    });
    return [
      row('url', 'URL', 'MCP endpoint of the shared-memory server (http or https).', settings?.url ?? ''),
      row('scope', 'Scope', 'Scope of every memory written, for example project:learning.', settings?.scope ?? ''),
    ];
  };
  async function loadSettings() {
    if (settings !== null || aborted()) return;
    try { settings = await ctx.call('get-settings'); settingsError = ''; }
    catch (error) { if (aborted()) return; settingsError = message(error); }
    settingsHandle?.update({ rows: settingsRows() });
  }

  registrations.push(ctx.registerView({ id: 'send', name: 'Send to Shared Memory', mount: mountView }));
  registrations.push(ctx.registerAction({ id: 'open', name: 'Send to Shared Memory', icon: shareIcon, run: () => ctx.app.openView('send') }));
  registrations.push(ctx.placeAction({ id: 'open-sidebar', actionId: 'open', location: 'sidebar' }));
  settingsHandle = ctx.registerSettings({ rows: settingsRows() });
  registrations.push(() => settingsHandle.dispose());
  registrations.push(ctx.onNotification(event => {
    if (event.pluginId && event.pluginId !== ctx.manifest.id) return;
    const data = isObject(event.data) ? event.data : {};
    if (event.topic === 'progress') {
      view.progress = { sending: true, total: data.total, done: data.done, stopping: data.stopping === true };
      emit();
    } else if (event.topic === 'finished') {
      view.progress = { sending: false };
      // A send started from this window reports its own, fuller result.
      if (!sendInFlight) view.summary = `${data.done ?? 0} of ${data.total ?? 0} processed${data.stopped ? ', stopped' : ''}.`;
      emit(); void load();
    }
  }));
  registrations.push(ctx.onResync(() => { void load(); void loadSettings(); }));
  void loadSettings();

  const dispose = () => { for (const unregister of registrations.splice(0).reverse()) unregister(); observers.clear(); };
  ctx.cleanup(dispose);
  return dispose;
}
