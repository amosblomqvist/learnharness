You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package G5: quizzes for every chapter (scripts/quest/ch11.py)

Fantasy Quest has 190 lessons, but only 19 prediction lessons, and predictions are what feed Tutor's spaced reviews. Create `scripts/quest/ch11.py` with **no CHAPTERS list**: your `Q(...)` lessons go into the existing chapters (they're added at the end of each chapter they name). Prefix ids with `g5-`.

Write **25 predictions**, at least one per existing chapter: intro, vars, funcs, scope, debug, computing, compare, loops, strings, lists, dicts, sets, errors, hints, testing, practice, classes, files, modules, guild, tuples, functional, recursion, iterators, decorators. Find each chapter's lessons in src/study/content/quest.md (`stage:` lines), and make each prediction about a trap in what that chapter taught:

- integer vs float division, `round` banker's rounding, string multiplication
- default argument evaluated once, keyword vs positional
- a local that shadows a global, `global` inside a function
- `is` vs `==` on small ints and strings: avoid this (it's implementation-specific). Use `==` vs identity of lists instead
- chained comparisons, `and`/`or` returning operands, not booleans
- `range` with a negative step, `break` inside nested loops
- `strip` with characters, `split` with no arguments vs `split(" ")`, slicing past the end
- `sort()` returns None, aliasing through `*` (`[[0]*3]*3`), `remove` removes the first match
- dict ordering, `get` with a default, iterating while deleting (a RuntimeError message: design it to catch and print the type)
- set ordering is not guaranteed: only print sorted results or sizes
- `finally` running after `return`, `except` order
- class attribute vs instance attribute, `__repr__` vs `__str__`
- `with open` writing then reading, `json` turning tuples into lists and int keys into strings
- `__name__` in a module vs a script

`why:` is one or two plain sentences on what happens. Every answer is checked against a real run, so the output must not depend on memory addresses, set order, dict order of sets, or the current time.
