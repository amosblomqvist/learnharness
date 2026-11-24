/** Native desktop windows use IPC. The authenticated mobile gateway handles
 * this path itself; a bare web server never pretends that it is sharing. */
export function GET() {
	return Response.json({ available: false, enabled: false, remote: false, message: "Open the LearnHarness desktop app to manage Mobile Access." }, { headers: { "Cache-Control": "no-store" } });
}
