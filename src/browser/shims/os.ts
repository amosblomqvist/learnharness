/** `node:os` for the phone build. */
import { BROWSER_HOME } from "./process.ts";

export const homedir = () => BROWSER_HOME;
export const tmpdir = () => "/lh/tmp";
export const platform = () => "browser";
export const type = () => "Browser";
export const arch = () => "wasm";
export const release = () => "";
export const hostname = () => "phone";
export const cpus = () => [{ model: "browser", speed: 0 }];
export const EOL = "\n";

export default { homedir, tmpdir, platform, type, arch, release, hostname, cpus, EOL };
