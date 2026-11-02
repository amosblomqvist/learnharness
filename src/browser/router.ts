/**
 * The phone build's `/api/*` router (mobile Phase 0).
 *
 * The desktop app serves the UI's `/api/*` calls from Next route handlers
 * (app/api/**\/route.ts). Those handlers are plain Request → Response
 * functions, so the phone build runs the SAME modules in the page: the
 * build enumerates them into the virtual `lh:routes` module, and this file
 * matches a request to one with Next's precedence (static segments beat
 * [param] beats [...catchAll]) and calls the exported method handler with
 * Next 16's `{ params: Promise }` context.
 */

import { routes, type RouteEntry } from "lh:routes";

type Segment = { kind: "static"; value: string } | { kind: "param"; name: string } | { kind: "catchAll"; name: string };

type CompiledRoute = RouteEntry & { segments: Segment[]; rank: number[] };

function compile(entry: RouteEntry): CompiledRoute {
	const segments: Segment[] = entry.path
		.split("/")
		.filter(Boolean)
		.map((seg) => {
			const catchAll = /^\[\.\.\.(\w+)\]$/.exec(seg);
			if (catchAll) return { kind: "catchAll", name: catchAll[1]! };
			const param = /^\[(\w+)\]$/.exec(seg);
			if (param) return { kind: "param", name: param[1]! };
			return { kind: "static" as const, value: seg };
		});
	// Lower rank sorts first: per position 0 = static, 1 = param, 2 = catch-all.
	const rank = segments.map((s) => (s.kind === "static" ? 0 : s.kind === "param" ? 1 : 2));
	return { ...entry, segments, rank };
}

const table: CompiledRoute[] = routes.map(compile).sort((a, b) => {
	for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
		const d = (a.rank[i] ?? -1) - (b.rank[i] ?? -1);
		if (d !== 0) return d;
	}
	return 0;
});

function match(pathname: string): { route: CompiledRoute; params: Record<string, string | string[]> } | null {
	const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
	for (const route of table) {
		const params: Record<string, string | string[]> = {};
		let ok = true;
		for (let i = 0; i < route.segments.length; i++) {
			const seg = route.segments[i]!;
			if (seg.kind === "catchAll") {
				if (i >= parts.length) ok = false;
				else params[seg.name] = parts.slice(i);
				break;
			}
			const part = parts[i];
			if (part === undefined) {
				ok = false;
				break;
			}
			if (seg.kind === "static" && seg.value !== part) {
				ok = false;
				break;
			}
			if (seg.kind === "param") params[seg.name] = part;
		}
		const last = route.segments[route.segments.length - 1];
		if (ok && (last?.kind === "catchAll" || route.segments.length === parts.length)) return { route, params };
	}
	return null;
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Response | Promise<Response>;

/** Route one request. Unknown paths are 404s; unsupported methods 405s;
 *  a handler that throws becomes a 500 (matching Next's behavior). */
export async function routeRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const found = match(url.pathname);
	if (!found) return Response.json({ error: `No route for ${url.pathname}` }, { status: 404 });
	let mod: Record<string, unknown>;
	try {
		mod = await found.route.load();
	} catch (err) {
		console.error(`[router] ${found.route.path} failed to load:`, err);
		return Response.json({ error: `${found.route.path} is not available in the phone app` }, { status: 501 });
	}
	const handler = mod[req.method.toUpperCase()] as Handler | undefined;
	if (typeof handler !== "function") return new Response(null, { status: 405 });
	try {
		return await handler(req, { params: Promise.resolve(found.params) });
	} catch (err) {
		console.error(`[router] ${req.method} ${url.pathname} threw:`, err);
		return Response.json({ error: "Internal error" }, { status: 500 });
	}
}

/** For tests and diagnostics: the route paths in match order. */
export function routeOrder(): string[] {
	return table.map((r) => r.path);
}
