import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { migrateLegacyGrok } = require("../electron/subscription-migration.cjs");
const { subscriptionFileStore } = require("../electron/legacy-subscriptions.cjs");
const { fileStore } = require("../electron/subscription-store.cjs");
const credential = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000 };
const state = (allowBackgroundUse = false) => ({ version: 1, provider: "subscription-xai", activeId: "g1", allowBackgroundUse, accounts: [{ id: "g1", label: "Grok account 1", credential }] });
test("migrates only active legacy Grok credential into an empty upstream store and keeps consent", async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-migration-"));
 try {
  const old = subscriptionFileStore(path.join(dir, "legacy.json"), "subscription-xai");
  const upstream = fileStore(path.join(dir, "xai-credentials.json"), "xai");
  await old.write(state(false));
  assert.equal(await migrateLegacyGrok({ directory: dir, legacyStore: old, upstreamStore: upstream }), true);
  assert.deepEqual(await upstream.read(), { version: 1, allowBackgroundUse: false, connectionId: (await upstream.read()).connectionId, credential });
  assert.deepEqual(await old.read(), state(false));
  const stat = await fs.stat(path.join(dir, "xai-credentials.json")); assert.equal(stat.mode & 0o777, 0o600);
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("never overwrites upstream credentials or migrates a non-active legacy account", async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-migration-"));
 try {
  const old = subscriptionFileStore(path.join(dir, "legacy.json"), "subscription-xai");
  const upstream = fileStore(path.join(dir, "xai-credentials.json"), "xai");
  await old.write({ ...state(), activeId: null });
  assert.equal(await migrateLegacyGrok({ directory: dir, legacyStore: old, upstreamStore: upstream }), false);
  await upstream.write({ version: 1, allowBackgroundUse: true, connectionId: "123e4567-e89b-42d3-a456-426614174000", credential });
  await old.write(state());
  assert.equal(await migrateLegacyGrok({ directory: dir, legacyStore: old, upstreamStore: upstream }), false);
  assert.equal((await upstream.read()).allowBackgroundUse, true);
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("an existing empty or disconnected native store is authoritative across restarts", async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-migration-"));
 try {
  const old = subscriptionFileStore(path.join(dir, "legacy.json"), "subscription-xai");
  const upstream = fileStore(path.join(dir, "xai-credentials.json"), "xai");
  await old.write(state());
  await upstream.write({ version: 1, allowBackgroundUse: true });
  assert.equal(await migrateLegacyGrok({ directory: dir, legacyStore: old, upstreamStore: upstream }), false);
  await upstream.write({ version: 1, allowBackgroundUse: true, connectionId: "123e4567-e89b-42d3-a456-426614174000", credential });
  // Model a user disconnect: credential removed, but the upstream store remains.
  await upstream.write({ version: 1, allowBackgroundUse: true });
  assert.equal(await migrateLegacyGrok({ directory: dir, legacyStore: old, upstreamStore: upstream }), false);
  assert.equal((await upstream.read()).credential, undefined);
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("existing symlink target skips migration before legacy read; corrupt legacy never blocks an existing native store", async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-migration-"));
 try {
  const legacyPath = path.join(dir, "legacy.json"), target = path.join(dir, "xai-credentials.json");
  const old = subscriptionFileStore(legacyPath, "subscription-xai");
  const upstream = fileStore(target, "xai");
  await fs.writeFile(legacyPath, "invalid fixture JSON");
  await fs.writeFile(path.join(dir, "target-fixture"), "not a credential");
  await fs.symlink(path.join(dir, "target-fixture"), target);
  assert.equal(await migrateLegacyGrok({ directory: dir, legacyStore: old, upstreamStore: upstream }), false);
  await fs.unlink(target);
  await fs.writeFile(target, "corrupt native fixture");
  assert.equal(await migrateLegacyGrok({ directory: dir, legacyStore: old, upstreamStore: upstream }), false);
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("corrupt legacy data is contained by the caller and leaves files unchanged", async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-migration-"));
 try {
  const legacyPath = path.join(dir, "legacy.json");
  const old = subscriptionFileStore(legacyPath, "subscription-xai");
  await fs.writeFile(legacyPath, "invalid fixture JSON");
  await assert.rejects(migrateLegacyGrok({ directory: dir, legacyStore: old }), /./);
  assert.equal(await fs.readFile(legacyPath, "utf8"), "invalid fixture JSON");
  assert.equal(await fs.stat(path.join(dir, "xai-credentials.json")).then(() => true, () => false), false);
 } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
