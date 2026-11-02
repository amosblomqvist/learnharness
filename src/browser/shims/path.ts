/** `node:path` for the phone build — POSIX semantics only (one virtual root). */
import { BROWSER_CWD } from "./process.ts";

function normalizeParts(parts: string[], absolute: boolean): string[] {
	const out: string[] = [];
	for (const seg of parts) {
		if (!seg || seg === ".") continue;
		if (seg === "..") {
			if (out.length && out[out.length - 1] !== "..") out.pop();
			else if (!absolute) out.push("..");
		} else out.push(seg);
	}
	return out;
}

export const sep = "/";
export const delimiter = ":";

export function isAbsolute(p: string): boolean {
	return p.startsWith("/");
}

export function normalize(p: string): string {
	if (!p) return ".";
	const absolute = isAbsolute(p);
	const trailing = p.endsWith("/");
	let out = normalizeParts(p.split("/"), absolute).join("/");
	if (!out && !absolute) out = ".";
	if (out && trailing) out += "/";
	return (absolute ? "/" : "") + out;
}

export function join(...parts: string[]): string {
	const joined = parts.filter((p) => p !== "").join("/");
	return joined ? normalize(joined) : ".";
}

export function resolve(...parts: string[]): string {
	let resolved = "";
	for (let i = parts.length - 1; i >= 0 && !isAbsolute(resolved); i--) {
		const p = parts[i];
		if (p) resolved = resolved ? `${p}/${resolved}` : p;
	}
	if (!isAbsolute(resolved)) resolved = `${BROWSER_CWD}/${resolved}`;
	const out = "/" + normalizeParts(resolved.split("/"), true).join("/");
	return out;
}

export function dirname(p: string): string {
	if (!p) return ".";
	const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
	const i = trimmed.lastIndexOf("/");
	if (i === -1) return ".";
	if (i === 0) return "/";
	return trimmed.slice(0, i);
}

export function basename(p: string, ext?: string): string {
	const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
	let base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
	if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
	return base;
}

export function extname(p: string): string {
	const base = basename(p);
	const i = base.lastIndexOf(".");
	return i <= 0 ? "" : base.slice(i);
}

export function relative(from: string, to: string): string {
	const a = resolve(from).split("/").filter(Boolean);
	const b = resolve(to).split("/").filter(Boolean);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

export function parse(p: string) {
	const base = basename(p);
	const ext = extname(p);
	return { root: isAbsolute(p) ? "/" : "", dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format(o: { dir?: string; root?: string; base?: string; name?: string; ext?: string }): string {
	const base = o.base ?? `${o.name ?? ""}${o.ext ?? ""}`;
	const dir = o.dir ?? o.root ?? "";
	return dir ? (dir.endsWith("/") ? dir + base : `${dir}/${base}`) : base;
}

export function toNamespacedPath(p: string): string {
	return p;
}

const pathApi = { sep, delimiter, isAbsolute, normalize, join, resolve, dirname, basename, extname, relative, parse, format, toNamespacedPath };
export const posix = pathApi;
/** Only the Claude CLI discovery code touches win32; it never runs on a phone. */
export const win32 = pathApi;

export default { ...pathApi, posix, win32 };
