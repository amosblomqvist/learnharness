import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * LibreOffice → PDF conversion for course-library Office files (owner
 * ruling 2026-10-29: hybrid — convert when LibreOffice is installed, else
 * the in-app extraction in office-extract.ts). A converted PDF keeps slide
 * and page layout, so the existing PDF reading/rendering path sees Office
 * files exactly as they look.
 *
 * Every conversion runs with its OWN throwaway profile dir: soffice
 * refuses to run two instances on one profile, and a learner's open
 * LibreOffice window must never block (or be disturbed by) an import.
 */

const CONVERT_TIMEOUT_MS = 180_000;

function candidates(): string[] {
	const names = process.platform === "win32" ? ["soffice.exe"] : ["soffice", "libreoffice"];
	const onPath = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.flatMap((dir) => names.map((name) => path.join(dir, name)));
	const installs =
		process.platform === "darwin"
			? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
			: process.platform === "win32"
				? [
						path.join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice", "program", "soffice.exe"),
						path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "LibreOffice", "program", "soffice.exe"),
					]
				: ["/usr/bin/soffice", "/usr/lib/libreoffice/program/soffice", "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice"];
	return [...onPath, ...installs];
}

/** Test seam (the headlessOverride idiom): set `current` to pin the
 *  lookup — null forces the in-app extraction path. */
export const sofficeOverride: { current?: string | null } = {};

/** The soffice binary, or null when LibreOffice isn't installed. Looked up
 *  per call (cheap stat calls) so installing LibreOffice later just works
 *  for the next import — no restart. */
export function findSoffice(): string | null {
	if (sofficeOverride.current !== undefined) return sofficeOverride.current;
	for (const candidate of candidates()) {
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			/* not here */
		}
	}
	return null;
}

/** Convert an Office file to PDF bytes. Throws with a readable message on
 *  timeout, a failed run, or a run that produced no PDF. */
export async function convertToPdf(soffice: string, inputPath: string): Promise<Uint8Array> {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "lh-soffice-"));
	try {
		const profile = pathToFileURL(path.join(work, "profile")).href;
		const outDir = path.join(work, "out");
		fs.mkdirSync(outDir);
		await new Promise<void>((resolve, reject) => {
			execFile(
				soffice,
				[`-env:UserInstallation=${profile}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, inputPath],
				{ timeout: CONVERT_TIMEOUT_MS, windowsHide: true },
				(err, _stdout, stderr) => {
					if (err) {
						const reason = (err as { killed?: boolean }).killed ? "timed out" : (stderr || err.message).trim().split("\n")[0];
						reject(new Error(`LibreOffice conversion failed: ${reason}`));
					} else resolve();
				},
			);
		});
		const pdf = fs.readdirSync(outDir).find((f) => f.toLowerCase().endsWith(".pdf"));
		if (!pdf) throw new Error("LibreOffice conversion produced no PDF");
		return new Uint8Array(fs.readFileSync(path.join(outDir, pdf)));
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}
