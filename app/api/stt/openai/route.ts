import { effectiveSettings, keyValue, transcribeOpenAIDictation } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return transcribeOpenAIDictation(request, {
		apiKey: keyValue("OPENAI_API_KEY"),
		enabled: effectiveSettings().general.dictationProvider === "openai",
	});
}
