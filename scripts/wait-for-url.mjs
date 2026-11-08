// Blocks until the URL answers any HTTP response, or exits 1 after the timeout.
// desktop:dev uses it so Electron only loads the page once `next dev` is up.
const [url, timeoutArg] = process.argv.slice(2);
const deadline = Date.now() + Number(timeoutArg ?? 60_000);
while (Date.now() < deadline) {
	try {
		await fetch(url, { signal: AbortSignal.timeout(2_000) });
		process.exit(0);
	} catch {
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
console.error(`wait-for-url: ${url} did not answer in time`);
process.exit(1);
