# Sources for the next modules

Checked on 2026-10-04: every link below opened, with the title shown. These become the lessons' `source:` lines ("Go deeper"). Give videos a title like `Video: … (channel, length)`.

## Databases and SQL

| Kind | Source | Why |
|---|---|---|
| Docs | [PostgreSQL tutorial](https://www.postgresql.org/docs/current/tutorial.html) (PostgreSQL 18) | The official start: tables, queries, joins, transactions |
| Book (free) | [Use The Index, Luke](https://use-the-index-luke.com/) | How indexes really work, and why queries are slow |
| Docs | [SQLAlchemy 2.0 Unified Tutorial](https://docs.sqlalchemy.org/en/20/tutorial/index.html) | SQL from Python, Core and ORM |
| Practice | [SQLBolt](https://sqlbolt.com/) | Interactive SQL lessons in the browser |
| Practice | [PostgreSQL Exercises](https://pgexercises.com/) | Graded questions on one dataset, joins to window functions |
| Video | [Learn PostgreSQL Tutorial – Full Course for Beginners](https://www.youtube.com/watch?v=qw--VYLpxG4) (freeCodeCamp, Amigoscode, ~4 h) | Hands-on Postgres from zero |
| Video | [Database Indexing Explained (with PostgreSQL)](https://www.youtube.com/watch?v=-qNSXK7s7_w) (Hussein Nasser) | Watching `EXPLAIN` change as an index appears |
| Course | [CMU 15-445/645 Intro to Database Systems, Fall 2024](https://15445.courses.cs.cmu.edu/fall2024/) (Andy Pavlo, lectures on YouTube) | How databases work inside: storage, indexes, transactions |
| VS Code | [PostgreSQL extension (Microsoft)](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql) | Run queries, explore schemas, see query plans |

## HTTP and web APIs

| Kind | Source | Why |
|---|---|---|
| Docs | [MDN: Overview of HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview) | The best first read on requests, responses, headers |
| Spec | [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110) | The source of truth for methods and status codes (a reference) |
| Docs | [FastAPI tutorial](https://fastapi.tiangolo.com/tutorial/) | Building APIs in Python: validation, auth, CORS, databases |
| Guide | [Zalando RESTful API Guidelines](https://opensource.zalando.com/restful-api-guidelines/) | How a large company designs APIs: naming, errors, pagination, versioning |
| Security | [OWASP API Security Top 10 (2023)](https://api-security.owasp.org/editions/2023/en/0x11-t10) | The mistakes that get APIs breached |
| Video | [Hyper Text Transfer Protocol Crash Course – HTTP 1.0, 1.1, HTTP/2, HTTP/3](https://www.youtube.com/watch?v=0OrmKCB0UrQ) (Hussein Nasser, 46 min) | How HTTP evolved and why |
| Video | [Python API Development – Comprehensive Course for Beginners](https://www.youtube.com/watch?v=0sOvCWFmrtA) (freeCodeCamp, Sanjeev Thiyagarajan, 19 h) | A full FastAPI build with Postgres, SQLAlchemy, auth, pytest, Docker and GitHub Actions: a capstone across all five topics |

## Testing

| Kind | Source | Why |
|---|---|---|
| Docs | [pytest: Get started](https://docs.pytest.org/en/stable/getting-started.html) and [fixtures](https://docs.pytest.org/en/stable/how-to/fixtures.html) | Python's standard test runner |
| Docs | [Vitest guide](https://vitest.dev/guide/) (Vitest 5) | Testing TypeScript |
| Article | [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) (Ham Vocke, martinfowler.com) | Which kinds of tests, and how many of each |
| Book chapter (free) | [Software Engineering at Google, ch. 11: Testing Overview](https://abseil.io/resources/swe-book/html/ch11.html) | How testing works at scale: test sizes, flakiness, the "Beyoncé rule" |
| Talk | [Write tests. Not too many. Mostly integration.](https://kentcdodds.com/talks/write-tests-not-too-many-mostly-integration) (Kent C. Dodds) | The counterpoint: confidence over coverage |
| VS Code | [Python testing in VS Code](https://code.visualstudio.com/docs/python/testing) | Running and debugging pytest from the editor |
| Video | [getting started with pytest (beginner – intermediate)](https://www.youtube.com/watch?v=mzlH8lp4ISA) (anthony writes code, a pytest core developer) | pytest from someone who maintains it |
| Video | [Vitest Crash Course](https://www.youtube.com/watch?v=qtm3wjM2eGI) (Web Dev Simplified) | Vitest's main features in one sitting |

## CI/CD

| Kind | Source | Why |
|---|---|---|
| Docs | [Understanding GitHub Actions](https://docs.github.com/en/actions/get-started/understand-github-actions) | Workflows, events, jobs, actions, runners |
| Article | [Continuous Integration](https://martinfowler.com/articles/continuousIntegration.html) (Martin Fowler, updated January 2024) | What CI really means, and why feature branches aren't it |
| Research | [DORA's software delivery performance metrics](https://dora.dev/guides/dora-metrics-four-keys/) | How teams measure delivery: lead time, deploy frequency, failure rate, recovery |
| Video | [GitHub Actions Tutorial – Basic Concepts and CI/CD Pipeline with Docker](https://www.youtube.com/watch?v=R8_veQiYBjI) (TechWorld with Nana) | A first pipeline, built step by step |
| Video | [Top 10 Rules For Continuous Integration](https://www.youtube.com/watch?v=Xl62gQpAl1w) (Dave Farley, Continuous Delivery) | The discipline behind the tools |

## System design

| Kind | Source | Why |
|---|---|---|
| Guide | [The System Design Primer](https://github.com/donnemartin/system-design-primer) | The classic free overview, with exercises and Anki cards |
| Book (free) | [Site Reliability Engineering](https://sre.google/sre-book/table-of-contents/) (Google) | Running systems: SLOs, monitoring, incidents, load balancing |
| Docs | [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html) | The six pillars, and the review questions AWS uses (useful for the SAA exam too) |
| Book (paid) | *Designing Data-Intensive Applications* (Martin Kleppmann) | The deep one: replication, partitioning, consistency |
| Video | [System Design Concepts Course and Interview Prep](https://www.youtube.com/watch?v=F2FmTdLtb_4) (freeCodeCamp, Hayk Simonyan, ~54 min) | The building blocks in one hour |
| Video | [System Design Interview: A Step-By-Step Guide](https://www.youtube.com/watch?v=i7twT3x5yv8) (ByteByteGo) | A method for working through any design question |
