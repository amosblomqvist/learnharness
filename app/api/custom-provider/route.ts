/** Custom endpoints (PR #62, extended to multiple named endpoints): discover/
 *  manual connect, offline pins, and disconnect. Host boundaries and mutations
 *  live behind the server barrel. */
import { customProviderGet, customProviderMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = customProviderGet;
export const POST = customProviderMutation;
export const PATCH = customProviderMutation;
export const DELETE = customProviderMutation;
