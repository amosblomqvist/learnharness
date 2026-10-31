import { withUser } from "@/src/server/auth/context.ts";
/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel. */
import { customProviderGet, customProviderMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = withUser(customProviderGet);
export const POST = withUser(customProviderMutation);
export const PATCH = withUser(customProviderMutation);
export const DELETE = withUser(customProviderMutation);
