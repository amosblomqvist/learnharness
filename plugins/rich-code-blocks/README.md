# Rich code blocks

An optional official LearnHarness plugin using only the public plugin API.
It turns higher-level notation into **static SVG**:

| Initially-off setting | Fence | Content |
| --- | --- | --- |
| Chemical structures | `smiles` | One SMILES molecule |
| Musical notation | `abc` | One complete ABC tune; no audio |
| Technical diagrams | `tikz` | TikZ, CircuitikZ, tikz-cd and PGFPlots |

Enable the plugin, then enable only the families wanted in its dedicated Settings
page. Enabled families alone register renderers and add short system instructions
to prober, teacher, and practice agents, including the probing phase at the start
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
size, normal labels are approximately **19.4 px**, rather than the previous
**13.3 px**. Text-relative SVG width follows surrounding font-size changes without
replacing the SVG or recompiling TeX. Authored relative font sizes (including
subscripts), diagram proportions and the original tight viewBox are preserved.
Wide TikZ diagrams scroll horizontally within their own wrapper instead of
shrinking their labels. Existing **12 px padding** and centering are unchanged;
no extra margins or blank drawing space are introduced. Chemistry and music
retain their previous natural sizing and fit-to-width behavior.

## Source/build/install layout

This repository's authoring project is **`plugins/rich-code-blocks/`**. Build here:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run test:browser
```

The portable type-only SDK is `.sdk/`. In the matching app checkout, refresh it
with `npm run sdk`; outside the checkout, copy matching packaged authoring types
into `.sdk/` before installing development dependencies. Runtime code does not
import host implementation modules.

Build output goes directly into this project's **`dist/`**, not `dist/<id>/`.
Build cleanup refuses symlinked `dist/` and misplaced `dist/data/` and never
removes the workspace root or persistent sibling `data/`.

A separately authorized installation copies the **contents** of this built
`dist/` into `<learning data>/plugins/rich-code-blocks/dist/`. Keep persistent
state at sibling `<learning data>/plugins/rich-code-blocks/data/`, never inside
`dist/`, and preserve it during updates. No runtime dependency install, registration,
development/normal mode, profile, legacy fallback or migration is involved.
Already-admitted code changes require the app's normal restart lifecycle.
Building this project does **not** install it, restart an app/server, stage an
official release, or enable any format.

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

## Verification boundaries

`npm test` exercises small contracts, settings, lifecycle, cache and Worker bounds.
`npm run test:browser` starts only a disposable loopback fixture and a temporary
Chrome profile to exercise built bundles, static SVG admission and actual library
rendering/timing. A development-only KaTeX dependency supplies real reference math
for font-parity checks; its code/fonts are not shipped in the plugin build.
The fixture does not start/restart LearnHarness, install into a real data
directory, call a model or establish packaged-app/user functional acceptance.
See `THIRD-PARTY.md` for pinned libraries and explicit static-browser adaptations.

The browser fixture also changes the host Text token to non-black/white colors,
including a same-mode override. It checks live and cached mounts without extra
TeX work or settings requests, while retaining authored colors and rasterized mask
alpha. This is plugin-fixture coverage, not a real LearnHarness installation test.

### Historical black/white-ink checkpoint

Strict plugin TypeScript checking, **16 unit tests**, direct `dist/` build and the
real-Chrome disposable fixture passed. All six pictured examples rendered: SMILES,
ABC, basic TikZ/free-body geometry, CircuitikZ, tikz-cd and a PGFPlots function.
On this machine the small examples measured roughly **14 ms / 18 ms / 77–555 ms**
(SMILES / ABC / TikZ); cached plot remount was about **1 ms**. These are fixture
measurements, not general performance guarantees or packaged-app measurements.

A genuinely nonterminating TeX macro was forcibly stopped at about **10 seconds**,
with **500** page heartbeat ticks continuing; the next diagram rendered in about
**58 ms**. The fixture checked incomplete/disabled source, invalid/oversized input,
active cancellation, disable cleanup, cached mount-unique IDs, visible chemical
labels, TeX ampersand/less-than labels, and actual TeX-authored script/image and
reference-amplification attempts. The amplified reference graph was refused before
mounting. SVG root/self cycles were also refused. Four bundled font files actually
loaded, and the run had **zero page errors or off-origin requests**. Both dark/light
fixture screenshots were captured and visually inspected with White ink on dark
and Black ink on light. Browser checks also proved transparent backgrounds for all
six examples, stable mounted SVG identities and no TeX work/cache eviction on ink
changes, preserved atom/TikZ colors and white fills, and actual raster alpha for
shared-definition and gradient masks under both ink choices. TikZ sizing checks
compare all four technical-diagram examples against actual KaTeX at 16 px and
20 px surrounding text, verify unchanged padding and chemistry/music widths, and
confirm a wide diagram scrolls without shrinking normal labels or subscripts.
Font-size changes reused the existing SVGs without sending any TeX jobs.

The build also preserves complete GPLv3 and Apache-2.0 texts and the relevant
PyDvi/ColorBrewer notices alongside the other upstream licenses. This checkpoint
is **not** real-app installation, packaged Electron, human functional acceptance,
commit, push, or release verification. Official release source/licensing delivery
and build-selection/staging remain separate from this plugin build.
