"use strict";
const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { subscriptionFileStore } = require("./legacy-subscriptions.cjs");
const { fileStore } = require("./subscription-store.cjs");
/** Migrate only the active legacy Grok credential, and only into an empty upstream xAI store. */
async function migrateLegacyGrok({ directory, legacyStore, upstreamStore }) {
	const target = path.join(directory, "xai-credentials.json");
	const targetExists = async () => {
		try { await fs.lstat(target); return true; }
		catch (error) { if (error?.code === "ENOENT") return false; throw error; }
	};
	// An existing record, including an empty, corrupt, or symlinked record, is
	// authoritative. Never inspect legacy files once a native store exists.
	if (await targetExists()) return false;
	const oldStore = legacyStore ?? subscriptionFileStore(path.join(directory, "subscription-credentials", "subscription-xai.json"), "subscription-xai");
	const newStore = upstreamStore ?? fileStore(target, "xai");
	const old = await oldStore.read();
	if (!old || !old.activeId) return false;
	const account = old.accounts.find((item) => item.id === old.activeId && item.credential);
	if (!account) return false;
	// Recheck both file existence and store state immediately before committing;
	// a user-created or disconnected native store must never be resurrected.
	if (await targetExists()) return false;
	const current = await newStore.read();
	if (current.credential || await targetExists()) return false;
	await newStore.write({ version: 1, allowBackgroundUse: old.allowBackgroundUse, connectionId: randomUUID(), credential: account.credential });
	return true;
}
module.exports = { migrateLegacyGrok };
