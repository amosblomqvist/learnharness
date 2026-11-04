#!/usr/bin/env node
/**
 * Sandbox runner: loopback-only, token-gated, one throwaway systemd unit per
 * execution (DynamicUser, no network, read-only FS, hard caps). Root only
 * because systemd-run requires it; payloads never see root. See README.md.
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(path.join(HERE, "languages.json"), "utf8")).languages;

const HOST = process.env.LH_RUNNER_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LH_RUNNER_PORT ?? 3212);
const TOKEN = process.env.LH_RUNNER_TOKEN ?? readToken();
const MAX_CODE_BYTES = 200 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

function readToken() {
	try {
		return readFileSync("/etc/learnharness-runner/token", "utf8").trim();
	} catch {
		return "";
	}
}

/** Fixed sandbox for every run. Kept in one place so it can be reviewed. */
function sandboxArgs(runtimeSec) {
	return [
		"--quiet", "--pipe", "--wait", "--collect",
		"-p", "DynamicUser=yes",
		"-p", "PrivateNetwork=yes",
		"-p", "PrivateTmp=yes",
		"-p", "ProtectSystem=strict",
		"-p", "ProtectHome=yes",
		"-p", "ProtectKernelTunables=yes",
		"-p", "ProtectKernelModules=yes",
		"-p", "ProtectControlGroups=yes",
		"-p", "ProtectClock=yes",
		"-p", "ProtectHostname=yes",
		"-p", "NoNewPrivileges=yes",
		"-p", "RestrictSUIDSGID=yes",
		"-p", "RestrictNamespaces=yes",
		"-p", "RestrictRealtime=yes",
		"-p", "LockPersonality=yes",
		"-p", "SystemCallArchitectures=native",
		// No AF_INET/AF_INET6: belt-and-braces on top of PrivateNetwork.
		"-p", "RestrictAddressFamilies=AF_UNIX AF_NETLINK",
		"-p", "CapabilityBoundingSet=",
		"-p", "AmbientCapabilities=",
		"-p", "MemoryMax=1G",
		"-p", "TasksMax=128",
		"-p", "CPUQuota=200%",
		"-p", "UMask=0077",
		"-p", `RuntimeMaxSec=${runtimeSec}`,
		// Identifiable name so leftovers from a dead parent can be swept.
		"--unit", `lh-run-${randomBytes(4).toString("hex")}`,
		"--", "/bin/bash", "-s",
	];
}

/** Java's file name must match its public class — derive it from the code. */
function javaClassName(code) {
	const m = code.match(/public\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/)
		?? code.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
	return m ? m[1] : "Main";
}

function buildScript(spec, code, stdin, checks = []) {
	const delim = `LH_${randomBytes(8).toString("hex")}`;
	// Checks run in the program's own namespace: appended to the same source,
	// after it. A language without a harness simply gets none.
	const withChecksSource =
		spec.checkAppend && checks.length
			? `${code}\n${spec.checkAppend.replace("__LH_CHECKS__", JSON.stringify(checks).replace(/"""/g, '\\"\\"\\"'))}\n`
			: code;
	// Some runtimes need a header the learner should not have to type
	// (an escript shebang, a #lang line).
	const withPrepend = spec.prepend ? `${spec.prepend}\n${withChecksSource}` : withChecksSource;
	const compileSec = spec.limits?.compileSec ?? 20;
	const runSec = spec.limits?.runSec ?? 5;
	const file = spec.classFromCode && spec.file === "Main.java" ? `${javaClassName(code)}.java` : spec.file;
	const compile = spec.compile?.replace(/\bMain\b/g, spec.classFromCode ? javaClassName(code) : "Main");
	const run = spec.run.replace(/\bMain\b/g, spec.classFromCode ? javaClassName(code) : "Main");

	const envLines = Object.entries(spec.env ?? {})
		.map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
		.join("\n");

	return [
		"set -u",
		"umask 077",
		'mkdir -p "$(mktemp -d)" 2>/dev/null || true',
		'cd "$(mktemp -d)"',
		envLines,
		`cat > ${file} <<'${delim}'`,
		withPrepend,
		"",
		delim,
		`cat > stdin.txt <<'${delim}'`,
		stdin ?? "",
		"",
		delim,
		"echo '@@LH_COMPILE_BEGIN@@'",
		compile
			? `timeout -k 2 ${compileSec} bash -c '${compile.replace(/'/g, `'\\''`)}' 2>&1; echo "@@LH_COMPILE_RC=$?"`
			: 'echo "@@LH_COMPILE_RC=0"',
		"echo '@@LH_COMPILE_END@@'",
		"[ \"${rc:-0}\" = 0 ] || true",
		"echo '@@LH_RUN_BEGIN@@'",
		`timeout -k 2 ${runSec} bash -c '${run.replace(/'/g, `'\\''`)}' < stdin.txt 2>&1; rc=$?; echo "@@LH_RUN_RC=$rc"`,
		"echo '@@LH_RUN_END@@'",
		"",
	].join("\n");
}

function slice(out, begin, end) {
	const i = out.indexOf(begin);
	if (i < 0) return { text: "", rc: null };
	const rest = out.slice(i + begin.length);
	const j = rest.indexOf(end);
	const body = j < 0 ? rest : rest.slice(0, j);
	const rcMatch = body.match(/@@LH_(COMPILE|RUN)_RC=(\d+)/);
	return { text: body.replace(/@@LH_\w+@@\n?/g, "").replace(/@@LH_\w+=\d+\n?/g, "").trimEnd(), rc: rcMatch ? Number(rcMatch[2]) : null };
}

function runSandbox(script, runtimeSec) {
	return new Promise((resolve) => {
		const child = spawn("systemd-run", sandboxArgs(runtimeSec), { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		let killed = false;
		const cap = (s, chunk) => (s.length < MAX_OUTPUT_BYTES ? s + chunk.toString("utf8") : s);
		child.stdout.on("data", (c) => { out = cap(out, c); });
		child.stderr.on("data", (c) => { err = cap(err, c); });
		const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, runtimeSec * 1000 + 5000);
		child.on("error", (e) => { clearTimeout(timer); resolve({ out, err: String(e), code: -1, timedOut: false }); });
		child.on("close", (code) => { clearTimeout(timer); resolve({ out, err, code, timedOut: killed }); });
		child.stdin.end(script);
	});
}

async function probe(language, spec) {
	if (!spec.version) return { available: true, version: null };
	return new Promise((resolve) => {
		let out = "";
		const c = spawn("bash", ["-c", spec.version], { stdio: ["ignore", "pipe", "ignore"] });
		const t = setTimeout(() => { c.kill("SIGKILL"); resolve({ available: false, version: null }); }, 8000);
		c.stdout.on("data", (d) => { out += d.toString("utf8"); });
		c.on("error", () => { clearTimeout(t); resolve({ available: false, version: null }); });
		c.on("close", (code) => {
			clearTimeout(t);
			const v = out.split("\n")[0]?.trim() ?? "";
			if (code === 0) resolve({ available: true, version: v.slice(0, 80) });
			else resolve({ available: false, version: v.slice(0, 80) });
		});
	});
}

/** Probe results are expensive (21 toolchains) and change only on install:
 *  cache them so /health stays cheap enough for a per-page-load check. */
let probeCache = { at: 0, value: null };
async function probeAll() {
	if (probeCache.value && Date.now() - probeCache.at < 60_000) return probeCache.value;
	const entries = await Promise.all(
		Object.entries(MANIFEST).map(async ([id, spec]) => ({ id, label: spec.label, ...(await probe(id, spec)) })),
	);
	probeCache = { at: Date.now(), value: entries };
	return entries;
}

const server = createServer(async (req, res) => {
	const json = (status, body) => {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	};

	if (req.method === "GET" && req.url === "/health") {
		return json(200, { ok: true, languages: await probeAll() });
	}

	// A new runtimes install happens rarely; let the operator refresh without a restart.
	if (req.method === "POST" && req.url === "/refresh") {
		if (!TOKEN || req.headers["x-lh-runner-token"] !== TOKEN) return json(401, { error: "unauthorized" });
		probeCache = { at: 0, value: null };
		return json(200, { ok: true, languages: await probeAll() });
	}

	if (req.method !== "POST" || req.url !== "/execute") return json(404, { error: "not found" });

	if (!TOKEN || req.headers["x-lh-runner-token"] !== TOKEN) {
		return json(401, { error: "unauthorized" });
	}

	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > MAX_CODE_BYTES + MAX_STDIN_BYTES + 4096) return json(413, { error: "payload too large" });
	}
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return json(400, { error: "invalid JSON" });
	}
	const { language, code, stdin, checks } = parsed ?? {};
	const wantedChecks = Array.isArray(checks)
		? checks.slice(0, 12).map((c) => ({
				expr: String(c?.expr ?? "").slice(0, 400),
				expect: String(c?.expect ?? "").slice(0, 400),
				label: String(c?.label ?? c?.expr ?? "").slice(0, 200),
			})).filter((c) => c.expr)
		: [];
	const spec = MANIFEST[language];
	if (!spec) return json(400, { error: `unsupported language: ${String(language)}` });
	if (typeof code !== "string" || code.length === 0) return json(400, { error: "code required" });
	if (Buffer.byteLength(code) > MAX_CODE_BYTES) return json(413, { error: "code too large" });
	if (stdin !== undefined && Buffer.byteLength(String(stdin)) > MAX_STDIN_BYTES) return json(413, { error: "stdin too large" });

	const runtimeSec = (spec.limits?.compileSec ?? 0) + (spec.limits?.runSec ?? 5) + 15;
	const result = await runSandbox(buildScript(spec, code, stdin, wantedChecks), runtimeSec);

	const parseChecks = (text) =>
		text
			.split("\n")
			.filter((l) => l.startsWith("@@LH_CHECK "))
			.map((l) => {
				const [, verdict, ...rest] = l.split(" ");
				return { label: rest.join(" "), pass: verdict === "PASS" };
			});
	const stripChecks = (text) => text.split("\n").filter((l) => !l.startsWith("@@LH_CHECK ")).join("\n");
	const compileFrom = slice(result.out, "@@LH_COMPILE_BEGIN@@", "@@LH_COMPILE_END@@");
	const runFrom = slice(result.out, "@@LH_RUN_BEGIN@@", "@@LH_RUN_END@@");

	// A sandbox-level failure (systemd refused the unit, runtime cap hit) has no
	// markers at all — report it as such rather than pretending the code failed.
	const sandboxError = !result.out.includes("@@LH_RUN_RC=") ? (result.err.trim() || "sandbox did not run") : null;

	return json(200, {
		engine: "sandbox",
		language,
		compile: { ok: compileFrom.rc === 0, stderr: compileFrom.text.slice(0, 4000), exit: compileFrom.rc },
		run: {
			stdout: stripChecks(runFrom.text).slice(0, 8000),
			exit: runFrom.rc,
			timedOut: runFrom.rc === 124,
		},
		...(spec.checkAppend && wantedChecks.length ? { checks: parseChecks(runFrom.text) } : {}),
		sandboxError,
		truncated: result.out.length >= MAX_OUTPUT_BYTES,
	});
});

/** A runner restart can leave a unit behind; they are capped by RuntimeMaxSec,
 *  but stop them now rather than letting them finish compiling. */
function sweepOrphans() {
	const list = spawnSync("systemctl", ["list-units", "lh-run-*", "--plain", "--no-legend", "--no-pager"]);
	const names = String(list.stdout ?? "").split("\n").map((l) => l.split(" ")[0]).filter((n) => n?.startsWith("lh-run-"));
	for (const name of names) spawn("systemctl", ["stop", name], { stdio: "ignore" });
	if (names.length) console.log(`[lh-runner] swept ${names.length} orphaned unit(s)`);
}

server.listen(PORT, HOST, () => {
	sweepOrphans();
	console.log(`[lh-runner] listening on http://${HOST}:${PORT} (token ${TOKEN ? "loaded" : "MISSING"})`);
});
