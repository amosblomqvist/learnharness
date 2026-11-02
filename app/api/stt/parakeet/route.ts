/**
 * Local dictation model: GET status (poll while downloading), POST start the
 * download, DELETE remove the model or cancel a running download. The model
 * lives under the data root; see src/server/parakeet-model.ts.
 */
import { parakeetHandlers } from "@/src/server";

export const dynamic = "force-dynamic";

export const GET = parakeetHandlers.status;
export const POST = parakeetHandlers.startDownload;
export const DELETE = parakeetHandlers.remove;
