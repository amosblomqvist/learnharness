import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

/**
 * ESLint with one job here: ENFORCE THE IMPORT LAW (the shell/core
 * architecture, docs/architecture.md). Everything else stays out of the
 * way — this is not a style linter.
 *
 *   components/**  →  "@/src/core"  (the pure core barrel) — ONLY
 *   app/**         →  "@/src/core" + "@/src/server" (the server barrel) — ONLY
 *   src/core/**    →  never imports src/agent, src/server, src/store (pure
 *                    core: adapters implement core/ports.ts, never the reverse)
 *   src/agent/**   →  never imports src/server, src/store (dependencies —
 *                    the storage ports, the composition — arrive via
 *                    factories/closures from the chat-handler)
 *
 * tests/ and scripts/ are internal — unrestricted.
 */

export default defineConfig([
	// electron/** — the desktop shell: plain Node, no framework, outside the
// import law (same rationale as scripts/).
	globalIgnores([".next/**", "node_modules/**", "data/**", "next-env.d.ts", "scripts/**", "electron/**", "dist/**"]),
	{
		files: ["**/*.{js,mjs,ts,tsx}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: "latest", sourceType: "module" },
		},
		plugins: { "@next/next": nextPlugin, import: importPlugin },
		settings: {
			"import/resolver": { typescript: { alwaysTryTypes: true } },
		},
		rules: {
			...nextPlugin.configs.recommended.rules,
			"import/no-restricted-paths": [
				"error",
				{
					zones: [
						{
							target: "./components",
							from: "./src",
							// NOTE: the plugin resolves `except` relative to the zone's `from` path.
							except: ["./core/index.ts"],
							message:
								"Browser shell imports ONLY the pure core barrel: `from \"@/src/core\"` (architecture: docs/architecture.md).",
						},
						{
							target: "./app",
							from: "./src",
							except: ["./core/index.ts", "./server/index.ts"],
							message:
								"app/ (transport + server components) imports ONLY the barrels: `@/src/core` and `@/src/server` (architecture: docs/architecture.md).",
						},
						{
							target: "./src/core",
							from: ["./src/agent", "./src/server", "./src/store"],
							message:
								"Pure core never imports IO layers (agent/server/store): adapters implement core/ports.ts, and the composition root (src/server/stores.ts) passes them in (architecture: docs/architecture.md).",
						},
						{
							target: "./src/agent",
							from: ["./src/server", "./src/store"],
							message:
								"The agent layer receives its dependencies (storage ports via factories/closures) — it never imports the server layer or store adapters (architecture: docs/architecture.md).",
						},
					],
				},
			],
		},
	},
]);
