/**
 * BYOK mint: the renderer never holds a real speech key. The server resolves
 * the dictation provider (saved choice + keys present) and returns
 * { provider, token } — see src/server/stt-token.ts for the protocol per
 * provider, the keyless 503 and the upstream 502.
 */
import { keyValue, mintSttToken, readSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return mintSttToken({
		keyValue,
		savedProvider: () => readSettingsRecord()?.dictation?.provider,
		fetch,
	});
}
