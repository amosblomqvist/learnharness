import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { generate } from "selfsigned";
import { readTransferMember, parseTransferJson } from "./lesson-export.ts";
import { atomic } from "./lesson-import.ts";

export const lanHash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type LanIdentity = { version: 1; id: string; port: number; cert: string; privateKey: string;
	devices: { id: string; name: string; tokenHash: string }[] };
function folder(root: string) {
	const dir = path.join(root, "lesson-lan");
	for (const p of [root, dir]) if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error("Invalid LAN storage");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}
export function saveLanIdentity(root: string, identity: LanIdentity) {
	const file = path.join(folder(root), "identity.json");
	if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("Invalid LAN storage");
	atomic(file, Buffer.from(JSON.stringify(identity)));
}
export async function loadLanIdentity(root: string): Promise<LanIdentity> {
	const file = path.join(folder(root), "identity.json");
	if (fs.existsSync(file)) {
		if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Invalid LAN storage");
		const v = parseTransferJson(readTransferMember(file, false, 131072)) as LanIdentity;
		if (v.version !== 1 || typeof v.cert !== "string" || typeof v.privateKey !== "string" || !/^[a-f0-9-]{36}$/.test(v.id) ||
			!Number.isInteger(v.port) || v.port < 0 || v.port > 65535 || !Array.isArray(v.devices) || v.devices.length > 16 ||
			v.devices.some(d => !/^[a-f0-9]{64}$/.test(d.tokenHash) || !/^[a-f0-9-]{36}$/.test(d.id) || typeof d.name !== "string" || d.name.length > 100)) throw new Error("Invalid LAN identity");
		return v;
	}
	const pems = await generate([{ name: "commonName", value: "LearnHarness LAN" }], {
		keyType: "ec", curve: "P-256", algorithm: "sha256",
		extensions: [{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true }, { name: "extKeyUsage", serverAuth: true }],
	});
	const identity: LanIdentity = { version: 1, id: randomUUID(), port: 0, cert: pems.cert, privateKey: pems.private, devices: [] };
	saveLanIdentity(root, identity); return identity;
}

export function lanReceipt(root: string, peer: string, operation: string): { requestHash: string; installed: string[]; unchanged: number } | undefined {
	if (!/^[a-f0-9-]{36}$/.test(peer) || !/^[a-f0-9-]{36}$/.test(operation)) throw new Error("Invalid receipt");
	const file = path.join(root, "lesson-transfers", "receipts", `${peer}_${operation}.json`);
	if (!fs.existsSync(file)) return;
	if ([path.dirname(file), file].some(p => fs.lstatSync(p).isSymbolicLink())) throw new Error("Invalid receipt storage");
	return parseTransferJson(readTransferMember(file, false, 65536)) as ReturnType<typeof lanReceipt>;
}
