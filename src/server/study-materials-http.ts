import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AUTH_FILE } from "../../config.ts";
import { desktopAPIAuthorized, subscriptionRequestOrigin } from "./desktop-access.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { resolvePolicy } from "../agent/tools/file-access.ts";
import { fileAccessPolicy } from "./file-access.ts";
import { StudyMaterials, type MaterialConfig } from "./study-materials.ts";
import type { MaterialReference, MaterialSource } from "../core/study-materials.ts";

const configFile = path.join(path.dirname(AUTH_FILE), "material-sources-credentials.json");
const sources = new Set(["obsidian", "notion", "zotero"]);
let writes: Promise<unknown> = Promise.resolve();
function authorized(request: Request): boolean {
	if (request.headers.get("x-learnharness-materials") !== "1") return false;
	if (process.env.LH_DESKTOP_SERVER === "1" || process.env.LH_DESKTOP_API_SECRET) return desktopAPIAuthorized(request.headers);
	const origin = request.headers.get("origin");
	return !!origin && origin !== "null" && origin === subscriptionRequestOrigin(request) && (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
}
function validate(config: MaterialConfig): MaterialConfig {
	if (config.obsidianRoot !== undefined && (typeof config.obsidianRoot !== "string" || config.obsidianRoot.length > 3000)) throw new Error("Invalid Obsidian folder.");
	if (config.notionToken !== undefined && (typeof config.notionToken !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(config.notionToken))) throw new Error("Invalid Notion integration token.");
	if (config.zoteroEnabled !== undefined && typeof config.zoteroEnabled !== "boolean") throw new Error("Invalid Zotero connection setting.");
	return config;
}
async function readConfig(): Promise<MaterialConfig> {
	try {
		const value = JSON.parse(await fs.readFile(configFile, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["obsidianRoot", "notionToken", "zoteroEnabled"].includes(key))) throw new Error();
		return validate(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error("Material connection configuration could not be read. Restore it before retrying.");
	}
}
async function saveConfig(body: Record<string, unknown>): Promise<MaterialConfig> {
	const current = await readConfig();
	const next = validate({ ...current,
		...(body.obsidianRoot !== undefined ? { obsidianRoot: typeof body.obsidianRoot === "string" ? body.obsidianRoot.trim() : body.obsidianRoot as string } : {}),
		...(body.notionToken !== undefined ? { notionToken: typeof body.notionToken === "string" ? body.notionToken.trim() : body.notionToken as string } : {}),
		...(body.zoteroEnabled !== undefined ? { zoteroEnabled: body.zoteroEnabled as boolean } : {}),
	});
	if (body.clearNotion === true) delete next.notionToken;
	if (next.obsidianRoot) {
		if (!path.isAbsolute(next.obsidianRoot)) throw new Error("Use an absolute Obsidian vault folder path.");
		next.obsidianRoot = resolveSourcePath(next.obsidianRoot, resolvePolicy(fileAccessPolicy()));
		if (!(await fs.stat(next.obsidianRoot)).isDirectory()) throw new Error("The Obsidian source must be a folder.");
	}
	await fs.mkdir(path.dirname(configFile), { recursive: true });
	const temporary = `${configFile}.${randomUUID()}.tmp`;
	try { await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" }); await fs.rename(temporary, configFile); }
	finally { await fs.rm(temporary, { force: true }); }
	return next;
}
const response = (value: object, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
export async function studyMaterialsResponse(request: Request): Promise<Response> {
	if (!authorized(request)) return response({ error: "Material access requires a trusted same-origin LearnHarness request." }, 403);
	try {
		const raw = await readBoundedJson(request, 64_000);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a material operation.");
		const body = raw as Record<string, unknown>;
		if (body.op === "configure") {
			const operation = writes.catch(() => {}).then(() => saveConfig(body)); writes = operation;
			return response(new StudyMaterials(await operation).status());
		}
		const service = new StudyMaterials(await readConfig());
		if (body.op === "status") return response(service.status());
		if (body.op === "list") {
			if (!sources.has(String(body.source))) throw new Error("Choose a supported material source.");
			for (const key of ["folder", "query", "cursor"]) if (body[key] !== undefined && typeof body[key] !== "string") throw new Error("Invalid material search.");
			return response(await service.list(body.source as MaterialSource, body.folder as string | undefined, body.query as string | undefined, body.cursor as string | undefined));
		}
		if (body.op === "prepare") {
			if (!Array.isArray(body.materials) || !body.materials.length || body.materials.length > 8) throw new Error("Choose between one and eight documents.");
			const references: MaterialReference[] = body.materials.map(value => {
				if (!value || typeof value !== "object" || !sources.has(value.source) || typeof value.id !== "string" || !value.id || value.id.length > 3000) throw new Error("Invalid selected material.");
				return { source: value.source, id: value.id };
			});
			const materials = []; let size = 0;
			for (const reference of references) {
				const material = await service.read(reference); size += material.text.length;
				if (size > 60_000) throw new Error("The selection exceeds 60,000 characters. Choose fewer documents.");
				materials.push(material);
			}
			return response({ materials });
		}
		throw new Error("Unknown material operation.");
	} catch (error) { return response({ error: error instanceof Error ? error.message : "Could not load selected materials." }, error instanceof CustomBodyLimitError ? 413 : 400); }
}
