/**
 * Injected into every module of the phone bundle (esbuild `inject`): free
 * references to `process` and `Buffer` resolve to these shims.
 */
export { browserProcess as process } from "./process.ts";
export { Buffer } from "./buffer.ts";
