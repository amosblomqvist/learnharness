// Append the license of every bundled third-party package to the bundle's
// legal file. esbuild's legalComments only keeps comments the packages chose to
// mark as legal, which most bundled packages do not have, so the notice is
// generated from the packages esbuild actually bundled (its metafile inputs).
import { appendFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying)(\.[a-z0-9]+)?$/i;
const RULE = '='.repeat(80);

// The installed package directory that contains a bundled input, or null for plugin source.
function packageRoot(file) {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  const length = parts[at + 1].startsWith('@') ? 2 : 1;
  return parts.slice(0, at + 1 + length).join(path.sep);
}

async function licenseText(directory, name) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map(entry => entry.name).sort();
  if (!files.length) throw new Error(`No license file found for bundled package ${name} in ${directory}. Refusing to build without its license notice.`);
  return (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).map(text => text.trim()).join('\n\n');
}

/** Append one notice per bundled package (name, version, declared license, license file text). */
export async function writeLicenseNotice({ metafile, workingDirectory, legalFile }) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const root = packageRoot(path.resolve(workingDirectory, input));
    if (root) roots.add(root);
  }
  const packages = [];
  for (const directory of roots) {
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const name = manifest.name ?? path.basename(directory);
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'UNKNOWN';
    packages.push({ name, version: manifest.version ?? 'unknown', license, text: await licenseText(directory, name) });
  }
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
  const sections = packages.map(p => [RULE, `${p.name}@${p.version}`, `License: ${p.license}`, RULE, '', p.text, ''].join('\n'));
  const header = ['', 'Third-party packages bundled into backend.cjs and their licenses:', '', ''].join('\n');
  await appendFile(legalFile, header + sections.join('\n'));
  return packages.map(({ name, version, license }) => ({ name, version, license }));
}
