const { defineConfig, globalIgnores } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([globalIgnores(["dist/*", ".expo/*"]), expoConfig]);
