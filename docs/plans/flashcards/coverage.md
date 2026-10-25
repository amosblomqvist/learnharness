# Codebase map coverage

Baseline: `b277ee3e0fa24249c1b2d0f9b7fd6ed485f484b9`. All **533 tracked files** are assigned exactly once across **19 existing modules**. The composed plan adds five proposed flashcard modules.

This is an architecture overview, not a class-by-class runtime call graph. Module groupings are authored for navigation; cross-module references inside captured evidence do not change primary file ownership. Tests and packaged assets are summarized on the canvas, with every path available in the inventory.

| Module | Tracked files | Scope |
| --- | ---: | --- |
| Application shell | 10 | Compose pages, navigation and global providers. |
| Session & practice UI | 44 | Render conversations, learner input, practice and session navigation. |
| Knowledge graph UI | 11 | Display graph, coverage, home overview and graph interactions. |
| Settings UI | 14 | Configure models, keys, appearance and connections. |
| Shared UI & artifacts | 24 | Render reusable controls, messages and generated artifacts. |
| HTTP route adapters | 31 | Expose app operations through Next.js routes and desktop authorization. |
| Server orchestration | 14 | Compose stores, turns, compaction, search, pricing and streams. |
| Open-window lifecycle | 14 | Manage Electron, desktop capabilities and per-window event streams. |
| Session records | 5 | Persist native messages, session identity and source coverage contracts. |
| Knowledge graph & extraction | 8 | Own graph storage, mutation and teacher-only knowledge extraction. |
| Background jobs | 8 | Manage job persistence, completion and specialized research/artifact workers. |
| Agent runtime & providers | 15 | Run bounded subagents and provider bridges behind injected engine ports. |
| Teaching agent & tools | 37 | Assemble teaching prompts, tools and interactive agent execution. |
| Settings & credentials | 10 | Persist settings and credentials; resolve model and role configuration. |
| Shared domain & projections | 35 | Define pure contracts, search, layout and presentation projections. |
| Test suites | 185 | Verify domain, stores, routes, UI, providers and packaging. |
| Build & development tooling | 26 | Configure dependencies, builds, linting, scripts and CI. |
| Documentation & skills | 27 | Record architecture, contribution rules and reusable workflows. |
| Packaged assets | 15 | Provide icons, branding and release resources. |

## Dependency evidence

The map contains 107 grouped static import edges. Each edge lists source locations and resolved target files. The nine proposed flashcard edges describe intended API contracts separately. Static imports include type-only imports and barrel re-exports; they do not establish runtime payloads, actual calls, HTTP/IPC wiring, or transitive impact.

The bounded lexical scan covers literal local `import`, `from`, dynamic `import()` and `require()` in JS/TS source. It resolves relative and `@/` paths against tracked files using common extensions and index files. It does not parse TypeScript semantics, exclude all comments, or resolve computed imports. External packages are omitted. These limitations apply to dependency completeness, not the file inventory.

5 local references were unresolved and are retained for inspection:

- `next-env.d.ts:3` → `./.next/dev/types/routes.d.ts`
- `next-env.d.ts:4` → `./.next/dev/types/root-params.d.ts`
- `tests/auth-provider-keys.test.ts:24` → `../node_modules/@earendil-works/pi-ai/dist/providers/all.js`
- `tests/auth-provider-keys.test.ts:25` → `../node_modules/@earendil-works/pi-ai/dist/env-api-keys.js`
- `tests/demo-runtime-payload.test.ts:27` → `./browser-data/browser-data.js`

## Navigation

Press **z** in the updated planning-harness viewer to switch between the full map and the relevant slice. The slice contains changed/proposed modules plus direct callers/providers and contracts; it is compactly arranged with changes first. It does not claim downstream impact. The header displays visible/total module counts. Both canvas and tree use the same slice, and module internals remain accessible. Press z again before searching unrelated files.

Use **Enter** to inspect a module, **e** for connections, **v** for provided interfaces, and **i** to follow captured implementation references. Source excerpts are snapshots of the pinned revision; planned locations are intentions rather than a known code diff.

Machine-readable evidence: [inventory.json](inventory.json), including the primary owner and SHA-256 of every tracked file, resolved dependency references and unresolved local references. Proposal artifacts themselves are outside the pinned upstream inventory. Recompute the map when changing the source baseline; this snapshot is not an always-current TypeScript index.
