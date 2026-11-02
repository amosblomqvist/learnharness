/** `node:fs/promises` for the phone build — the promise half of ./fs.ts. */
import { constants, promises } from "./fs.ts";

export const { readFile, writeFile, appendFile, stat, lstat, mkdir, readdir, unlink, rm, rename, access, mkdtemp, chmod, open } = promises;
export { constants };
export default { ...promises, constants };
