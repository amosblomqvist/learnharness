# Fantasy Quest: the plan to "proficient enough to build things"

**Goal:** take Fantasy Quest (the game-style Python course) from a drill book to a complete first Python course, about **40–45%** of full proficiency on its own. Full proficiency means you can start from a blank folder and build, test, debug and ship a real program of a few thousand lines.

**How:** a lot more code written by you, from nothing. Every topic is a short story beat, an assignment and a checked coding task (no AI-written explanations: the reading is the official Python docs each lesson links to). Finished tasks come back to be **rewritten from memory** in a blank editor. Then **projects** are built in real folders, in your own editor, checked by hidden acceptance tests.

## Where it stands (October 2026)

| Piece | Status |
|---|---|
| Book I, lessons 1–132: intro to testing and practice quests, 17 chapters | done, hardened (AST checks, protected lines, fuzzing, known-wrong answers) |
| Book II: classes, files, modules, the Guild game (16 lessons) | done (DeepSeek), checked |
| Blank-file mode: every finished Fantasy Quest task comes back as a spaced review to rewrite from nothing | done (app) |
| Input for Run: programs that call `input()` read lines from the console's Input tab | done (app) |
| Project steps: a spec, a real folder (`~/Desktop/projects/quest-projects/<name>`), Open in PyCharm, hidden acceptance tests, a reference solution | done (app) |
| Workshop module, projects P01 (quest log CLI) and P02 (the dungeon) | done, checked |
| Book III: functions as values (G1), iterators/generators/decorators (G2) | done, checked |
| Book III: the everyday library, testing | **work packages G3–G4** |
| More quiz/predict lessons in the early chapters | **work package G5** |
| Workshop projects P03–P08 | **work packages W3–W8** |

Score estimate (the rubric is in the chat log; roughly: core language 20, Python's model 15, standard library 10, testing 10, real projects 15, writing from a blank page 20, reading others' code 10):

| After | Estimate |
|---|---|
| now (Books I–II + G1–G2 + blank-file mode + P01–P02) | ~39% |
| + G3–G4 (the everyday library, testing) | ~42% |
| + Workshop P03–P05 | ~45% |
| + P06–P08 (web API, FastAPI, a tool of your own) | ~50% |

## Order

Lessons first, then the projects that use them. Each project's `needs` points at the Fantasy Quest lessons that teach what it uses, so Tutor keeps it locked until then.

```
G1 functions as values (done) ─┐
G2 iterators, generators, decorators (done) ─┼─> W4 package, W8 tool
G3 the everyday library ─┼─> W3 log scout, W5 bestiary, W6 WSGI API, W8 tool
G4 testing ─┘──> W4 package
G5 quizzes (any time)
W2 dungeon game (done)
W7 FastAPI API (after W6; follows the freeCodeCamp "Python API Development" course)
```

G1, G2 and W2 are done. G3–G5 each write one new file (`scripts/quest/ch9.py` … `ch11.py`) and nothing else, so they can run in parallel. W3–W8 each write one new folder under `scripts/workshop/`, so they can run in parallel too.

## Who does what

The remaining packages are written for **Grok 4.7** (the long, token-heavy content work) and **DeepSeek**. Suggested split:

| Package | Suggested | Size |
|---|---|---|
| G1 functions as values (ch7) | done | 21 lessons |
| G2 iterators, generators, closures, decorators (ch8) | done | 21 lessons |
| G3 the everyday library (ch9) | Grok | ~28 lessons |
| G4 testing like you mean it (ch10) | DeepSeek | ~12 lessons |
| G5 quizzes for chapters 1–26 (ch11) | DeepSeek | ~25 predict lessons |
| W2 the dungeon (interactive game) | done | 1 project |
| W3 the log scout (regex, collections, datetime) | DeepSeek | 1 project |
| W4 the armory (multi-module package + your own tests) | Grok | 1 project |
| W5 the bestiary (CSV to report) | DeepSeek | 1 project |
| W6 the guild API, standard library (WSGI + sqlite3) | Grok | 1 project |
| W7 the guild API, FastAPI (local toolchain) | Grok | 1 project |
| W8 a tool for your own machine (backup rotator) | Grok | 1 project |

Every brief is in `docs/quest/packages/`, and every one points at `docs/quest/CONTRACT.md` for the rules that apply to all of them.

## Running a package with Grok

From Terminal, in the repo:

```bash
cd ~/Desktop/tutor && grok "$(cat docs/quest/packages/G1-functions-as-values.md)"
```

Or headless, so it runs to the end without asking:

```bash
cd ~/Desktop/tutor && grok --prompt-file docs/quest/packages/G1-functions-as-values.md --permission-mode acceptEdits --max-turns 300
```

Add `-m <model id>` for Grok 4.7 if it isn't your default. For DeepSeek, open the same brief in whichever tool you use it through (aider, hermes) from `~/Desktop/tutor`.

## Accepting a package

A package is done when, in `~/Desktop/tutor`:

```bash
npm run build:quest && npm run build:workshop && npm run check:study quest workshop
```

ends with `All good`, and `git status` shows only the package's own new file or folder plus the regenerated `src/study/content/quest.md` / `workshop.md`. Then rebuild the app with `npm run app`. Read a few lessons in the app before accepting: the checker proves the tests work, not that the assignment reads well.
