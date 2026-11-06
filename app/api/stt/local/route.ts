import { localDictationDelete } from "@/src/server";

export async function DELETE(request: Request) {
	return localDictationDelete(request);
}
