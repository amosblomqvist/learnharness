import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginAction, PluginActionPlacement, PluginFrontendContext, PluginUi, PluginView } from "learnharness-plugin-api";
import { activate, REQUIRED_UI_METHODS } from "../src/main.ts";
import { createFixture } from "./fixture.ts";

function registrationContext(ui: PluginUi) {
  const controller = new AbortController();
  const views: PluginView[] = [], actions: PluginAction[] = [], placements: PluginActionPlacement[] = [];
  const disposed: string[] = [], opened: string[] = [];
  const context = {
    ui, signal: controller.signal,
    registerView(value: PluginView) { views.push(value); return () => { disposed.push(`view:${value.id}`); }; },
    registerAction(value: PluginAction) { actions.push(value); return () => { disposed.push(`action:${value.id}`); }; },
    placeAction(value: PluginActionPlacement) { placements.push(value); return () => { disposed.push(`placement:${value.id}`); }; },
    app: { openView(id: string) { opened.push(id); } },
  } as PluginFrontendContext;
  return { context, controller, views, actions, placements, disposed, opened };
}

test("activation explicitly registers gallery sidebar and teaching/practice-only native surface action", async () => {
  const fixture = createFixture();
  try {
    const f = registrationContext(fixture.ui), dispose = activate(f.context);
    assert.deepEqual(f.views.map(view => view.id), ["gallery"]);
    assert.deepEqual(f.actions.map(action => action.id), ["open-gallery", "open-surface"]);
    assert.deepEqual(f.placements, [
      { id: "gallery-sidebar", actionId: "open-gallery", location: "sidebar" },
      { id: "surface-topbar", actionId: "open-surface", location: "top-bar", sessions: ["teaching", "practice"] },
    ]);
    await f.actions[0]!.run({ placement: "sidebar", surface: "sidebar" });
    assert.deepEqual(f.opened, ["gallery"]);
    const surface = f.actions[1]!;
    for (const context of [{ placement: "sidebar", surface: "sidebar" }, { placement: "graph", surface: "graph" }, { placement: "top-bar", surface: "plugin-view", pluginId: "ui-showcase", viewId: "gallery" }] as const) assert.throws(() => surface.run(context), /native session top-bar context/);
    assert.equal(fixture.records.length, 0, "Rejected contexts must not call openSurface");
    for (const kind of ["teaching", "practice"] as const) {
      const target = Object.freeze({}) as Extract<Parameters<PluginAction["run"]>[0], { surface: "session" }>["surfaceTarget"];
      const view = Object.freeze({
        sessionId: "synthetic", kind, title: "Synthetic session", messages: [], transcript: [],
        status: "ready" as const, reconciliation: "ready" as const, busy: false, compacting: false,
        phase: kind === "practice" ? "practice" as const : "teach" as const,
        contextTokens: null, queuedSteers: [], composer: { text: "" },
        input: { type: "unavailable" as const, expanded: false, revealed: false },
      });
      await surface.run({ placement: "top-bar", surface: "session", sessionId: "synthetic", kind, surfaceTarget: target, view });
      assert.equal(fixture.records.findLast(record => record.method === "openSurface")!.target, target);
    }
    assert.equal(fixture.records.filter(record => record.method === "openSurface").length, 2);
    f.controller.abort(); dispose(); dispose();
    assert.equal(f.disposed.length, 5); assert.equal(new Set(f.disposed).size, 5);
    assert.ok(fixture.records.every(record => record.disposed === 1));
  } finally { fixture.restore(); }
});

function sessionContext() {
  const surfaceTarget = Object.freeze({}) as Extract<Parameters<PluginAction["run"]>[0], { surface: "session" }>["surfaceTarget"];
  return {
    placement: "top-bar", surface: "session", sessionId: "synthetic", kind: "teaching", surfaceTarget,
    view: { sessionId: "synthetic", kind: "teaching", title: "Synthetic session", messages: [], transcript: [],
      status: "ready", reconciliation: "ready", busy: false, compacting: false, phase: "teach",
      contextTokens: null, queuedSteers: [], composer: { text: "" }, input: { type: "unavailable", expanded: false, revealed: false } },
  } satisfies Parameters<PluginAction["run"]>[0];
}

test("top-bar surface toggles without stacking and closes its explicit nested examples", async () => {
  const fixture = createFixture();
  try {
    const f = registrationContext(fixture.ui), dispose = activate(f.context);
    const action = f.actions.find(action => action.id === "open-surface")!, context = sessionContext();
    for (let attempt = 0; attempt < 3; attempt++) {
      await action.run(context);
      assert.equal(fixture.records.filter(record => record.method === "openSurface" && !record.disposed).length, 1);
      fixture.find("surface-nested").props.onClick();
      assert.equal(fixture.records.filter(record => record.method === "openSurface" && !record.disposed).length, 2, "Explicit nesting remains supported");
      await action.run(context);
      assert.equal(fixture.records.filter(record => record.method === "openSurface" && !record.disposed).length, 0);
    }
    assert.equal(fixture.records.filter(record => record.method === "openSurface").length, 6);
    dispose();
    await action.run(context);
    assert.equal(fixture.records.filter(record => record.method === "openSurface").length, 6, "Retired actions stay inert");
    assert.ok(fixture.records.every(record => record.disposed === 1));
  } finally { fixture.restore(); }
});

test("native close clears the toggle; retired targets and stale callbacks cannot clear a fresh surface", async () => {
  const fixture = createFixture();
  try {
    const f = registrationContext(fixture.ui), dispose = activate(f.context);
    const action = f.actions.find(action => action.id === "open-surface")!, context = sessionContext();
    await action.run(context);
    const original = fixture.records.findLast(record => record.method === "openSurface")!;
    original.props.onClose(); original.handle.dispose();
    await action.run(context);
    const reopened = fixture.records.findLast(record => record.method === "openSurface")!;
    assert.notEqual(reopened, original);
    original.props.onClose();
    await action.run(context);
    assert.equal(reopened.disposed, 1, "A stale close must not make the next click open another surface");
    await action.run(context);
    const beforeNavigation = fixture.records.findLast(record => record.method === "openSurface")!;
    beforeNavigation.handle.dispose(); // Host retires the page without firing user onClose.
    const returnedContext = sessionContext();
    await action.run(returnedContext);
    const returned = fixture.records.findLast(record => record.method === "openSurface")!;
    assert.notEqual(returned, beforeNavigation);
    assert.equal(returned.target, returnedContext.surfaceTarget);
    await action.run(returnedContext);
    assert.equal(returned.disposed, 1);
    await action.run(returnedContext);
    f.controller.abort(); dispose();
    assert.ok(fixture.records.every(record => record.disposed === 1));
  } finally { fixture.restore(); }
});

test("every required capability fails closed with no partial registrations or fallback UI", () => {
  for (const missing of REQUIRED_UI_METHODS) {
    const ui = Object.fromEntries(REQUIRED_UI_METHODS.filter(method => method !== missing).map(method => [method, () => { throw new Error("No UI may mount during activation"); }])) as unknown as PluginUi;
    const f = registrationContext(ui);
    assert.throws(() => activate(f.context), new RegExp(`Missing capabilities: ui\\.${missing}`));
    assert.deepEqual(f.views, []); assert.deepEqual(f.actions, []); assert.deepEqual(f.placements, []);
  }
});

test("Tree and Badge are required current-feature capabilities, never optional fallbacks", () => {
  assert.equal(REQUIRED_UI_METHODS.length, 15);
  assert.ok(REQUIRED_UI_METHODS.includes("mountBadge"));
  assert.ok(REQUIRED_UI_METHODS.includes("mountTree"));
  const ui = Object.fromEntries(REQUIRED_UI_METHODS.filter(method => method !== "mountTree").map(method => [method, () => {}])) as unknown as PluginUi;
  const f = registrationContext(ui);
  assert.throws(() => activate(f.context), /Missing capabilities: ui\.mountTree.*No fallback UI/);
  assert.deepEqual(f.views, []); assert.deepEqual(f.actions, []); assert.deepEqual(f.placements, []);
});

test("already-aborted activation is inert", () => {
  const ui = Object.fromEntries(REQUIRED_UI_METHODS.map(method => [method, () => {}])) as unknown as PluginUi;
  const f = registrationContext(ui); f.controller.abort(); activate(f.context)();
  assert.deepEqual(f.views, []); assert.deepEqual(f.actions, []); assert.deepEqual(f.placements, []);
});
