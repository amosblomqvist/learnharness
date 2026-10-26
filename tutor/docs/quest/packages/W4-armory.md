You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package W4: Workshop project P04, the armory, a real package (scripts/workshop/p04-armory/)

Create one new folder under scripts/workshop/ (named below) by copying the structure of scripts/workshop/p01-quest-log/. Then `npm run build:workshop && npm run check:study workshop`.

**What the learner builds:** a multi-module package in src layout. The learner also writes their own tests: the hidden acceptance tests check that `tests/` exists with at least 8 test functions that pass. Your hidden test runs them with unittest discovery or by importing them; read how lab.ts `runProjectTests` works if it helps.

```
armory/
  pyproject.toml          (name, version, [project.scripts] armory = "armory.cli:main")
  src/armory/__init__.py  (exports Item, Inventory, craft)
  src/armory/items.py     (dataclass Item: name, kind, weight, value; validation)
  src/armory/inventory.py (Inventory with a weight limit: add, remove, total_value, heaviest, by_kind)
  src/armory/crafting.py  (recipes loaded from recipes.json via importlib.resources)
  src/armory/cli.py       (main(argv): list, add, craft; exit codes)
  tests/test_*.py         (the learner's own tests)
```

**Spec** the public API exactly (classes, methods, exceptions such as `TooHeavy` and `UnknownRecipe`) and the CLI. The hidden tests import `armory` from `src/` (the harness puts PROJECT_ROOT/src on sys.path) and exercise the API, run `python -m armory.cli` through subprocess with PYTHONPATH set to src, check that the learner's own tests exist and pass, and that pyproject.toml parses with tomllib and declares the script.

**needs:** the G2 decorator lessons and G4 unittest (g2-wraps, g4-testcase, g4-tmp-files), plus quest/class-dataclass, quest/class-inherit, quest/module-main.
Tier: `packages`.
