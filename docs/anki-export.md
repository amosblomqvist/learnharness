# Anki export

Export a session's quiz history as an [Anki](https://apps.ankiweb.net/) deck. In the sidebar, right-click (or long-press) a session and choose **Export Anki deck (.apkg)…**, next to **Export as Markdown…**. The downloaded file opens directly in Anki Desktop (File → Import, or double-click): no manual text import, no column mapping.

## What becomes a card

The export is a deterministic snapshot of what the session actually asked — the same evidence view the session's markdown export renders:

- **Graded quiz answers** (teaching `quiz` and probe `probe` checks): Front is the question; Back is the correct option plus the teacher's post-answer explanation when present. Whether you answered right, wrong, or "I don't know" does not change the card — every posed-and-answered check is reviewable material.
- **Free-recall answers** (teaching `explain` and probe `recall` checks): Front is the question; Back is the model's committed answer — the correct answer the teacher recorded before you replied. Records without a committed answer export no card.
- **Concluded practice problems**: Front is the problem statement; Back is the model solution committed when the problem was posed. Dismissed problems never export — their solution was never revealed to you, and the export keeps that promise.

Dismissed checks, unanswered questions, preference questions (`ask_user_question`), and failed tool calls are not learning evidence and export nothing. A session with no exportable evidence produces a valid empty deck.

## Decks, notes, and re-exports

- Cards land in a deck named `LearnHarness::<session title>`, using one shared "LearnHarness Basic" note type (Front/Back).
- Card identities (GUIDs) derive from the chat id and the message each card came from, so **exporting the same session again updates the existing deck in Anki instead of duplicating cards**. Rename the deck inside Anki if you want a copy instead.
- Answer history, scheduling, and review statistics start fresh in Anki; LearnHarness does not export its own record of your session performance.

## Limitations

- **Text only.** Questions and answers export as plain text. LaTeX/markup the session displayed via rendering (for example math typeset from `\( ... \)`) appears as its raw source. Images and other artifacts are not exported.
- **Not verified against Anki Desktop.** The file is built to the documented Anki2 package format (schema ver 11) and roundtripped in automated tests (ZIP structure and the SQLite collection are parsed and checked), but a real import into Anki Desktop/AnkiWeb/AnkiDroid has not been exercised end-to-end.
- **Scheduling is not shared.** Anki's own spaced repetition governs the exported cards from import onward; there is no synchronization back into LearnHarness and no AnkiConnect integration (a possible follow-up).
- **Runtime requirement.** The server builds the deck with Node's built-in SQLite (`node:sqlite`), which needs **Node 22.5 or newer** (unflagged from Node 23.4). On an older runtime the route answers `500 Anki export requires Node 22.5+` and the menu item simply downloads that error.
