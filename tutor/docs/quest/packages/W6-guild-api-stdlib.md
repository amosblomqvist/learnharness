You're working in the repository at ~/Desktop/tutor (an Electron study app). Before writing anything, read these in full:

1. docs/quest/CONTRACT.md: the rules, the lesson API, the sandbox, and how to validate. They are not optional.
2. docs/quest/PLAN.md: where this package fits.
3. For style, read scripts/quest/ch2.py and scripts/quest/ch4.py (lessons), scripts/quest/lib.py (the generator; read-only for you), and the last chapter file, scripts/quest/ch6.py. For projects, read scripts/workshop/p01-quest-log/ completely.

Work in small steps: write a few lessons, run `npm run build:quest && npm run check:study quest/<id>` on them, fix, continue. Finish with the full validation from CONTRACT.md and the report it asks for. Do not commit.

---

# Package W6: Workshop project P06, the guild API with the standard library (scripts/workshop/p06-guild-api/)

Create one new folder under scripts/workshop/ (named below) by copying the structure of scripts/workshop/p01-quest-log/. Then `npm run build:workshop && npm run check:study workshop`.

**What the learner builds:** a JSON HTTP API for the Guild's quest board, as a **WSGI application** (`app(environ, start_response)` in `guild_api.py`) over **sqlite3**, using only the standard library. They can serve it locally with `wsgiref.simple_server` (put it under `__main__`), but the tests call the WSGI app directly (the sandbox has no network), with a tiny client helper in the tests that builds environ dicts.

**The API to specify:** `GET /quests` (filter by `?status=open|done`, pagination with `limit` and `offset`), `POST /quests` (validate the JSON body; 400 with an error message on bad input), `GET /quests/<id>` (404), `PATCH /quests/<id>` (partial update), `DELETE /quests/<id>`, `POST /heroes` and `POST /quests/<id>/join` (a hero joins a party: 409 if already in it), `GET /heroes/<id>/quests`. Status codes, headers (`Content-Type: application/json`) and the JSON shapes, exactly. The database path comes from the `GUILD_DB` environment variable (the tests point it at TEST_TMP). The schema is created on first use, and foreign keys are on.

This is deliberately the same API as W7 (FastAPI), so the learner builds it once by hand and once with a framework, following the freeCodeCamp "Python API Development" course's structure (posts → quests, users → heroes, votes → joins).

**needs:** quest/file-json, quest/class-dataclass, g3-re-validate, g4-testcase (verify the ids in quest.md; the g3/g4 ones come from packages G3 and G4).
Tier: `web`.
