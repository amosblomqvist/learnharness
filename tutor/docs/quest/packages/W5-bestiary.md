You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package W5: Workshop project P05, the bestiary (scripts/workshop/p05-bestiary/)

Create one new folder under scripts/workshop/ (named below) by copying the structure of scripts/workshop/p01-quest-log/. Then `npm run build:workshop && npm run check:study workshop`.

**What the learner builds:** `bestiary.py`, which reads `monsters.csv` (put a 60–100 row file in start/: name, type, hp, attack, defense, xp, region, first_seen as an ISO date) and writes reports. Commands: `stats` (count, mean and median hp per type, using the statistics module), `danger -n N` (top N by a danger score the spec defines exactly), `region NAME` (a table formatted with f-string widths), `export --format json|csv --out PATH` (filtered by `--type` and `--since DATE`), `validate` (report bad rows with line numbers, exit 1 if any).

**Tests:** the bundled CSV plus small CSVs the tests write, covering bad rows, empty files, ties in the ranking, exact table formatting, round-tripping the export, and date filtering.

**needs:** g3-csv-read, g3-csv-write, g3-datetime-parse, g1-sort-key, quest/format-spec (verify the ids).
Tier: `data`.
