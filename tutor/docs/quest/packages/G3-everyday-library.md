You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package G3: Book III, part 3, the everyday library (scripts/quest/ch9.py)

Create `scripts/quest/ch9.py` with these chapters, about 24 write lessons plus 4 predictions. Prefix ids with `g3-`. The Workshop projects W3 (log scout), W5 (bestiary), W6 (guild API) and W8 (backup tool) depend on these lessons, so cover what's listed.

```python
CHAPTERS = [
    ("collections", "Collections", "Counter, defaultdict, deque and namedtuple: the right container for the job."),
    ("time", "Dates and times", "Timestamps, durations, and formatting dates for people."),
    ("paths", "Files and paths", "pathlib, folders, globbing, and reading CSV."),
    ("regex", "Regular expressions", "Find, extract and replace patterns in text."),
    ("cli", "Programs with a front door", "argparse, logging and exit codes."),
]
```

## Lessons

**collections**: g3-counter (most_common, ties), g3-defaultdict (group loot by monster), g3-deque (a turn queue with rotate and maxlen, a "last 3 messages" log), g3-namedtuple (a `Hit(attacker, target, damage)` record), g3-ordered-ops (Counter arithmetic: loot after trading), predict g3-quiz-counter.

**time**: g3-datetime-parse (`datetime.strptime` on "2026-10-24 21:15"), g3-timedelta (quest deadline: due date plus days, days left), g3-format (strftime for a ledger line), g3-compare-dates (sort log entries by time; the earliest and latest), g3-durations (total time played from session start/end pairs), predict g3-quiz-timedelta. Use fixed dates in the tests; never `datetime.now()` in a test without injecting it.

**paths**: g3-pathlib-join (build paths with `/`, `.name`, `.suffix`, `.stem`), g3-write-read-path (`Path.write_text`/`read_text` in the scratch folder), g3-glob (count `.sav` files in a folder the test creates), g3-mkdir (create nested save folders, `exist_ok`), g3-csv-read (`csv.DictReader` over a bestiary the test writes), g3-csv-write (`csv.DictWriter` writing a loot report), predict g3-quiz-path.

**regex**: g3-re-search (find a gold amount in a message), g3-re-findall (all damage numbers in a battle log), g3-re-groups (named groups to parse "Sam hits Goblin for 12"), g3-re-sub (redact the dragon's true name, case-insensitive), g3-re-validate (fullmatch for a hero name: letters only, 2–12 chars), g3-re-log-line (parse a full log line into a dict, or None when it doesn't match), predict g3-quiz-greedy (greedy versus non-greedy).

**cli**: g3-argparse (a `main(argv)` that parses `--level` and a positional name; the tests call `main([...])`), g3-exit-codes (`main` returns 0, 1 or 2; `sys.exit(main())` under `__main__`), g3-logging (log to a list handler or a StringIO; levels; no print), g3-stdin-loop (a program reading commands from `sys.stdin` until "quit": tests feed stdin through a subprocess or by patching `sys.stdin` with io.StringIO).

Docs: library pages for collections, datetime, pathlib, csv, re, argparse (and its HOWTO), logging (and its HOWTO), sys. HOWTO "Regular expression HOWTO" is a good link for the regex chapter.

Every lesson needs known-wrong answers. Fuzz the pure functions (Counter-based counts, regex parsers against a reference, date arithmetic).
