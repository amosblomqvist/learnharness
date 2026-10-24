/**
 * The endpoint record store (fork addition): read-modify-write over
 * data/endpoint.json, same discipline as the other small JSON records
 * (settings, render-settings). A missing or broken file reads as EMPTY —
 * an unconfigured endpoint, never a crash. Sync reads (the engine build
 * path is sync), async writes.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CUSTOM_ENDPOINT_FILE, EMPTY_ENDPOINT, setCurrentEndpoint, type CustomEndpoint, type CustomModel } from "../agent/custom-endpoint.ts";

function sanitize(raw: unknown): CustomEndpoint {
	if (typeof raw !== "object" || raw === null) return EMPTY_ENDPOINT;
	const record = raw as Record<string, unknown>;
	const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl : "";
	const models: CustomModel[] = Array.isArray(record.models)
		? record.models.flatMap((row) => {
				if (typeof row !== "object" || row === null) return [];
				const m = row as Record<string, unknown>;
				if (typeof m.id !== "string" || !m.id) return [];
				return [
					{
						id: m.id,
						name: typeof m.name === "string" && m.name ? m.name : m.id,
						...(typeof m.contextWindow === "number" && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
						...(m.vision === true ? { vision: true } : {}),
					},
				];
			})
		: [];
	return { baseUrl, models, updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "" };
}

export function readEndpoint(): CustomEndpoint {
	try {
	// Sync on purpose: the engine/store build path is synchronous.
	return sanitize(JSON.parse(readFileSync(CUSTOM_ENDPOINT_FILE, "utf8")));
	} catch {
		return EMPTY_ENDPOINT;
	}
}

/** Write + publish the record to the agent-layer state the provider reads. */
export async function writeEndpoint(record: CustomEndpoint): Promise<void> {
	setCurrentEndpoint(record);
	await mkdir(path.dirname(CUSTOM_ENDPOINT_FILE), { recursive: true });
	const tmp = `${CUSTOM_ENDPOINT_FILE}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(record, null, "\t"), "utf8");
	await rename(tmp, CUSTOM_ENDPOINT_FILE);
}

export async function readEndpointFile(): Promise<CustomEndpoint> {
	try {
		return sanitize(JSON.parse(await readFile(CUSTOM_ENDPOINT_FILE, "utf8")));
	} catch {
		return EMPTY_ENDPOINT;
	}
}

// BOOT HYDRATION: importing this module loads the saved record into the
// agent-layer state, so the provider serves models from the first request
// after boot (src/server/index.ts imports it — the same trick the keys
// seam's boot fill-gap uses).
setCurrentEndpoint(readEndpoint());

/** Store a freshly discovered list (the save path: URL + models together). */
export async function saveEndpoint(baseUrl: string, models: CustomModel[]): Promise<CustomEndpoint> {
	const record: CustomEndpoint = { baseUrl, models, updatedAt: new Date().toISOString() };
	await writeEndpoint(record);
	return record;
}