# ansi-to-react and linkify-it advisory remediation research

<!-- archive-note:start -->
> Archived on 2026-10-23 under [workspace task 26](https://github.com/gzy31007/learnharness/issues/26). The original report follows unchanged except for mechanical local-link routing.
>
> Research cutoff: 2026-10-21, Asia/Shanghai. Historical input: the report's observed ansi-to-react 6.2.6 / linkify-it 3.0.3 working-tree graph; no complete source commit is recorded in this report.
>
> Later status, checked against the archive baseline: The historical scoped-override recommendation was not the selected implementation. The owner later approved removing the unused direct parent and orphaned subtree. Both packages are absent from the archive baseline manifest/lock. Old installed bytes and release artifacts are separate inventories. [Owning record](https://github.com/gzy31007/learnharness/issues/11).
>
> Read the [archive guide](README.md) and [local evidence register](local-evidence.md) before reusing any present-tense statement, line number, or acceptance result. Archive publication is not a new test run, distribution approval, or general risk acceptance.
<!-- archive-note:end -->

Research cutoff: 2026-10-21, Asia/Shanghai. Public registry and GitHub source responses were read during this session.

## Decision summary

There is **no currently published, in-range fix** that keeps the existing parent dependency, avoids a downgrade or removal, and avoids an override. The application declares `ansi-to-react: ^6.2.6`. npm's official registry still identifies **6.2.6** as that package's `latest`, with no later 6.x release. That release declares `linkify-it: ^3.0.3`. The registry has no patched 3.x release, and that child range excludes both 5.0.2 and 6.1.0. A normal lock refresh or parent update within the existing range cannot fix these findings. Sources: [parent registry][ansi-registry], [child registry][linkify-registry], [application declaration](local-evidence.md#local-104), [locked parent](local-evidence.md#local-099).

For the two requested advisories, **5.0.2 is the first version that fixes both**. The current `linkify-it` **latest is 6.1.0**, not 5.0.2. Latest is not a drop-in target for this parent: 6.x removes the callable default export and `.pretest()` and changes link recognition defaults. Sources: [advisory A][advisory-a], [advisory B][advisory-b], [child registry][linkify-registry], [6.1.0 changelog][changelog6].

Recommendation, subject to human approval: if preserving the existing parent and its rendering behavior remains the requirement, evaluate an **exact, parent-scoped override to linkify-it 5.0.2**, rather than a global override or an override to latest. Published source retains the particular public contract the parent consumes. This crosses the parent's declared major range and still needs resolver, runtime, rendering and packaging acceptance. It is a proposed exception to the no-override preference, not an in-range solution or authorization to edit dependencies.

Removing the direct dependency, for which no current source reference was found, is also a narrow candidate if its owner confirms it is unnecessary. Preserving the parent's available rendering modes is different from preserving current observed application behavior: if only the latter matters and ownership confirms non-use, removal can be simpler than maintaining a cross-major override. The current static scan supports discussing removal; it does not make the installed vulnerable dependency fixed, establish historical non-use, or authorize deleting a capability. The alternatives and acceptance gates are below.

## Scope, baseline and method

- The earlier [triage section](local-evidence.md#local-028) correctly recorded the old chain and the two first-patched versions. It did not establish a currently published parent upgrade or compatibility route. This note supplies those missing checks.
- Fresh local reads confirm the application declaration `^6.2.6`, locked `ansi-to-react` 6.2.6, its `linkify-it` requirement `^3.0.3`, and locked `linkify-it` 3.0.3. See [manifest](local-evidence.md#local-104), [parent lock entry](local-evidence.md#local-099) and [child lock entry](local-evidence.md#local-092). These are local baseline facts, separate from registry availability.
- Read the full official npm package metadata, the public reviewed advisory API descriptions and version records, official GitHub commit diffs and changelogs, and published npm tarball members. Archives were read as text in memory, not installed, extracted into the workspace, imported or executed. No search snippets or community posts support the conclusions.
- Every GitHub/API/raw-source request was preceded by `curl -sI -m 10 -x http://127.0.0.1:7897 https://github.com`, requiring the upstream HTTP response to be 200, not merely the proxy's `200 Connection established`. Every registry and GitHub fetch explicitly used the same proxy. Public requests used no account credentials.
- No install, package-manager resolution, audit execution, vulnerability payload, application test, manifest/lock edit, issue operation, git operation, deployment, login or user-data access occurred. This note is the only written artifact. The research skill's requested nested background delegation was rejected by the runtime depth limit before any child started; research proceeded directly in this already-delegated researcher.
- Retrieval limits: the GitHub release API for tag `5.0.1` returned 404, so no release-body claim relies on it. The 5.0.2 npm archive does not ship `CHANGELOG.md`; its tagged GitHub changelog was read instead. Tag comparison, the fixing commit and published bytes corroborate the fixes without assuming a release page exists.

## Current official publication facts

| Package or line | Registry result at cutoff | Consequence |
| --- | --- | --- |
| `ansi-to-react` latest | `6.2.6`, published `2026-01-24T01:19:32.919Z` | The application already locks the newest published parent. |
| `ansi-to-react` admissible 6.x releases at or above 6.2.6 | Only `6.2.6` | No published 6.x patch/minor upgrade can change the child range. |
| Older stable parent line | `6.1.6` and earlier registry manifests have no `linkify-it` dependency | Selecting one is a downgrade outside `^6.2.6`, not a patched current-parent release. Its React peer range ends at React 17; 6.2.6 admits React 19. |
| Parent 6.2.6 dependencies | `anser: ^2.3.2`, `escape-carriage: ^1.3.1`, `linkify-it: ^3.0.3` | The vulnerable child cannot resolve to 5.x without changing this dependency contract. |
| `linkify-it` 3.x | Published 3.0.0, 3.0.1, 3.0.2 and 3.0.3; no later 3.x version | No backported fixed 3.x release appears in the official registry. |
| First common fixed child | `5.0.2`, published `2026-07-01T23:50:58.055Z` | Covers both requested advisories with the narrower preserved API. |
| Child latest | `6.1.0`, published `2026-07-22T21:50:51.849Z` | New major API and recognition behavior; not a replacement-only change for this parent. |

Sources: [full parent registry, including the 6.2.6 version object][ansi-registry], and [full child registry, including the 5.0.2 and 6.1.0 version objects][linkify-registry]. The parent registry also lists prerelease tag `6.0.5-alpha.0`, which is neither a newer fix nor a candidate in the existing range. The child registry lists 6.0.0 and 6.1.0 above 5.0.2. The 5.0.2 and 6.1.0 changelog calendar dates are July 2 and July 23 respectively; the table preserves the registry's exact UTC publication timestamps rather than treating those calendar labels as conflicting release versions.

The parent 6.2.6 registry `gitHead` is `145140971e9d83ccac32265f24b1c55dea437896`. Child 5.0.2 has `gitHead` `50a0c914f834b201cab25ff4faefd1f832b37332`; child 6.1.0 has `7c568a123a17727fa2f34a0abcabbd46437299c1`. The API analysis below reads the actual published archives, not an unversioned default branch.

## Advisory coverage and actual upstream patches

| Advisory | Exact affected range from the reviewed API | First patched version | Mechanism and source-supported fix |
| --- | --- | --- | --- |
| [GHSA-22p9-wv53-3rq4][advisory-a], CVE-2026-48801 | `<= 5.0.0` | `5.0.1` | Quadratic JS-level `.match()` scan of fuzzy links/emails. The old loop repeatedly scans sliced tails. Upstream replaces it with separate global-regex scans for schemed links, fuzzy links and fuzzy emails, then merges candidates in index order. |
| [GHSA-v245-v573-v5vm][advisory-b], CVE-2026-59887 | `<= 5.0.1` | `5.0.2` | Repeated schema hits invoke an unbounded mailto local-part validator. Upstream caps the local part at 64 characters; the same commit caps the HTTP user/password portion at 50 characters. |

The first advisory describes availability impact rather than code execution or confidentiality/integrity impact. It explicitly calls the first issue structural scan-loop complexity, not simply regex backtracking. The second also concerns availability. Actual application exploitability requires attacker-controlled text to reach the affected processing path. The descriptions include reproductions; none was executed here.

The [5.0.0...5.0.1 comparison][compare501] identifies commit [`6be6d15e0641bf1daeaa977d500cabc743166159`][fix501], whose message is `Fix fuzzy link/email scan perfomance`. Its patch adds global fuzzy regexes and replaces the sliced-tail `.match()` loop. The changelog states, "Reworked search logic - check each pattern separate, use `g` regexes instead of slice" and "Removed internal cache". Published 5.0.2 `index.mjs:472-563` contains this merged-scan implementation. Match result fields remain public; old private cache fields do not. Sources: [comparison][compare501], [5.0.2 tagged changelog][changelog502], [published 5.0.2 archive][tar502].

For the second issue, commit [`105e5d77f7d119871d2b2d86ed208568eb3e7ffe`][fix502], `Restrict scan length in email name and http auth`, changes `lib/re.mjs` to use `{0,63}` after the first email-name character and `{1,50}` for the optional auth portion. Published 5.0.2 `lib/re.mjs:93-97` explicitly comments, "Max name length capped to 64 chars (RFC 5321)." The changelog states, "Fixed DoS in `mailto:` links (restrict user name to 64 chars)." Sources: [actual fixing diff][fix502], [tagged changelog][changelog502], [published archive][tar502].

Do not confuse the advisory's suggested remediation with the shipped patch. **5.0.2 still calls `text.slice(pos)` in the mailto validator**, at published `index.mjs:94-107`; its concrete fix bounds the regex scan. This note does not claim the implementation eliminated every tail slice or proved a universal complexity bound for every custom schema.

Coverage calculation: 5.0.1 is outside the first affected range but inside the second. 5.0.2 is outside both ranges and is therefore the earliest common patched release. Both 6.0.0 and 6.1.0 are also outside these two published affected ranges. This is bounded coverage for the two specified advisories, not a comprehensive current advisory inventory or a claim that any version is free of all security defects.

## What the parent actually consumes

The published [ansi-to-react 6.2.6 archive][taransi] contains CommonJS `lib/index.js` and its public declaration `lib/index.d.ts`. The relevant published member locations are:

- `lib/index.js:35-42`: TypeScript's `__importDefault(require("linkify-it"))` interop.
- `lib/index.js:134-143`: only `linkify === "fuzzy"` selects linkify-it; falsy values return a plain span, while boolean true selects the parent's separate classic regex implementation.
- `lib/index.js:171-198`: calls `linkifyIt({ fuzzyEmail: false }).tlds(["io"], true)`, then `.pretest(text)` and `.match(text)`. It expects null or an ordered match array. It reads `index`, `lastIndex` and `url`, renders labels from original substrings, and preserves text between matches.
- `lib/index.js:200-202` and `lib/index.d.ts:2-8`: public `linkify?: boolean | "fuzzy"`; omitted linkify defaults to false. The parent itself exports a React component as `exports.default`, not as `module.exports = Ansi`.

`fuzzyEmail: false` disables bare-address matching; it **does not disable the explicit `mailto:` schema**. Nor does it turn off fuzzy URL matching in 3.x or 5.x. Disabling one fuzzy option, or relying on the parent's default false, is not a dependency-version fix for both findings. Sources: [published parent][taransi], [3.0.3 implementation][tar303], [5.0.2 implementation and README][tar502].

## CJS, ESM and match compatibility

| Contract | Locked 3.0.3 | First common fixed 5.0.2 | Latest 6.1.0 |
| --- | --- | --- | --- |
| CommonJS package entry | Default `index.js`; `module.exports = LinkifyIt` | `require` resolves to `build/index.cjs.js`; `module.exports = LinkifyIt` | `require` resolves to `build/index.cjs.js`; object of named exports `LinkifyIt`, `REBuilder`, `linkifyit` |
| ESM interface | CommonJS consumed through interop | `import` resolves to `index.mjs`; `export default LinkifyIt` | `import` resolves to `build/index.mjs`; named exports only, no default |
| Parent's callable default | Function accepts the options object without `new` | Preserved; constructor explicitly handles a call without `new` | Not preserved; named `LinkifyIt` is a class, with a separate named `linkifyit()` factory |
| `.pretest()` | Present | Present | Removed |
| Fuzzy URL default | true | true | false |
| `.match()` result | Array or null; absolute string offsets and normalized URL | Same consumed fields and Array/null shape; internal scan and cache change | Same broad match-field shape, but that does not repair the earlier export and method incompatibilities |
| Unicode dependency | `uc.micro: ^1.0.1` | `uc.micro: ^2.0.0` | `uc.micro: ^3.0.0` |

Sources: published archives [3.0.3][tar303], [5.0.2][tar502], [6.1.0][tar610], and [6.x migration changelog][changelog6]. The 5.0.2 package retains a CJS build despite its 5.0.0 changelog entry "Rewrite to ESM". It would be incorrect to label 5.0.2 ESM-only from that entry alone.

In the 5.0.2 archive, `index.mjs:339-349` preserves the no-`new` and options-only construction; `:435-437` retains pretest; `:260-299` builds `schema`, `index`, `lastIndex`, `raw`, `text` and `url`; `:472-563` returns an ordered, non-overlapping result array or null; `:627-635` normalizes schemaless URLs with `http://` and bare-email matches with `mailto:`. Its CJS build ends with `module.exports = LinkifyIt`. These are the exact seams the parent needs.

By contrast, the [6.x changelog][changelog6] explicitly lists "Switched to class and named exports", "Removed `.pretest()`", and the changed fuzzy-link default. It also changes Unicode punctuation boundaries, disables URL-authentication scanning by default, and introduces a default 10,000-character link limit. Overriding the existing parent to 6.1.0 alone would make its default-import wrapper attempt to call a non-callable module object. Even repairing that import would leave its pretest call incompatible and fuzzy URL behavior changed. This is a static incompatibility finding, not an observed runtime test result.

A 3.x-to-5.0.2 change is still cross-major. Besides the security patches and Unicode data dependency, the [changelog][changelog502] records paired-punctuation fixes and changes around `---` after emails on 4.x. The email and auth length caps intentionally change recognition of overlong input. Retained method names do not prove byte-for-byte rendering equivalence.

## Narrow choices for a human decision

| Choice | What it changes | Assessment |
| --- | --- | --- |
| Keep parent 6.2.6 and use an exact scoped child override to 5.0.2 | Replaces the vulnerable child only beneath this parent; keeps the public parent and its modes | Recommended candidate when preserving the current parent is required. Source-compatible at the consumed seams, but outside parent semver; requires explicit override approval and acceptance tests. |
| Remove the direct parent with no current source reference found | Removes a dependency/capability rather than repairing its implementation | Valid candidate if the owner confirms it is unnecessary and the installed/packaged graph loses the vulnerable subtree. No import is evidence for considering this choice, not proof that the current tree is remediated. |
| Obtain a maintained parent patch or controlled fork declaring 5.0.2 | Changes the parent dependency contract in its own package, avoiding an application override | Appropriate if no-override is an absolute policy and removal is unacceptable. No such newer official parent release was present at cutoff. Fork publication, provenance and ongoing maintenance are separate decisions, not work authorized by this note. |
| Downgrade to parent 6.1.6 | Avoids the linkify-it dependency in that older published manifest | Not recommended. Violates the no-downgrade constraint, does not preserve the same dependency implementation, and its React 16/17 peer range excludes the application's React 19 declaration. This is not an in-range security patch. |
| Override child to latest 6.1.0 without changing the parent | Changes only dependency resolution but breaks imports and methods | Reject as a replacement-only plan. Adapting the parent and recognizing the changed defaults would be a separate, wider migration. |

The [npm 10.9.8 override documentation][npm-overrides] explicitly allows overrides scoped to a parent and even a parent version. A possible approval candidate is the nested mapping `overrides["ansi-to-react@6.2.6"]["linkify-it"] = "5.0.2"`, with no override of the parent itself. This describes a decision, not a manifest edit or a resolver result. Exact parent-version scoping deliberately requires revisiting the exception after a parent upgrade. Do not add a direct child dependency and assume it supersedes the parent's incompatible range; another vulnerable nested copy can remain. A global override has a broader effect than this ticket requires.

The current static code scan found no literal `ansi-to-react` or `linkify-it` reference in the ordinary searched `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.mjs` and `*.cjs` source files. It is not a complete dynamic-loader, generated-artifact or historical-use analysis. The current [tool output conversion](local-evidence.md#local-036) passes through text and [renders it in a pre element](local-evidence.md#local-035); the [live tool input card](local-evidence.md#local-034) likewise uses a pre element. These observations do not show a reachable linkify-it path in those components. They also do not repair or remove the installed vulnerable package. No claim is made that the dependency was never wired in historically.

## Compatibility acceptance suggestions, not tests run here

If a route is approved, run benign tests against the resolved package and actual parent, not only a direct linkify-it import. Keep adversarial performance tests outside this research session and require separate approval before executing upstream pathological cases.

| Area | Benign fixture or assertion | What it guards |
| --- | --- | --- |
| CJS and ESM loading | CJS `require("linkify-it")` must be callable; ESM default import must be callable for the 5.0.2 route. Instantiate with `{ fuzzyEmail: false }`, chain `.tlds(["io"], true)`, and verify `.pretest` and `.match` are functions. Load the parent using the consumer/bundler's actual default-import convention. | Published CJS/default interop; prevents accidentally resolving to named-only 6.x. |
| No-match and ordering | Empty and ordinary non-link text return null from `.match()`. A short sentence with two different links yields ordered, non-overlapping offsets. Prefixing an emoji must not corrupt original text when JS substring offsets are used. | Null handling, absolute offsets and preservation of intervening/trailing text. |
| Ordinary URLs | Explicit `https://example.com/a?x=1`, `http://example.com`, `www.example.com`, `example.io`, and a URL next to punctuation. Assert href and visible text separately. Schemaless recognized URLs use `http://`; explicit HTTPS remains HTTPS. | Parent's fuzzy URL recognition, added `.io` TLD, normalization and punctuation behavior. |
| Mailto versus bare email | `mailto:alice@example.com` stays linkifiable under `{ fuzzyEmail: false }`; `alice@example.com` must not become an email link with those parent options. A separate default-options library test can verify bare-email normalization. | Prevents mistaking fuzzyEmail suppression for mailto suppression, or suppressing all email processing to hide the finding. |
| Email/auth limits | Small fixtures around 63/64/65 local-part characters and 49/50/51 auth characters. Verify ordinary valid values; explicitly record the intended behavior beyond the new caps, including no unexpected full overlong mailto match and no text loss. | Intentional 5.0.2 security-related recognition changes, including possible partial-match differences that need observation. |
| Public parent modes | Render the parent with omitted/false, true, and `"fuzzy"` linkify. Verify plain spans, classic URL behavior, fuzzy URL/mailto behavior, ANSI styles/classes, leading/middle/trailing text, and anchors' href/text/target. | Tests the actual parent seam, including modes not implemented by linkify-it. |
| Build/runtime boundary | Run the project's approved type/build/render checks and inspect the real packaged output in relevant runtime targets. Confirm neither an old nested child nor a bundled old copy remains. | Source compatibility alone does not prove bundler, packaging or deployed-byte compatibility. |
| Resolution and advisory evidence | For override, prove the child resolved beneath parent 6.2.6 is exactly 5.0.2. For removal, prove the parent and every now-orphaned vulnerable child are absent from the resulting dependency graph and shipped output. Refresh the audit evidence for both advisory identifiers. | Proves a real graph/artifact change rather than a source-search result or a new unused direct dependency. |

The 5.0.1 rewrite resets global regex cursors for each scan and removes the prior private result cache. Include repeated calls on the same instance and mixed explicit/fuzzy links in the benign ordering checks. Assert the consumed fields and rendered output rather than removed private cache properties. The upstream fixing diffs contain regression tests, but their presence is source evidence only; they were not executed here.

## Remaining limits

No proposed graph was resolved or installed. No source import, benign rendering assertion, build, Windows acceptance, package inventory after remediation, or performance measurement was executed. The recommendation rests on published source contracts and exact advisory ranges. A human still needs to select removal, a scoped override, or a maintained-parent approach and authorize its implementation. Recheck registry availability at that point because a new official parent release could remove the need for the exception.

## Primary sources

[ansi-registry]: https://registry.npmjs.org/ansi-to-react
[linkify-registry]: https://registry.npmjs.org/linkify-it
[taransi]: https://registry.npmjs.org/ansi-to-react/-/ansi-to-react-6.2.6.tgz
[tar303]: https://registry.npmjs.org/linkify-it/-/linkify-it-3.0.3.tgz
[tar502]: https://registry.npmjs.org/linkify-it/-/linkify-it-5.0.2.tgz
[tar610]: https://registry.npmjs.org/linkify-it/-/linkify-it-6.1.0.tgz
[advisory-a]: https://api.github.com/advisories/GHSA-22p9-wv53-3rq4
[advisory-b]: https://api.github.com/advisories/GHSA-v245-v573-v5vm
[compare501]: https://api.github.com/repos/markdown-it/linkify-it/compare/5.0.0...5.0.1
[fix501]: https://github.com/markdown-it/linkify-it/commit/6be6d15e0641bf1daeaa977d500cabc743166159
[fix502]: https://api.github.com/repos/markdown-it/linkify-it/commits/105e5d77f7d119871d2b2d86ed208568eb3e7ffe
[changelog502]: https://api.github.com/repos/markdown-it/linkify-it/contents/CHANGELOG.md?ref=5.0.2
[changelog6]: https://raw.githubusercontent.com/markdown-it/linkify-it/7c568a123a17727fa2f34a0abcabbd46437299c1/CHANGELOG.md
[npm-overrides]: https://raw.githubusercontent.com/npm/cli/v10.9.8/docs/lib/content/configuring-npm/package-json.md#L934-L1042
