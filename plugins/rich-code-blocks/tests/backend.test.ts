import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { DEFAULT_SETTINGS, FAMILIES, INSTRUCTIONS, parseSettings } from "../src/contract.ts";

function fixture(directory: string) {
  const controller = new AbortController();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const instructions = new Set<{ agents: string[]; text: string }>();
  const events: { topic: string; data: unknown }[] = [];
  const ctx = {
    dataDirectory: directory, signal: controller.signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    registerInstructions(value: { agents: string[]; text: string }) { instructions.add(value); return () => { instructions.delete(value); }; },
    events: { emit(topic: string, data: unknown) { events.push({ topic, data }); } },
  } as unknown as PluginBackendContext;
  return { controller, handlers, instructions, events, activate: () => activate(ctx), call: (name: string, input?: unknown) => handlers.get(name)!(input) };
}

test("all-off startup is nonwriting; only accepted toggles contribute exact prober/teacher/practice prompts and survive restart", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rich-backend-"));
  const directory = path.join(temporary, "data");
  try {
    const host = fixture(directory);
    const dispose = host.activate();
    assert.deepEqual(host.call("get-settings"), DEFAULT_SETTINGS);
    assert.equal(host.instructions.size, 0); assert.equal(fs.existsSync(directory), false);
    for (const family of FAMILIES) {
      const accepted = parseSettings(host.call("set-family", { family, enabled: true }));
      assert.equal(accepted[family], true);
      assert.ok([...host.instructions].some(value => value.text === INSTRUCTIONS[family]));
      assert.ok([...host.instructions].every(value => JSON.stringify(value.agents) === '["prober","teacher","practice"]'));
    }
    assert.equal(host.instructions.size, 3);
    assert.equal(host.events.length, 3);
    const disk = fs.readFileSync(path.join(directory, "settings.json"), "utf8");
    assert.equal(parseSettings(JSON.parse(disk)).revision, 3);
    assert.deepEqual(fs.readdirSync(directory), ["settings.json"]);
    host.call("set-family", { family: "chemicalStructures", enabled: true });
    assert.equal(host.events.length, 3, "Idempotent accepted values don't rewrite or emit.");
    assert.throws(() => host.call("set-family", { family: "chemicalStructures", enabled: "yes" }));
    assert.equal(fs.readFileSync(path.join(directory, "settings.json"), "utf8"), disk);
    dispose(); dispose(); assert.equal(host.instructions.size, 0); assert.equal(host.handlers.size, 0);
    const second = fixture(directory); const disposeSecond = second.activate();
    assert.equal(second.instructions.size, 3);
    // Independent windows update only one key; the backend serializes whole-file writes.
    second.call("set-family", { family: "chemicalStructures", enabled: false });
    const next = parseSettings(second.call("set-family", { family: "musicalNotation", enabled: false }));
    assert.equal(next.technicalDiagrams, true); assert.equal(next.chemicalStructures, false); assert.equal(next.revision, 5);
    assert.deepEqual([...second.instructions], [{ agents: ["prober", "teacher", "practice"], text: INSTRUCTIONS.technicalDiagrams }]);
    second.call("set-family", { family: "technicalDiagrams", enabled: false });
    assert.equal(second.instructions.size, 0, "Disabling every family removes every role's instructions.");
    second.controller.abort(); assert.throws(() => second.call("set-family", { family: "technicalDiagrams", enabled: false }));
    disposeSecond();
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

for (const inkColor of [undefined, "white", "black"]) test(`legacy ${inkColor ?? "absent"} ink is ignored without startup writes; real saves drop it and preserve families`, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rich-theme-"));
  try {
    const file = path.join(directory, "settings.json");
    const canonical = { ...DEFAULT_SETTINGS, revision: 4, technicalDiagrams: true };
    const original = JSON.stringify({ ...canonical, inkColor }) + "\n";
    fs.writeFileSync(file, original);
    const host = fixture(directory); const dispose = host.activate();
    assert.deepEqual(host.call("get-settings"), canonical);
    assert.equal(fs.readFileSync(file, "utf8"), original, "Reading legacy settings must not rewrite them.");
    assert.equal(host.handlers.has("set-ink-color"), false, "the obsolete write operation is removed");
    const instructions = [...host.instructions];
    assert.equal(instructions.length, 1);
    assert.equal(instructions[0]!.text, INSTRUCTIONS.technicalDiagrams);
    host.call("set-family", { family: "technicalDiagrams", enabled: true });
    assert.equal(fs.readFileSync(file, "utf8"), original, "No-op toggles remain nonwriting too.");
    assert.equal([...host.instructions][0], instructions[0]);
    const next = parseSettings(host.call("set-family", { family: "chemicalStructures", enabled: true }));
    assert.deepEqual(next, { ...canonical, revision: 5, chemicalStructures: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), next);
    assert.equal("inkColor" in next, false);
    assert.deepEqual(host.events, [{ topic: "settings-changed", data: next }]);
    dispose(); assert.equal(host.handlers.size, 0);
    const restarted = fixture(directory); const off = restarted.activate();
    assert.deepEqual(restarted.call("get-settings"), next); off();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("malformed/newer settings are refused without overwriting; failed atomic save publishes no accepted state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rich-invalid-"));
  try {
    const file = path.join(directory, "settings.json");
    for (const original of ['{"version":2}', '{broken', JSON.stringify({ ...DEFAULT_SETTINGS, chemicalStructures: 1 })]) {
      fs.writeFileSync(file, original); assert.throws(() => fixture(directory).activate());
      assert.equal(fs.readFileSync(file, "utf8"), original);
    }
    fs.rmSync(file);
    const host = fixture(directory); const dispose = host.activate();
    fs.mkdirSync(file); // rename cannot replace a directory
    assert.throws(() => host.call("set-family", { family: "technicalDiagrams", enabled: true }));
    assert.deepEqual(host.call("get-settings"), DEFAULT_SETTINGS);
    assert.equal(host.instructions.size, 0); assert.equal(host.events.length, 0);
    assert.deepEqual(fs.readdirSync(directory), ["settings.json"]);
    dispose();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
