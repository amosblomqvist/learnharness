# Perrin layout adaptation

The application chrome adopts the non-color foundations of [Perrin UI Kit](https://github.com/94yi/perrin-ui-kit): system UI fonts, a 4/8/12/16/24/32px spacing rhythm, 20px panel padding, 24px section spacing, and 8px control corners. The kit's MIT notice is retained in `perrin-ui-kit-LICENSE`.

- Settings headings use a clear 20px hierarchy; supporting text and controls are readable without changing reading preferences.
- Settings navigation uses 44px targets and becomes a horizontally scrolling strip below 640px. Rows can wrap instead of squeezing labels and controls.
- Session search gets its own full-width row, and session entries have more breathing room. Rename and display rows retain matching geometry.
- Session headers use a 20px system-UI title in a 44px target, centered within the 60px header in display and rename states. This replaces the serif-metric-dependent 4px translation. Long names remain bounded to 70%, truncate and expose the complete name through the native tooltip; click/F2 rename remains available. Reading-font and serif preferences still apply to lesson prose.
- Prose, answered cards and the active question/composer share a centered 46rem column with 16px side padding. They no longer alternate between a full-width transcript and a narrow dock.

No kit palette is imported. Existing theme values, color overrides, hover colors, teaching-prose fonts/sizes, code fonts, and markdown rendering remain application-owned. Theme previews stack on narrow screens rather than overflowing their cards.

Browser verification also exposed a development-mode crash: React seals its ref objects, but the session input bridges add a `changed` callback. Those bridges now use stable application-owned mutable objects. The accompanying browser smoke exercises the session and settings together without inference. Next.js is patched from 16.4.3 to 16.4.6 for the reported cache-disclosure advisories. No data migration is introduced.
