import fs from "node:fs";
import path from "node:path";
import { SOURCE_ORGANIZATION_FILE } from "../../config.ts";
import { emptySourceOrganization, parseSourceOrganization } from "../core/source-organization.ts";
import type { SourceOrganizationStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export const sourceOrganizationStore: SourceOrganizationStore = {
	read() {
		assertGraphFormat();
		let raw: string;
		try { raw = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySourceOrganization();
			throw error;
		}
		return parseSourceOrganization(JSON.parse(raw));
	},
	write(state) {
		assertGraphFormat();
		const valid = parseSourceOrganization(state);
		fs.mkdirSync(path.dirname(SOURCE_ORGANIZATION_FILE), { recursive: true });
		ensureGraphFormat();
		writeFileAtomicSync(SOURCE_ORGANIZATION_FILE, JSON.stringify(valid, null, "\t") + "\n");
		emit("sources-changed", {});
	},
};
