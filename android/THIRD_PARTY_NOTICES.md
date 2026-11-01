# LearnHarness Android

LearnHarness is licensed under AGPL-3.0-only. The full application license is
included in the local server bundle. Corresponding source, including the Android
host and build instructions: https://github.com/Matias-Sanmiguel/learnharness
(branch `cursor-provider`).

The embedded runtime is Node.js Mobile 24.22.1-0, maintained by fogtape, based on
Node.js 24.22.1, under the MIT license and the third-party notices included in
Node's LICENSE. This runtime is a prerelease. Exact binary digest and source
references are recorded in `android/runtime.json` in the corresponding source.

- Runtime source: https://github.com/fogtape/nodejs-mobile/tree/v24.22.1-0
- Node license: https://github.com/nodejs/node/blob/v24.22.1/LICENSE
- Canvas (MIT): https://github.com/Brooooooklyn/canvas
- resvg-js (MPL-2.0): https://github.com/yisibl/resvg-js

JavaScript dependency versions, source locations and integrity digests are
recorded in the source repository's package-lock.json. Their license files are
retained in the packaged dependency directories when present in the trace.
