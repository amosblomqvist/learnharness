You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package G2: Book III, part 2, iterators, generators, closures and decorators (scripts/quest/ch8.py)

Create `scripts/quest/ch8.py` with these chapters and about 18 write lessons plus 3 predictions. Prefix ids with `g2-`.

```python
CHAPTERS = [
    ("iterators", "Iterators and generators", "Make values one at a time, only when someone asks."),
    ("decorators", "Closures and decorators", "Functions that remember, and functions that wrap functions."),
]
```

## Lessons (in this order)

**iterators**
1. g2-iter-next: `iter()` and `next()` by hand over a list of rooms; `StopIteration` (catch it, or use next's default).
2. g2-yield: a generator `def patrol(rooms): yield ...`; checks `node:Yield`.
3. g2-genexpr: a generator expression passed straight to `sum`/`max`; checks `node:GeneratorExp`, forbid `ListComp`.
4. g2-infinite: an endless generator (`turn_order(heroes)` cycling forever) and taking the first n with `itertools.islice`.
5. g2-lazy: a generator that reads "lines" lazily and stops early; the tests prove it is lazy (they pass an iterator that raises if consumed past what's needed).
6. g2-yield-from: flatten nested dungeon levels with `yield from`.
7. g2-pipeline: chain generators: parse → filter → transform a stream of battle-log lines.
8. g2-enumerate-zip-lazy: `zip` and `enumerate` over generators; zip stops at the shortest.
9. g2-itertools: `itertools.chain`, `groupby` (sorted first!), `accumulate` for running gold totals.
10. Predict: g2-quiz-exhausted: a generator iterated twice gives nothing the second time.
11. Quest (project=True): g2-q-spawner: a wave generator for monsters with escalating counts and a cap; tests check laziness and the sequence.

**decorators**
12. g2-closure: `make_counter()` returning a function that counts calls; `nonlocal`.
13. g2-closure-late-binding: fix the classic loop-closure bug (`lambdas in a loop all return the last value`).
14. g2-decorator-basic: `@shout` uppercases what a function returns.
15. g2-decorator-args: a decorator that passes `*args, **kwargs` through and logs calls to a list.
16. g2-wraps: keep `__name__` and `__doc__` with `functools.wraps`; tests check them.
17. g2-decorator-factory: `@retry(times=3)`, a decorator with arguments, around a flaky function the tests control.
18. g2-cache: `functools.cache` (or lru_cache) on a slow recursive `paths(n)`; the tests count calls.
19. Predict: g2-quiz-decorator-order: two stacked decorators and the order their wrappers run.
20. Predict: g2-quiz-nonlocal: a closure that rebinds without `nonlocal`, so it raises UnboundLocalError (the answer is what's printed before the error, or design it to print a caught message).

Docs: tutorial "Iterators" and "Generators" and "Generator expressions", library itertools, functools (wraps, cache), reference "nonlocal", glossary "decorator", PEP 318 is not a doc, so link the glossary and the reference "Function definitions".

Remember: the starter must fail and every lesson has known-wrong answers (for example, a list where a generator was required, so the laziness test fails).
