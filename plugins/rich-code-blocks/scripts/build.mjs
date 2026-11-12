import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error("Refusing to build into a symlinked dist directory.");
  try { fs.lstatSync(path.join(output, "data")); throw new Error("Refusing to build over misplaced dist/data; preserve it outside dist first."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
} catch (error) { if (error.code !== "ENOENT") throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const common = { absWorkingDir: root, bundle: true, target: "es2022", minify: true, legalComments: "eof", metafile: true };
const viewportListeners = 'try {\n    window.addEventListener("resize", resizeOuter);\n    window.addEventListener("orientationChange", resizeOuter);\n} catch(e) {\n    // if we aren\'t in a browser, this code will crash, but it is not needed then either.\n}';
const browser = await build({
  ...common, entryPoints: ["src/main.ts"], outdir: output,
  format: "esm", platform: "browser", splitting: true, chunkNames: "assets/chunks/[name]-[hash]",
  alias: { "rich-code-blocks-smiles": "smiles-drawer" },
  plugins: [{ name: "static-renderers-no-window-side-effects", setup(builder) {
    builder.onLoad({ filter: /smiles-drawer\.min\.mjs$/ }, ({ path: file }) => {
      const original = fs.readFileSync(file, "utf8");
      const exposure = /typeof window<"u"&&window\.document&&window\.document\.createElement&&\(window\.SmilesDrawer=[\w$]+,window\.SmiDrawer=[\w$]+\);/g;
      if ((original.match(exposure) ?? []).length !== 1) throw new Error("Pinned SMILES global-exposure patch no longer matches; review the dependency before building.");
      return { contents: original.replace(exposure, "/* Module-only build: window globals omitted. */"), loader: "js" };
    });
    builder.onLoad({ filter: /abc_tunebook_svg\.js$/ }, ({ path: file }) => {
      const original = fs.readFileSync(file, "utf8");
      if (!original.includes(viewportListeners)) throw new Error("Pinned ABC viewport-listener patch no longer matches; review the dependency before building.");
      return { contents: original.replace(viewportListeners, "/* Static-only build: unused viewport listeners omitted. */"), loader: "js" };
    });
  } }],
});
const worker = await build({
  ...common, entryPoints: ["src/tex-worker.ts"], outfile: path.join(output, "assets/tex-worker.js"),
  format: "esm", platform: "browser", alias: { "node:buffer": "buffer" },
  plugins: [{ name: "no-node-dom-or-optimizer-in-worker", setup(builder) {
    builder.onLoad({ filter: /@prinsss[/\\]dvi2html[/\\]lib[/\\]html\.js$/ }, ({ path: file }) => {
      const original = fs.readFileSync(file, "utf8");
      const emission = "htmlText += String.fromCharCode(c);";
      if (original.split(emission).length !== 2) throw new Error("Pinned DVI text-escaping patch no longer matches; review the dependency before building.");
      return { contents: original.replace(emission, 'htmlText += c === 38 ? "&amp;" : c === 60 ? "&lt;" : c === 62 ? "&gt;" : String.fromCharCode(c);'), loader: "js" };
    });
    builder.onResolve({ filter: /^(jsdom|svgo)$/ }, ({ path: name }) => ({ path: name, namespace: "node-only" }));
    builder.onLoad({ filter: /.*/, namespace: "node-only" }, () => ({
      contents: 'export class JSDOM { constructor() { throw new Error("DOM parsing is unavailable in the TeX worker."); } } export function optimize() { throw new Error("Node SVG optimization is unavailable in the TeX worker."); }', loader: "js",
    }));
  } }],
});
const backend = await build({
  ...common, entryPoints: ["src/backend.ts"], outfile: path.join(output, "backend.cjs"), format: "cjs", platform: "node",
});
for (const result of [browser, worker, backend]) {
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.startsWith("src/") && !input.startsWith("node_modules/") && !input.startsWith("node-only:")) throw new Error(`Unexpected runtime input: ${input}`);
  }
}
for (const file of ["manifest.json", "README.md", "LICENSE", "THIRD-PARTY.md"]) fs.copyFileSync(path.join(root, file), path.join(output, file));
fs.copyFileSync(path.join(root, "src/styles.css"), path.join(output, "styles.css"));
const engine = path.join(root, "node_modules/isomorphic-tikzjax");
fs.cpSync(path.join(engine, "tex"), path.join(output, "assets/tex"), { recursive: true });
fs.cpSync(path.join(engine, "css/bakoma"), path.join(output, "assets/fonts/bakoma"), { recursive: true });
const fontCss = fs.readFileSync(path.join(engine, "css/fonts.css"), "utf8").replace(/font-family:\s*([a-zA-Z0-9_-]+);/g, "font-family: rich-code-blocks-font-$1;");
fs.writeFileSync(path.join(output, "assets/fonts/fonts.css"), fontCss);
const notices = path.join(output, "licenses");
fs.mkdirSync(notices, { recursive: true });
fs.cpSync(path.join(root, "licenses"), notices, { recursive: true });
for (const name of ["abcjs", "smiles-drawer", "chroma-js", "isomorphic-tikzjax", "@prinsss/dvi2html", "buffer", "base64-js", "ieee754", "md5", "charenc", "crypt", "is-buffer", "pako"]) {
  const directory = path.join(root, "node_modules", name);
  const license = fs.readdirSync(directory).find(file => /^licen[sc]e(?:\.|$)/i.test(file));
  if (!license) throw new Error(`Missing license for bundled dependency ${name}`);
  fs.copyFileSync(path.join(directory, license), path.join(notices, name.replaceAll("/", "-") + "-LICENSE"));
}
fs.copyFileSync(path.join(engine, "css/bakoma/LICENCE"), path.join(notices, "bakoma-LICENCE"));
console.log(`Built Rich code blocks directly into ${output}`);
console.log(`Browser bundle: ${fs.statSync(path.join(output, "main.js")).size} bytes; TeX worker: ${fs.statSync(path.join(output, "assets/tex-worker.js")).size} bytes.`);
