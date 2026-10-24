/**
 * A short explanation shown UNDER a provider error (the error text itself
 * stays verbatim — session-core.ts surfaces it unmasked). Timeouts get a
 * hint because the SDK's bare "Request timed out." names no cause or next
 * step; any other error gets none.
 */
const TIMEOUT_RE = /timed? ?out|timeout|ETIMEDOUT|ECONNRESET|socket hang up/i;

export function providerErrorHint(message: string): string | null {
	if (!TIMEOUT_RE.test(message)) return null;
	return "The model provider did not answer in time, even after automatic retries. Check your connection and the provider's status, then send the message again. Slow models can be quicker with a lower thinking level (Settings → Models).";
}
