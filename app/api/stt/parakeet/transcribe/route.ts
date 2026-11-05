/** POST raw 16 kHz mono 16-bit PCM → { text } from the local Parakeet model. */
import { parakeetHandlers } from "@/src/server";

export const dynamic = "force-dynamic";

export const POST = parakeetHandlers.transcribe;
