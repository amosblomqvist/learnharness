import { test } from "node:test";
import assert from "node:assert/strict";
import { mobileShareLink } from "../components/mobile-runtime";

const base = { available: true, enabled: true, remote: false, message: "" };

test("home mobile link shows the direct link even when Tailscale Serve HTTPS is up", () => {
	assert.equal(mobileShareLink({ ...base, serving: true, url: "https://pc.ts.net:9443", directUrl: "http://100.1.2.3:9081" }), "http://100.1.2.3:9081");
	assert.equal(mobileShareLink({ ...base, serving: false, url: "https://pc.ts.net:9443", directUrl: "http://100.1.2.3:9081" }), "http://100.1.2.3:9081");
});

test("home mobile link never falls back to the HTTPS link", () => {
	assert.equal(mobileShareLink({ ...base, serving: true, url: "https://pc.ts.net:9443", directUrl: null }), null);
	assert.equal(mobileShareLink({ ...base, serving: false, url: "https://pc.ts.net:9443", directUrl: null }), null);
});

test("home mobile link is hidden when off, unavailable, or on the phone", () => {
	const ready = { serving: true, url: "https://pc.ts.net:9443", directUrl: "http://100.1.2.3:9081" };
	assert.equal(mobileShareLink(undefined), null);
	assert.equal(mobileShareLink({ ...base, ...ready, enabled: false }), null);
	assert.equal(mobileShareLink({ ...base, ...ready, available: false }), null);
	assert.equal(mobileShareLink({ ...base, ...ready, remote: true }), null);
});

test("mobile link QR code encodes the exact link as a scannable SVG", async () => {
	const { mobileLinkQrSvg } = await import("../components/mobile-link-qr");
	const QRCode = (await import("qrcode")).default;
	const link = "https://pc.tail1234.ts.net:9443";
	const svg = await mobileLinkQrSvg(link);
	assert.match(svg, /^<svg[^>]*viewBox=/);
	assert.match(svg, /fill="#ffffff"/);
	assert.match(svg, /stroke="#000000"/);
	const encoded = QRCode.create(link, { errorCorrectionLevel: "M" }).segments
		.map(segment => { const data = (segment as { data: string | Uint8Array }).data; return typeof data === "string" ? data : new TextDecoder().decode(data); })
		.join("");
	assert.equal(encoded, link);
});

test("QR code always uses the direct link and hides without one", async () => {
	const { mobileQrLink } = await import("../components/mobile-runtime");
	assert.equal(mobileQrLink({ ...base, serving: true, url: "https://pc.ts.net:9443", directUrl: "http://100.1.2.3:9081" }), "http://100.1.2.3:9081");
	assert.equal(mobileQrLink({ ...base, serving: true, url: "https://pc.ts.net:9443", directUrl: null }), null);
	assert.equal(mobileQrLink({ ...base, serving: true, url: "https://pc.ts.net:9443", directUrl: "http://100.1.2.3:9081", remote: true }), null);
});
