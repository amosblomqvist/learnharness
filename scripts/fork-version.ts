import * as path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionParts(version: string): [string, string, bigint] {
	const match = VERSION_PATTERN.exec(version);
	if (!match) throw new Error(`Invalid version: ${version}`);
	return [match[1]!, match[2]!, BigInt(match[3]!)];
}

export function forkVersion(upstream: string, n: number): string {
	const [major, minor, patch] = versionParts(upstream);
	if (!Number.isInteger(n) || n < 1 || n > 99) {
		throw new Error("Sequence number must be an integer from 1 to 99");
	}
	return `${major}.${minor}.${patch * 100n + BigInt(n)}`;
}

export function parseForkVersion(version: string): { upstream: string; n: number } {
	const [major, minor, patch] = versionParts(version);
	const n = Number(patch % 100n);
	if (n === 0) throw new Error("Fork version must have a sequence number from 1 to 99");
	return { upstream: `${major}.${minor}.${patch / 100n}`, n };
}

const invokedAsCli = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsCli) {
	const [upstream, sequence] = process.argv.slice(2);
	console.log(forkVersion(upstream ?? "", Number(sequence)));
}
