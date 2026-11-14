# Themes and runtime picker

Only when the user asks for switchable themes or fonts, or names a palette. A theme is one fixed palette, not a light/dark pair: the picker is the reader's light/dark control, so theme values never go in `prefers-color-scheme`.

## Palettes

Columns map to tokens; text tokens already reach 4.5:1. `-dim` variants are the same hex at about 12% alpha (`#rrggbb1f`). `--border` is `rgba(255,255,255,.08)` on dark themes and `rgba(0,0,0,.08)` on light ones; `--border-bright` takes the `--text-dim` value. `--node-a/b/c` are for fills, strokes, and chip markers, not text.

| id | mode | --bg | --surface | --text | --text-dim | --accent | --node-a | --node-b | --node-c | --ok | --warn | --risk | --info |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dracula | dark | #282a36 | #44475a | #f8f8f2 | #adb6d0 | #caa8fa | #8be9fd | #50fa7b | #ff79c6 | #50fa7b | #ffb86c | #ff9b9b | #8be9fd |
| nord | dark | #2e3440 | #3b4252 | #eceff4 | #a9aeb7 | #88c0d0 | #88c0d0 | #a3be8c | #b48ead | #a3be8c | #daa08e | #d89fa4 | #88c0d0 |
| one-dark | dark | #282c34 | #2c313a | #abb2bf | #9398a1 | #61afef | #61afef | #98c379 | #c678dd | #98c379 | #e5c07b | #e37981 | #61afef |
| catppuccin-mocha | dark | #1e1e2e | #313244 | #cdd6f4 | #989baa | #cba6f7 | #89b4fa | #a6e3a1 | #f5c2e7 | #a6e3a1 | #fab387 | #f38ba8 | #89b4fa |
| tokyo-night | dark | #1a1b26 | #24283b | #a9b1d6 | #898fac | #7aa2f7 | #7aa2f7 | #9ece6a | #bb9af7 | #9ece6a | #ff9e64 | #f7768e | #7aa2f7 |
| gruvbox-dark | dark | #282828 | #3c3836 | #ebdbb2 | #afa18e | #fe8019 | #83a598 | #b8bb26 | #d3869b | #b8bb26 | #fe8019 | #fc7c6d | #88a99c |
| synthwave-84 | dark | #262335 | #241b2f | #ffffff | #848bbd | #ff7edb | #36f9f6 | #72f1b8 | #fede5d | #72f1b8 | #ff8b39 | #fe4652 | #36f9f6 |
| solarized-light | light | #fdf6e3 | #eee8d5 | #526970 | #526970 | #00629b | #00629b | #859900 | #d33682 | #606e00 | #b54314 | #c42d2a | #00629b |
| github-light | light | #ffffff | #f6f8fa | #1f2328 | #656d76 | #0969da | #0969da | #1a7f37 | #8250df | #1a7f37 | #bc4c00 | #cf222e | #0969da |
| catppuccin-latte | light | #eff1f5 | #ccd0da | #4c4f69 | #54565f | #7230c9 | #1e66f5 | #40a02b | #ea76cb | #29661c | #983c07 | #b30d30 | #1851c2 |
| gruvbox-light | light | #fbf1c7 | #ebdbb2 | #3c3836 | #6b5f56 | #ad3903 | #076678 | #79740e | #8f3f71 | #67630c | #ad3903 | #9d0006 | #076678 |

Font pairs (id → body / mono): `dm` DM Sans / Fira Code · `instrument` Instrument Sans / JetBrains Mono · `plex` IBM Plex Sans / IBM Plex Mono · `bricolage` Bricolage Grotesque / JetBrains Mono · `jakarta` Plus Jakarta Sans / Azeret Mono. Load all in one Google Fonts link. A display face for headings stays in `--font-display` and does not change with the picker.

## Picker contract

- One fixed bar at the top right: theme dots (fill `--surface`, ring `--accent`), a divider, then `Aa` font chips, each in its own family. Every control uses `aria-pressed`; the active ring is `var(--text)`, not white. Hide the bar in print.
- Build the dots and chips from the `THEMES` / `FONT_PAIRS` data, never by hand.
- The default theme and font sit in `:root` as plain CSS, so the page renders without JS.
- `applyTheme(id)` sets every column above with `root.style.setProperty`; `applyFont(id)` sets `--font-body` and `--font-mono`. Both update `aria-pressed`, then redraw anything that baked colors or measured text, such as a canvas chart.
- Rules read fonts only through `var(--font-body)` and `var(--font-mono)`.

## Project defaults

`visual-explainer.config.md` can set `theme:` and `font:` to the ids above; in Claude Code, `.claude/visual-explainer.local.md` overrides it for personal preferences. Both only seed the defaults; an unknown value falls back to the page's own choice.
