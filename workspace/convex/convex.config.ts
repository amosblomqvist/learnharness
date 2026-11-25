import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import google from "@convex-dev/auth/components/google/convex.config.js";

const app = defineApp({ env: { AUTH_GOOGLE_CLIENT_ID: v.string(), AUTH_GOOGLE_CLIENT_SECRET: v.string() } });
app.use(auth);
app.use(google, {
	httpPrefix: "/oauth/google",
	env: { CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID, CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET },
});
export default app;
