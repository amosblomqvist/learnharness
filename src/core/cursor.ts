/** Cursor subscription connection. The login lives in `cursor-agent` on this
 * machine; LearnHarness does not store a Cursor API key. */

export const CURSOR_PROVIDER_ID = "cursor";

/** Shown when a pinned Cursor model cannot run because the CLI is signed out. */
export const CURSOR_SIGN_IN_ERROR =
	"Cursor is not signed in — run cursor-agent login, then restart LearnHarness";

/** Providers settings copy. The model picker is the control; this is the instruction. */
export const CURSOR_PROVIDER_NOTE =
	"Cursor uses the cursor-agent login on this machine, not an API key. Sign in with cursor-agent login, restart LearnHarness, then pick a cursor/ model. Requests stay on your Cursor subscription.";
