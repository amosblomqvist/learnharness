import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
const require = createRequire(import.meta.url);
const { createIdentity, loadIdentity, fingerprint } = require("../electron/phone-access-cert.cjs");

test("self-signed certificate parses, verifies with its own key, and is valid now", () => {
	const now = new Date("2026-11-25T12:00:00Z");
	const { key, cert } = createIdentity({ now, commonName: "LearnHarness test" });
	const x509 = new crypto.X509Certificate(cert);
	assert.ok(x509.verify(x509.publicKey), "self-signature");
	assert.ok(x509.checkPrivateKey(crypto.createPrivateKey(key)));
	assert.equal(x509.subject, "CN=LearnHarness test");
	assert.equal(x509.issuer, "CN=LearnHarness test");
	assert.equal(x509.ca, false);
	assert.equal(x509.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
	assert.ok(new Date(x509.validFrom) < now && new Date(x509.validTo) > new Date("2036-11-24T00:00:00Z"));
	assert.deepEqual(x509.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
});

test("validity after 2049 switches to GeneralizedTime and still parses", () => {
	const { cert } = createIdentity({ now: new Date("2045-01-01T00:00:00Z"), years: 10 });
	assert.match(new crypto.X509Certificate(cert).validTo, /2055/);
});

test("a TLS client pinning the fingerprint completes a handshake", async () => {
	const { key, cert } = createIdentity();
	const pin = fingerprint(cert);
	const server = https.createServer({ key, cert }, (_req, res) => res.end("ok"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		const body = await new Promise<string>((resolve, reject) => {
			const req = https.get({ host: "127.0.0.1", port, rejectUnauthorized: false }, (res) => {
				const seen = (res.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256.replace(/:/g, "").toLowerCase();
				if (seen !== pin) reject(new Error("pin mismatch"));
				res.setEncoding("utf8"); let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolve(text));
			});
			req.on("error", reject);
		});
		assert.equal(body, "ok");
	} finally {
		server.close();
	}
});

test("identity is created once, reused, and its key file is private", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-phone-cert-"));
	try {
		const first = loadIdentity(dir);
		const again = loadIdentity(dir);
		assert.equal(again.fingerprint, first.fingerprint);
		assert.equal(fs.statSync(path.join(dir, "key.pem")).mode & 0o777, 0o600);
		fs.writeFileSync(path.join(dir, "key.pem"), createIdentity().key); // mismatched pair → replaced
		assert.notEqual(loadIdentity(dir).fingerprint, first.fingerprint);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
