# LearnHarness data skill tests

Run independently of the application, with Python 3.10+ and no dependencies:

```sh
python3 -B -m unittest discover -s tests/skills -v
```

These tests exercise the self-contained readers in `skills/learnharness/` against
small synthetic records and the native golden data in `tests/fixtures/golden-data/`.
They check preservation of learning evidence, graph selection/merging, unsupported
formats, path boundaries, and unchanged file bytes/mtimes. A portability test copies
the skill and fixture data outside the repository and invokes both output formats
from an unrelated working directory, checking that no cache or data files appear.

No real installed-user profile, provider keys, app server, LLM, or network is used.
The test command is intentionally separate from the app's Node test suite; the skill
has no app-runtime, release, or website integration.
