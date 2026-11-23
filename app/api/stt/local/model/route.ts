/**
 * POST /api/stt/local/model — start downloading the on-device speech model
 * (answers at once; poll GET /api/stt/local for progress). DELETE — cancel a
 * download in progress, or remove the installed model.
 */
import { localSttDownloadResponse, localSttRemoveResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function POST() {
	return localSttDownloadResponse();
}

export function DELETE() {
	return localSttRemoveResponse();
}
