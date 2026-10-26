You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package W8: Workshop project P08, a tool for your own machine (scripts/workshop/p08-backup-rotator/)

Create one new folder under scripts/workshop/ (named below) by copying the structure of scripts/workshop/p01-quest-log/. Then `npm run build:workshop && npm run check:study workshop`.

**What the learner builds:** `rotate.py`, a backup rotator they can really use, for example on their Linux lab or their Desktop projects. `rotate.py backup SOURCE DEST` writes a timestamped `.tar.gz` (tarfile) into DEST, named `<name>-YYYYmmdd-HHMMSS.tar.gz`. `rotate.py prune DEST --keep-daily 7 --keep-weekly 4 --keep-monthly 6` keeps the newest backup of each day/week/month inside those windows and deletes the rest. `--dry-run` prints what would happen. `rotate.py list DEST` lists backups with sizes. Configuration can come from a TOML file (tomllib) given with `--config`. Logging goes to stderr with levels, and `-v` raises the verbosity.

**The clock must be injectable:** the spec says `--now "2026-10-25T12:00:00"` overrides the current time, so the tests can check the pruning rules exactly. The tests create fake backup files with names across a year, run prune with --now, and assert exactly which survive. They also build a real backup of a small tree and check the archive contents, the dry-run deleting nothing, and errors (missing source: exit 1; bad config: exit 2).

**needs:** g3-pathlib-join, g3-timedelta, g3-argparse, g3-logging, g3-exit-codes, g1-sort-key (verify the ids).
Tier: `ship`.
