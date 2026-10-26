You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package W7: Workshop project P07, the guild API with FastAPI (scripts/workshop/p07-guild-api-fastapi/), local toolchain

Create one new folder under scripts/workshop/ (named below) by copying the structure of scripts/workshop/p01-quest-log/. Then `npm run build:workshop && npm run check:study workshop`.

This project follows the freeCodeCamp course "Python API Development – Comprehensive Course for Beginners" (Sanjeev Thiyagarajan, https://www.youtube.com/watch?v=0sOvCWFmrtA), with the Guild's names: posts → quests, users → heroes, votes → joins. The learner watches the course and builds the Guild version alongside it.

`meta.json` must set `"local": true`: the tests need FastAPI, so they run outside Tutor's sandbox with the project's own `.venv` (the harness uses PROJECT_ROOT/.venv/bin/python). A plain check:study skips local projects. Validate yours with:

```bash
npm run build:workshop && TUTOR_CHECK_LOCAL=1 npm run check:study workshop/p07-guild-api-fastapi
```

That copies start/ plus solution/ into a temp folder, runs `uv sync` there (so start/pyproject.toml must declare every dependency, including httpx for TestClient), and runs the hidden tests with that folder's `.venv`. Paste its last lines into your report.

**What the learner builds:** a FastAPI app (`app/main.py` with routers for quests, heroes, auth and joins), SQLAlchemy 2.0 models with SQLite by default (`DATABASE_URL` from the environment; Postgres works too), Pydantic v2 schemas, password hashing and JWT login (`POST /login` returning a bearer token; protected routes), the same endpoints and status codes as W6 plus auth, and Alembic is optional (say so in the spec). `pyproject.toml` with uv.

**Tests:** use `fastapi.testclient.TestClient` (it needs httpx: list it as a dependency in the spec), a fresh SQLite file per test under TEST_TMP via `DATABASE_URL`, and cover auth (401 without a token, 403 on someone else's quest), validation errors (422), every endpoint and the joins.

**needs:** p06-guild-api is a project in this module, so use `p06-guild-api` (no prefix); plus the G4 mocking lessons (verify the ids).
Tier: `web`. Add a `start/pyproject.toml` with the dependencies so `uv sync` works from the start.
