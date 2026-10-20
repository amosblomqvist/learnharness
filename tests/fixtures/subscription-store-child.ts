/**
 * Real subprocess fixture for subscription-store.test.ts.
 *
 * Modes:
 *   owner <dir>          print this process's StoreOwner JSON, exit 0
 *   snapshot <dir>       print the authoritative snapshot JSON, exit 0
 *   hold <dir>           hold a transaction until stdin gets a line
 *   crash-lock <dir>     acquire the store lock, print READY, exit while held
 *   journal-crash <dir>  begin a refresh journal, print READY, exit while held
 *   paused-write <dir>   acquire, print READY, wait for stdin, then try save
 *   abort-transaction <dir> <ms>
 *                        try a transaction, abort after <ms>, report ABORTED
 *   contend <dir> <ms>   hold a shared critical-section marker for <ms>;
 *                        print OVERLAP if another process is inside it
 *
 * READY is printed only from inside the transaction callback, so the parent
 * knows the cross-process lock is actually held. No real credential or
 * application data directory is used.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { createSubscriptionStore } from "../../src/store/subscription-credentials.ts";

const [mode, directory, argument] = process.argv.slice(2);

function print(line: string): void {
	fs.writeSync(1, `${line}\n`);
}

function waitForStdin(): Promise<void> {
	return new Promise((resolve) => {
		process.stdin.setEncoding("utf8");
		process.stdin.once("data", () => {
			// A resumed stdin keeps the event loop alive; pause it so the
			// fixture can exit naturally after the parent releases it.
			process.stdin.pause();
			resolve();
		});
		process.stdin.resume();
	});
}

async function main(): Promise<void> {
	if (!mode || !directory) throw new Error("usage: subscription-store-child.ts <mode> <directory>");
	const store = createSubscriptionStore(directory);

	if (mode === "owner") {
		print(JSON.stringify(store.owner));
		return;
	}

	if (mode === "snapshot") {
		print(JSON.stringify(await store.snapshot()));
		return;
	}

	if (mode === "hold") {
		await store.transaction(async () => {
			print("READY");
			await waitForStdin();
		});
		print("RELEASED");
		return;
	}

	if (mode === "crash-lock") {
		await store.transaction(async () => {
			print("READY");
			process.exit(0);
		});
		return;
	}

	if (mode === "journal-crash") {
		await store.transaction(async (tx) => {
			const journal = await tx.beginRefresh();
			print(`READY ${journal.operationId}`);
			process.exit(0);
		});
		return;
	}

	if (mode === "paused-write") {
		try {
			await store.transaction(async (tx) => {
				print("READY");
				await waitForStdin();
				try {
					await tx.save({
						version: 1,
						generation: tx.state.generation,
						credential: {
							type: "oauth",
							access: "takeover-write",
							refresh: "takeover-write",
							expires: 1_900_000_000,
							accountId: "takeover-write",
						},
					});
					print("SAVED");
				} catch (error) {
					print(`ERROR ${error instanceof Error ? error.name : "unknown"}`);
					return;
				}
			});
		} catch (error) {
			print(`FATAL ${error instanceof Error ? error.name : "unknown"}`);
			process.exit(1);
		}
		return;
	}

	if (mode === "abort-transaction") {
		const delay = Number(argument ?? "300");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), delay);
		try {
			await store.transaction(async () => {
				print("READY");
			}, controller.signal);
			print("COMPLETED");
		} catch (error) {
			print(`ABORTED ${error instanceof Error ? error.name : "unknown"}`);
		} finally {
			clearTimeout(timer);
		}
		return;
	}

	if (mode === "contend") {
		const hold = Number(argument ?? "100");
		const marker = path.join(directory, "critical-section.marker");
		await store.transaction(async () => {
			let handle: number;
			try {
				handle = fs.openSync(marker, "wx", 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") print("OVERLAP");
				throw error;
			}
			try {
				print("ENTER");
				await new Promise((resolve) => setTimeout(resolve, hold));
			} finally {
				fs.closeSync(handle);
				fs.rmSync(marker, { force: true });
			}
			print("EXIT");
		});
		print("DONE");
		return;
	}

	throw new Error(`unknown mode: ${mode}`);
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		print(`FATAL ${error instanceof Error ? error.name : "unknown"}`);
		process.exit(1);
	},
);
