/** Exercise the real dictation hook using fake capture and sockets; no audio or network. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";

it("uses the saved language, retains it on reconnect, then picks up a new language next run", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const replacements: Record<string, unknown> = {
		window: dom.window, document: dom.document,
		navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
		AudioContext: class {
			state = "running";
			destination = {};
			audioWorklet = { addModule: async () => {} };
			createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
		},
		AudioWorkletNode: class {
			port = { onmessage: null };
			connect() {}
			disconnect() {}
		},
	};
	class Socket extends EventTarget {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSED = 3;
		static sockets: Socket[] = [];
		readyState = Socket.CONNECTING;
		constructor(public url: string, public protocols: string[]) { super(); Socket.sockets.push(this); }
		send() {}
		close() { this.readyState = Socket.CLOSED; }
		open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
		loseConnection() {
			this.readyState = Socket.CLOSED;
			const event = new Event("close"); Object.assign(event, { code: 1006 }); this.dispatchEvent(event);
		}
	}
	let language = "ru";
	let settingsReads = 0;
	replacements.WebSocket = Socket;
	replacements.fetch = async (url: string) => {
		if (url === "/api/stt/token") return Response.json({ token: "test-token" });
		assert.equal(url, "/api/settings"); settingsReads++;
		return Response.json({ settings: { version: 1, general: { transcriptionLanguage: language } } });
	};
	const originals = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	let dictation!: Dictation;
	function Harness() { dictation = useDictation({ append() {} }); return null; }
	const root = createRoot(document.getElementById("root")!);
	try {
		await act(async () => { root.render(<Harness />); });
		await act(async () => { dictation.toggle(); });
		assert.equal(Socket.sockets.length, 1);
		const first = Socket.sockets[0]!;
		assert.equal(new URL(first.url).searchParams.get("language"), "ru");
		assert.deepEqual(first.protocols, ["bearer", "test-token"]);
		await act(async () => { first.open(); });
		assert.equal(dictation.phase, "recording");
		language = "multi"; // A settings save during a run applies only to the next run.
		await act(async () => { first.loseConnection(); });
		assert.equal(Socket.sockets.length, 2);
		assert.equal(new URL(Socket.sockets[1]!.url).searchParams.get("language"), "ru");
		assert.equal(settingsReads, 1);
		await act(async () => { dictation.cancel(); });
		await act(async () => { dictation.toggle(); });
		assert.equal(Socket.sockets.length, 3);
		assert.equal(new URL(Socket.sockets[2]!.url).searchParams.get("language"), "multi");
		assert.equal(settingsReads, 2);
	} finally {
		await act(async () => { dictation.cancel(); });
		await act(async () => { root.unmount(); });
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	}
});
