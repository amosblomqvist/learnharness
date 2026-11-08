import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { setDictationActive } from "../components/dictation-state.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import type { UserSettings } from "../src/core/index.ts";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const trigger = () => byTest("dictation-device");
const menu = () => document.querySelector('[data-testid="dictation-device-menu"]');
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="dictation-device-list"] button')];
const click = async (element: HTMLElement) => { assert(element); await act(async () => { element.click(); }); };
/** Flush the picker's async enumerate (enumerateDevices → optional getUserMedia → re-enumerate → setState). */
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };

type DeviceState = {
	record: UserSettings;
	writes: Record<string, unknown>[];
	devices: { deviceId: string; kind: string; label: string }[];
	granted: boolean;
	deny: boolean;
	getUserMediaCalls: number;
};

async function fixture(record?: UserSettings) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.scrollIntoView = () => {};
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 200, bottom: 230, left: 400, right: 500, width: 100, height: 30, x: 400, y: 200, toJSON() {} });
	const changeListeners = new Set<() => void>();
	const state: DeviceState = {
		record: record ?? ({ version: 1, dictation: { language: "en" } } as UserSettings),
		writes: [],
		devices: [
			{ deviceId: "default", kind: "audioinput", label: "Default - MacBook Microphone" },
			{ deviceId: "mic-builtin", kind: "audioinput", label: "MacBook Microphone" },
			{ deviceId: "mic-usb", kind: "audioinput", label: "USB Mic" },
			{ deviceId: "spk", kind: "audiooutput", label: "MacBook Speakers" },
		],
		granted: false,
		deny: false,
		getUserMediaCalls: 0,
	};
	const mediaDevices = {
		async enumerateDevices() {
			// Chromium/Electron before a mic grant: ONE id-less, label-less
			// placeholder per kind — the real devices stay hidden until the
			// first getUserMedia. Only a granted session reveals them.
			if (!state.granted) {
				return [
					{ deviceId: "", kind: "audioinput", label: "", groupId: "", toJSON() {} },
					{ deviceId: "", kind: "audiooutput", label: "", groupId: "", toJSON() {} },
				];
			}
			return state.devices.map((d) => ({ ...d, groupId: "g", toJSON() {} }));
		},
		async getUserMedia() {
			state.getUserMediaCalls++;
			if (state.deny) throw new DOMException("denied", "NotAllowedError");
			state.granted = true;
			return { getTracks: () => [{ stop() {} }] };
		},
		addEventListener(_type: string, cb: () => void) { changeListeners.add(cb); },
		removeEventListener(_type: string, cb: () => void) { changeListeners.delete(cb); },
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
		Event: win.Event, CustomEvent: win.CustomEvent, DOMException: win.DOMException ?? globalThis.DOMException,
		IS_REACT_ACT_ENVIRONMENT: true,
		// react-dom reads navigator.userAgent at load, so keep it alongside the
		// overridden mediaDevices.
		navigator: { userAgent: globalThis.navigator?.userAgent ?? "node", mediaDevices },
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: state.record });
			assert.equal(url, "/api/settings/dictation");
			const body = JSON.parse(init!.body as string);
			state.writes.push(body);
			state.record = { ...state.record, dictation: body };
			return Response.json({ settings: state.record });
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const { createRoot } = await import("react-dom/client");
	const { DictationInputDeviceSetting } = await import("../components/dictation-device.tsx");
	let root = createRoot(doc.getElementById("root")!);
	const mount = async () => { await act(async () => { root.render(<DictationInputDeviceSetting />); }); };
	dispose = async () => { await act(async () => { setDictationActive(false); root.unmount(); }); };
	await mount();
	// Refresh the shared window-lifetime store from THIS fixture's record.
	await act(async () => { notifySettingsSaved("dictation"); });
	await settle();
	return {
		state,
		emitDeviceChange: async () => { await act(async () => { for (const cb of changeListeners) cb(); await Promise.resolve(); }); },
		remount: async () => { await dispose!(); root = createRoot(doc.getElementById("root")!); await mount(); await settle(); },
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("lists audio inputs under System default and saves the chosen id with its label", async () => {
	const f = await fixture();
	assert.match(trigger().textContent!, /System default/);
	await click(trigger());
	await settle();
	assert.deepEqual(options().map((o) => o.textContent), ["System default", "MacBook Microphone", "USB Mic"]);
	assert.equal(f.state.getUserMediaCalls, 1, "opening requests permission once to reveal labels");
	await click(byTest("dictation-device-mic-usb"));
	assert.deepEqual(f.state.writes, [{ language: "en", inputDeviceId: "mic-usb", inputDeviceLabel: "USB Mic" }]);
	assert.match(trigger().textContent!, /USB Mic/);
	assert.equal(menu(), null);
	await f.remount();
	assert.match(trigger().textContent!, /USB Mic/);
});

test("a denied permission still requests access once and leaves the menu usable", async () => {
	const f = await fixture();
	f.state.deny = true;
	await click(trigger());
	await settle();
	// The prompt was attempted; denied, the id-less placeholders stay hidden,
	// so System default is all that remains selectable (Chromium behavior).
	assert.equal(f.state.getUserMediaCalls, 1);
	assert.deepEqual(options().map((o) => o.textContent), ["System default"]);
	assert(menu(), "the menu stays open and usable after a denied prompt");
});

test("selecting System default clears a pinned device", async () => {
	const f = await fixture({ version: 1, dictation: { language: "en", inputDeviceId: "mic-usb", inputDeviceLabel: "USB Mic" } } as UserSettings);
	assert.match(trigger().textContent!, /USB Mic/);
	await click(trigger());
	await settle();
	await click(byTest("dictation-device-system-default"));
	assert.deepEqual(f.state.writes, [{ language: "en" }]);
	assert.match(trigger().textContent!, /System default/);
});

test("a disconnected pinned device still shows its saved label", async () => {
	await fixture({ version: 1, dictation: { language: "en", inputDeviceId: "mic-gone", inputDeviceLabel: "Studio Mic" } } as UserSettings);
	assert.match(trigger().textContent!, /Studio Mic/);
});

test("the device list refreshes when devices change while the menu is open", async () => {
	const f = await fixture();
	await click(trigger());
	await settle();
	assert.equal(options().length, 3);
	f.state.devices = f.state.devices.filter((d) => d.deviceId !== "mic-usb");
	await f.emitDeviceChange();
	await settle();
	assert.deepEqual(options().map((o) => o.textContent), ["System default", "MacBook Microphone"]);
});

test("capture locks the row and dismisses an open device menu until capture ends", async () => {
	await fixture();
	await click(trigger());
	await settle();
	assert(menu());
	await act(async () => { setDictationActive(true); });
	assert.equal(trigger().disabled, true);
	assert.match(byTest("row-dictation-device").className, /opacity-40/);
	assert.equal(menu(), null);
	await act(async () => { setDictationActive(false); });
	assert.equal(trigger().disabled, false);
});
