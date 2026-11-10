import assert from "node:assert/strict";
import { it } from "node:test";
import { Sheets } from "../src/state.ts";
import type { Stroke } from "../src/strokes.ts";
const stroke = (x = 10): Stroke => ({ tool: "pen", points: [{ x, y: 10, pressure: .5 }] });
const blank = { background: "data:image/png;base64,fixture", backgroundColor: "#141414", width: 500, height: 400, pixelRatio: 2 };
function fixture(kind: "teaching" | "practice" = "teaching") {
  let changes = 0, resets = 0;
  const sheets = new Sheets(() => changes++, () => resets++), state = sheets.session("a", kind);
  sheets.create(state, blank);
  return { sheets, state, changes: () => changes, resets: () => resets };
}
it("teaching clears only after acceptance, never on capture", () => {
  const { sheets, state } = fixture(); sheets.update(state, [stroke()]);
  const captured = sheets.capture(state)!;
  assert.equal(captured.sendImage, true); assert.equal(state.draft!.strokes.length, 1);
  sheets.accepted(captured); assert.equal(state.draft!.strokes.length, 0); assert.equal(sheets.pending(state), false);
});
it("failed/unacknowledged captures retain the drawing", () => {
  const { sheets, state } = fixture(); sheets.update(state, [stroke()]);
  sheets.capture(state); assert.equal(state.draft!.strokes.length, 1); assert.equal(sheets.pending(state), true);
});
it("teaching late acceptance cannot erase newer strokes or recoloring", () => {
  const { sheets, state } = fixture(); sheets.update(state, [stroke()]); const captured = sheets.capture(state)!;
  sheets.update(state, [...state.draft!.strokes, stroke(50)]); sheets.accepted(captured);
  assert.equal(state.draft!.strokes.length, 2);
  const recolor = sheets.capture(state)!; sheets.setColor("#ff0000"); sheets.accepted(recolor);
  assert.equal(state.draft!.strokes.length, 2);
});
it("practice keeps strokes and undo after acceptance and suppresses unchanged resends", () => {
  const { sheets, state } = fixture("practice"); sheets.update(state, [stroke()]);
  const captured = sheets.capture(state)!; sheets.accepted(captured);
  assert.equal(state.draft!.strokes.length, 1); assert.equal(sheets.pending(state), false);
  assert.equal(sheets.capture(state)!.sendImage, false);
});
it("practice sends changed sheets and Undo back to the last sent image suppresses duplicates", () => {
  const { sheets, state } = fixture("practice"); sheets.update(state, [stroke()]); sheets.accepted(sheets.capture(state)!);
  sheets.update(state, [...state.draft!.strokes, stroke(50)]); assert.equal(sheets.pending(state), true);
  sheets.undo(state); assert.equal(sheets.pending(state), false);
});
it("practice late acknowledgment marks only its captured image sent, retaining newer work", () => {
  const { sheets, state } = fixture("practice"); sheets.update(state, [stroke()]); const captured = sheets.capture(state)!;
  sheets.update(state, [...state.draft!.strokes, stroke(50)]); sheets.accepted(captured);
  assert.equal(sheets.pending(state), true); assert.equal(state.draft!.strokes.length, 2);
});
it("fully erased history sends nothing but survives acceptance in practice", () => {
  const { sheets, state } = fixture("practice"); sheets.update(state, [stroke()]); sheets.accepted(sheets.capture(state)!);
  sheets.update(state, [...state.draft!.strokes, { tool: "eraser", points: [{ x: 10, y: 10, pressure: .5 }] }]);
  assert.equal(sheets.pending(state), false); assert.equal(sheets.capture(state)!.sendImage, false);
  sheets.accepted(sheets.capture(state)!); assert.equal(state.draft!.strokes.length, 2);
  sheets.undo(state); assert.equal(sheets.pending(state), false, "the restored image was already sent");
});
it("off-screen ink remains eligible regardless of the current viewport", () => {
  const { sheets, state } = fixture(); sheets.update(state, [stroke(-1000000)]);
  assert.equal(sheets.pending(state), true); assert.equal(sheets.capture(state)!.sendImage, true);
});
it("panning never changes content, revision, resend detection, or acceptance ownership", () => {
  const { sheets, state } = fixture("practice"); sheets.update(state, [stroke()]); const captured = sheets.capture(state)!;
  const draft = state.draft; sheets.setTool(state, "hand"); sheets.setPan(state, { x: -10000, y: 5000 });
  assert.equal(state.draft, draft); assert.equal(sheets.signature(state), captured.signature);
  sheets.accepted(captured); assert.equal(sheets.pending(state), false);
  sheets.setPan(state, { x: 3, y: -40 }); assert.equal(sheets.capture(state)!.sendImage, false);
});
it("export scale is frozen per attempt and does not edit ink or force unchanged practice resends", () => {
  const { sheets, state } = fixture("practice"); sheets.update(state, [stroke()]); const captured = sheets.capture(state)!;
  assert.equal(captured.imageScale, 50); const draft = state.draft;
  sheets.setImageScale(25); assert.equal(captured.imageScale, 50); assert.equal(sheets.capture(state)!.imageScale, 25);
  assert.equal(state.draft, draft); sheets.accepted(captured); assert.equal(sheets.pending(state), false);
  sheets.update(state, [...state.draft!.strokes, stroke(80)]); assert.equal(sheets.capture(state)!.imageScale, 25);
});
it("teaching acceptance still clears after a camera-only change", () => {
  const { sheets, state } = fixture(); sheets.update(state, [stroke()]); const captured = sheets.capture(state)!;
  sheets.setPan(state, { x: 100, y: -500 }); sheets.accepted(captured);
  assert.equal(state.draft!.strokes.length, 0); assert.deepEqual(state.pan, { x: 100, y: -500 });
});
it("camera position belongs to each session and resets only with a new sheet/problem", () => {
  const { sheets, state } = fixture("practice"); sheets.observePoses(state, ["p1"], true); sheets.update(state, [stroke()]);
  sheets.setPan(state, { x: -800, y: 1200 });
  assert.deepEqual(sheets.session("b", "practice").pan, { x: 0, y: 0 });
  assert.deepEqual(sheets.session("a", "practice").pan, { x: -800, y: 1200 });
  sheets.setTool(state, "hand"); sheets.observePoses(state, ["p1", "p2"]);
  assert.deepEqual(state.pan, { x: 0, y: 0 }); assert.equal(state.tool, "pen");
});
it("color changes recolor all held sheets and count as practice changes", () => {
  const { sheets, state } = fixture("practice"); sheets.update(state, [stroke()]); sheets.accepted(sheets.capture(state)!);
  const other = sheets.session("b", "teaching"); sheets.create(other, blank); sheets.update(other, [stroke(50)]);
  const before = other.draft!.revision; sheets.setColor("#ff0000");
  assert.equal(sheets.pending(state), true); assert.equal(other.draft!.revision, before + 1);
  assert.equal(sheets.capture(other)!.color, "#ff0000");
});
it("navigation reuse returns the same per-session sheet, never another session's ink", () => {
  const { sheets, state } = fixture(); sheets.update(state, [stroke()]);
  assert.equal(sheets.session("a", "teaching"), state);
  assert.equal(sheets.pending(sheets.session("b", "teaching")), false);
});
it("only a new accepted pose resets practice, not repeated/empty observations", () => {
  const { sheets, state, resets } = fixture("practice"); sheets.observePoses(state, ["pose1"], true); sheets.update(state, [stroke()]);
  sheets.observePoses(state, []); sheets.observePoses(state, ["pose1"]);
  assert.equal(state.draft!.strokes.length, 1); assert.equal(resets(), 0);
  sheets.observePoses(state, ["pose1", "pose2"]); assert.equal(state.draft, undefined); assert.equal(resets(), 1);
  sheets.observePoses(state, ["pose1", "pose2"]); assert.equal(resets(), 1);
});
it("a historical backfill before the known latest pose does not reset the board", () => {
  const { sheets, state, resets } = fixture("practice"); sheets.observePoses(state, ["pose2"], true); sheets.update(state, [stroke()]);
  sheets.observePoses(state, ["pose1", "pose2"]); assert.equal(resets(), 0); assert.equal(state.draft!.strokes.length, 1);
});
it("new-problem reset fences old acceptance and preserves new sheet ownership", () => {
  const { sheets, state } = fixture("practice"); sheets.observePoses(state, ["pose1"], true); sheets.update(state, [stroke()]);
  const captured = sheets.capture(state)!; sheets.observePoses(state, ["pose1", "pose2"]);
  sheets.create(state, blank); sheets.update(state, [stroke(80)]); sheets.accepted(captured);
  assert.equal(state.sentSignature, ""); assert.equal(sheets.pending(state), true);
});
it("explicit Clear drops undo but retains the displayed reference until reopening", () => {
  const { sheets, state } = fixture(); sheets.update(state, [stroke()]); const background = state.draft!.background;
  sheets.clear(state); assert.equal(state.draft!.background, background); assert.equal(state.draft!.strokes.length, 0);
  sheets.dropUntouched(state); assert.equal(state.draft, undefined);
});
it("closing a fully erased sheet preserves its undo history", () => {
  const { sheets, state } = fixture(); sheets.update(state, [stroke(), { tool: "eraser", points: [{ x: 10, y: 10, pressure: .5 }] }]);
  sheets.dropUntouched(state); assert.equal(state.draft!.strokes.length, 2); sheets.undo(state); assert.equal(sheets.pending(state), true);
});
it("palette replacement merges into the newest strokes and preserves reference geometry, camera and attempt snapshots", () => {
  const { sheets, state } = fixture(); sheets.update(state, [stroke()]);
  const before = sheets.capture(state)!, old = state.draft!;
  sheets.setPan(state, { x: 42, y: -17 }); sheets.update(state, [...old.strokes, stroke(80)]);
  sheets.setPalette("#000000", "light", new Map([[state, { id: old.id, background: "light-reference", backgroundColor: "#ffffff" }]]));
  const next = sheets.capture(state)!;
  assert.equal(next.draft.background, "light-reference"); assert.equal(next.color, "#000000");
  assert.equal(next.draft.strokes.length, 2); assert.deepEqual(state.pan, { x: 42, y: -17 });
  assert.deepEqual([next.draft.id, next.draft.width, next.draft.height, next.draft.pixelRatio], [old.id, old.width, old.height, old.pixelRatio]);
  assert.equal(before.draft.background, old.background); assert.equal(before.color, "#ffffff");
  sheets.accepted(before); assert.equal(state.draft!.strokes.length, 2);
});
it("background palette edits count as changed practice images even with identical configured ink", () => {
  const { sheets, state } = fixture("practice"); sheets.update(state, [stroke()]); sheets.accepted(sheets.capture(state)!);
  const draft = state.draft!;
  sheets.setPalette(sheets.color, "different-palette", new Map([[state, { id: draft.id, background: "new-reference", backgroundColor: "#202020" }]]));
  assert.equal(sheets.pending(state), true); const next = state.draft;
  sheets.setPalette(sheets.color, "different-palette", new Map()); assert.equal(state.draft, next);
});
it("a late reference repaint cannot replace a new problem's sheet", () => {
  const { sheets, state } = fixture("practice"), old = state.draft!;
  sheets.create(state, { ...blank, background: "new-problem" });
  sheets.setPalette(sheets.color, "light", new Map([[state, { id: old.id, background: "old-problem-repaint", backgroundColor: "#ffffff" }]]));
  assert.equal(state.draft!.background, "new-problem");
});
it("accepted ink recolors only current-palette drafts, preserving older raster pairs and immutable attempts", () => {
  let ink = "#ffffff", changes = 0;
  const sheets = new Sheets(() => changes++, () => {}, () => ink);
  const old = sheets.session("old", "teaching"); sheets.create(old, { ...blank, palette: "dark" }); sheets.update(old, [stroke()]);
  const oldDraft = old.draft;
  ink = "#000000";
  const current = sheets.session("current", "practice"); sheets.create(current, { ...blank, palette: "light", backgroundColor: "#ffffff" });
  sheets.update(current, [stroke()]); const captured = sheets.capture(current)!;
  sheets.setInkForPalette("#7654ab", "light");
  assert.equal(sheets.capture(current)!.color, "#7654ab"); assert.equal(current.draft!.revision, captured.draft.revision + 1);
  assert.equal(old.draft, oldDraft); assert.equal(sheets.capture(old)!.color, "#ffffff");
  assert.equal(captured.color, "#000000"); assert.equal(captured.draft.color, "#000000");
  const acceptedDraft = current.draft, beforeNoop = changes;
  sheets.setInkForPalette("#7654ab", "light"); assert.equal(current.draft, acceptedDraft); assert.equal(changes, beforeNoop);
  sheets.accepted(captured); assert.equal(sheets.pending(current), true);
});
it("sheet change listeners unsubscribe and disposal loses window-owned drafts", () => {
  const { sheets, state } = fixture(); let calls = 0; const off = sheets.onChange(() => calls++);
  sheets.update(state, [stroke()]); off(); sheets.clear(state); assert.equal(calls, 1);
  sheets.dispose(); assert.equal(sheets.sessions.size, 0);
});
