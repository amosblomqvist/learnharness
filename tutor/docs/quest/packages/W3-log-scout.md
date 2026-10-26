You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package W3: Workshop project P03, the log scout (scripts/workshop/p03-log-scout/)

Create one new folder under scripts/workshop/ (named below) by copying the structure of scripts/workshop/p01-quest-log/. Then `npm run build:workshop && npm run check:study workshop`.

**What the learner builds:** `logscout.py`, a CLI that analyses the Guild's server logs: a few thousand lines like `2026-10-24 21:15:03 WARN [gate] Goblin spotted near the east wall (x3)`. Put two realistic log files in start/logs/ (generate them deterministically with a seed and commit the result; include malformed lines).

**Commands to specify:** `summary` (counts per level, the busiest hour, malformed lines skipped), `top --by source|monster -n N` (Counter, ties alphabetical), `between START END` (lines in a datetime window, inclusive, in order), `grep PATTERN [--ignore-case]` (regex, printing matching lines), and `--json` on summary and top for machine-readable output. Reads every `*.log` in a folder given by `--logs` (default `logs/`), with pathlib. Exit code 2 for a bad pattern or date, with an `error: ` message on stderr.

**Tests:** subprocess runs against the provided logs and against small logs the tests write, so hard-coded answers fail. Cover malformed lines, empty folders, ties, the inclusive time window, invalid regexes and the JSON shapes.

**needs:** the G3 lessons for collections, time, paths, regex and cli (the ids in G3's brief: g3-counter, g3-datetime-parse, g3-glob, g3-re-groups, g3-argparse, g3-exit-codes). They may not exist yet: use those ids and say so in your report.
Tier: `data`.
