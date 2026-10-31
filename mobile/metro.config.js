// The app reuses the harness's pure client code: the session state machine
// (../components/session-core.ts) and the core barrel (../src/core) it
// imports, so the chat protocol stays one source of truth. Metro must watch
// those folders and resolve their packages from the repo root.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const repoRoot = path.resolve(__dirname, "..");
const config = getDefaultConfig(__dirname);

config.watchFolders = [
  path.join(repoRoot, "src/core"),
  path.join(repoRoot, "components"),
  path.join(repoRoot, "node_modules"),
];
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules"), path.join(repoRoot, "node_modules")];

// The core barrel re-exports two server-only modules that import node:crypto
// (coverage hashing, graph ids). The app never calls them; the stub throws
// if it ever does.
const cryptoStub = path.join(__dirname, "src/shims/node-crypto.ts");
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "node:crypto") return { type: "sourceFile", filePath: cryptoStub };
  return (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
