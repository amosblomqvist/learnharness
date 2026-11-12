import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error("Refusing to build into a linked directory.");
  try { fs.lstatSync(path.join(output, "data")); throw new Error("Refusing to build over plugin data. Move it to a safe location first."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
} catch (error) { if (error.code !== "ENOENT") throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const shared = { absWorkingDir: root, bundle: true, target: "es2022", legalComments: "eof", metafile: true };
const results = await Promise.all([
  build({ ...shared, entryPoints: ["src/main.ts"], outfile: path.join(output, "main.js"), format: "esm", platform: "browser" }),
  build({ ...shared, entryPoints: ["src/backend.ts"], outfile: path.join(output, "backend.cjs"), format: "cjs", platform: "node", target: "node22" }),
]);
for (const result of results) for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith("src/")) throw new Error(`Unexpected runtime input in GitHub Sync bundle: ${input}`);
}
for (const [from, to] of [["manifest.json", "manifest.json"], ["src/styles.css", "styles.css"], ["README.md", "README.md"], ["LICENSE", "LICENSE"]]) {
  fs.copyFileSync(path.join(root, from), path.join(output, to));
}
console.log(`Built installable package: ${output}`);
