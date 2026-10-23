# source-map-js indexed source-map denial of service

<!-- archive-note:start -->
> Archived on 2026-10-23 under [workspace task 26](https://github.com/gzy31007/learnharness/issues/26). The original report follows unchanged except for mechanical local-link routing.
>
> Research cutoff: 2026-10-21, Asia/Shanghai. Historical input: the supplied Next 16.3.8 and PostCSS baseline; this report does not independently establish a complete immutable application snapshot.
>
> Later status, checked against the archive baseline: Research was followed by the separately recorded 1.2.2 patch and acceptance in issue 14. The archive baseline locks 1.2.2. The report's proposed tests remain unexecuted by its researcher; later task results are not retroactive research results. [Owning record](https://github.com/gzy31007/learnharness/issues/14).
>
> Read the [archive guide](README.md) and [local evidence register](local-evidence.md) before reusing any present-tense statement, line number, or acceptance result. Archive publication is not a new test run, distribution approval, or general risk acceptance.
<!-- archive-note:end -->

Checked on 2026-10-21, Asia/Shanghai. This is bounded primary-source research for learnharness issue 14, not a dependency change or an exploit run.

## Conclusion

`source-map-js@1.2.2` is the first fixed release named by GHSA-68fv-2mgg-jv7q. Its official tag contains the referenced fix, and its npm metadata points to the same release commit. The checked public advisory records do not identify a later same-root advisory affecting 1.2.2. The npm registry currently lists 1.2.2 as `latest`, with no later version. These findings support evaluating the exact 1.2.2 release as the minimal candidate. They do not prove that all resource-exhaustion inputs are safe.

The supplied Next 16.3.8 / private PostCSS 8.5.23 constraint, `source-map-js: ^1.2.1`, admits the stable version 1.2.2. Root PostCSS and other parent constraints, actual lock resolution, installation, and acceptance tests remain the main agent's responsibility. This research does not authorize a parent-package upgrade.

## Scope and evidence handling

Only this report was written. No dependencies were installed, no advisory payload or proposed regression was executed, and no code, configuration, lockfile, Git state, or issue was changed. No research was delegated. The npm tarball was not downloaded or inspected.

Before every GitHub API or raw-source request, an explicit `curl -sI -m 10 -x http://127.0.0.1:7897 https://github.com` preflight returned an origin HTTP 200. A proxy's `200 Connection established` was not treated as the origin status. GitHub and npm reads used that explicit proxy. No search snippets were used as evidence.

The historical application assessment was read at [security-advisory-triage.md:110-114](local-evidence.md#local-026). Its statements about absent direct application imports and request ingress are prior findings, not a fresh whole-application audit in this report.

## Complete advisory record

The complete [GitHub global advisory API record](https://api.github.com/advisories/GHSA-68fv-2mgg-jv7q), also exposed by the [reviewed advisory page](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), states:

- Identifier: GHSA-68fv-2mgg-jv7q / CVE-2026-93749.
- Summary: "source-map-js allows event-loop denial of service through indexed source-map section offsets".
- Exact npm affected range: `>= 1.0.0, < 1.2.2`. First patched version: `1.2.2`.
- Description: "fails to validate the per-section offset line value in indexed source maps", with extreme offsets causing "synchronous event loop blocking".
- Severity: high. CVSS 3.1 is 7.5, `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H`. CVSS 4.0 is 8.7, `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N`.
- CWE-1284, Improper Validation of Specified Quantity in Input.
- Published `2026-09-18T18:31:44Z`; updated and GitHub-reviewed `2026-10-05T23:31:22Z`; NVD publication recorded as `2026-09-18T18:18:33Z`.
- `withdrawn_at` and `repository_advisory_url` are null; `vulnerable_functions` is empty. The record does not itself enumerate the triggering APIs.

The API's full reference list contains NVD, the repository, original issue 76, an old source-node permalink, a VulnCheck advisory, PR 79, commit `cf7658058ceeaa8619d5ae0ec90be6905209d016`, release v1.2.2, and the global advisory itself. This report follows the original issue, patch, release, and source rather than treating the third-party descriptions as implementation evidence.

The [original reporter's issue 76](https://github.com/7rulnik/source-map-js/issues/76), created September 17, identifies `SourceNode.fromStringWithSourceMap` as the initial reproducer. It explains that an indexed map supplies `sections[].offset.line`, which becomes a generated mapping line and drives a padding loop. A JSON number such as `1e999` can parse as Infinity. The issue describes service stalls and crashes when untrusted maps reach re-emission. Its CWE-1287 / CWE-835 labels differ from the reviewed record's CWE-1284. Use the reviewed record for the catalog classification, and source code for the mechanism. The reporter's phrase "uncatchable-in-place array error" is not proof that every JavaScript RangeError is uncatchable; CPU stalls and process OOM need separate treatment.

## Official implementation and triggering APIs

[PR 79](https://github.com/7rulnik/source-map-js/pull/79) merged on `2026-09-30T13:18:10Z` as [commit cf7658058ceeaa8619d5ae0ec90be6905209d016](https://github.com/7rulnik/source-map-js/commit/cf7658058ceeaa8619d5ae0ec90be6905209d016). Both its description and complete six-file diff were read. It repairs more than a single offset check.

### Indexed-map intake

The public synchronous constructor `new SourceMapConsumer(map)` selects `IndexedSourceMapConsumer` when `map.sections != null`, [release source:22-30](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/lib/source-map-consumer.js#L22-L30).

[Release source:953-1007](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/lib/source-map-consumer.js#L953-L1007) now requires both offset fields to be numbers, non-negative integers, and at most `9007199254740991`. It rejects strings, fractions, NaN, infinities, null, and unsafe integers. Missing fields also throw through argument lookup. The thrown validation error is `Section offset line and column must be non-negative integers.`

`MAX_SECTION_OFFSET_LINE = 1e7`, [release source:14-20](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/lib/source-map-consumer.js#L14-L20). A line offset greater than 10,000,000 throws `Section offset line must not exceed 10000000.` The limit includes the sum along nested sections through `_maxOffsetLine`; exceeding the nested sum throws a message ending `including offsets of nested sections.` Exactly 10,000,000 is accepted. Columns have no matching ten-million cap because they do not create a semicolon per skipped line. Existing section-order checks remain in place. Sections using `url` are still unsupported.

### Re-emission through SourceNode

`SourceNode.fromStringWithSourceMap(code, consumer)` calls `consumer.eachMapping(...)`, then advances from the actual generated code toward each mapping's generated line. Before the fix it could keep requesting missing lines far beyond the code, doing work proportional to an attacker-selected offset and emitting literal `undefined` text.

The [new guard:115-124](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/lib/source-node.js#L115-L124) stops when `remainingLinesIndex >= remainingLines.length`, sets `lastGeneratedLine = mapping.generatedLine`, and breaks. This is a second protection beyond rejecting excessive constructor offsets. The later source-content copying also reads `consumer.sources`, [release source:144-153](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/lib/source-node.js#L144-L153).

### Copying into a generator and serialization

`SourceMapGenerator.fromSourceMap(consumer)` copies mappings and reads `consumer.sources`, [release source:42-90](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/lib/source-map-generator.js#L42-L90). Manual `eachMapping` / `addMapping` copying reaches the same serializer when the resulting generator is serialized with `toJSON()` or `toString()`.

A flat source map represents each skipped generated line with `;`. The old serializer appended one character per loop iteration, creating many string-rope nodes. The [new serializer:349-356](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/lib/source-map-generator.js#L349-L356) uses `next += lineDelta === 1 ? ';' : ';'.repeat(lineDelta);` and advances the line counter directly. Output size remains proportional to the gap. It is not constant-memory serialization, and the indexed-map cap is not a universal cap on every use of `SourceMapGenerator.addMapping`.

### Nested sources getter

The indexed consumer's `sources` getter used to recompute each nested consumer's sources repeatedly during the item loop. The [new getter:1021-1034](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/lib/source-map-consumer.js#L1021-L1034) stores `var sectionSources = this._sections[i].consumer.sources` once per section. This removes the reported exponential amplification with nesting. It does not set a maximum nesting depth, section count, source count, input size, or cumulative output size.

### What constitutes a trigger

Dependency presence is not enough. An attacker must control map input that reaches this synchronous implementation. Merely constructing an old consumer with a large finite offset is not the principal line-padding or generator-serialization trigger. The downstream operation matters. The nested getter can also be reached by reading `consumer.sources` directly, without serialization. A validation-only test must not be described as having reproduced the historical process stall.

## Official regression evidence

The patch modifies the consumer, generator, and SourceNode test files. The tagged files preserve those changes:

- [Consumer tests:898-976](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/test/test-source-map-consumer.js#L898-L976) reject invalid line and column values; reject `1e7 + 1`; accept line `1e7` and column 5,000,000; check nested offsets summing to generated line 5001; accept a total of `1e7` but reject a larger nested total; and instrument a nested getter to require exactly one innermost sources read.
- [Generator tests:786-821](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/test/test-source-map-generator.js#L786-L821) check a million-line gap and copy an indexed map with offset `1e7`, expecting serialized mappings length `1e7 + 4` and suffix `;AAAA`.
- [SourceNode tests:277-311](https://github.com/7rulnik/source-map-js/blob/0a1d334fd1e55a47df97fcd60a7915d46df3b08a/test/test-source-node.js#L277-L311) require offset-past-code conversion to preserve `var x;\n` with fewer than ten children, and a depth-40 nested map to preserve code and source content.

The PR reports `npm test` passing 145/145 and capped-heap/deadline comparisons. Those are maintainer-reported results, not tests rerun here. Its large stress inputs are not recommended as the default local regression.

## Release and exact npm metadata

The [official v1.2.2 release API](https://api.github.com/repos/7rulnik/source-map-js/releases/tags/v1.2.2) gives publication time `2026-09-30T13:34:23Z`. The [release page](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2) names PR 79 / CVE-2026-93749 and also a CSP unsafe-eval fix from PR 29. The release is therefore not literally a security-only code change. It has no attached release assets.

The [tag reference](https://api.github.com/repos/7rulnik/source-map-js/git/ref/tags/v1.2.2) resolves directly to commit `0a1d334fd1e55a47df97fcd60a7915d46df3b08a`. The [fix-to-release comparison](https://api.github.com/repos/7rulnik/source-map-js/compare/cf7658058ceeaa8619d5ae0ec90be6905209d016...0a1d334fd1e55a47df97fcd60a7915d46df3b08a) is ahead by two commits and behind by zero; only the changelog and package version differ. Thus the release contains the inspected fix without later implementation edits in that interval.

The exact [npm version document](https://registry.npmjs.org/source-map-js/1.2.2) returned:

- `name`: `source-map-js`; `version`: `1.2.2`.
- `gitHead`: `0a1d334fd1e55a47df97fcd60a7915d46df3b08a`.
- `main`: `./source-map.js`; `typings`: `source-map.d.ts`.
- `engines.node`: `>=0.10.0`. Publisher tooling fields are `_nodeVersion: 26.10.0` and `_npmVersion: 11.19.1`; they are not consumer runtime requirements.
- `license`: `BSD-3-Clause`; repository `git+https://github.com/7rulnik/source-map-js.git`.
- `dist.tarball`: `https://registry.npmjs.org/source-map-js/-/source-map-js-1.2.2.tgz`.
- `dist.integrity`: `sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==`.
- `dist.shasum`: `79fb88d97535a21cb27162cb05d211b67acea4ab`.
- `dist.fileCount`: 18; `dist.unpackedSize`: 142723 bytes.

The metadata also carries registry signatures. They were not cryptographically verified here. The integrity and shasum above are registry declarations, not hashes independently computed from downloaded bytes. Matching `gitHead` and the tag establishes metadata consistency, not byte-for-byte tarball verification.

The [full package registry document](https://registry.npmjs.org/source-map-js) gives `time["1.2.2"] = 2026-09-30T14:08:09.382Z`, `time.modified = 2026-09-30T14:08:09.648Z`, and `dist-tags.latest = 1.2.2`. Its complete version list ends at 1.2.2. The difference between GitHub release time and npm publication time is expected separate publication metadata, not a version discrepancy.

For ordinary stable semver resolution, `^1.2.1` admits `>=1.2.1 <2.0.0`, including 1.2.2. This checks only the supplied parent constraint; it does not prove how every installed or bundled copy resolves.

## Check for later same-root advisories

The following complete first-page JSON responses were read. None was truncated at the requested page size:

- [Reviewed npm package advisories](https://api.github.com/advisories?ecosystem=npm&affects=source-map-js&per_page=100): one result, GHSA-68fv-2mgg-jv7q, still naming 1.2.2 as first fixed.
- [Unreviewed npm package advisories](https://api.github.com/advisories?ecosystem=npm&affects=source-map-js&type=unreviewed&per_page=100): empty array.
- [Public repository security advisories](https://api.github.com/repos/7rulnik/source-map-js/security-advisories): empty array.
- [Original disclosure comments](https://api.github.com/repos/7rulnik/source-map-js/issues/76/comments?per_page=100): seven comments. The final comment, dated September 30, identifies PR 79 and 1.2.2; no later correction appears in that thread.

Together with the registry version list, these checks found no public follow-up requiring a version after 1.2.2. This is a time-bounded negative result over these records, not proof that private reports, unpublished bypasses, or every issue in the repository are absent.

## Application reachability boundary

The historical note reports no direct application use or request path accepting source maps. This report did not repeat a full source/route/data-flow audit. The supplied pinned Next version and private PostCSS constraint are context from the main investigation, not independently re-established package topology here.

The installed private PostCSS implementation was read to distinguish an existing library path from a proven application ingress:

- [previous-map.js:16-36](local-evidence.md#local-079) returns early for `opts.map === false`, otherwise loads previous-map input and lazily constructs `SourceMapConsumer`.
- [previous-map.js:64-70](local-evidence.md#local-080) recognizes objects with a `sections` array as maps. [previous-map.js:104-146](local-evidence.md#local-078) accepts `opts.map.prev` strings or objects, converts an existing consumer through `SourceMapGenerator.fromSourceMap(prev).toString()`, and decodes inline source-map annotations. External-file paths have separate checks at [previous-map.js:87-101](local-evidence.md#local-081); those checks are not an offset validator.
- [input.js:70-75](local-evidence.md#local-076) constructs a previous map and requests its consumer when map text exists. [map-generator.js:103-128](local-evidence.md#local-077) can copy a previous consumer into a generator and emit an annotation. These are real library capabilities, not evidence that an HTTP requester can supply the CSS or previous map.

A reachable denial of service therefore needs an additional trust-boundary fact: attacker-controlled CSS with an accepted map annotation, an attacker-controlled previous-map option, or another attacker-controlled map must reach one of the amplification operations in a shared process. Build-time dependency processing, developer-controlled local files, and production request handling are distinct exposure models. An npm production classification proves none of these attacker-control facts. This research neither demonstrates a production exploit nor establishes production unreachability.

## Proposed resource-limited regression, not executed

Use a trusted, already selected package entry for each resolved copy. Do not run this inside the application server or against a remote endpoint. Do not install or execute an exploit repository. The cases below use locally constructed, bounded fixtures and require a separate Node process for each case.

### Process controls

A future Linux/WSL runner can wrap each individual case with the following pattern. `NODE` must be an absolute trusted Node executable and `CASE_FILE` a reviewer-written local fixture worker. Neither file is created by this report.

```sh
env -u NODE_OPTIONS timeout --signal=KILL 5s bash -c '
  set -eu
  ulimit -c 0
  ulimit -t 2
  exec "$NODE" --max-old-space-size=64 "$CASE_FILE" "$CASE_NAME"
'
```

Export the three variables first and pass only a trusted, allowlisted case name. The outer deadline must remain outside Node because an event-loop timer cannot interrupt synchronous map processing. `ulimit -t 2` bounds process CPU time; GNU timeout enforces a five-second wall deadline even during a synchronous stall. Treat every nonzero exit, signal, deadline, OOM, or missing completion record as failure, not an accepted rejection. Disable core dumps and bound captured output. Run sequentially, with no retry escalation or automatic input growth.

`--max-old-space-size=64` caps V8 old-generation heap, not total process RSS or all native allocations. If a hard total-memory budget is required, add an existing OS/cgroup memory limit outside Node and fail closed when it cannot be applied. Do not call a JS heap flag an RSS cap. A tight address-space `ulimit -v` can prevent Node from starting because V8 reserves virtual address space, so it is not a portable replacement. These limits are proposed test budgets, not upstream performance guarantees.

### Minimal fixture and APIs

The shared data can be this small:

```js
function flat() {
  return {
    version: 3,
    sources: ['a.js'],
    sourcesContent: ['a'],
    names: [],
    mappings: 'AAAA'
  };
}
function indexed(line, column, child = flat()) {
  return {
    version: 3,
    sections: [{ offset: { line, column }, map: child }]
  };
}
```

`AAAA` is one mapping at generated line 1, column 0 to original line 1, column 0. Indexed offsets are zero-based. Consumer mapping lines are one-based. Keep nonzero-line and nonzero-column examples separate here rather than assuming unrelated offset behavior has been repaired.

Recommended individual cases and exact expectations:

1. **Normal flat map.** Construct a consumer from `flat()`. `eachMapping` must yield one mapping at generated line 1 / column 0 to `a.js`, original line 1 / column 0. `SourceMapGenerator.fromSourceMap(consumer).toJSON().mappings` should remain `AAAA`. `SourceNode.fromStringWithSourceMap('a', consumer).toString()` should remain `a`.
2. **Small indexed offsets.** `indexed(3, 0)` must yield generated line 4 / column 0 through `eachMapping`; `indexed(0, 7)` must yield generated line 1 / column 7. The original source position stays line 1 / column 0. A depth-five nest with line offset 1000 at every level should yield line 5001. These are compatibility checks, not timing measurements.
3. **Constructor rejection.** Test `indexed(10000001, 0)` and a depth-three nest with line offset 5,000,000 per level. The constructor must throw a line-limit error, with the latter mentioning nested offsets. Never pass an unexpectedly accepted result to SourceNode or generator serialization. This makes an accidental old-version run bounded too.
4. **Offset type validation.** At constructor intake, test each field with `-1`, `1.5`, `'1'`, `null`, `undefined`, NaN, positive/negative Infinity, and `9007199254740992`. Require a throw. Set these values on objects directly; JSON serialization changes NaN/Infinity to null and drops undefined, so it would not test those exact values. If wire-number parsing is checked, use a separate tiny JSON fixture containing `1e999` and require constructor rejection, with no downstream re-emission.
5. **Accepted limit without amplification.** Construct `indexed(10000000, 0)` and inspect only the single `eachMapping` record, expecting line 10000001. A two-level nest with line offset 5,000,000 per level should also be accepted. Do not serialize either map in the default suite. A column of 5,000,000 with line offset zero is accepted and can be checked by mapping inspection only.
6. **Code exhausted before mapping.** With `indexed(4096, 0)`, call `SourceNode.fromStringWithSourceMap('var x;\n', consumer)`. Require exact output `var x;\n` and fewer than ten children. This bounded reduction of the upstream case reaches the repaired API and catches the old empty-line/undefined behavior without a huge offset.
7. **Bounded generator serialization.** For `indexed(4096, 0)`, copy the one consumer mapping with `eachMapping` into `SourceMapGenerator.addMapping`, preserving generated/original coordinates and source. `toJSON().mappings` should equal `';'.repeat(4096) + 'AAAA'`, length 4100. Do not print the mapping string. This checks output semantics on the repaired serializer. It is deliberately too small to demonstrate the historical heap blowup; correctness alone does not prove the rope optimization, which is also established by source inspection.
8. **Nested getter count instead of a stall.** Build a depth-four indexed nest with zero offsets. Wrap the innermost basic consumer's `sources` getter with a read counter, retaining its original array. Reading the outer `consumer.sources` must return `['a.js']` and invoke the innermost getter exactly once. This follows the official instrumented test without using depth-40 exponential work. A separate small SourceNode conversion can verify source-content preservation.

Run normal and small-offset compatibility cases against a trusted baseline only if authorized; failing a rejection assertion must not fall through into a large-offset operation. Run every selected installed candidate separately, with its resolved entry and package version recorded. An exact version string alone does not show which copy PostCSS actually loaded. Reuse the main agent's dependency-resolution evidence rather than changing parent constraints in this research task.

The minimum useful regression is constructor rejection plus normal-map compatibility plus the bounded SourceNode conversion. Generator output and getter-count cases cover the additional repairs in the actual release. No high-stress test is needed to establish the documented patch mechanism.

## Remaining unknowns and handoff

The public records support 1.2.2 for this named advisory as checked today. They do not establish a universal resource bound on arbitrary source-map input. Total sections, total sources, depth, output length, and direct generator mappings still need caller budgets if untrusted maps are ever accepted.

Tarball bytes, registry signatures, candidate lockfile integrity, all parent constraints, actual consumer resolution, build compatibility, application attacker-controlled ingress, and the proposed subprocess tests were not independently verified here. The main agent should handle those within the issue's approved minimal-change scope. If a fresh advisory or candidate regression contradicts this evidence, stop and report the discrepancy rather than silently choosing a broader upgrade.
