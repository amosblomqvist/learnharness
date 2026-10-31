/**
 * Print a signed session cookie for an existing account (mobile-web, 2026-10-29).
 * Test harness only: reads the server's own key from the data root, exactly
 * like the server verifies it. Never ships a credential to a browser profile.
 *
 * Usage: node scripts/print-session.mjs <email> [dataDir]
 */

import fs from "node:fs";
import path from "node:path";
import { SignJWT } from "jose";

const email = process.argv[2];
const dataDir = process.argv[3] ?? process.env.LH_DATA_DIR ?? path.join(process.cwd(), "data");
if (!email) throw new Error("usage: node scripts/print-session.mjs <email> [dataDir]");

const key = new Uint8Array(Buffer.from(fs.readFileSync(path.join(dataDir, "session.key"), "utf-8").trim(), "base64url"));
const registry = JSON.parse(fs.readFileSync(path.join(dataDir, "users.json"), "utf-8"));
const account = registry.users.find((u) => u.email === email.toLowerCase());
if (!account) throw new Error(`no account for ${email}`);

const token = await new SignJWT({ email: account.email, role: account.role, ver: account.sessionVersion })
	.setProtectedHeader({ alg: "HS256", typ: "JWT" })
	.setSubject(account.id)
	.setIssuer("learnharness")
	.setIssuedAt()
	.setExpirationTime("3600s")
	.sign(key);

process.stdout.write(token);
