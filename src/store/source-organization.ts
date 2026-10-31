import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sourceOrganizationFile } from "../../config.ts";
import { emptySourceOrganization, parseSourceOrganization } from "../core/source-organization.ts";
import type { SourceOrganizationStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";

export const sourceOrganizationStore: SourceOrganizationStore = {
	read() {
		assertGraphFormat();
		let raw: string;
		try { raw = fs.readFileSync(sourceOrganizationFile(), "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySourceOrganization();
			throw error;
		}
		return parseSourceOrganization(JSON.parse(raw));
	},
	write(state) {
		assertGraphFormat();
		const valid = parseSourceOrganization(state);
		fs.mkdirSync(path.dirname(sourceOrganizationFile()), { recursive: true });
		ensureGraphFormat();
		const tmp = `${sourceOrganizationFile()}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(valid, null, "\t") + "\n", "utf8");
			fs.renameSync(tmp, sourceOrganizationFile());
		} finally { fs.rmSync(tmp, { force: true }); }
		emit("sources-changed", {});
	},
};
