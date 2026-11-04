# Themes

**Settings → Appearance → Theme** sets every color in the app from one palette.
LearnHarness ships twelve presets: Default (the original dark palette), Catppuccin
Latte, Frappé, Macchiato and Mocha, Rosé Pine, Moon and Dawn, Gruvbox Dark, Ivory, Pastel, and NvChad Onedark.
Each theme declares whether it is dark or light, and the window chrome follows it.

## Overriding single colors

The **Colors** block under the theme grid has one field per theme color. A filled
field wins over the active theme; an empty field uses the theme's value, shown in
its hint. Overrides are kept when you switch themes, so a background you like
survives a change of palette. **Reset all** clears every override.

`background`, `bold` and `italic` keep their pre-theme settings keys
(`appearance.background`, `mdRendering.boldColor`, `mdRendering.italicColor`), so
values set in older versions keep working.

## Theme files

**Export JSON** downloads the active theme with your overrides applied. Importing
that file back reproduces what is on screen. **Import JSON** accepts a file in this
shape:

```json
{
	"name": "My Theme",
	"mode": "dark",
	"colors": {
		"background": "#1e1e2e",
		"surface": "#313244",
		"border": "#45475a",
		"text": "#cdd6f4",
		"textMuted": "#a6adc8",
		"accent": "#cba6f7",
		"bold": "#b4befe",
		"italic": "#f5c2e7",
		"code": "#fab387",
		"error": "#f38ba8",
		"success": "#a6e3a1",
		"warning": "#f9e2af"
	}
}
```

All twelve colors are required, as `#rgb` or `#rrggbb` hex. `mode` is `"dark"` or
`"light"`. A file with a missing or invalid key is refused, and the error names
the key.

| Key | Where it shows |
|---|---|
| `background` | Page background |
| `surface` | Cards, popovers, inputs; hover states derive from it |
| `border` | Borders and input outlines |
| `text` | Body text |
| `textMuted` | Secondary text and hints |
| `accent` | Focus rings, toggles, the selected theme card |
| `bold` | **Bold** text in lessons |
| `italic` | *Italic* text in lessons |
| `code` | Inline `code` in lessons |
| `error` | Errors, wrong answers, destructive actions |
| `success` | Correct answers, connected states |
| `warning` | Warnings and partial states |

## Where custom themes live

Imported themes are saved as `<id>.json` in the `themes/` folder of the app data
directory (`data/themes/` in a development checkout, or under Electron `userData`
in the desktop app). The id is a slug of the name; a name that collides with an
existing theme gets a `-2`, `-3`… suffix. Preset ids are reserved.

Removing the active custom theme switches back to Default and keeps your overrides.
