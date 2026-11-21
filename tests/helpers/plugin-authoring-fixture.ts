/** Seed canonical reference material, without dependencies/builds/data, in isolated curator fixtures. */
import * as fs from "node:fs";
import * as path from "node:path";

/** Code examples can contain [index](argument) syntax that is not a Markdown link. */
export function markdownProse(text: string): string {
	let fence: { marker: string; length: number } | undefined;
	return text.split("\n").map(line => {
		const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (!fence && match) { fence = { marker: match[1]![0]!, length: match[1]!.length }; return ""; }
		if (fence) {
			if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
			return "";
		}
		return line;
	}).join("\n");
}

export function markdownAnchors(text: string): Set<string> {
	const seen = new Map<string, number>();
	return new Set([...markdownProse(text).matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) => {
		const slug = heading!.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "").replace(/ /g, "-");
		const count = seen.get(slug) ?? 0; seen.set(slug, count + 1);
		return count ? `${slug}-${count}` : slug;
	}));
}

export function seedAuthoringReferenceFixture(root: string) {
	const source = path.resolve(import.meta.dirname, "../..");
	for (const id of ["flashcards", "coding-questions", "drawing-pad", "rich-code-blocks", "listening", "ui-showcase"]) {
		for (const name of [".gitignore", "README.md", "LICENSE", "THIRD-PARTY.md", "FSRS-LICENSE.txt", "manifest.json", "package.json", "package-lock.json", "tsconfig.json", "src", "scripts", "tests", "licenses"]) {
			const from = path.join(source, "plugins", id, name);
			if (!fs.existsSync(from)) continue;
			const to = path.join(root, "plugins", id, name);
			fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true });
		}
	}
	for (const id of ["hello-plugin", "managed-agent", "teaching-extension"]) fs.cpSync(path.join(source, "examples/plugins", id, "dist"), path.join(root, "examples/plugins", id, "dist"), { recursive: true });
	fs.cpSync(path.join(source, "docs/plugin-api"), path.join(root, "docs/plugin-api"), { recursive: true });
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	// The real generator and compiler have independent coverage tests. Curator fixtures
	// exercise archive/source admission and link integrity, not repeated compiler builds.
	fs.writeFileSync(path.join(root, "scripts/build-plugin-api-reference.mjs"), `import fs from 'node:fs';import path from 'node:path';fs.cpSync(path.resolve('docs/plugin-api'),process.argv[3],{recursive:true});`);
}
