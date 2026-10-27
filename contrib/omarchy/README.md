# Omarchy theme

LearnHarness can follow the current [Omarchy](https://omarchy.org) desktop theme, the same way T3 Code does. Select **Settings → Appearance → Theme → Omarchy**. Open windows retint when you switch Omarchy themes.

LearnHarness reads `~/.config/LearnHarness/themes/omarchy.json` (or `$XDG_CONFIG_HOME/LearnHarness/themes/omarchy.json`). On Linux it creates the `themes` directory the first time it runs. These two files keep that theme file up to date:

| File | Install as |
| --- | --- |
| `learnharness.json.tpl` | `~/.config/omarchy/themed/learnharness.json.tpl` |
| `60-learnharness` | `~/.config/omarchy/hooks/theme-set.d/60-learnharness` |

```sh
cp contrib/omarchy/learnharness.json.tpl ~/.config/omarchy/themed/
install -m 755 contrib/omarchy/60-learnharness ~/.config/omarchy/hooks/theme-set.d/
omarchy-theme-refresh
```

Omarchy renders the template into `~/.local/state/omarchy/current/theme/learnharness.json` on each theme switch, and the hook copies it into place atomically. Themes without a `colors.toml` produce no file; the previous palette stays.
