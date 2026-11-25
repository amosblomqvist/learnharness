import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./functions";

export const list = query({
	args: { paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		const owner = await getAuthUserId(ctx);
		if (!owner) throw new Error("Sign in to sync threads.");
		return ctx.db.query("threads").withIndex("by_owner_thread", q => q.eq("owner", owner)).paginate(args.paginationOpts);
	},
});
export const download = query({
	args: { threadId: v.string() },
	handler: async (ctx, { threadId }) => {
		const owner = await getAuthUserId(ctx);
		if (!owner) throw new Error("Sign in to sync threads.");
		const thread = await ctx.db.query("threads").withIndex("by_owner_thread", q => q.eq("owner", owner).eq("threadId", threadId)).unique();
		return thread?.storageId ? { revision: thread.revision, url: await ctx.storage.getUrl(thread.storageId) } : null;
	},
});
export const uploadUrl = mutation({
	args: {},
	handler: async ctx => {
		if (!await getAuthUserId(ctx)) throw new Error("Sign in to sync threads.");
		return ctx.storage.generateUploadUrl();
	},
});
export const commit = mutation({
	args: {
		threadId: v.string(), expected: v.union(v.string(), v.null()), revision: v.string(), updatedAt: v.number(),
		digest: v.union(v.string(), v.null()), storageId: v.union(v.id("_storage"), v.null()),
	},
	handler: async (ctx, args) => {
		const owner = await getAuthUserId(ctx);
		if (!owner) throw new Error("Sign in to sync threads.");
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(args.threadId) || (args.digest === null) !== (args.storageId === null)
			|| (args.digest !== null && !/^[a-f0-9]{64}$/.test(args.digest)) || !Number.isFinite(args.updatedAt) || args.updatedAt < 0) throw new Error("Invalid thread snapshot.");
		const prior = await ctx.db.query("threads").withIndex("by_owner_thread", q => q.eq("owner", owner).eq("threadId", args.threadId)).unique();
		// Idempotent after a lost response, including deletion tombstones.
		if (prior && (prior.revision === args.revision || prior.digest === args.digest)) return { revision: prior.revision, digest: prior.digest, updatedAt: prior.updatedAt };
		if ((prior?.revision ?? null) !== args.expected) return null;
		if (args.storageId && !await ctx.db.system.get(args.storageId)) throw new Error("Snapshot upload is missing.");
		const next = { owner, threadId: args.threadId, revision: args.revision, digest: args.digest, storageId: args.storageId, updatedAt: args.updatedAt };
		if (prior) await ctx.db.replace("threads", prior._id, next);
		else await ctx.db.insert("threads", next);
		// Old payloads are retained: an in-flight reader may still be using one.
		return { revision: args.revision, digest: args.digest, updatedAt: args.updatedAt };
	},
});
