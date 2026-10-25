import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

const source = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
describe("Electron legacy subscription preload API", () => {
 it("dispatches old provider-key controls only on the separate legacy channel", async () => {
  const ipc = new EventEmitter() as EventEmitter & { invoke: (...args: unknown[]) => Promise<unknown> };
  const calls: unknown[][] = [];
  ipc.invoke = async (...args) => { calls.push(args); return { available: true }; };
  let exposed: any;
  runInNewContext(source, {
   process: { platform: "darwin" },
   require: () => ({
    contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { exposed = api; } },
    ipcRenderer: ipc,
   }),
  });
  assert.deepEqual(Object.keys(exposed.legacySubscriptions).sort(), ["cancel", "consent", "disconnect", "login", "logout", "onChange", "select", "status"]);
  assert.equal("lease" in exposed.legacySubscriptions, false);
  assert.equal("token" in exposed.legacySubscriptions, false);
  await exposed.legacySubscriptions.status("subscription-anthropic");
  await exposed.legacySubscriptions.login("subscription-anthropic", "acct-1", false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
   ["lh:legacy-subscriptions:control", { provider: "subscription-anthropic", op: "status" }],
   ["lh:legacy-subscriptions:control", { provider: "subscription-anthropic", op: "login", id: "acct-1", allowBackgroundUse: false }],
  ]);
  assert.deepEqual(Object.keys(exposed.subscriptions).sort(), ["cancel", "consent", "disconnect", "login", "onChange", "open", "respond", "retry", "status"]);
  assert.equal(calls.some(([channel]) => channel === "lh:subscriptions:control"), false);
 });
 it("subscribes and unsubscribes only to the legacy changed channel", () => {
  const ipc = new EventEmitter() as EventEmitter & { invoke: () => Promise<unknown> };
  ipc.invoke = async () => undefined;
  let exposed: any;
  runInNewContext(source, { process: { platform: "darwin" }, require: () => ({ contextBridge: { exposeInMainWorld: (_: string, api: unknown) => { exposed = api; } }, ipcRenderer: ipc }) });
  let calls = 0;
  const dispose = exposed.legacySubscriptions.onChange(() => calls++);
  ipc.emit("lh:subscriptions:changed");
  ipc.emit("lh:legacy-subscriptions:changed");
  assert.equal(calls, 1);
  dispose(); ipc.emit("lh:legacy-subscriptions:changed"); assert.equal(calls, 1);
 });
});
