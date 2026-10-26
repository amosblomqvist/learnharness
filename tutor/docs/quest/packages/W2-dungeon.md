You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package W2: Workshop project P02, the dungeon (scripts/workshop/p02-dungeon/)

Create one new folder under scripts/workshop/ (named below) by copying the structure of scripts/workshop/p01-quest-log/. Then `npm run build:workshop && npm run check:study workshop`.

**What the learner builds:** `dungeon.py`, an interactive text adventure played in the terminal. The world comes from a data file, `world.json` (put one in start/, so the folder starts with it), with rooms, exits, items and one locked door that needs a key. The game reads commands with `input()` until `quit`, a win, or a loss.

**The interface to specify exactly in spec.md:**
- Commands: `look`, `go <dir>`, `take <item>`, `drop <item>`, `inventory`, `use <item>` (the key on the locked door), `save <name>` and `load <name>` (JSON files beside the world file), `quit`. Unknown commands get `I don't understand that.`
- The exact text for each response, the prompt (`> `), the win message when Sam reaches the treasure room, and the loss when the torch runs out after N moves (state that N is in world.json).
- `python dungeon.py [--world PATH]` with a default world.json; exit code 0 on quit or win, 1 on loss.

**Tests:** drive the game through subprocess with prepared stdin (`input` text) and compare the transcript line for line. Cover every command, the locked door, save then load restoring the state exactly, a missing save, an unknown direction, the torch running out, and a custom world file the tests write (so a hard-coded world fails).

**needs:** quest/guild-play, quest/file-json, quest/class-dataclass (check that the ids exist in quest.md).
Tier: `games`. About 250–400 lines in the reference solution.
