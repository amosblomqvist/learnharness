# Bundled third-party software

Rich code blocks is AGPL-3.0-only (see LICENSE). Dependency licenses are retained in
the built distribution's `licenses/` directory; BaKoMa's license is also retained
beside the fonts. There are no runtime npm installs or external CDN assets.

Primary rendering dependencies:

- **smiles-drawer 2.4.1** — MIT, Daniel Probst / Reymond Group, University of Berne.
  https://github.com/reymond-group/smilesDrawer
- **abcjs 6.7.2** — MIT, Paul Rosen and Gregory Dyke and contributors.
  https://github.com/paulrosen/abcjs
- **isomorphic-tikzjax 0.1.1** — LPPL-1.3c, prin and upstream TikZJax contributors.
  https://github.com/prinsss/node-tikzjax
- **@prinsss/dvi2html 0.0.1** — mixed upstream notices: package metadata says
  GPL-3.0; its bundled PyDvi TFM implementation carries GPL-3.0-or-later notices
  (Copyright 2014 Fabrice Salvaire). The package's root LICENSE is a separate MIT
  notice, Copyright 2015 Mitch Anderson. Both that MIT text and the full GPLv3
  text/PyDvi notice are retained; the MIT file does not cover the GPL portions.
  https://github.com/prinsss/dvi2html
- **BaKoMa fonts** — BaKoMa Fonts Licence, Basil K. Malyshev.

The isomorphic-tikzjax distribution supplies the bundled TeX/WASM image, package
archive, and fonts. Upstream credits TikZJax / kisonecat and artisticat1's
`output-single-file` build. The original image/archive is copied unchanged.

Other bundled JavaScript dependencies (versions are fixed in package-lock.json):
chroma-js (BSD-3-Clause AND Apache-2.0, including ColorBrewer material by Cynthia
Brewer, Mark Harrower and The Pennsylvania State University), buffer (MIT), base64-js (MIT), ieee754 (BSD-3-Clause),
md5 (BSD-3-Clause), charenc (BSD-3-Clause), crypt (BSD-3-Clause), is-buffer (MIT),
and pako (MIT/Zlib). Their upstream notices are copied into `licenses/`, along
with the complete Apache-2.0 text for ColorBrewer (not merely its license URL).

## Explicit static-browser adaptations

The build removes smiles-drawer's unused `window.SmilesDrawer` / `window.SmiDrawer`
global exports from its pinned ES module. The module export is used directly;
the original dependency on disk is unchanged and the exact patch is asserted.

The build bundles only abcjs's visual entry, `src/api/abc_tunebook_svg.js`, rather
than audio/synth/editor APIs. It omits that module's two top-level viewport
resize/orientation listeners; the plugin never uses its viewport mode. The exact
pinned-source replacement is asserted by the build so an upgrade cannot silently
retain those activation-independent global side effects. The dependency on disk
is not modified. Per-score interaction listeners are discarded with the detached
render tree: only rebuilt static SVG enters the application.

In the TeX Worker build, Node-only `jsdom` and `svgo` dynamic imports resolve to
explicit throwing stubs. The Worker calls `dvi2svg` with `disableSanitize: true`,
which avoids those paths. That upstream option bypasses DOM parsing, **not a
security sanitizer**. The plugin applies its own strict static SVG rebuilding
before anything is displayed. `node:buffer` resolves to the bundled browser
Buffer implementation. No Node filesystem implementation ships in the Worker.

Font CSS is namespaced to `rich-code-blocks-font-*`, matching admitted SVG font
attributes, and uses only bundled relative font files. Generated SVG never
imports a stylesheet or supplies an external URL. The pinned DVI writer's raw
single-SVG fragment omits its final closing root tag (normally repaired by its
HTML parser). The Worker closes only that known one-root/no-closing-tag fragment
before strict XML sanitization; it never parses generated HTML. A separate
asserted-source DVI adaptation escapes ordinary text characters `&`, `<` and `>`
when they are emitted, preserving intentional numeric entities. Thus valid TeX
labels such as `A\\&B` and `$x<y$` remain valid XML rather than being mistaken for
markup. Browser-produced
SMILES/ABC SVG is serialized with XMLSerializer to retain its SVG namespace.
SMILES label CSS translate transforms become validated finite 2D SVG matrices;
only approved static declarations survive. Vendor license texts are not modified. Narrow TypeScript declarations cover only the vendor calls used here:
the pinned SMILES package has dangling Vertex references in its declarations,
and the TikZ package's default declarations describe the Node entry.
