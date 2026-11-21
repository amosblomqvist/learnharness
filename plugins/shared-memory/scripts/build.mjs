import { build } from 'esbuild';
import { mkdir, copyFile, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLicenseNotice } from './license-notice.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'dist');

async function exists(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Never build through a linked dist or over plugin data placed inside it.
const current = await exists(out);
if (current?.isSymbolicLink()) throw new Error('Refusing to build into a linked directory.');
if (current && await exists(path.join(out, 'data'))) throw new Error('Refusing to build over plugin data. Move it to a safe location first.');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// platform node leaves only Node built-ins external; the MCP SDK client is bundled.
const result = await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src/backend.cjs')],
  outfile: path.join(out, 'backend.cjs'),
  bundle: true, format: 'cjs', platform: 'node', target: 'node22',
  legalComments: 'linked', metafile: true, logLevel: 'warning',
});
await writeLicenseNotice({ metafile: result.metafile, workingDirectory: root, legalFile: path.join(out, 'backend.cjs.LEGAL.txt') });
// The browser module has no dependencies to bundle beyond its own source.
await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src/main.js')],
  outfile: path.join(out, 'main.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'warning',
});
await Promise.all([
  ...['manifest.json', 'LICENSE', 'README.md'].map(file => copyFile(path.join(root, file), path.join(out, file))),
  copyFile(path.join(root, 'src/styles.css'), path.join(out, 'styles.css')),
]);
console.log(`Built ${out}`);
