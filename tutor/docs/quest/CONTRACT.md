# The contract for Fantasy Quest work packages

Read this whole file before writing anything. Every package brief in `packages/` assumes it.

The repo is `~/Desktop/tutor`, an Electron study app. Courses are Markdown modules in `src/study/content/`, but **Fantasy Quest and the Workshop are generated**: never edit `quest.md` or `workshop.md` by hand. Fantasy Quest lessons come from `scripts/quest/chN.py`; Workshop projects come from folders in `scripts/workshop/`.

## Rules for every package

1. **Touch only your own file or folder.** A G package creates exactly one `scripts/quest/chN.py`. A W package creates exactly one `scripts/workshop/pNN-name/` folder. Don't edit `lib.py`, `build.py`, other chapters, app code, or this document. If you think the framework needs a change, stop and say so in your report.
2. **No explanatory prose.** The learner reads the official, human-written docs, linked from every lesson; Tutor never shows AI-written explanations. A lesson is: a one-line **story** beat in the Fantasy Quest world, an **assignment** that says what to build and what the console must show, and a **doc link**. Don't explain the concept ("a generator is a function that…"); name it and link it. A hint may say *what to type* ("`yield` each item"), not teach the theory.
3. **Docs links are official.** docs.python.org (tutorial, library, reference, HOWTOs) first; for a third-party tool, its own official docs (fastapi.tiangolo.com, docs.sqlalchemy.org, docs.pytest.org, docs.astral.sh/uv). No blogs, no Real Python, no videos as the lesson's source.
4. **The world.** Sam (the hero), Mira (mage), Bran (fighter), the Guild, quests, gold, loot, dungeons, dragons. Keep it light and short: one sentence of story.
5. **Every task is checked, and every check is proven.** The validation commands below must end in `All good`. That proves each solution passes, each starter fails, each known-wrong answer fails, and each prediction is exact.
6. **Report** at the end: what you added (ids and titles), the validation output's last line, and anything you were unsure about.

## The sandbox your tests run in

- Python 3.14 standard library only. No pytest, no third-party packages, **no network**.
- About 8 seconds per run.
- The learner's file is `solution.py`. Your tests are `test_solution.py` in the same scratch folder, and the working directory is that folder: a test may create files there.
- Tests are plain functions named `test_*` with `assert`. A failing assert's message is shown to the learner, so write messages a learner can act on.

## Fantasy Quest lessons (G packages)

Your file starts like this:

```python
"""Book III, part N: <topic>. <one line on what the chapter drills>."""
from lib import L, Q, out, dedent, DOCS

T = "# Don't touch below this line\n"

# New doc links go into DOCS here, never in lib.py.
DOCS["genexpr"] = ("Python reference: Generator expressions", "https://docs.python.org/3/reference/expressions.html#generator-expressions")

# Your chapters, in order. build.py puts them after the core chapters, before the closing Quiz.
CHAPTERS = [
    ("generators", "Generators", "Make values one at a time, only when they're asked for."),
]
```

Then lessons, in teaching order. Lesson and chapter ids must be **unique across the whole course**: prefix yours (`g2-yield`, not `yield`).

### A write lesson: `L(...)`

```python
L(chapter, id, title, doc_key, story, assign, starter, solution, hint,
  expect=None,      # output lesson: the exact console text, compared line for line
  tests=None,       # function lesson: test code (it may use every helper below)
  checks=[...],     # code-shape rules, see below
  fuzz=None,        # (function_name, "def ref(...): ...", "def gen(r): return [args...]")
  wrong=[(why, code), ...],   # at least one known-wrong answer; check:study proves each fails
  extra=None,       # more test code, added to an output lesson's tests
  project=False)    # True for a bigger "Quest:" lesson (worth more XP)
```

- **Output lessons** (`expect=`): the starter ends with `T` and protected lines that print. The tests check that the protected lines are unchanged, so the learner can't just print the answer.
- **Function lessons** (`tests=`): import from `solution` and assert. Cover the edges (empty input, 0, one item, ties, negative numbers, case).
- **`fuzz`** for every pure function: `ref` is a correct reference and `gen(r)` returns an argument list built with `random.Random` `r`. The test compares the learner's function with `ref` on 300 inputs. The arguments are deep-copied first, so mutation can't leak.
- **`checks`** force the concept the lesson is about, by reading the code's syntax tree, so comments and strings can't fake them. Each one is a string, or a `(string, message)` pair:
  - `"node:For"`, `"node:While"`, `"node:ListComp"`, `"node:GeneratorExp"`, `"node:Yield"`, `"node:Lambda"`, `"node:With"`, `"node:Try"`, `"node:ClassDef"`, … (any `ast` class name)
  - `"call:sorted"`: calls that function or method
  - `"tok:**"`: that operator or keyword appears as code
  - `"def:name"`, `"name:x"`, `"kw:key"`, `"fname:hero"` (used inside an f-string)
  - prefix `!` to forbid one, e.g. `"!call:sum"`
- **`wrong`**: at least one per lesson, two or more when the lesson has a classic mistake. Wrong answers must be *plausible*: the off-by-one, the shared list, `>` where `>=` was needed, a hard-coded example, printing instead of returning, the loop the lesson said not to use.
- Helpers your test code can use: `SRC` (the learner's source), `TREE`/`NODES` (its syntax tree), `has_token`, `has_node`, `calls`, `defines`, `uses_name`, `keyword_arg`, `fstring_uses`, `printed(fn, *args)` (what a call prints), `shown()` (what the whole file prints).
- The **starter** must fail. Usually it's the function signature with a wrong body (`return None`, `return []`), or buggy code to fix.
- Assignments are short: what to write, an example call and result, and the exact output in a ```text block for output lessons.

### A prediction lesson: `Q(...)`

```python
Q(chapter, id, title, doc_key, story, code, answer, why)
```

The learner reads `code` and types exactly what it prints. `answer` is checked against a real run. `why` is one or two sentences saying what happens, not a lecture. Predictions also become spaced-review cards, so put two or three in every chapter, on the traps.

## Workshop projects (W packages)

One folder, `scripts/workshop/pNN-name/`. Copy `p01-quest-log/` as your template and read it first.

```
meta.json   {"id": "pNN-name", "title": "Project: ...", "tier": "tools|games|data|packages|web|ship",
             "needs": ["quest/<lesson id>", ...], "minutes": 240, "story": "one line",
             "folder": "kebab-name", "sources": [[title, url], ...], "hint": "...", "local": false}
spec.md     the spec the learner builds from: file names, commands, functions, exact output,
            exit codes, file formats. It's the contract the tests check, so be exact.
start/      files the folder starts with. Usually empty (README.md is generated from spec.md);
            data files the program reads go here.
tests/      hidden acceptance tests, test_*.py: plain functions with assert. The project folder is
            on sys.path and in os.environ["PROJECT_ROOT"]; it's read-only. Write scratch files
            under os.environ["TEST_TMP"]. Run programs with subprocess and sys.executable.
solution/   a reference solution, in the style a good teacher would write: small functions,
            standard library only (unless local), readable names.
```

- **`needs`**: the Fantasy Quest lesson ids that teach everything the project uses. Look them up in `src/study/content/quest.md` (`id:` lines). If the lessons don't exist yet, use the ids from the G package brief and say so in your report.
- **Blank page:** don't give the learner skeleton code. The spec fixes the interface (names, commands, formats); everything inside is theirs.
- **Tests check behaviour, not implementation:** the output, exit codes, files written, return values. Then add one test per robustness rule in the spec (bad input, missing file, empty data).
- **Size:** a project's reference solution is usually 120–400 lines. The tests: 12–30 functions.
- **`local: true`** only for projects that need third-party packages (the FastAPI project). Their tests run outside the sandbox with the project's own `.venv` and are skipped by check:study, so test the reference solution yourself and say how in your report.
- A line in any file must not start with `task:`, `file:`, `test:`, `solution:`, `hint:` (or another lesson field name) followed by text: build.py refuses it.

## Validation

```bash
cd ~/Desktop/tutor
npm run build:quest          # G packages: regenerates src/study/content/quest.md
npm run build:workshop       # W packages: regenerates src/study/content/workshop.md
npm run check:study quest    # or: workshop, or quest/<lesson id> for one lesson
```

Run check:study for one lesson while you work (`npm run check:study quest/g2-yield`), and the whole module at the end. If check:study can't start `sandbox-exec` in your environment, say so in your report: the owner will run it.
