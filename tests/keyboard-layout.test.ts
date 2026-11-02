import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionForBinding, eventBinding, KEYBOARD_ACTIONS } from "../src/core/keyboard.ts";

/**
 * Non-Latin keyboard layouts: with Ctrl/Cmd held, a Cyrillic (or Greek,
 * Hebrew, …) layout reports the LAYOUT's character in `key` — Ctrl+K on a
 * Russian layout is key "л" — so every letter shortcut went dead until the
 * learner switched back to a Latin layout. A modified letter whose `key` is
 * not ASCII falls back to its physical key (`code` KeyK → "k"). ASCII
 * character mappings (including AZERTY/Dvorak, where `key` is already
 * the intended letter) are untouched.
 */

function press(init: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): KeyboardEvent {
	return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent;
}

describe("eventBinding — non-Latin layouts", () => {
	it("Ctrl+K on a Russian layout is the model selector, as on a Latin layout", () => {
		const binding = eventBinding(press({ key: "л", code: "KeyK", ctrlKey: true }));
		assert.equal(binding, "mod+k");
		assert.equal(actionForBinding(binding), "open-model-picker");
	});

	it("shift stays explicit: Ctrl+Shift+F on a Russian layout is the sessions search", () => {
		const binding = eventBinding(press({ key: "А", code: "KeyF", ctrlKey: true, shiftKey: true }));
		assert.equal(binding, "mod+shift+f");
		assert.equal(actionForBinding(binding), "sessions-search");
	});

	it("Cmd+, on a Russian layout (key \"б\") opens settings", () => {
		const binding = eventBinding(press({ key: "б", code: "Comma", metaKey: true }));
		assert.equal(binding, "mod+,");
		assert.equal(actionForBinding(binding), "open-settings");
	});

	it("ASCII layout characters keep following `key`, not the physical position (AZERTY: the A key types q)", () => {
		assert.equal(eventBinding(press({ key: "q", code: "KeyA", ctrlKey: true })), "mod+q");
		assert.equal(eventBinding(press({ key: "k", code: "KeyK", ctrlKey: true })), "mod+k");
	});

	it("bare non-Latin typing is not a binding to rewrite", () => {
		assert.equal(eventBinding(press({ key: "л", code: "KeyK" })), "л");
		assert.equal(eventBinding(press({ key: "Л", code: "KeyK", shiftKey: true })), "л");
	});

	it("all current modified-letter defaults survive non-ASCII layout characters", () => {
		for (const action of KEYBOARD_ACTIONS) {
			const match = /^mod\+(shift\+)?([a-z])$/.exec(action.binding);
			if (!match) continue;
			for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
				const binding = eventBinding(press({ key: "λ", code: `Key${match[2]!.toUpperCase()}`, shiftKey: !!match[1], ...modifier }));
				assert.equal(binding, action.binding);
				assert.equal(actionForBinding(binding), action.id);
			}
		}
	});

	it("Alt/Option-only and combined modifiers use the same physical fallback", () => {
		assert.equal(eventBinding(press({ key: "˚", code: "KeyK", altKey: true })), "alt+k");
		assert.equal(eventBinding(press({ key: "б", code: "Comma", altKey: true })), "alt+,");
		assert.equal(eventBinding(press({ key: "Δ", code: "KeyD", ctrlKey: true, altKey: true, shiftKey: true })), "mod+alt+shift+d");
		assert.equal(eventBinding(press({ key: "q", code: "KeyA", altKey: true })), "alt+q", "ASCII still follows key, not position");
	});

	it("tests the reported character before Unicode lowercasing can expand it", () => {
		assert.equal(eventBinding(press({ key: "İ", code: "KeyI", ctrlKey: true, shiftKey: true })), "mod+shift+i");
		assert.equal(eventBinding(press({ key: "İ", code: "KeyI" })), "i\u0307", "bare typing keeps existing case normalization");
	});

	it("unmapped codes and named keys keep their existing key meanings", () => {
		assert.equal(eventBinding(press({ key: "é", code: "Digit2", ctrlKey: true })), "mod+é");
		assert.equal(eventBinding(press({ key: "ж", code: "Semicolon", ctrlKey: true })), "mod+ж");
		assert.equal(eventBinding(press({ key: "λ", code: "", ctrlKey: true })), "mod+λ");
		assert.equal(eventBinding(press({ key: "Dead", code: "KeyN", altKey: true })), "alt+dead");
		assert.equal(eventBinding(press({ key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true })), "mod+arrowleft");
		assert.equal(eventBinding(press({ key: "?", code: "Slash", ctrlKey: true, shiftKey: true })), "mod+shift+?");
	});
});
