"use strict";
// Shipped as a real file, NOT imported into the Next module graph. Both this
// sidecar and plugin entrypoints are opened by Node's native createRequire.
const { createRequire } = require("node:module");
const { isAbsolute } = require("node:path");

exports.load = function load(filename) {
	if (!isAbsolute(filename)) throw new Error("Plugin entrypoint must be absolute");
	// Keep Node's cache: toggling creates a fresh activation, not a code reload.
	return createRequire(filename)(filename);
};
