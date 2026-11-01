/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel. */
import { announceSettingsChanged, customProviderGet, customProviderMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = customProviderGet;
/** A saved custom provider changes every device's model catalog. */
async function mutation(request: Request): Promise<Response> {
	const response = await customProviderMutation(request);
	if (response.ok) announceSettingsChanged("keys");
	return response;
}

export const POST = mutation;
export const PATCH = mutation;
export const DELETE = mutation;
