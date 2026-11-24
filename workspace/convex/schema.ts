import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	users: defineTable({ name: v.optional(v.string()), email: v.optional(v.string()) }),
	threads: defineTable({
		owner: v.id("users"), threadId: v.string(), revision: v.string(), updatedAt: v.number(),
		digest: v.union(v.string(), v.null()), storageId: v.union(v.id("_storage"), v.null()),
	}).index("by_owner_thread", ["owner", "threadId"]),
});
