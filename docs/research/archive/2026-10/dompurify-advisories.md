# DOMPurify advisories and the narrowest patch for issue 12

<!-- archive-note:start -->
> Archived on 2026-10-23 under [workspace task 26](https://github.com/gzy31007/learnharness/issues/26). The original report follows unchanged except for mechanical local-link routing.
>
> Research cutoff: 2026-10-20, Asia/Shanghai. Historical input: 6c2b0b57f7d3177a777acab081411db539362416; observed HEAD ef38592db11d68bae3b22c175aaefc57966b039e.
>
> Later status, checked against the archive baseline: Research completed, remediation not implemented. The later owner decision selected 3.4.16; the report's unselected-version statements are historical. The archive baseline still locks 3.4.14. Issue closure is not repair or risk acceptance. [Owning record](https://github.com/gzy31007/learnharness/issues/12).
>
> Read the [archive guide](README.md) and [local evidence register](local-evidence.md) before reusing any present-tense statement, line number, or acceptance result. Archive publication is not a new test run, distribution approval, or general risk acceptance.
<!-- archive-note:end -->

Research and source-access date: 2026-10-20, Asia/Shanghai.

## Scope and result

This is research for [learnharness issue 12][issue12], not permission to change dependencies or release software. It covers GHSA-p98j-92pf-mc4p and GHSA-6688-9rhm-gjv2, their upstream fixes, the installed dependency graph, the inspected rendering calls, and a bounded verification plan.

**Facts.** The lockfile and installed package contain DOMPurify **3.4.14**, which falls inside both advisory ranges. Both advisories first list **3.4.16** as patched. **3.4.17** is also published and is the npm `latest` version at the research cutoff. Mermaid 11.17.0 requires `dompurify: ^3.3.3`, so either patch candidate satisfies the locked parent's declared range. A parent upgrade or override is not required merely to resolve the external DOMPurify dependency to either candidate. See the [lock entry](local-evidence.md#local-101), [installed version](local-evidence.md#local-065), [parent constraint](local-evidence.md#local-074), [advisory metadata][global-p98j], [second advisory metadata][global-6688], and [npm registry][npm-dompurify].

**Inference from source, not a runtime exploit verdict.** The inspected default Mermaid import path supplies strings to DOMPurify, not Node inputs with effective `IN_PLACE`. Its registered `afterSanitizeAttributes` hook changes attributes but does not remove nodes. Those facts break necessary conditions for these two specific attacks on that path. There are real HTML insertion sinks. Their presence must not be mistaken for the missing Node-plus-`IN_PLACE` step, nor does their existence establish safety against unrelated sanitizer bugs.

**Important qualification.** Mermaid's separately distributed full ESM bundles embed DOMPurify **3.4.12**. Refreshing the external dependency lock does not rewrite those bytes. Static export/import inspection points the current app at the external-package core build, but no production bundle or Windows package was built or inspected in this research.

**User-confirmed acceptance scope.** In the research clarification, the user selected actual distributed Web and desktop artifacts as the acceptance inventory. Every DOMPurify copy shipped in those artifacts must be covered, including unused bundled files that are nevertheless shipped; upstream files proved not to be distributed are recorded separately. This is not an execution-only criterion, an assumption that the embedded copies are excluded, risk acceptance, or permission to implement/build/release. Artifact inspection is a mandatory gate before calling an external-lock-only patch sufficient.

## Baseline and method

The requested immutable baseline is `6c2b0b57f7d3177a777acab081411db539362416`, identified in the issue with branch `acceptance/issue8-windows-20261020`. At inspection, the checked-out branch was `main` and HEAD was `ef38592db11d68bae3b22c175aaefc57966b039e`. The local `acceptance/issue8-windows-20261020` ref also resolved to that newer HEAD. The commit hash, not the moving branch name, therefore defines this report's baseline.

Read-only `git diff --name-only` between those two commits returned only [the subscription implementation plan](local-evidence.md#local-043), [subscription implementation notes](local-evidence.md#local-044), and [Windows acceptance notes](local-evidence.md#local-045). A separate `git diff --exit-code` restricted to `package.json`, `package-lock.json`, `components`, `src`, `app`, `lib`, `electron`, `scripts`, and `tests` returned exit 0. Thus the tracked dependency and application sources discussed below are unchanged between the specified baseline and HEAD. Installed dependencies are observations of the current checkout, corroborated by its unchanged lockfile, not a claim that an old installation was recreated.

The required proxy preflight, `curl -sI -m 10 -x http://127.0.0.1:7897 https://github.com`, returned HTTP 200 before GitHub access. Both requested advisory HTML pages, their GitHub API records, Cure53's repository advisory records, the release/fix commit, version-tagged sanitizer sources, upstream tests, release records, and npm metadata were fetched and read. No search snippets or community posts support the conclusions. Public-source caches are under the authorized scratch directory. The report path was checked with `glob` and did not exist before creation.

Evidence labels in this report:

- **Fact** means a directly read source, metadata field, or local observation.
- **Inference** means a conclusion derived from those facts with its conditions stated.
- **Unverified** means the corresponding runtime, artifact, or compatibility check was not performed.

No dependency installation or upgrade, implementation/configuration change, exploit execution, live-service attack, model call, credential or real-data access, Windows execution, checkout, commit, push, or CI run was performed by this researcher. Pre-existing working-tree changes were left untouched. The parent agent supplied the fresh audit observation below; this researcher read its relevant entries but did not repeat the audit.

## Advisory ranges and source conflicts

| Advisory | Published affected range | First fixed and smallest 3.4.x patch | Installed 3.4.14 | Embedded 3.4.12 |
| --- | --- | --- | --- | --- |
| [GHSA-p98j-92pf-mc4p][page-p98j] | `>= 3.4.13, <= 3.4.15` | `3.4.16` | In range | Outside this specific declared incomplete-fix range. This is not a general safety finding. |
| [GHSA-6688-9rhm-gjv2][page-6688] | `<= 3.4.15` | `3.4.16` | In range | In range |

Cure53's structured `vulnerabilities` fields agree with the GitHub reviewed records on those ranges and patch versions. [Maintainer p98j record][maintainer-p98j] [Maintainer 6688 record][maintainer-6688] [Reviewed p98j record][global-p98j] [Reviewed 6688 record][global-6688]

There are stale or conflicting narrative details worth preserving:

- Cure53's p98j description still says "Fix status: not fixed as of 3.4.15" and "no fixed version is established." Its structured `patched_versions` field says `3.4.16`. The reviewed GitHub page explicitly says fixed in 3.4.16, and the release notes, code, and tests independently corroborate that patch. The historical prose is not evidence that 3.4.16 remains unpatched. [Maintainer p98j][maintainer-p98j] [Reviewed page][page-p98j] [Release 3.4.16][release16] [Fix commit][fix]
- The p98j description mentions an earlier `rootWasRemoved` guard, but the tagged 3.4.14 and 3.4.15 return paths do not contain the new guard. The actual release diff adds it in 3.4.16. Versioned code takes precedence over that historical attribution. See 3.4.14 lines 2987-3006, 3.4.15 lines 3056-3078, and 3.4.16 lines 3091-3135. [3.4.14 source][source14] [3.4.15 source][source15] [3.4.16 source][source16] [Fix commit][fix]
- Both advisory pages classify severity as low. The 6688 maintainer description also contains a proposed CVSS 3.1 score of 6.1, Medium. These are different source fields, not a reason to replace the actual preconditions with a severity label. The p98j report itself distinguishes retained event-handler evidence from actual browser resource-event dispatch, which its jsdom experiment did not execute. This report executed neither experiment. [Maintainer 6688][maintainer-6688] [Maintainer p98j][maintainer-p98j] [Reviewed pages][page-p98j]

The fresh audit supplied by the parent lists exactly these two DOMPurify advisories, `node_modules/dompurify`, effect `mermaid`, and `fixAvailable: false`. The issue recorded an earlier `fixAvailable: true`. That discrepancy is recorded, not resolved by guessing why the audit solver changed its answer. Neither boolean proves or disproves range compatibility, fix correctness, or application behavior. See the [audit entries](local-evidence.md#local-002) and [issue body][issue12].

## What the two attacks actually require

### GHSA-p98j-92pf-mc4p: hook-detached descendants

**Fact.** The reported chain requires attacker-influenced markup in a caller-owned live DOM tree sanitized with effective `IN_PLACE`, plus an `afterSanitizeElements` or `afterSanitizeAttributes` hook that removes a non-root element while the tree is walked. That wrapper must contain an as-yet-unsanitized descendant with an event-handler attribute. Traversal skips the detached subtree, so the handler can survive. For the reported post-return execution, a resource event must already be queued or otherwise fire on that retained live node. The detached nodes do not have to appear in the returned HTML to matter. The hook must remove a node, not merely an attribute. [Maintainer advisory, Summary, Root Cause, Impact and Attack Chain][maintainer-p98j]

DOMPurify 3.4.14 has detach checks after before/upon element hooks but not after the relevant after-hooks. Hook-detached nodes are not recorded in `DOMPurify.removed`, so an ordinary post-walk sweep cannot recover them. Inspect lines 2063-2100, 2117, 2150, 2183, 2224, 2606 and 2987-3006. [3.4.14 source][source14]

**Fix fact.** The [3.4.16 release commit][fix], `b9b9d80f7e401771c2ccaef5f45def7eec8f27d7`, adds `_handleHookDetachedNode(currentNode, root)` after `afterSanitizeElements` for both kept custom elements and ordinary elements, and after attribute hooks. The helper neutralizes detached subtrees when `IN_PLACE` is active. See 3.4.16 lines 2084-2124, 2208-2217, 2257-2266, 2538-2551 and 2696-2702. [3.4.16 source][source16]

The upstream tests cover before/upon controls, `afterSanitizeElements`, `beforeSanitizeAttributes`, `afterSanitizeAttributes`, and the separate kept-custom-element path. They retain a reference to a detached descendant and assert its event attribute is gone, not just that the returned tree omits it. See 3.4.16 test lines 2080-2178. [Upstream tests][tests16]

**Inference.** Finding an `afterSanitizeAttributes` hook alone is insufficient. Conversely, failing to find a direct app import is insufficient to exclude the attack, because a dependency may register hooks on the same sanitizer instance.

### GHSA-6688-9rhm-gjv2: removed rawtext root and HTML reparse

**Fact.** The reported chain requires a Node input, effective `IN_PLACE`, and a rawtext root such as `style` whose text triggers a force-removal decision. With the default `SAFE_FOR_XML: true`, a literal own-end-tag sequence in the root's text can trigger the mXSS probe. The old return path still hands back that detached root. Stripping its attributes does not remove its raw text. The caller must then serialize and reparse that markup in HTML context for the reported payload to materialize. No foreign-content context is required. Moving the returned node with `appendChild` alone is not this attack. No node-removing after-hook is required for this second advisory. [Maintainer advisory, Root cause, Impact and Applicability scope][maintainer-6688]

The installed-version source implements the rawtext removal probe at 3.4.14 lines 1872-1902, but its in-place completion at lines 2987-3006 only strips attributes from removed elements and returns `dirty`. Its input-mode guard at line 2826 is `IN_PLACE && typeof dirty !== 'string' && _isNode(dirty)`. A string is not promoted to in-place Node processing even if a config requests `IN_PLACE`. [3.4.14 source][source14]

**Fix fact.** The 3.4.16 completion pass also detects `entry.element === dirty` and throws rather than returning the removed root. Its error includes "a node selected for removal could not be safely returned; refusing to sanitize in place". See lines 3091-3135. Upstream tests assert that a force-removed rawtext root throws, while removing a dangerous rawtext child still returns the safe parent root. See test lines 1390-1455. [3.4.16 source][source16] [Upstream tests][tests16]

**Inference.** An HTML insertion after ordinary string sanitization does not satisfy this advisory's removed-rawtext-Node-root precondition. It remains a security-sensitive sink and still needs ordinary sanitizer regression coverage.

## Dependency graph and rendering evidence

### All lockfile introduction paths

The parent agent's read-only dependency listing found a single deduplicated external DOMPurify 3.4.14 instance. This researcher independently read the manifests and lock entries supporting the following graph:

| Root path | Locked versions and declared ranges | DOMPurify target |
| --- | --- | --- |
| App to Mermaid | Root `mermaid: ^11.17.0`, locked Mermaid 11.17.0 | Mermaid declares `dompurify: ^3.3.3`, locked 3.4.14 |
| App to diagram plugin to Mermaid | Root `@streamdown/mermaid: ^1.0.2`, locked plugin 1.0.2, plugin requires `mermaid: ^11.12.2` | Same Mermaid and external DOMPurify instance |
| App to Streamdown to Mermaid | Root `streamdown: ^2.5.0`, locked Streamdown 2.5.0, Streamdown requires `mermaid: ^11.12.2` | Same Mermaid and external DOMPurify instance |

Sources: [root manifest](local-evidence.md#local-102), [plugin manifest](local-evidence.md#local-064), [Streamdown manifest](local-evidence.md#local-089), [locked Mermaid](local-evidence.md#local-093), [locked DOMPurify](local-evidence.md#local-101), and the [published Mermaid 11.17.0 manifest][npm-mermaid]. A dependency graph path establishes package presence, not execution of a specific sanitizer mode.

### Inspected app and default core calls

| Call or sink | Actual evidence | Conditions for these advisories |
| --- | --- | --- |
| App-owned diagram renderer | [Renderer lines 12-40](local-evidence.md#local-039) creates the plugin, supplies `securityLevel: "strict"`, and calls `render(id, chart)` with a chart string. | No Node sanitizer call or `IN_PLACE` here. Strict alone is not the exclusion evidence. |
| Plugin and package entry | [Plugin distribution line 1](local-evidence.md#local-063) imports `mermaid` and calls its initialize/render API. [Mermaid exports lines 6-14](local-evidence.md#local-075) map the bare import to `dist/mermaid.core.mjs`. | Static default path uses the core distribution, not the full ESM bundle. Production bundler resolution is not verified. |
| Common label sanitizer and hooks | [Core common chunk lines 5054-5127](local-evidence.md#local-066) imports external `dompurify`; `removeScript(txt)` and `sanitizeText(text, config)` sanitize text. Before/after attribute hooks preserve anchor `target` and add `rel="noopener"`. | The after-hook removes only a temporary attribute, not a node. Text input also fails the Node-plus-`IN_PLACE` condition. The optional `dompurifyConfig` forwarding is acknowledged, not silently ignored. |
| Final diagram SVG sanitization | [Core render lines 1351-1364](local-evidence.md#local-073) reads `innerHTML` into `code`, then sanitizes that string with added tags/attributes and an integration-point option. | Real SVG serialization exists, but not serialization of an in-place sanitizer-returned rawtext root. No `IN_PLACE` option in this call. |
| Class tooltip HTML | [Tooltip lines 1210-1224](local-evidence.md#local-068) reads a `title` attribute and uses `.html(DOMPurify.sanitize(title))`. | HTML reparse exists. Sanitizer input is an attribute string, not an in-place rawtext root. |
| State tooltip HTML | [Tooltip lines 1770-1783](local-evidence.md#local-067) uses the same title-string sanitization then `.html`. | Same missing Node-plus-`IN_PLACE` condition. |
| Flowchart tooltip HTML | [Tooltip lines 549-562](local-evidence.md#local-069) uses the same title-string sanitization then `.html`. | Same missing Node-plus-`IN_PLACE` condition. |
| Inline and overlay app insertion | [Inline renderer and sink](local-evidence.md#local-038) and [overlay renderer](local-evidence.md#local-042), [overlay sink](local-evidence.md#local-041) insert SVG strings through `dangerouslySetInnerHTML`. | Real downstream HTML sinks. They do not themselves establish a preceding in-place rawtext-root call. The overlay also has a separate `rawSvg` branch, which is not audited as part of these DOMPurify mechanisms. |
| Chat Markdown configuration | [Message configuration lines 345-381](local-evidence.md#local-032) omits the Mermaid plugin from `streamdownPlugins` and supplies `mdComponents` to intercept Mermaid fences. [Streamdown's shipped pipeline](local-evidence.md#local-088) configures `rehype-raw`, `rehype-sanitize` and `rehype-harden`. | Distinguishes the app-owned Mermaid route from Streamdown package presence. Ordinary Markdown sanitization is a separate pipeline, not a direct DOMPurify call shown here. |

Literal searches across the app source directories found no direct DOMPurify usage or `IN_PLACE` setting. A search of default core chunks found the common-label sanitizer and the three tooltip calls listed above, no `DOMPurify.setConfig`, and no `IN_PLACE` setting. These searches support the positive call-site evidence; they are not the whole reachability argument. Dynamically loaded third-party code, custom runtime configuration, and final packaged artifacts were not executed or proved absent.

### Embedded copies are a separate inventory item

Mermaid 11.17.0's [full ESM common chunk](local-evidence.md#local-071) names an embedded `dompurify@3.4.12` source, and its [runtime assignment](local-evidence.md#local-072) sets `DOMPurify.version = "3.4.12"`. The [minified full ESM chunk license](local-evidence.md#local-070) also names DOMPurify 3.4.12. These are bytes inside the published Mermaid distribution, not additional lockfile package nodes. The [published manifest][npm-mermaid] identifies the version and distribution archive.

For p98j, 3.4.12 is outside the declared `>=3.4.13` range because it predates the partial neutralization fix; the maintainer explicitly explains this historical boundary. Do not turn that range distinction into a claim that its older hook behavior is safe. For 6688, 3.4.12 is inside the published `<=3.4.15` range. [Maintainer p98j, Affected Versions][maintainer-p98j] [Maintainer 6688, Affected versions][maintainer-6688]

**Inference with a limit.** The inspected bare-import path does not select these full ESM builds. A lock-only DOMPurify patch can address the default external dependency path without touching Mermaid. It cannot establish that every copy shipped anywhere is patched, and static entry selection is not proof that a production bundler or desktop package excludes the embedded copies.

## Patch candidates and compatibility limits

| Candidate | Availability at cutoff | Fix evidence | Compatibility qualification |
| --- | --- | --- | --- |
| DOMPurify 3.4.16 | GitHub release 2026-09-23 15:23:58 UTC; npm publication 2026-09-23 15:29:57.247 UTC | Both advisories name it; release notes name hook-removal and rawtext-root fixes; commit `b9b9d80f7e401771c2ccaef5f45def7eec8f27d7` includes code and regression tests. | Smallest published patch in 3.4.x that fixes both. It also changes build tooling from Rollup to Rolldown and adjusts declaration exports, so patch numbering is not a complete compatibility test. |
| DOMPurify 3.4.17 | GitHub release 2026-10-12 12:37:20 UTC; npm publication 2026-10-12 12:41:28.880 UTC; npm `latest` at cutoff | Versioned code retains the after-hook checks and rejects removed roots. It adds further in-place, shadow-root, hook/custom-element, and other hardening. | Newer same-line candidate with a larger behavioral diff. Not automatically chosen over 3.4.16 in this research. |

Sources: [3.4.16 release][release16], [3.4.17 release][release17], [release API][releases], [npm metadata and publication times][npm-dompurify], [fix commit][fix]. In 3.4.17, see lines 2364, 2416, 2739, 2876-2881 for hook checks, lines 1509-1518 for removed-root detection, and lines 3210-3223 for the fail-closed return path. [3.4.17 source][source17]

**Narrowest dependency inference.** `^3.3.3` admits both 3.4.16 and 3.4.17. Keeping Mermaid 11.17.0, Streamdown 2.5.0 and plugin 1.0.2 locked while changing only the external DOMPurify resolution is therefore range-compatible. This establishes metadata compatibility, not tested rendering behavior. No declared parent constraint requires an override, new direct dependency, parent upgrade, or major-version jump. An exact transitive override could enforce a persistent policy if the user wants one; it is not necessary to overcome the current range.

**Distributed-copy branch under the confirmed scope.** Inspect the actual Web and desktop outputs before deciding that the external lock refresh is sufficient. If they ship any of Mermaid's old embedded DOMPurify bytes, those copies must also be addressed. A parent release/rebuild that actually replaces them, or a separately authorized packaging-exclusion approach with artifact evidence, would be needed. If those upstream bundles are proved not to ship, record that exclusion and keep the external patch narrow. No such artifact exclusion or replacement Mermaid candidate was validated here. Do not claim that an arbitrary Mermaid upgrade fixes the embedded copy, or quietly expand this research into packaging changes.

### Necessary lock and artifact checks after authorization

For the external-package branch, the intended diff is the `node_modules/dompurify` lock entry's version, `resolved` archive URL and `integrity`, plus any genuine metadata consequence. Preserve the Mermaid/plugin/Streamdown versions and parent ranges. Confirm all three introduction paths resolve to the intended single external version and no nested old external copy appears. The current [Trusted Types entry](local-evidence.md#local-098) is 2.0.7 with `optional: true`; inspect its flags and edges rather than assuming they cannot change.

The registry currently reports these candidate identities:

| Version | npm `gitHead` | npm `dist.integrity` |
| --- | --- | --- |
| 3.4.16 | `b9b9d80f7e401771c2ccaef5f45def7eec8f27d7` | `sha512-sqo+pNp3qRhCIpbgRi1y8Tgk27Bo2Ry7w0dC1NBeNTdZChWjz9Xb/KOoZbRP/R6pQZ80Qw8YhXw13hWWBbMRnQ==` |
| 3.4.17 | `a77a3e78b59f72fa4d1c83f22e121ad9cc7d3575` | `sha512-B/pSlYVHQ58kqISD/yDjuJ1yfzI34m1gF4lAod2bwSRhiN4K5Cl3H8Af7hqB2PmTL911tdEudnnXn5FnhRoz0w==` |

These are registry observations, not an independent signature or installed-byte verification. Both candidates keep the CJS, ESM and browser entry paths and the `@types/trusted-types: ^2.0.7` optional edge. The 3.4.17 registry record also lists that type package in `dependencies`, unlike 3.4.16, so inspect the resolver's resulting metadata diff. [npm registry][npm-dompurify] [Cached normalized metadata](local-evidence.md#local-003)

If an override or parent change is selected later, record that policy in the appropriate manifest and inspect all resulting lock entries instead of accepting a broad automatic fix. Do not refresh unrelated vulnerabilities as part of this patch. Build-output and packaged-file inventory must separately identify any embedded DOMPurify version; the package-level audit alone cannot do that.

## Controlled regression plan, not executed

All tests below are proposed for a separately authorized implementation phase. Use synthetic fixtures, an isolated local document/browser profile, blocked network/resource fetching, no application account/session, and no executable attack against a live app. Prefer structural assertions with inert marker attributes over event dispatch. No dependency or browser installation is authorized by this report.

1. **Resolution and diff gate.** From the immutable baseline or a documented successor, choose 3.4.16 or 3.4.17 explicitly. Check the manifest/lock diff and read-only dependency graph. Require the selected external version on all three paths, preserved parent versions, and matching registry identity. Re-run the two-advisory audit attribution, but do not use its exit status or `fixAvailable` flag as the sole pass criterion.
2. **Hook-neutralization regression.** Adapt the upstream structural test with a safe root, removable non-root wrapper and retained reference to a descendant with inert event-handler text and no resource URL. For `afterSanitizeElements` and `afterSanitizeAttributes`, assert that the wrapper is absent from the returned root and the detached descendant's `on*` attribute is absent. Include before/upon controls, a no-removal case, a kept custom-element wrapper, and hook cleanup between cases. This checks the detached tree, not only returned HTML. Upstream basis: [test lines 2080-2178][tests16].
3. **Removed-root contract.** Use an inert rawtext fixture carrying an own-end-tag and marker markup. Require failure before a removed root is returned. Preserve a control where a dangerous rawtext child is dropped but a safe parent and sibling survive, plus a non-in-place control. Any serialization/reparse probe must be inert and isolated. Do not weaken the test to merely checking stripped root attributes. Upstream basis: [test lines 1390-1455][tests16].
4. **Normal rendering compatibility.** Render representative flowcharts, class/state diagrams, tooltips, label HTML/`foreignObject`, anchors with `target` and `rel`, Unicode labels, diagram errors, and repeated renders. Cover the app's inline and overlay routes, interrupted streaming fences and retry behavior. Assert labels, layout-critical SVG/MathML, links and expected styling survive while handlers and unsafe URLs do not. Check CJS/ESM/type resolution and browser entry behavior because 3.4.16 changed bundling/declarations. Do not relax the sanitization policy to make snapshots pass. The relevant app contracts are in the [renderer](local-evidence.md#local-040), [inline route](local-evidence.md#local-038), and [overlay route](local-evidence.md#local-042).
5. **Artifact gate (user-confirmed scope).** Inspect the actual authorized Web build and desktop packaging outputs without real data or credentials. Establish the resolved Mermaid entry and DOMPurify version for every shipped import path, including lazy chunks, and inventory all other shipped files, including unused full ESM/minified bundles. Patch every shipped old copy or demonstrate its exclusion through an independently authorized packaging change. Upstream files proved not to ship are listed separately; lack of execution alone does not exclude shipped bytes. Keep Windows runtime acceptance separate; none was performed here.

## Remaining unknowns and decision gates

- **Resolved product decision:** the user selected actual distributed Web and desktop artifacts, including every shipped copy, not only executed default-import output. Upstream files proved not to ship are recorded separately. Whether embedded copies actually ship remains an unverified engineering fact, not another user preference to guess.
- The user has not selected 3.4.16 versus 3.4.17, authorized implementation, or accepted any residual risk. The report establishes candidates, not a product choice.
- No candidate was installed, built, typechecked, rendered, or executed on Windows here. Semver acceptance, matching entry names and `fixAvailable` do not replace those checks.
- Production bundler resolution, embedded-copy exclusion, desktop contents and dynamically altered sanitizer configuration remain unverified. The static default-path inference must be revisited if imports, hooks, Node inputs or persistent DOMPurify configuration change.
- The advisories' original live demonstrations are upstream evidence, not experiments repeated here. The exact browser resource-event behavior and host-specific consequences were not measured.
- This is not an audit of all Mermaid/SVG/CSS/Markdown risks, the overlay's independent `rawSvg` provenance, or other audit findings. Removing these two advisory entries would not establish that those areas are secure.

## Primary sources actually read

The GitHub advisory HTML and API content were both read. Version-tagged raw sources were read directly; line numbers above refer to those versions rather than moving `main`.

- [Issue 12 body and baseline][issue12]
- [GitHub advisory GHSA-p98j-92pf-mc4p][page-p98j] and [reviewed API record][global-p98j]
- [Cure53 p98j repository advisory API, including full description][maintainer-p98j]
- [GitHub advisory GHSA-6688-9rhm-gjv2][page-6688] and [reviewed API record][global-6688]
- [Cure53 6688 repository advisory API, including full description][maintainer-6688]
- [Cure53 fix/release commit][fix] and [commit API diff][fix-api]
- [DOMPurify 3.4.14 source][source14], [3.4.15 source][source15], [3.4.16 source][source16], [3.4.17 source][source17], and [3.4.16 regression tests][tests16]
- [Cure53 release API with release bodies and timestamps][releases], corresponding to [3.4.16][release16] and [3.4.17][release17]
- [Versioned 3.4.17 README][readme17], especially lines 476-481 on in-place constraints and lines 485-487 on persistent configuration
- [npm DOMPurify metadata][npm-dompurify] and [published Mermaid 11.17.0 manifest][npm-mermaid]

[issue12]: https://api.github.com/repos/gzy31007/learnharness/issues/12
[page-p98j]: https://github.com/advisories/GHSA-p98j-92pf-mc4p
[page-6688]: https://github.com/advisories/GHSA-6688-9rhm-gjv2
[global-p98j]: https://api.github.com/advisories/GHSA-p98j-92pf-mc4p
[global-6688]: https://api.github.com/advisories/GHSA-6688-9rhm-gjv2
[maintainer-p98j]: https://api.github.com/repos/cure53/DOMPurify/security-advisories/GHSA-p98j-92pf-mc4p
[maintainer-6688]: https://api.github.com/repos/cure53/DOMPurify/security-advisories/GHSA-6688-9rhm-gjv2
[fix]: https://github.com/cure53/DOMPurify/commit/b9b9d80f7e401771c2ccaef5f45def7eec8f27d7
[fix-api]: https://api.github.com/repos/cure53/DOMPurify/commits/b9b9d80f7e401771c2ccaef5f45def7eec8f27d7
[source14]: https://raw.githubusercontent.com/cure53/DOMPurify/3.4.14/src/purify.ts
[source15]: https://raw.githubusercontent.com/cure53/DOMPurify/3.4.15/src/purify.ts
[source16]: https://raw.githubusercontent.com/cure53/DOMPurify/3.4.16/src/purify.ts
[source17]: https://raw.githubusercontent.com/cure53/DOMPurify/3.4.17/src/purify.ts
[tests16]: https://raw.githubusercontent.com/cure53/DOMPurify/3.4.16/test/test-suite.js
[readme17]: https://raw.githubusercontent.com/cure53/DOMPurify/3.4.17/README.md
[releases]: https://api.github.com/repos/cure53/DOMPurify/releases?per_page=20
[release16]: https://github.com/cure53/DOMPurify/releases/tag/3.4.16
[release17]: https://github.com/cure53/DOMPurify/releases/tag/3.4.17
[npm-dompurify]: https://registry.npmjs.org/dompurify
[npm-mermaid]: https://registry.npmjs.org/mermaid/11.17.0
