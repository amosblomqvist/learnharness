You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package G1: Book III, part 1, functions as values (scripts/quest/ch7.py)

Create `scripts/quest/ch7.py`. It declares these chapters (ids exactly as here), with about 18 write lessons and 3 prediction lessons. Prefix every lesson id with `g1-`.

```python
CHAPTERS = [
    ("tuples", "Tuples and unpacking", "Fixed records, unpacking, and functions that return several things."),
    ("functional", "Functions as values", "Pass functions around: keys, lambdas, map, filter, any and all."),
    ("recursion", "Recursion", "Solve a problem with a smaller copy of itself."),
]
```

## Lessons to write (in this order)

**tuples**
1. g1-tuple-record: a tuple as a fixed record, `(name, hp, level)`; index into it (docs: tutorial "Tuples and sequences").
2. g1-unpack: unpacking `name, hp, level = hero`; the error when the counts don't match (fix a starter that crashes).
3. g1-star-unpack: `first, *rest = queue` and `*body, last`.
4. g1-tuple-immutable: fix code that tries to change a tuple; build a new tuple instead.
5. g1-enumerate-unpack: loops that unpack pairs, `for name, hp in party:`.
6. g1-namedtuple-lite: return several values and unpack at the call site (a function returning `(dealt, taken)` from a fight round).
7. Predict: g1-quiz-tuple: a one-item tuple without the comma, `("sword")` vs `("sword",)`.

**functional**
8. g1-fn-as-value: store functions in a dict `{"heal": heal, "hit": hit}` and dispatch a command by name.
9. g1-sort-key: `sorted(heroes, key=...)` with a named function, then `min`/`max` with `key`.
10. g1-lambda: the same with `lambda`; checks `node:Lambda`.
11. g1-map-filter: `map` and `filter` (and the equivalent comprehension in the wrong answers).
12. g1-any-all: `any`/`all` over a generator of conditions ("is anyone poisoned?", "is everyone ready?").
13. g1-higher-order: a function that takes a function, `apply_n(f, x, n)`.
14. g1-return-function: a function that returns a function, `make_multiplier(n)`.
15. Predict: g1-quiz-key: `sorted` with `key=len` and ties (sorting is stable).
16. Quest (`project=True`): g1-q-auction: rank bids with a key function and ties broken by arrival order; fuzz it.

**recursion**
17. g1-countdown: a recursive countdown that prints (output lesson); forbid `For`/`While` with checks.
18. g1-sum-nested: total the gold in nested lists of chests (`[3, [4, [5]], 1]`), recursively.
19. g1-depth: how deep a nested dict of dungeon rooms goes.
20. g1-flood: count the rooms reachable from the entrance in a dict graph, without visiting a room twice (recursion and a visited set).
21. Predict: g1-quiz-recursion: a small recursive function's output, with the call order showing.

Docs keys you'll probably add to DOCS: tutorial "Tuples and sequences", library "sorted", HOWTO "Sorting" (key functions), reference "Lambdas", library "map"/"filter"/"any"/"all", tutorial "Defining functions" (recursion has no tutorial page: link "Defining functions" or the FAQ entry on recursion limits).

Every lesson needs a known-wrong answer. Fuzz every pure function.
