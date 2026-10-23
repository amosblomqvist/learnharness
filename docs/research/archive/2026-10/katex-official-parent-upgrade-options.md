# Official parent upgrade options for KaTeX

<!-- archive-note:start -->
> Archived on 2026-10-23 under [workspace task 26](https://github.com/gzy31007/learnharness/issues/26). The original report follows unchanged except for mechanical local-link routing.
>
> Research cutoff: 2026-10-21, Asia/Shanghai. Historical input: the report's declared local dependency graph and the 2026-10-21 12:17-12:23 Asia/Shanghai registry window; no newly built candidate.
>
> Later status, checked against the archive baseline: This remains a deferred decision record, not completed remediation. The owner chose to wait for an official compatible chain, temporarily accepting the known KaTeX risk only for existing local personal use and suspending new external distribution. That acceptance excludes DOMPurify and other vulnerabilities. The earlier 0.18.2 out-of-range override is not the integration plan. The archive baseline still locks KaTeX 0.16.47. [Owning record](https://github.com/gzy31007/learnharness/issues/17).
>
> Read the [archive guide](README.md) and [local evidence register](local-evidence.md) before reusing any present-tense statement, line number, or acceptance result. Archive publication is not a new test run, distribution approval, or general risk acceptance.
<!-- archive-note:end -->

Research window: 2026-10-21, approximately 12:17 to 12:23 Asia/Shanghai, equivalent to 04:17 to 04:23 UTC. Registry metadata was first sampled at 04:17:56 UTC and the final blocker cross-check at 04:21:35 UTC. These are observations of published metadata, not predictions about future releases.

## Decision answer

**No complete, published, contract-satisfying version-only combination exists for the application's current integrations in this snapshot.** Updating official parents is allowed by the owner's revised direction, but the latest published math plugin still requires KaTeX 0.16, and the latest published Mermaid plugin still requires Mermaid 11. Both are ordinary production dependencies. Updating Streamdown itself removes one redundant Mermaid dependency, not these application-used plugin dependencies. Sources are the full official registry records for [the math plugin](https://registry.npmjs.org/%40streamdown%2Fmath), [the Mermaid plugin](https://registry.npmjs.org/%40streamdown%2Fmermaid), [Streamdown](https://registry.npmjs.org/streamdown) and [Mermaid](https://registry.npmjs.org/mermaid).

This conclusion is about retaining the existing integrations through published parent upgrades. It is not a proof that no other rendering architecture could preserve equivalent product behavior. Replacing those integrations would require a separate owner decision and code adaptation, which this research neither designs nor authorizes.

The previous exact KaTeX 0.18.2 plus out-of-range override is historical validation, not the selected integration plan. DOMPurify 3.4.16 remains the owner's future target. Nothing in this report changes that target or accepts the current risk.

## Scope and method

The acceptance condition is that every package-manager KaTeX node resolves to at least 0.18.2 while satisfying every parent's published dependency range. There must be no forced out-of-range override, self-maintained patch or fork, feature removal, or application-owned editing of a third party's manifest to claim compatibility. A range permitting a safe version is weaker than a range guaranteeing a safe lower bound, and neither is runtime compatibility evidence.

I read the official npm registry JSON bodies, versioned official release bodies through GitHub's API, and official source pinned to release tags or registry `gitHead` commits. No search summaries were used. HTTP proxy checks against GitHub returned HTTP 200 before the GitHub collection batches. Requests used the explicit `http://127.0.0.1:7897` proxy. Public response bodies were processed in memory rather than cached into the repository.

The authorized output is this one new report. No package installation, tarball download, audit execution, patch, build, test, application run, tracker operation, commit, push, CI, release, credential access, real-data access, or Windows operation was performed. Executing a metadata-collection script is not executing the application or a compatibility test.

## Local baseline and actual integrations

The current [manifest:33-64](local-evidence.md#local-103) declares `@streamdown/math ^1.0.2`, `@streamdown/mermaid ^1.0.2`, `katex ^0.16.47`, `mermaid ^11.17.0` and `streamdown ^2.5.0`. It also fixes Next to 16.3.8 and declares React and React DOM `^19.2.8`. The [lock:11749-11763](local-evidence.md#local-091) contains KaTeX 0.16.47.

These integrations are not hypothetical unused packages:

- [The Markdown plugin configuration:349-356](local-evidence.md#local-033) calls `createMathPlugin({ singleDollarTextMath: true })`.
- [The shared diagram renderer:12-40](local-evidence.md#local-039) imports `createMermaidPlugin` from `@streamdown/mermaid` and calls `plugin.getMermaid(mermaidTheme).render(id, chart)`. Its configuration includes `securityLevel: "strict"` and `theme: "dark"`.
- [The glyph helper:1-25](local-evidence.md#local-037) imports KaTeX directly and calls `renderToString`; [the root layout:3](local-evidence.md#local-031) imports its CSS.

The app bypasses Streamdown's built-in diagram presentation, but does not bypass the separate Mermaid plugin. Removing Streamdown's own Mermaid edge is useful graph cleanup, not permission to remove the application-used plugin.

## Published contracts and exact blockers

The following are fresh registry facts, not values copied from the previous report. The version endpoints identify exact release contracts; the linked complete registry documents also supplied version enumeration and dist-tags.

| Parent or package | Exact published version examined | Relevant production declaration | Consequence |
| --- | --- | --- | --- |
| `@streamdown/math` | [1.0.3](https://registry.npmjs.org/%40streamdown%2Fmath/1.0.3), current latest | `katex ^0.16.27`, `rehype-katex ^7.0.1`, `remark-math ^6.0.0` | The plugin alone blocks a graph containing only KaTeX >=0.18.2. |
| `rehype-katex` | [7.0.1](https://registry.npmjs.org/rehype-katex/7.0.1), current latest | `katex ^0.16.0` | Independent rendering-parent blocker even if the math plugin's own KaTeX declaration were removed. |
| `remark-math` | [6.0.0](https://registry.npmjs.org/remark-math/6.0.0), current latest | `micromark-extension-math ^3.0.0`, `mdast-util-math ^3.0.0`, `unified ^11.0.0` | Introduces the micromark production branch without directly declaring KaTeX. |
| `micromark-extension-math` | [3.1.0](https://registry.npmjs.org/micromark-extension-math/3.1.0), current latest | `katex ^0.16.0` | Still blocks the package-manager criterion even when its HTML compiler is not the selected renderer. |
| `mdast-util-math` | [3.0.0](https://registry.npmjs.org/mdast-util-math/3.0.0), current latest | No KaTeX dependency | This AST adapter is not another KaTeX blocker. |
| `@streamdown/mermaid` | [1.0.3](https://registry.npmjs.org/%40streamdown%2Fmermaid/1.0.3), current latest | `mermaid ^11.16.1` | Excludes Mermaid 12.2.0. All released Mermaid 11 versions enumerated in the registry retain a KaTeX 0.16 range. |
| `mermaid` | [11.17.2](https://registry.npmjs.org/mermaid/11.17.2), latest 11.x publication | `katex ^0.16.47` | A compatible plugin patch refresh does not remove affected KaTeX. |
| `mermaid` | [12.0.0](https://registry.npmjs.org/mermaid/12.0.0) and [12.1.0](https://registry.npmjs.org/mermaid/12.1.0) | Both still `katex ^0.16.47` | A major-version jump by itself does not solve the KaTeX declaration. |
| `mermaid` | [12.2.0](https://registry.npmjs.org/mermaid/12.2.0), current latest | `katex ^0.18.0`, Node `>=22.12.0` | First examined published Mermaid release permitting a fixed 0.18 engine, but not permitted by the existing or latest Mermaid plugin. |
| `streamdown` | [2.5.0](https://registry.npmjs.org/streamdown/2.5.0), local lock | `mermaid ^11.12.2` | An additional mandatory Mermaid 11 branch in the current lock. |
| `streamdown` | [2.6.0](https://registry.npmjs.org/streamdown/2.6.0) and [2.7.1](https://registry.npmjs.org/streamdown/2.7.1), current latest | No production Mermaid or KaTeX dependency | Upgrading to 2.6.0 is the narrowest examined removal of this one edge. It leaves both plugins untouched. |

The complete [math-plugin registry](https://registry.npmjs.org/%40streamdown%2Fmath) lists only 1.0.0, 1.0.1, 1.0.2 and 1.0.3. All four declare the same three relevant production ranges. The complete [Mermaid-plugin registry](https://registry.npmjs.org/%40streamdown%2Fmermaid) likewise lists only 1.0.0 through 1.0.3. The first three require `mermaid ^11.12.2`, and 1.0.3 requires `^11.16.1`. There is no newer published plugin, prerelease included, hidden behind another dist-tag in these records.

I also enumerated published stable contracts in the complete [rehype-katex](https://registry.npmjs.org/rehype-katex) and [micromark-extension-math](https://registry.npmjs.org/micromark-extension-math) records. No examined release accepts KaTeX 0.18. Older packages are not an official compatible upgrade path around these blockers. The decisive impossibility proof does not require searching every old renderer architecture: the application-used math plugin has only the four published versions above, all of which mandate KaTeX 0.16.

### Blocking paths

The arrows below represent ordinary `dependencies`, not upstream development dependencies or optional peers. Each edge's owning contract is linked in the table above.

1. Application -> `@streamdown/math@1.0.3` -> `katex ^0.16.27`.
2. Application -> `@streamdown/math@1.0.3` -> `rehype-katex ^7.0.1` -> `rehype-katex@7.0.1` -> `katex ^0.16.0`.
3. Application -> `@streamdown/math@1.0.3` -> `remark-math ^6.0.0` -> `remark-math@6.0.0` -> `micromark-extension-math ^3.0.0` -> `micromark-extension-math@3.1.0` -> `katex ^0.16.0`.
4. Application -> `@streamdown/mermaid@1.0.3` -> `mermaid ^11.16.1` -> compatible Mermaid 11 -> KaTeX 0.16.
5. Application -> locked `streamdown@2.5.0` -> `mermaid ^11.12.2` -> compatible Mermaid 11 -> KaTeX 0.16. Streamdown >=2.6.0 removes this particular path.
6. The root's own `katex ^0.16.47` and `mermaid ^11.17.0` declarations also need changes for a future 0.18/Mermaid 12 graph. Updating them cannot invalidate the mandatory child constraints above.

For 0.x caret ranges, `^0.16.0` and `^0.16.27` stay below 0.17.0. They cannot resolve to 0.18.2. This is the dependency-range interpretation used here. Conversely, `^0.18.0` permits 0.18.0 and 0.18.1 as well as fixed versions. The current [KaTeX registry](https://registry.npmjs.org/katex) still tops out at 0.16.47 on the 0.16 line, with 0.18.11 the newest 0.18 release and 0.19.0 the latest overall. None is an official 0.16 security backport.

The [official advisory](https://api.github.com/advisories/GHSA-238p-pmpm-9mq7) marks `>=0.11.0, <0.18.2` affected and 0.18.2 first patched. Its description says, "KaTeX does not enable said prototype pollution" and requires insertion of generated output without a separate sanitizer for the described exploit. This report does not convert package presence into a demonstrated application exploit.

## Package presence versus execution

### Math

The [math plugin's 1.0.3 source](https://raw.githubusercontent.com/vercel/streamdown/%40streamdown/math%401.0.3/packages/streamdown-math/index.ts) imports `remarkMath` and `rehypeKatex`. `createMathPlugin` returns these as `remarkPlugin` and `rehypePlugin`. The implementation forwards `singleDollarTextMath` to remark-math and `errorColor` to rehype-katex. It does not expose a renderer-injection option. The source does not directly import the plugin's own declared KaTeX dependency, but the declaration still installs it.

The [rehype-katex 7.0.1 source at its registry gitHead](https://raw.githubusercontent.com/remarkjs/remark-math/88a9497e1ede93b958237c85edbf5651faeca7af/packages/rehype-katex/lib/index.js) imports KaTeX and calls `katex.renderToString`. This is the actual Markdown rendering branch selected by the plugin.

The [remark-math 6.0.0 source at its registry gitHead](https://raw.githubusercontent.com/remarkjs/remark-math/d5d0660b150810a535bbb07eac6cc96a4510aa24/packages/remark-math/lib/index.js) imports `{math}` from micromark-extension-math and registers `math(settings)` in `data.micromarkExtensions`. It registers mdast's from/to-Markdown adapters separately. It does not register `mathHtml` as an HTML compiler.

The [micromark entry source](https://raw.githubusercontent.com/micromark/micromark-extension-math/e2afefe07f3bdbc8d7188e009aff71566a2ab6f0/dev/index.js) exports both `math` and `mathHtml`. Its [HTML compiler source](https://raw.githubusercontent.com/micromark/micromark-extension-math/e2afefe07f3bdbc8d7188e009aff71566a2ab6f0/dev/lib/html.js) imports KaTeX and captures `katex.renderToString`. This establishes the reason for its production KaTeX declaration, not that the application's remark pipeline invokes that compiler. Bundler evaluation and tree-shaking were not inspected. Regardless of emitted code, the owner's all-package-manager-nodes criterion still includes that dependency.

### Mermaid and Streamdown

The [Mermaid plugin 1.0.3 source](https://raw.githubusercontent.com/vercel/streamdown/%40streamdown/mermaid%401.0.3/packages/streamdown-mermaid/index.ts) imports `mermaidLib` from `mermaid` as a value, not merely a type. Its `render` method calls `mermaidLib.render`; `getMermaid(config)` initializes it with the supplied configuration. This matches the application's actual integration.

The [Mermaid 12.2.0 manifest](https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4012.2.0/packages/mermaid/package.json) maps the default package import to `dist/mermaid.core.mjs`. Its [common rendering source](https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4012.2.0/packages/mermaid/src/diagrams/common/common.ts) dynamically imports `katex` when math is present, the environment supports the chosen MathML path and the build includes large features. `renderKatexSanitized` applies `sanitizeText` after rendering. This source is not evidence of a newly emitted Next bundle or of every distributed file's embedded engine version.

The [Streamdown 2.6.0 release](https://github.com/vercel/streamdown/releases/tag/streamdown%402.6.0) explicitly says it removed Mermaid as a "hard runtime dependency" and replaced the type import with a local structural type. The [2.6.0 source manifest](https://raw.githubusercontent.com/vercel/streamdown/streamdown%402.6.0/packages/streamdown/package.json) and [2.7.1 source manifest](https://raw.githubusercontent.com/vercel/streamdown/streamdown%402.7.1/packages/streamdown/package.json) have no direct production declaration for `remark-math`, `rehype-katex` or `micromark-extension-math` either. They still list the math and Mermaid plugins under `devDependencies`. These are upstream development/test dependencies, not runtime dependencies installed transitively merely because this app consumes Streamdown. The application's own direct plugin declarations are a separate matter.

The KaTeX and Mermaid edges listed as blockers are not optional dependencies. `@types/katex` is type metadata and must not be counted as a second executable KaTeX engine. Neither removing development dependencies nor choosing to omit optional dependencies removes these ordinary production edges.

## Narrowest partial candidates, not an approved full combination

| Partial option | Contract-level result | Why it is not the requested solution |
| --- | --- | --- |
| Streamdown 2.6.0 | Removes Streamdown's own Mermaid 11 edge. [Registry](https://registry.npmjs.org/streamdown/2.6.0), [release](https://github.com/vercel/streamdown/releases/tag/streamdown%402.6.0). | Both application-used plugins still force the old dependency lines. |
| Mermaid 12.2.0 with exact KaTeX 0.18.2 | 0.18.2 is the first fixed version and satisfies Mermaid's `^0.18.0`. [Mermaid contract](https://registry.npmjs.org/mermaid/12.2.0), [advisory](https://api.github.com/advisories/GHSA-238p-pmpm-9mq7). | The Mermaid plugin excludes 12.2.0; the math branches still exclude 0.18.2. Prior isolated override validation does not change those declarations. |
| Mermaid 12.2.0 with exact KaTeX 0.18.11 | The newest published 0.18 engine also fits the Mermaid range. [KaTeX contract](https://registry.npmjs.org/katex/0.18.11). | Same plugin blockers, plus behavior and Node dependency changes described below. It is not selected merely because it is newer. |
| KaTeX 0.19.0 | Current latest overall. [Registry](https://registry.npmjs.org/katex/0.19.0). | It does not satisfy Mermaid 12.2.0's `^0.18.0`, nor any current math-parent 0.16 range. |

Even for a future admissible graph, a safe root pin does not prove every child reused that node. An approved installation would need a lock graph with every KaTeX instance enumerated and checked. A manifest-only range change or a normal fresh resolver choosing today's newest version does not establish this acceptance condition.

## React, Next, Node and breaking changes

### Framework contracts

[Streamdown 2.6.0](https://registry.npmjs.org/streamdown/2.6.0), [2.7.1](https://registry.npmjs.org/streamdown/2.7.1), [math 1.0.3](https://registry.npmjs.org/%40streamdown%2Fmath/1.0.3) and [Mermaid plugin 1.0.3](https://registry.npmjs.org/%40streamdown%2Fmermaid/1.0.3) accept React `^18.0.0 || ^19.0.0`; Streamdown accepts the same React DOM range. These package records do not declare a Next peer or an explicit Node engine. Absence of an engine field is not a statement that all Node versions work.

The existing [Next 16.3.8 contract](https://registry.npmjs.org/next/16.3.8) requires Node `>=20.9.0` and allows React/React DOM `^19.0.0` as one alternative. [React DOM 19.2.8](https://registry.npmjs.org/react-dom/19.2.8) requires React `^19.2.8`. Thus the app's declared React 19.2.8 baseline is not rejected by the examined parent peers, and these facts do not require a Next or React upgrade. They do not prove hydration, SSR, streaming-state, CSS or custom-component compatibility.

Mermaid 12.2.0 raises the combined examined engine floor to Node `>=22.12.0`, stricter than Next's own floor. KaTeX [0.18.11](https://registry.npmjs.org/katex/0.18.11) and [0.19.0](https://registry.npmjs.org/katex/0.19.0) also declare ordinary `commander ^15.0.0`; [Commander 15.0.0](https://registry.npmjs.org/commander/15.0.0) requires Node `>=22.12.0`. This is an installation-graph constraint even if the browser does not use KaTeX's CLI. [KaTeX 0.18.2](https://registry.npmjs.org/katex/0.18.2) instead declares `commander ^8.3.0`. No candidate runtime was launched or checked.

### Behavior changes that prevent a compatibility claim

- [Mermaid 12.0.0's official release](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0) requires ES2024, Safari 17.4+ and Node 22.12+. It makes bundled ELK the default layout and changes default theme/look to `redux-color`/`neo` for the listed diagram families. It removes `defaultRenderer` from flowchart/class/state configuration in favor of top-level `layout`. The app explicitly chooses a dark theme but not a layout or look, so that explicit theme does not by itself preserve prior rendering. The release documents opt-in settings to retain earlier defaults, but applying a configuration is an owner-controlled compatibility choice, not research authorization.
- [Mermaid 12.1.0](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.1.0) enables `elk.orientFeedbackEdges` by default and states that this changes existing ELK layouts. This change is inherited by a move to 12.2.0.
- [Streamdown 2.6.0](https://github.com/vercel/streamdown/releases/tag/streamdown%402.6.0) removes the `codeDownload` prop in favor of the controls API despite being a minor-numbered release. It also changes animation, custom-tag handling, memoization and sanitization-related behavior. [The 2.7.0 release](https://github.com/vercel/streamdown/releases/tag/streamdown%402.7.0) moves Marked to 18 and explains its changed whitespace token boundaries and Streamdown's adaptation. Its metadata is preserved in the [2.7.1 contract](https://registry.npmjs.org/streamdown/2.7.1), which also moves remend from the local baseline's 1.3.0 to 1.4.0. These changes require future application validation, not a recommendation to jump to latest.
- [KaTeX 0.17.0](https://github.com/KaTeX/KaTeX/releases/tag/v0.17.0) changes the internal `__defineFunction` API. [0.18.0](https://github.com/KaTeX/KaTeX/releases/tag/v0.18.0) changes internal CSS class prefixes and explicitly warns consumers with selectors or allowlists to update them. The application imports KaTeX CSS, so engine/style alignment is part of any eventual upgrade. This report does not claim every existing `katex-*` selector breaks.
- [KaTeX 0.18.11](https://github.com/KaTeX/KaTeX/releases/tag/v0.18.11) routes missing-character metrics through `strict`. [0.19.0's release](https://github.com/KaTeX/KaTeX/releases/tag/v0.19.0) documents that the change already shipped in 0.18.11: strict error mode can throw, callbacks receive `symbolNotInFont`, and callbacks returning null/undefined now warn and no longer typecheck. Therefore 0.18.11 and 0.18.2 are not behaviorally interchangeable merely because both satisfy the advisory threshold.

## DOMPurify declaration impact and embedded-copy limit

[Mermaid 11.17.0](https://registry.npmjs.org/mermaid/11.17.0), [11.17.1](https://registry.npmjs.org/mermaid/11.17.1) and [11.17.2](https://registry.npmjs.org/mermaid/11.17.2) declare `dompurify ^3.3.3`. [12.0.0](https://registry.npmjs.org/mermaid/12.0.0), [12.1.0](https://registry.npmjs.org/mermaid/12.1.0) and [12.2.0](https://registry.npmjs.org/mermaid/12.2.0) declare `dompurify ^3.4.12`. The selected target [DOMPurify 3.4.16](https://registry.npmjs.org/dompurify/3.4.16) fits both ranges. This declaration change does not itself require an out-of-range DOMPurify override, but neither range pins 3.4.16. The [current registry](https://registry.npmjs.org/dompurify) has latest 3.4.17; that observation does not replace the owner's 3.4.16 selection.

DOMPurify 3.4.16's `jsdom` and `happy-dom` entries are upstream development dependencies, not evidence that this browser application must install those DOM environments. Its `@types/trusted-types` dependency is optional type metadata. These details must not be confused with Mermaid's ordinary DOMPurify runtime dependency. Source: [exact DOMPurify 3.4.16 metadata](https://registry.npmjs.org/dompurify/3.4.16).

The [Mermaid 12.2.0 common source](https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid%4012.2.0/packages/mermaid/src/diagrams/common/common.ts) imports DOMPurify and uses its hooks and `sanitize`. A package-manager dependency declaration cannot identify the exact DOMPurify bytes prebundled into every published Mermaid distribution file. No tarball or newly built bundle was downloaded or examined, so this report does not claim Mermaid 12.2.0's embedded copies are 3.4.16, that a root DOMPurify selection rewrites them, or that every core/full-ESM/IIFE entry follows the same bundling boundary. The earlier observed embedded 3.4.12 is historical evidence about the previous distribution, not a fresh verification of 12.2.0. This remains an explicit verification gap if a future candidate is authorized.

## Official integration APIs are not a version-only escape

The official [math plugin source](https://raw.githubusercontent.com/vercel/streamdown/%40streamdown/math%401.0.3/packages/streamdown-math/index.ts) describes a structural `MathPlugin` with `remarkPlugin`, `rehypePlugin` and an optional `getStyles`. The official [Mermaid plugin source](https://raw.githubusercontent.com/vercel/streamdown/%40streamdown/mermaid%401.0.3/packages/streamdown-mermaid/index.ts) describes `DiagramPlugin.getMermaid`, `initialize` and `render`. Mermaid itself exposes initialization and rendering, which this wrapper calls. These APIs explain where an owner-authorized alternative integration could be investigated.

They are not proof of a ready, published, version-only replacement retaining this app's behavior. In particular, simply stopping use of `@streamdown/math` while keeping the latest rehype-katex and remark-math still retains their 0.16 branches. Replacing only the math renderer would leave remark-math's micromark dependency. Likewise, bypassing `@streamdown/mermaid` with a direct Mermaid import would change application code and integration ownership. No such change is selected here, and no new adapter is designed.

## What remains for the owner

Under the stated preferences, the valid immediate conclusion is to report the upstream blockers rather than force an upgrade. There is no complete candidate to approve for installation from this research.

The owner can keep all constraints and defer integration until appropriate official parents are published. If work must proceed sooner, the owner would have to explicitly reconsider at least one constraint: authorize investigation of a different official-library integration with application code adaptation, or reconsider the currently excluded override/patch/fork/feature-removal paths. None is implied or recommended by listing it. Whether interim controls or residual-risk handling are acceptable is also a separate decision. The researcher cannot choose that policy.

For a future official release to satisfy the current approach, the math plugin, its rehype renderer and its remark/micromark branch all need compatible published contracts that allow fixed engines, or an official release that removes the relevant mandatory branch without losing required behavior. The Mermaid plugin must permit a fixed-engine Mermaid release, and the root declarations and resolved graph must agree. Merely widening manifests is not enough to establish runtime compatibility.

## Evidence limits and handoff

The previous [KaTeX research](local-evidence.md#local-030) and [issue 17 closeout](local-evidence.md#local-025) were read as background, not used as current registry evidence. Their historical isolated override result is not evidence that an official parent author supports the new dependency contract.

Some attempted GitHub source paths returned HTTP 404: micromark's root `index.js` and `lib/html.js` are generated paths absent from its source commit. The successful `dev/index.js` and `dev/lib/html.js` reads above supplied the original source instead. An exploratory Mermaid `handleRenderingBools.ts` path also returned 404; no claim relies on it. An exploratory unpublished `@streamdown/code@1.1.2` metadata request returned 404; it is not a candidate or an asserted publication.

Still unknown: candidate runtime compatibility; all current deployment Node/browser floors; final Next/Electron chunk contents; actual embedded DOMPurify/KaTeX versions in a future distribution; sanitizer behavior under the new CSS/classes; complete application exploitability; future upstream schedules; tarball-to-source reproducibility. No absence-of-vulnerability or release-readiness claim is made.

The result is a bounded dependency-contract decision aid. The security map remains unresolved by this report, and no issue state or tracker text was changed.
