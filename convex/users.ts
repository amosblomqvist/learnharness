import { getAuthUserId } from "@convex-dev/auth/server";
import { vGoogleProfile } from "@convex-dev/auth/methods/google/server";
import { v } from "convex/values";
import { internalMutation, query } from "./functions";

export const createGoogleUser = internalMutation({
	args: { method: v.object({ name: v.literal("google"), profile: vGoogleProfile }) },
	returns: v.id("users"),
	handler: async (ctx, { method: { profile } }) => ctx.db.insert("users", {
		...(profile.name ? { name: profile.name } : {}), ...(profile.email ? { email: profile.email } : {}),
	}),
});
export const current = query({
	args: {},
	handler: async ctx => {
		const id = await getAuthUserId(ctx);
		if (!id) throw new Error("Sign in to sync threads.");
		const user = await ctx.db.get("users", id);
		if (!user) throw new Error("Account unavailable.");
		return { id, name: user.name ?? null, email: user.email ?? null };
	},
});
