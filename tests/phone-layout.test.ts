/**
 * Phone layout decisions (lh-m5s): the pure seams the responsive UI reads.
 * Every expected value is a literal from the PRD's worked examples.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capDockHeight, confidenceHitHeight, copyVisibility, enterKey, modelMenuWidth, pointerGesture, keyboardInset, overlayDrawer, phoneLayout, sidebarOpen, sidebarToggleAction } from "../components/phone-layout.ts";

describe("phoneLayout", () => {
	it("a 390px browser is an overlay shell with sheet dialogs and a compact title", () => {
		const layout = phoneLayout({ width: 390, electron: false, coarsePointer: true });
		assert.equal(layout.shell, "overlay");
		assert.equal(layout.sheetDialogs, true);
		assert.equal(layout.compactTitle, true);
	});

	it("a 1200px window is the desktop shell", () => {
		const layout = phoneLayout({ width: 1200, electron: false, coarsePointer: false });
		assert.equal(layout.shell, "desktop");
		assert.equal(layout.sheetDialogs, false);
		assert.equal(layout.compactTitle, false);
	});

	it("Electron at 800px stays electron-narrow and never becomes an overlay", () => {
		const layout = phoneLayout({ width: 800, electron: true, coarsePointer: false });
		assert.equal(layout.shell, "electron-narrow");
		assert.equal(layout.sheetDialogs, false);
	});

	it("overlay wraps controls, splits graph tools into two rows, and docks the node card at the bottom", () => {
		const layout = phoneLayout({ width: 390, electron: false, coarsePointer: true });
		assert.equal(layout.wrapControls, true);
		assert.equal(layout.graphToolRows, 2);
		assert.equal(layout.nodeCard, "bottom-sheet");
	});

	it("desktop and electron-narrow keep one control row, one tool row, and the anchored node card", () => {
		for (const layout of [
			phoneLayout({ width: 1200, electron: false, coarsePointer: false }),
			phoneLayout({ width: 800, electron: true, coarsePointer: false }),
		]) {
			assert.equal(layout.wrapControls, false);
			assert.equal(layout.compactTitle, false);
			assert.equal(layout.graphToolRows, 1);
			assert.equal(layout.nodeCard, "anchor");
		}
	});

	it("a coarse pointer inserts newlines on Enter; a fine pointer does not", () => {
		assert.equal(phoneLayout({ width: 390, electron: false, coarsePointer: true }).enterInsertsNewline, true);
		assert.equal(phoneLayout({ width: 390, electron: false, coarsePointer: false }).enterInsertsNewline, false);
	});
});

describe("the session drawer", () => {
	it("the overlay starts closed even when the stored desktop preference says open", () => {
		assert.equal(sidebarOpen({ shell: "overlay", preference: true, overlayOpen: false }), false);
	});

	it("the overlay opens on toggle, then closes on a backdrop tap", () => {
		const opened = overlayDrawer(false, "toggle");
		assert.equal(opened, true);
		assert.equal(overlayDrawer(opened, "backdrop"), false);
	});

	it("opening a session closes the overlay", () => {
		assert.equal(overlayDrawer(true, "navigate"), false);
	});

	it("the desktop shell follows the stored preference", () => {
		assert.equal(sidebarOpen({ shell: "desktop", preference: true, overlayOpen: false }), true);
		assert.equal(sidebarOpen({ shell: "desktop", preference: false, overlayOpen: true }), false);
	});

	it("Electron under 928px still auto-closes and still asks the window to widen when opened", () => {
		assert.equal(sidebarOpen({ shell: "electron-narrow", preference: true, overlayOpen: true }), false);
		assert.equal(sidebarToggleAction({ shell: "electron-narrow", preference: false }), "widen-window");
	});

	it("Electron under 928px with the preference already open flips the preference, as before", () => {
		assert.equal(sidebarToggleAction({ shell: "electron-narrow", preference: true }), "flip-preference");
	});

	it("toggling on a narrow browser flips the overlay, never the stored preference", () => {
		assert.equal(sidebarToggleAction({ shell: "overlay", preference: true }), "flip-overlay");
		assert.equal(sidebarToggleAction({ shell: "desktop", preference: true }), "flip-preference");
	});
});

describe("keyboardInset", () => {
	it("a closed keyboard leaves only the home-indicator inset", () => {
		const inset = keyboardInset({ layoutHeight: 800, visualHeight: 800, offsetTop: 0, safeAreaBottom: 34 });
		assert.equal(inset.bottomInset, 34);
	});

	it("an open keyboard lifts the dock by the covered height and drops the home indicator", () => {
		const inset = keyboardInset({ layoutHeight: 800, visualHeight: 430, offsetTop: 0, safeAreaBottom: 34 });
		assert.equal(inset.bottomInset, 370);
		assert.equal(inset.dockMaxHeight, 120);
	});
});

describe("capDockHeight", () => {
	const openKeyboard = keyboardInset({ layoutHeight: 800, visualHeight: 430, offsetTop: 0, safeAreaBottom: 34 });

	it("a tall question card is capped to the open-keyboard dock height", () => {
		assert.equal(capDockHeight(700, openKeyboard.dockMaxHeight), 120);
	});

	it("a short card keeps its measured height", () => {
		assert.equal(capDockHeight(80, openKeyboard.dockMaxHeight), 80);
	});
});

describe("enterKey (text fields)", () => {
	const key = { shiftKey: false, metaKey: false, ctrlKey: false };

	it("an unmodified Enter on a coarse pointer types a newline", () => {
		assert.equal(enterKey({ ...key, coarsePointer: true }), "newline");
	});

	it("an unmodified Enter on a fine pointer submits", () => {
		assert.equal(enterKey({ ...key, coarsePointer: false }), "submit");
	});

	it("Shift+Enter on a fine pointer types a newline", () => {
		assert.equal(enterKey({ ...key, coarsePointer: false, shiftKey: true }), "newline");
	});

	it("Meta+Enter and Ctrl+Enter submit even on a coarse pointer", () => {
		assert.equal(enterKey({ ...key, coarsePointer: true, metaKey: true }), "submit");
		assert.equal(enterKey({ ...key, coarsePointer: true, ctrlKey: true }), "submit");
	});
});

describe("copyVisibility", () => {
	it("without hover, copy controls stay visible", () => {
		assert.equal(copyVisibility(false), "visible");
	});

	it("with hover, copy controls reveal on hover", () => {
		assert.equal(copyVisibility(true), "hover-reveal");
	});
});

describe("confidenceHitHeight", () => {
	it("a coarse pointer gets a 44px confidence hit area", () => {
		assert.equal(confidenceHitHeight(true), 44);
	});

	it("a fine pointer keeps the 16px confidence track", () => {
		assert.equal(confidenceHitHeight(false), 16);
	});
});

describe("pointerGesture", () => {
	it("a 500ms hold that travels 3px is a long-press", () => {
		assert.equal(pointerGesture({ holdMs: 500, travelPx: 3 }), "long-press");
	});

	it("4px of travel is a pan, however long the hold", () => {
		assert.equal(pointerGesture({ holdMs: 500, travelPx: 4 }), "pan");
	});

	it("a short still press is a tap", () => {
		assert.equal(pointerGesture({ holdMs: 100, travelPx: 0 }), "tap");
	});
});

describe("modelMenuWidth", () => {
	it("a 1200px viewport keeps the 352px menu", () => {
		assert.equal(modelMenuWidth(1200), 352);
	});

	it("a 300px viewport caps the menu at 276px", () => {
		assert.equal(modelMenuWidth(300), 276);
	});

	it("a 390px viewport still fits the 352px menu", () => {
		assert.equal(modelMenuWidth(390), 352);
	});
});
