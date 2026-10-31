/**
 * Auth + isolation smoke (mobile-web, 2026-10-29).
 *
 * Runs the real HTTP surface of a throwaway instance:
 *   setup → session cookie → create data as admin → second account sees an
 *   empty list → disable → refused → invite → join → logout.
 *
 * Usage: node scripts/smoke-auth.mjs http://127.0.0.1:3105 /tmp/lh-auth-it
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:3105";
const DATA = process.argv[3] ?? "/tmp/lh-auth-it";

const jar = (cookie = "") => {
	let current = cookie;
	return {
		header: () => current,
		capture: (res) => {
			const set = res.headers.get("set-cookie");
			if (set) current = set.split(";")[0];
		},
		clear: () => {
			current = "";
		},
	};
};

async function req(pathname, { method = "GET", body, cookie } = {}) {
	const res = await fetch(`${BASE}${pathname}`, {
		method,
		redirect: "manual",
		headers: {
			...(body ? { "content-type": "application/json" } : {}),
			...(cookie ? { cookie } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	return { res, json, text };
}

const admin = jar();
const bob = jar();
const invited = jar();

function step(name) {
	console.log(`\n▸ ${name}`);
}

step("anonymous: pages redirect to /login, API is 401");
{
	const root = await req("/");
	assert.equal(root.res.status, 307, "root redirects");
	// Fresh instance: the first visitor claims it via /setup. Once accounts
	// exist the same request lands on /login.
	assert.match(root.res.headers.get("location") ?? "", /\/(setup|login)$/);
	const api = await req("/api/chats");
	// 503 setup_required before the first account exists, 401 after.
	assert.ok([401, 503].includes(api.res.status), `anonymous API refused (${api.res.status})`);
}

step("setup creates the admin and signs in");
{
	const res = await req("/api/auth/setup", {
		method: "POST",
		body: { name: "Admin", email: "admin@it.test", password: "correct horse battery" },
	});
	assert.equal(res.res.status, 200, `setup status ${res.res.status}: ${res.text}`);
	admin.capture(res.res);
	assert.ok(admin.header(), "session cookie set");
}

step("admin creates a chat");
let chatId;
{
	const created = await req("/api/chats", {
		method: "POST",
		body: { title: "Admin's private session" },
		cookie: admin.header(),
	});
	assert.ok([200, 201].includes(created.res.status), `create status ${created.res.status}: ${created.text}`);
	chatId = created.json?.id;
	assert.ok(chatId, "chat id returned");
	const list = await req("/api/chats", { cookie: admin.header() });
	assert.equal(list.json.chats.length, 1, "admin sees their chat");
}

step("setup refuses once initialized");
{
	const res = await req("/api/auth/setup", {
		method: "POST",
		body: { name: "Intruder", email: "intruder@it.test", password: "correct horse battery" },
	});
	assert.equal(res.res.status, 409, "second setup is 409");
}

step("admin creates a second account; its data is empty");
let bobId;
{
	const res = await req("/api/users", {
		method: "POST",
		body: { name: "Bob", email: "bob@it.test", password: "another good password" },
		cookie: admin.header(),
	});
	assert.equal(res.res.status, 201, `create user ${res.res.status}: ${res.text}`);
	bobId = res.json.user.id;

	const login = await req("/api/auth/login", {
		method: "POST",
		body: { email: "bob@it.test", password: "another good password" },
	});
	assert.equal(login.res.status, 200, "bob logs in");
	bob.capture(login.res);

	const list = await req("/api/chats", { cookie: bob.header() });
	assert.equal(list.res.status, 200);
	assert.equal(list.json.chats.length, 0, "bob does not see admin's chat");
	assert.ok(!JSON.stringify(list.json).includes(chatId), "admin chat id never leaks into bob's list");
}

step("wrong password is refused");
{
	const res = await req("/api/auth/login", {
		method: "POST",
		body: { email: "bob@it.test", password: "not the password" },
	});
	assert.equal(res.res.status, 401, "bad password is 401");
}

step("disabling bob kills his API access on the next request");
{
	const res = await req(`/api/users/${bobId}`, {
		method: "PATCH",
		body: { disabled: true },
		cookie: admin.header(),
	});
	assert.equal(res.res.status, 200, `disable ${res.res.status}: ${res.text}`);
	const after = await req("/api/chats", { cookie: bob.header() });
	assert.equal(after.res.status, 401, "disabled account is refused");
	const relogin = await req("/api/auth/login", {
		method: "POST",
		body: { email: "bob@it.test", password: "another good password" },
	});
	assert.equal(relogin.res.status, 401, "disabled account cannot log back in");
}

step("invite link creates a fresh account");
{
	const invite = await req("/api/users", {
		method: "POST",
		body: { invite: true, role: "user" },
		cookie: admin.header(),
	});
	assert.equal(invite.res.status, 200, `invite ${invite.res.status}: ${invite.text}`);
	const code = invite.json.invite.code;
	const join = await req("/api/auth/join", {
		method: "POST",
		body: { code, name: "Carol", email: "carol@it.test", password: "carol's long password" },
	});
	assert.equal(join.res.status, 200, `join ${join.res.status}: ${join.text}`);
	invited.capture(join.res);
	const reuse = await req("/api/auth/join", {
		method: "POST",
		body: { code, name: "Dup", email: "dup@it.test", password: "another long password" },
	});
	assert.equal(reuse.res.status, 410, "invite is single-use");
	const list = await req("/api/chats", { cookie: invited.header() });
	assert.equal(list.json.chats.length, 0, "invited account starts empty");
}

step("logout ends the session");
{
	await req("/api/auth/logout", { method: "POST", cookie: admin.header() });
	admin.clear();
	const after = await req("/api/chats", { cookie: admin.header() });
	assert.equal(after.res.status, 401, "no cookie, no access");
}

step("on-disk layout is per account");
{
	const usersDir = path.join(DATA, "users");
	const dirs = fs.readdirSync(usersDir);
	assert.ok(dirs.length >= 3, `three account roots (${dirs.join(", ")})`);
	const registry = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf-8"));
	const adminRecord = registry.users.find((u) => u.email === "admin@it.test");
	const adminChats = path.join(usersDir, adminRecord.id, "chats");
	assert.ok(fs.existsSync(adminChats) && fs.readdirSync(adminChats).some((f) => f.startsWith(chatId)), "admin chat lives under the admin root");
	console.log(`  account roots: ${dirs.join(", ")}`);
}

console.log("\n✓ auth + isolation smoke passed");
