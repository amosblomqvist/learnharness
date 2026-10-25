"use strict";
// Synthetic protocol double, not proof of a native OS key store.
const { randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const key = randomBytes(32);
const syntheticSafeStorage = {
	isEncryptionAvailable: () => true,
	getSelectedStorageBackend: () => "gnome_libsecret",
	encryptString(value) {
		const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
		const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
	},
	decryptString(bytes) {
		const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
		decipher.setAuthTag(bytes.subarray(12, 28));
		return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
	},
};
module.exports = { syntheticSafeStorage };
