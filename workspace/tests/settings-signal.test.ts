/**
 * The cross-surface settings signal (fix wave, owner ruling 2026-09-22):
 * writers dispatch lh:settings-saved {section} after a successful PUT,
 * readers re-read. These tests pin the SEAM's contract — delivery,
 * section detail, unsubscribe, and junk-event tolerance — against a bare
 * EventTarget standing in for window (Node has no DOM; the reader WIRING
 * is verified live per dev-verification.md).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

// A DOM-less window: EventTarget is all the seam touches. The module
// imports react (harmless) and reads window at CALL time, not import time.
const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window: unknown }).window = new EventTarget();

const {
	SETTINGS_SAVED_EVENT,
	notifySettingsSaved,
	onSettingsSaved,
} = await import("../components/settings-signal.ts");

afterEach(() => {
	(globalThis as { window: unknown }).window = realWindow ?? new EventTarget();
});

describe("settings-signal — the seam's contract", () => {
	it("a writer's notify reaches a reader with the section", () => {
		const got: string[] = [];
		const off = onSettingsSaved((section) => got.push(section));
		notifySettingsSaved("models");
		assert.deepEqual(got, ["models"]);
		off();
	});

	it("unsubscribe stops delivery (a reader unmounting never leaks)", () => {
		const got: string[] = [];
		const off = onSettingsSaved((section) => got.push(section));
		off();
		notifySettingsSaved("models");
		assert.deepEqual(got, []);
	});

	it("readers filter their own section — general doesn't reach a models reader", () => {
		const got: string[] = [];
		const off = onSettingsSaved((s) => {
			if (s === "models") got.push(s);
		});
		notifySettingsSaved("general");
		notifySettingsSaved("appearance");
		assert.deepEqual(got, []);
		notifySettingsSaved("models");
		assert.deepEqual(got, ["models"]);
		off();
	});

	it("a foreign CustomEvent on the same name with no section detail is ignored", () => {
		const got: string[] = [];
		const off = onSettingsSaved((section) => got.push(section));
		// e.g. some other dispatch path that forgot the detail payload
		globalThis.window.dispatchEvent(
			new CustomEvent(SETTINGS_SAVED_EVENT, { detail: undefined }),
		);
		assert.deepEqual(got, []);
		off();
	});
});
