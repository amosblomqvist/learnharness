/**
 * `node:url` for the phone build. Bundled code computes directories from
 * `fileURLToPath(import.meta.url)`; the build defines import.meta.url as a
 * file: URL under the virtual app root, so this only needs the decode.
 */

export function fileURLToPath(url: string | URL): string {
	const u = typeof url === "string" ? new URL(url) : url;
	return decodeURIComponent(u.pathname);
}

export function pathToFileURL(path: string): URL {
	return new URL(`file://${encodeURI(path)}`);
}

const NativeURL = globalThis.URL;
const NativeURLSearchParams = globalThis.URLSearchParams;
export { NativeURL as URL, NativeURLSearchParams as URLSearchParams };

export default { fileURLToPath, pathToFileURL, URL: NativeURL, URLSearchParams: NativeURLSearchParams };
