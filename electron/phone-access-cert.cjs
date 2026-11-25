"use strict";

// Self-signed TLS identity for Phone access. Phones never validate it against
// a CA: they pin its SHA-256 fingerprint, learned from the pairing QR code. So the certificate only needs to be
// well-formed, stable, and private-key protected.
//
// Node can make keys and signatures but not X.509 certificates, so this writes
// the few DER structures by hand (EC P-256, ECDSA-SHA256, X.509 v3).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// ─── Minimal DER ──────────────────────────────────────────────────────────
function length(n) {
	if (n < 0x80) return Buffer.from([n]);
	const bytes = [];
	for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (n, body) => tlv(0xa0 + n, body);
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octets = (body) => tlv(0x04, body);
const utf8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
function integer(bytes) {
	let b = Buffer.from(bytes);
	while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
	if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
	return tlv(0x02, b);
}
const bitString = (body, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), body]));
function oid(dotted) {
	const [a, b, ...rest] = dotted.split(".").map(Number);
	const out = [40 * a + b];
	for (const value of rest) {
		const chunk = [value & 0x7f];
		for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
		out.push(...chunk);
	}
	return tlv(0x06, Buffer.from(out));
}
function time(date) {
	// UTCTime through 2049, GeneralizedTime after (RFC 5280 §4.1.2.5).
	const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
	return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const COMMON_NAME = "2.5.4.3";

/** A new P-256 key and a self-signed certificate for it, both PEM. */
function createIdentity({ commonName = "LearnHarness Phone access", now = new Date(), years = 10 } = {}) {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const name = seq(set(seq(oid(COMMON_NAME), utf8(commonName))));
	const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const notAfter = new Date(now);
	notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
	const serial = crypto.randomBytes(16);
	serial[0] &= 0x7f; // positive
	const extensions = explicit(3, seq(
		seq(oid("2.5.29.19"), bool(true), octets(seq())), // basicConstraints: critical, CA false
		seq(oid("2.5.29.15"), bool(true), octets(bitString(Buffer.from([0x80]), 7))), // keyUsage: critical, digitalSignature
		seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.1")))), // extKeyUsage: serverAuth
	));
	const tbs = seq(
		explicit(0, integer([2])), // v3
		integer(serial),
		ECDSA_SHA256,
		name,
		seq(time(notBefore), time(notAfter)),
		name,
		publicKey.export({ type: "spki", format: "der" }),
		extensions,
	);
	const signature = crypto.sign("sha256", tbs, privateKey); // DER ECDSA-Sig-Value
	const der = seq(tbs, ECDSA_SHA256, bitString(signature));
	const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
	return { key: privateKey.export({ type: "pkcs8", format: "pem" }), cert: pem };
}

/** SHA-256 of the certificate DER, lowercase hex: what phones pin. */
function fingerprint(certPem) {
	return new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, "").toLowerCase();
}


/** Load the identity from `directory`, creating it once. The key file is 0600. */
function loadIdentity(directory, options) {
	const keyFile = path.join(directory, "key.pem"), certFile = path.join(directory, "cert.pem");
	try {
		const key = fs.readFileSync(keyFile, "utf8"), cert = fs.readFileSync(certFile, "utf8");
		const parsed = new crypto.X509Certificate(cert);
		if (parsed.checkPrivateKey(crypto.createPrivateKey(key)) && new Date(parsed.validTo) > new Date()) {
			return { key, cert, fingerprint: fingerprint(cert) };
		}
	} catch (error) {
		if (error?.code !== "ENOENT") { /* unreadable or mismatched: replace below */ }
	}
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const identity = createIdentity(options);
	fs.writeFileSync(keyFile, identity.key, { mode: 0o600 });
	fs.writeFileSync(certFile, identity.cert, { mode: 0o644 });
	return { ...identity, fingerprint: fingerprint(identity.cert) };
}

module.exports = { createIdentity, loadIdentity, fingerprint };
