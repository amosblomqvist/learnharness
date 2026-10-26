You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package G4: Book III, part 4, testing like you mean it (scripts/quest/ch10.py)

Create `scripts/quest/ch10.py`, about 12 write lessons plus 2 predictions, prefix `g4-`. The core Testing chapter (`testing` in ch5.py) already has "write tests that catch planted bugs" lessons: read ch5.py's `mutation_tests` and `HARNESS` and reuse the idea (copy the helper into your file; don't import it from ch5).

```python
CHAPTERS = [
    ("unittest", "Tests with unittest", "The standard library's test framework: TestCase, assertions, setUp."),
    ("mocking", "Fakes and mocks", "Test code that talks to files, clocks and dice by replacing them."),
]
```

The learner writes tests; your tests run the learner's tests against the real code (must pass) and against planted bugs (each must be caught).

**unittest**: g4-testcase (a `TestCase` subclass with `assertEqual`; your tests run it with `unittest.TextTestRunner` on a StringIO stream and read the result), g4-assert-raises (`with self.assertRaises(ValueError):`), g4-setup (`setUp` building a fresh party per test; a planted bug only shows when tests share state), g4-subtest (`subTest` over a table of cases), g4-float-asserts (`assertAlmostEqual` for gold split by 3), predict g4-quiz-assert-order.

**mocking**: g4-inject (refactor a function so the dice roll is a parameter, then test it with a fixed roll), g4-mock-random (`unittest.mock.patch("random.randint")` around a crit function), g4-mock-time (a cooldown that uses `time.time()`: patch it), g4-tmp-files (test a save/load pair with `tempfile.TemporaryDirectory`), g4-mock-assert-called (check that `save()` was called once with the right data, via a Mock), g4-q-tested-shop (project=True: write a whole test class for the shop from Practice, caught against 5 planted bugs), predict g4-quiz-patch-target (patching where a name is used, not where it's defined).

Docs: library unittest (basic example, assert methods, setUp), unittest.mock (patch, "where to patch"), tempfile.

Every lesson needs known-wrong answers: a test that asserts too little (lets a planted bug through), a test that fails on the real code, a mock patched in the wrong place.
