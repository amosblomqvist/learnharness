import { anyApi, componentsGeneric, type ApiFromModules } from "convex/server";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupGoogle } from "@convex-dev/auth/methods/google/server";

// Component references are resolved by Convex on deployment. No generated files
// or deployment credentials are needed to build the optional local application.
const components = componentsGeneric() as unknown as {
	auth: Parameters<typeof setupConvexAuth>[0]["component"];
	authGoogle: Parameters<typeof setupGoogle>[1]["component"];
};
const auth = setupConvexAuth({ component: components.auth });
const internal = anyApi as unknown as ApiFromModules<{ users: typeof import("./users") }>;
export const { signOut, refreshSession, isAuthenticated } = auth;
export const { startSignInWithGoogle, completeSignInWithGoogle } = setupGoogle(auth, {
	component: components.authGoogle,
	allowedRedirectOrigins: (process.env.AUTH_REDIRECT_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3211").split(",").map(origin => origin.trim()).filter(Boolean),
}).attachUserCallbacks({ createUser: internal.users.createGoogleUser });
