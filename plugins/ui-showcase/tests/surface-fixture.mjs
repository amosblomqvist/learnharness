/** Test-only frontend package, installed solely inside the disposable native proof. */
const manifest = {
  id: "surface-proof", name: "Surface proof fixture", version: "0.0.0",
  apiVersion: 1, minAppVersion: "0.4.1", main: "main.js",
  description: "Disposable public-API Surface verification; not a product package.",
};

// This function is serialized as the fixture's entire frontend module. It has
// no imports, host internals, test globals, network access or generated actions.
function activate(ctx) {
  const registrations = [], surfaces = [], watchers = new Set();
  let latest;
  const snapshot = () => ({ records: surfaces.map(record => ({
    id: record.id, pathname: record.pathname, pending: record.pending,
    aborts: record.aborts, cleanups: record.cleanups, closes: record.closes,
    clicks: record.clicks, draft: record.input?.value ?? "",
    connected: !!record.root?.isConnected, signalAborted: !!record.contentSignal?.aborted,
  })) });
  const publish = () => { for (const render of watchers) render(); };
  const open = (pending = false) => {
    const record = { id: surfaces.length + 1, pathname: ctx.app.pathname(), pending,
      aborts: 0, cleanups: 0, closes: 0, clicks: 0 };
    latest = record; surfaces.push(record);
    record.handle = ctx.ui.openSurface({
      title: "Surface proof page body",
      content(container, signal) {
        record.contentSignal = signal;
        const root = document.createElement("section");
        root.dataset.surfaceProof = "surface"; root.style.padding = "24px";
        const heading = document.createElement("h2"); heading.textContent = "Surface proof page body";
        const input = document.createElement("input"); input.setAttribute("aria-label", "Surface proof draft");
        input.value = "Local surface draft";
        const slot = document.createElement("div"); slot.dataset.surfaceProof = "count";
        root.append(heading, input, slot); container.append(root);
        record.root = root; record.input = input;
        const button = ctx.ui.mountButton(slot, { label: "Count local Surface callback", onClick() { record.clicks++; publish(); } }, { signal });
        signal.addEventListener("abort", () => { record.aborts++; publish(); }, { once: true });
        const cleanup = () => { record.cleanups++; button.dispose(); root.remove(); publish(); };
        publish();
        // An intentionally late cleanup must run once after its owner expires,
        // never recreate the old page surface or activate its expired callbacks.
        return pending ? new Promise(resolve => { record.finish = () => { record.pending = false; resolve(cleanup); publish(); }; }) : cleanup;
      },
      onClose() { record.closes++; publish(); },
    }, { signal: ctx.signal });
    return record.handle;
  };
  const action = (id, name, run) => {
    registrations.push(ctx.registerAction({ id, name, run }));
    registrations.push(ctx.placeAction({ id, actionId: id, location: "sidebar" }));
  };
  action("open", "Surface proof: open page body", () => { open(); });
  action("pending", "Surface proof: pending cleanup", () => { open(true); });
  action("complete", "Surface proof: finish expired cleanup", () => {
    latest?.handle.update({ title: "Expired Surface update must not reopen" });
    latest?.finish?.();
  });
  action("settings", "Surface proof: open Settings", () => ctx.app.openSettings());
  action("dialog", "Surface proof: open dialog", () => {
    const handle = ctx.ui.openDialog({ title: "Surface proof dialog", content(container, signal) {
      const slot = document.createElement("div"); slot.dataset.surfaceProof = "dialog-open";
      container.append(slot);
      const button = ctx.ui.mountButton(slot, { label: "Open page surface behind this dialog", onClick() { open(); } }, { signal });
      return () => { button.dispose(); slot.remove(); };
    } }, { signal: ctx.signal });
    registrations.push(() => handle.dispose());
  });
  registrations.push(ctx.registerSettings((container, signal) => {
    const slot = document.createElement("div"); slot.dataset.surfaceProof = "settings-open";
    container.append(slot);
    // Button lifetime belongs to Settings. The opened Surface lifetime instead
    // belongs to the plugin/page and must survive closing the Settings mount.
    const button = ctx.ui.mountButton(slot, { label: "Open page surface behind Settings", onClick() { open(); } }, { signal });
    return () => { button.dispose(); slot.remove(); };
  }));
  registrations.push(ctx.registerView({ id: "evidence", name: "Surface proof evidence", mount(container) {
    const readout = document.createElement("pre"); readout.dataset.surfaceProof = "state";
    const render = () => { readout.textContent = JSON.stringify(snapshot()); };
    watchers.add(render); container.append(readout); render();
    return () => { watchers.delete(render); readout.remove(); };
  } }));
  action("evidence", "Surface proof: evidence", () => ctx.app.openView("evidence"));
  return () => {
    for (const record of surfaces) record.handle.dispose();
    for (const unregister of registrations.reverse()) unregister();
    watchers.clear();
  };
}

export const surfaceProofFixture = Object.freeze({
  id: manifest.id,
  files: Object.freeze({
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "main.js": `export ${activate.toString()}\n`,
  }),
});
