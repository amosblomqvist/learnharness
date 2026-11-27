/** Static checks for community catalog releases. Pure functions over the files
 * Install would write (see verifyCommunityRelease) and the source lockfile;
 * the network lives in scripts/check-community-catalog.ts. These checks are a
 * listing gate, not a sandbox: plugins remain trusted code. */

export type CatalogRule = "release-invalid" | "native-binary" | "obfuscation" | "secret" | "malicious-dependency" | "missing-lockfile";
export const CATALOG_RULES: readonly CatalogRule[] = ["release-invalid", "native-binary", "obfuscation", "secret", "malicious-dependency", "missing-lockfile"];
export interface CatalogFinding { rule: CatalogRule; file?: string; detail: string }

const NATIVE_EXTENSIONS = /\.(?:node|exe|dll|so|dylib|wasm|jar|msi|sh|bash|bat|cmd|ps1)$/i;
const NATIVE_SIGNATURES: [string, number[]][] = [
	["ELF", [0x7f, 0x45, 0x4c, 0x46]],
	["PE", [0x4d, 0x5a]],
	["Mach-O", [0xfe, 0xed, 0xfa, 0xce]],
	["Mach-O", [0xfe, 0xed, 0xfa, 0xcf]],
	["Mach-O", [0xce, 0xfa, 0xed, 0xfe]],
	["Mach-O", [0xcf, 0xfa, 0xed, 0xfe]],
	["Mach-O universal or Java class", [0xca, 0xfe, 0xba, 0xbe]],
	["WebAssembly", [0x00, 0x61, 0x73, 0x6d]],
];
const SCRIPT = /\.(?:js|cjs|mjs)$/i;
const DYNAMIC_CODE: [string, RegExp][] = [
	["eval(", /(?<![\w$.])eval\s*\(|\b(?:window|globalThis|self|global)\.eval\s*\(|\(\s*0\s*,\s*eval\s*\)/g],
	["new Function(", /\bnew\s+Function\s*\(/g],
	["Function(\"…\")", /(?<![\w$.])(?<!\bnew\s+)Function\s*\(\s*["'`]/g],
	["string timer", /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g],
];
const OBFUSCATOR_NAME = /\b_0x[0-9a-f]{4,}\b/gi;
const OBFUSCATOR_NAMES = 20;
const BLOB = 4096;
const ENCODED_BLOB = new RegExp(`[A-Za-z0-9+/]{${BLOB},}={0,2}|\\b[0-9a-fA-F]{${BLOB},}\\b`, "g");
const DATA_URI = /data:(?:image|font)\/[\w.+-]+;base64,$/;
const SECRETS: [string, RegExp][] = [
	["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/g],
	["OpenAI key", /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{48}\b/g],
	["OpenRouter key", /sk-or-v1-[a-f0-9]{64}/g],
	["Groq key", /\bgsk_[A-Za-z0-9]{40,}/g],
	["xAI key", /\bxai-[A-Za-z0-9]{40,}/g],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g],
	["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}\b/g],
	["Tavily key", /\btvly-[A-Za-z0-9-]{20,}/g],
	["Firecrawl key", /\bfc-[a-f0-9]{32}\b/g],
	["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/g],
	["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
	["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
	["Deepgram key", /deepgram[\s\S]{0,100}?\b([a-f0-9]{40})\b|\b([a-f0-9]{40})\b[\s\S]{0,100}?deepgram/gi],
	["hard-coded credential", /\b[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN)\b["']?\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/g],
];
const utf8 = new TextDecoder("utf-8", { fatal: true });

const startsWith = (bytes: Buffer, signature: number[]) => bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
export const maskSecret = (value: string) => `${value.slice(0, 4)}…`;
function text(bytes: Buffer): string | undefined {
	if (bytes.includes(0)) return undefined;
	try { return utf8.decode(bytes); } catch { return undefined; }
}

export function scanReleaseFiles(files: ReadonlyMap<string, Buffer>): CatalogFinding[] {
	const findings: CatalogFinding[] = [];
	for (const [file, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
		const signature = NATIVE_SIGNATURES.find(([, magic]) => startsWith(bytes, magic));
		if (signature || NATIVE_EXTENSIONS.test(file)) {
			findings.push({ rule: "native-binary", file, detail: signature ? `${signature[0]} file signature` : "native or executable file type" });
			continue;
		}
		const source = text(bytes);
		if (source === undefined) continue;
		if (SCRIPT.test(file)) findings.push(...obfuscation(file, source));
		findings.push(...secrets(file, source));
	}
	return findings;
}

function obfuscation(file: string, source: string): CatalogFinding[] {
	const findings: CatalogFinding[] = [];
	for (const [label, pattern] of DYNAMIC_CODE) {
		const offsets = [...source.matchAll(pattern)].map(match => match.index);
		if (offsets.length) findings.push({ rule: "obfuscation", file, detail: `${label} at offset ${offsets.slice(0, 3).join(", ")}${offsets.length > 3 ? ` (+${offsets.length - 3} more)` : ""}` });
	}
	const names = new Set([...source.matchAll(OBFUSCATOR_NAME)].map(match => match[0].toLowerCase()));
	if (names.size >= OBFUSCATOR_NAMES) findings.push({ rule: "obfuscation", file, detail: `${names.size} obfuscator-style _0x names` });
	for (const match of source.matchAll(ENCODED_BLOB)) {
		if (DATA_URI.test(source.slice(Math.max(0, match.index - 64), match.index))) continue;
		findings.push({ rule: "obfuscation", file, detail: `${match[0].length}-character encoded blob at offset ${match.index}` });
	}
	return findings;
}

function secrets(file: string, source: string): CatalogFinding[] {
	const findings: CatalogFinding[] = [];
	for (const [label, pattern] of SECRETS) {
		for (const match of source.matchAll(pattern)) {
			findings.push({ rule: "secret", file, detail: `${label} ${maskSecret(match.slice(1).find(Boolean) ?? match[0])} at offset ${match.index}` });
		}
	}
	return findings;
}

export interface LockedPackage { name: string; version: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** name@version for every package in an npm package-lock.json (v1-v3), dev
 * dependencies included: a malicious build-time package can still reach the bundle. */
export function lockedPackages(lock: unknown): LockedPackage[] {
	if (!object(lock)) throw new Error("package-lock.json is not an object");
	const seen = new Map<string, LockedPackage>();
	const add = (name: unknown, version: unknown) => {
		if (typeof name === "string" && name && typeof version === "string" && /^\d/.test(version)) seen.set(`${name}@${version}`, { name, version });
	};
	if (object(lock.packages)) {
		for (const [path, entry] of Object.entries(lock.packages)) {
			const at = path.lastIndexOf("node_modules/");
			if (at < 0 || !object(entry) || entry.link === true) continue;
			add(typeof entry.name === "string" ? entry.name : path.slice(at + "node_modules/".length), entry.version);
		}
	} else if (object(lock.dependencies)) {
		const visit = (dependencies: Record<string, unknown>) => {
			for (const [name, entry] of Object.entries(dependencies)) {
				if (!object(entry)) continue;
				add(name, entry.version);
				if (object(entry.dependencies)) visit(entry.dependencies);
			}
		};
		visit(lock.dependencies);
	} else throw new Error("package-lock.json has no packages or dependencies");
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** OSV querybatch results are in query order. MAL-* ids are malicious packages. */
export function maliciousDependencies(packages: readonly LockedPackage[], osv: unknown): CatalogFinding[] {
	const results = object(osv) && Array.isArray(osv.results) ? osv.results : undefined;
	if (!results || results.length !== packages.length) throw new Error("Unexpected OSV response");
	return packages.flatMap((pkg, i) => {
		const result = results[i];
		const vulns = object(result) && Array.isArray(result.vulns) ? result.vulns : [];
		const ids = vulns.map(vuln => object(vuln) ? vuln.id : undefined).filter((id): id is string => typeof id === "string" && id.startsWith("MAL-"));
		return ids.length ? [{ rule: "malicious-dependency" as const, file: "package-lock.json", detail: `${pkg.name}@${pkg.version}: ${ids.join(", ")}` }] : [];
	});
}

export interface CatalogException { id: string; version: string; rule: CatalogRule; file?: string; reason: string }
export interface ReleaseFindings { id: string; version: string; findings: CatalogFinding[] }
export type ReportedFinding = CatalogFinding & { id: string; version: string };

export function parseCheckExceptions(data: unknown): CatalogException[] {
	if (!object(data) || data.schemaVersion !== 1 || !Array.isArray(data.exceptions)) throw new Error("Unsupported check-exceptions.json");
	return data.exceptions.map((entry: unknown): CatalogException => {
		if (!object(entry)) throw new Error("Invalid catalog check exception");
		const { id, version, rule, file, reason } = entry;
		if (typeof id !== "string" || !id || typeof version !== "string" || !version || !CATALOG_RULES.includes(rule as CatalogRule)
			|| (file !== undefined && (typeof file !== "string" || !file)) || typeof reason !== "string" || !reason.trim()) {
			throw new Error(`Invalid catalog check exception: ${JSON.stringify(entry)}`);
		}
		return { id, version, rule: rule as CatalogRule, ...(file === undefined ? {} : { file: file as string }), reason };
	});
}

/** An exception excuses findings matching id, version, rule and (if set) file.
 * One that excuses nothing is stale and fails the run. */
export function applyCheckExceptions(releases: readonly ReleaseFindings[], exceptions: readonly CatalogException[]) {
	const used = new Set<CatalogException>();
	const failures: ReportedFinding[] = [], excused: ReportedFinding[] = [];
	for (const { id, version, findings } of releases) {
		for (const finding of findings) {
			const exception = exceptions.find(e => e.id === id && e.version === version && e.rule === finding.rule && (e.file === undefined || e.file === finding.file));
			const reported = { id, version, ...finding };
			if (exception) { used.add(exception); excused.push(reported); }
			else failures.push(reported);
		}
	}
	return { failures, excused, stale: exceptions.filter(e => !used.has(e)) };
}
