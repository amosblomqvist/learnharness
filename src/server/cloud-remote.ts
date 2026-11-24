import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { randomUUID } from "node:crypto";
import { bundleDigest, MAX_BUNDLE_BYTES, validateThreadBundle, type ThreadBundle } from "../store/thread-bundles.ts";
import type { SyncHead } from "../core/thread-sync.ts";
import type { SyncRemote } from "./thread-sync-engine.ts";

export interface CloudTokens { accessToken: string; refreshToken: string; refreshTokenExpiresAt: number; userId: string }
export interface CloudUser { id: string; name: string | null; email: string | null }
export const cloudRefs = {
	start: makeFunctionReference<"mutation", { redirectTo: string }, { redirect: string; state: string }>("auth:startSignInWithGoogle"),
	complete: makeFunctionReference<"mutation", { code: string; state: string }, { status: "complete"; tokens: CloudTokens } | { status: "error" }>("auth:completeSignInWithGoogle"),
	refresh: makeFunctionReference<"mutation", { refreshToken: string }, { kind: "rotated"; tokens: CloudTokens } | { kind: "noSession" }>("auth:refreshSession"),
	signOut: makeFunctionReference<"mutation", { refreshToken: string }, null>("auth:signOut"),
	user: makeFunctionReference<"query", Record<string, never>, CloudUser>("users:current"),
	list: makeFunctionReference<"query", { paginationOpts: { numItems: number; cursor: string | null } }, { page: (SyncHead & { threadId: string })[]; isDone: boolean; continueCursor: string }>("threads:list"),
	download: makeFunctionReference<"query", { threadId: string }, { revision: string; url: string | null } | null>("threads:download"),
	upload: makeFunctionReference<"mutation", Record<string, never>, string>("threads:uploadUrl"),
	commit: makeFunctionReference<"mutation", { threadId: string; expected: string | null; revision: string; digest: string | null; storageId: string | null; updatedAt: number }, SyncHead | null>("threads:commit"),
};
export function cloudClient(url: string, token?: string): ConvexHttpClient {
	const client = new ConvexHttpClient(url, {
		logger: false,
		fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
	});
	if (token) client.setAuth(token);
	return client;
}
export function convexRemote(client: ConvexHttpClient): SyncRemote {
	return {
		async list() {
			const result: Record<string, SyncHead> = Object.create(null);
			let cursor: string | null = null;
			for (;;) {
				const page: { page: (SyncHead & { threadId: string })[]; isDone: boolean; continueCursor: string } = await client.query(cloudRefs.list, { paginationOpts: { numItems: 100, cursor } });
				for (const item of page.page) result[item.threadId] = { revision: item.revision, digest: item.digest, updatedAt: item.updatedAt };
				if (page.isDone) return result;
				cursor = page.continueCursor;
			}
		},
		async read(id, revision) {
			const snapshot = await client.query(cloudRefs.download, { threadId: id });
			if (!snapshot?.url || snapshot.revision !== revision) return null;
			const response = await fetch(snapshot.url, { signal: AbortSignal.timeout(60_000) });
			if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BUNDLE_BYTES) throw new Error("Cloud snapshot download failed.");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = []; let size = 0;
			try {
				for (;;) {
					const part = await reader.read(); if (part.done) break;
					size += part.value.length;
					if (size > MAX_BUNDLE_BYTES) { await reader.cancel(); throw new Error("Cloud thread exceeds the 128 MiB sync limit."); }
					chunks.push(part.value);
				}
			} finally { reader.releaseLock(); }
			const bundle: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			validateThreadBundle(bundle, id);
			return bundle;
		},
		async write(id, expected, bundle, updatedAt) {
			const digest = bundle ? bundleDigest(bundle) : null;
			let storageId: string | null = null;
			if (bundle) {
				const body = JSON.stringify(bundle);
				if (Buffer.byteLength(body) > MAX_BUNDLE_BYTES) throw new Error("Thread exceeds the 128 MiB sync limit.");
				const url = await client.mutation(cloudRefs.upload, {});
				const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(60_000) });
				if (!response.ok) throw new Error("Cloud snapshot upload failed.");
				storageId = (await response.json() as { storageId: string }).storageId;
			}
			const revision = randomUUID();
			return client.mutation(cloudRefs.commit, { threadId: id, expected, revision, digest, storageId, updatedAt });
		},
	};
}
