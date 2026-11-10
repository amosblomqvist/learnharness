# Rich code blocks

An optional Core LearnHarness plugin using only the public plugin API.
It turns higher-level notation into **static SVG**:

| Initially-off setting | Fence | Content |
| --- | --- | --- |
| Chemical structures | `smiles` | One SMILES molecule |
| Musical notation | `abc` | One complete ABC tune; no audio |
| Technical diagrams | `tikz` | TikZ, CircuitikZ, tikz-cd and PGFPlots |

Enable the plugin in **Settings → Core plugins**, then enable only the families
wanted in its dedicated Settings page. Enabled families alone register renderers
and add short system instructions to prober, teacher, and practice agents, including
the probing phase at the start
of a teaching session. Disabling a family restores ordinary readable
code fences. Prompt changes apply to future turns, not an already-running model
request. There are no subarea toggles, per-family prompt editors, simulations,
interactive circuits, playback, raw-SVG input or custom drawing toolbars.

## Transparent appearance

Rendered SVGs have no plugin background: the transcript shows through. Neutral
text and linework follow the app's **Text** color (`--foreground`), including Text
color overrides, in all three families. This includes the chemistry renderer's
neutral carbon/hydrogen ink. There is no separate Ink color setting.
Colored atoms and explicitly colored diagram elements remain colored. Intentional
white fills, authored gradients/patterns and functional masks are preserved, not
blanket-erased or inverted. A background deliberately drawn inside a TikZ diagram
is still part of that diagram; the plugin does not guess which shapes to delete.
No blend modes or inversion filters are used.

Theme and Text-color changes reach mounted SVGs immediately through inherited
CSS variables, without replacing them, compiling TeX again, clearing the compiled
SVG cache, or sending plugin settings requests. New cached mounts inherit the
current Text color too. Existing v1 settings remain readable with or without the
obsolete `inkColor` key; its value is ignored. Startup never rewrites the file.
The next changed family toggle saves settings without that obsolete key while
preserving the other family choices.

## TikZ sizing

TikZ diagrams scale as a whole so the engine's normal 10-point labels match the
surrounding chat LaTeX size (`1.21em`, matching KaTeX). At the default 16 px reading
size, normal labels are approximately **19.4 px**. Text-relative SVG width follows
surrounding font-size changes without replacing the SVG or recompiling TeX. Authored relative font sizes (including
subscripts), diagram proportions and the original tight viewBox are preserved.
Wide TikZ diagrams scroll horizontally within their own wrapper instead of
shrinking their labels. The wrapper uses **12 px padding** and centering without
extra margins or blank drawing space. Chemistry and music use natural sizing
and fit-to-width behavior.

## Core plugin and source reference

The app supplies and updates this plugin's code; writable preferences live under
`<learning data>/core-plugin-data/rich-code-blocks/`. This source project is reference
material, not an installable Community copy. `rich-code-blocks` is a reserved Core ID
even when disabled or missing. A Community fork needs its own manifest/folder ID and
must reconsider conflicting contribution, tool and fence names, including `smiles`,
`abc` and `tikz`. A new plugin ID does not make duplicate fence registrations coexist.
Do not install this build into a Community `plugins/rich-code-blocks/` folder.

## Development

In the extracted authoring kit, copy the shared **kit-root `types/` contents** into
`.sdk/` **before dependency setup**. From `plugins/rich-code-blocks/`:

```sh
mkdir -p .sdk
cp -R ../../types/. .sdk/
```

In a matching LearnHarness source checkout instead, `npm run sdk` generates `.sdk/`
using `../../scripts/build-plugin-types.mjs`. That command is **checkout-only** and
does not work in the extracted kit. Imports from the SDK are type-only; runtime
code does not import host implementation modules.

Set up development dependencies separately, including the SDK's declared
peer dependencies/types. With dependencies already available, the build-only command is:

```sh
npm run build
```

Build output goes directly into this project's **`dist/`**, not `dist/<id>/`.
It bundles JavaScript and local TeX/WASM/fonts and copies license notices. Cleanup
refuses symlinked `dist/` and misplaced `dist/data/` and preserves sibling `data/`.
Building does not install, enable or update the Core plugin, build/restart the host,
or enable any notation family.

## Examples

Chemical structure:

````markdown
```smiles
CC(=O)Oc1ccccc1C(=O)O
```
````

Musical score:

````markdown
```abc
X:1
T:Scale
M:4/4
L:1/4
K:C
C D E F | G A B c |]
```
````

Physics/free-body diagrams and geometry use general TikZ:

````markdown
```tikz
\usepackage{tikz}
\begin{document}
\begin{tikzpicture}
  \draw (0,0) rectangle (1,1);
  \draw[->] (0.5,0.5) -- (0.5,2) node[above] {$N$};
  \draw[->] (0.5,0.5) -- (0.5,-1) node[below] {$mg$};
\end{tikzpicture}
\end{document}
```
````

Circuit schematics (static drawing, **not circuit simulation**):

````markdown
```tikz
\usepackage{circuitikz}
\begin{document}
\begin{circuitikz}
  \draw (0,0) to[R=$R$] (3,0);
\end{circuitikz}
\end{document}
```
````

Commutative diagrams:

````markdown
```tikz
\usepackage{tikz-cd}
\begin{document}
\begin{tikzcd}
  A \arrow[r,"f"] & B
\end{tikzcd}
\end{document}
```
````

Analytic function plots:

````markdown
```tikz
\usepackage{pgfplots}
\pgfplotsset{compat=1.16}
\begin{document}
\begin{tikzpicture}
\begin{axis}[xlabel={$x$},ylabel={$f(x)$}]
  \addplot[domain=-2:2,samples=25]{x^2};
\end{axis}
\end{tikzpicture}
\end{document}
```
````

The bundled engine supplies a standalone document class; do not add
`\documentclass` or `\documentstyle`. Each block must be self-contained: explicitly
load its needed packages and TikZ libraries before `\begin{document}`, then close
with `\end{document}`. Bundled packages are available, not automatically loaded;
declarations in another block do not carry over. In particular, load
`\usepackage{amsmath}` for math labels using `\text{...}` or aligned equations.
Place the diagram environment directly inside `document`, without an outer
`\[...\]`, `$$...$$`, or `equation` wrapper. TikZ node labels can use `$...$`;
`tikzcd` cells already use math mode. The bundled PGFPlots version is **1.16**:
use `\pgfplotsset{compat=1.16}`, not `compat=1.18` or a newer version.
These requirements are also included in the prober/teacher/practice system
instructions when technical diagrams are enabled. Upstream also includes supporting
math/array/3D/chemfig packages, but those are not additional advertised families.
No raw SVG/HTML/JS, shell, remote resource, uploaded data-file or audio input path
is provided by this plugin.

## Lifetimes, limits and safety

- Incomplete and pending fences show source without compiling incomplete input.
  Errors and limit violations use the host's error-plus-readable-source fallback.
- TeX runs in one lazy serial browser Worker per window. A job has a **10 second**
  deadline (including cold loading), after which the Worker is terminated. Active
  mount cancellation also terminates it; waiting cancelled jobs are removed.
  Subsequent jobs recreate it. Disabling technical diagrams/plugin disposes it.
- Source limits are **2 KiB SMILES / 16 KiB ABC / 32 KiB TikZ**, measured as UTF-8.
  Generated SVG is capped at **2 MiB**; TeX admits at most **16 waiting jobs**.
  One volatile LRU holds at most **32 successful outputs / 8 MiB**, including keys.
  There is no persistent render cache or model inference request.
- TeX's fixed WASM linear memory is about **69 MiB**. That is not a total Worker
  memory cap: JS conversion, decompressed assets and fonts use additional memory.
  TeX CPU work cannot freeze the page event loop, but the browser still consumes
  CPU/memory. SMILES and ABC use DOM-based renderers on the main thread with source
  caps; **no hard execution deadline is claimed for them**.
- All JS, TeX/WASM, package resources and fonts are local bundled assets, loaded
  lazily. No CDN, service or arbitrary document-selected URL is used.
- Generated SVG is parsed inertly, then **rebuilt** from vetted static elements
  and attributes. Scripts, event attributes, HTML, links, animation, external URLs,
  stylesheet rules and unsafe CSS are discarded. IDs/local references are
  namespaced for each mount. Cyclic local `use` references are refused; memoized
  graph accounting applies the same **2 MiB limit to use-expanded output** before
  mounting, preventing small acyclic reference-amplification payloads. Text/font/
  style admission is restricted; only bundled TeX fonts or ordinary system families
  are selected. Never insert raw model HTML.
- Rendered drawings are transparent with theme-inherited neutral ink,
  preserving aspect ratio. Chemistry/music fit available width; wide TikZ scrolls
  to retain math-size labels. Plugin-owned paint variables
  are applied only after sanitization and before the final expanded-output budget
  check. Mask luminance and intentional colors/fills are retained. No raw generated
  tree or interaction listener is mounted. Abort/disposal fences late results.
- Settings are versioned, validated and atomically written in plugin-owned
  `data/settings.json`. Only a changed family toggle is sent to the backend; unrelated
  concurrent-window changes are retained. Accepted revisions synchronize live and
  reconnect reads cannot overwrite a newer accepted revision. Malformed/newer
  settings fail explicitly without rewriting the file. Disabling never deletes it.

This remains trusted-local plugin code, not a sandbox for arbitrary third-party
plugins. Static output sanitization and an isolated TeX Worker do not authorize
arbitrary JS execution or weaken Electron/host isolation.

## Tests and boundaries

After SDK/dependency setup, these checks use the plugin project, not a host checkout:

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
```

Unit tests exercise contracts, settings, lifecycle, cache and Worker bounds, including
output-cleanup guards. The browser script requires local Chrome/Chromium (`CHROME_PATH`
or a supported default path), built `dist/` files and the project's test dependencies.
It starts a disposable loopback fixture and temporary Chrome profile to exercise
actual libraries, SVG admission, timeout/cancellation, font sizing, live/cached theme
changes, authored colors and rasterized mask alpha. A development-only KaTeX dependency
supplies reference math; its code/fonts are not shipped in the plugin build.

The fixture mocks the host; it does not start/restart LearnHarness, install into a real
data directory, call a model or establish packaged-app/user functional acceptance.
This project has no `test:native` script. Real app integration and platform-specific
behavior require separate host checks.

## Source reading route

- [`src/main.ts`](src/main.ts) and [`src/backend.ts`](src/backend.ts): settings
  synchronization, conditional fence registrations and additive agent instructions.
- [`src/contract.ts`](src/contract.ts): family policy, source/output/cache limits
  and validated settings.
- [`src/render.ts`](src/render.ts) → [`src/tex-runner.ts`](src/tex-runner.ts) →
  [`src/tex-worker.ts`](src/tex-worker.ts): lazy rendering, serial work, cancellation
  and Worker lifetime.
- [`src/svg.ts`](src/svg.ts) and [`src/appearance.ts`](src/appearance.ts): static
  SVG admission, local reference handling and theme-aware paint/sizing.
- [`scripts/build.mjs`](scripts/build.mjs), [`licenses/`](licenses/) and
  [`tests/`](tests/): local assets, upstream adaptations, notices and fixtures.

See the [example map](../../docs/plugin-examples.md),
[authoring guide](../../docs/plugin-authoring.md) and
[API reference](../../docs/plugin-api/README.md).

## License

AGPL-3.0-only. See [`LICENSE`](LICENSE), [`THIRD-PARTY.md`](THIRD-PARTY.md) and
[`licenses/`](licenses/) for pinned libraries, static-browser adaptations and upstream
licenses/notices. The build preserves complete GPLv3 and Apache-2.0 texts and the
relevant PyDvi/ColorBrewer notices alongside the other upstream licenses.
