# SWE path coverage

Status of the expansion in `docs/swe-path-expansion-prompt.md`.

Legend: **thin** = a lesson exists but is still the short first draft. **deep** = body and practice meet the depth standard. **planned** = id reserved, not written yet.

Baseline before this pass (from the Markdown, not yet re-checked): 8 modules, 89 lessons.

| Module | Lessons before | Minutes before | Status |
|---|---:|---:|---|
| linux | 15 | 335 | quality pass done: 27 lessons, 180 steps, about 18 h. `npm run check:study linux` ends in "All good." Prose explains causes in place. Exercises do not copy the worked command. Predicts do not depend on block size, timing, or locale. Idempotent checks re-run the learner's script. `p-logs` is an 8-step project. |
| git | 6 | 150 | done: 14 lessons, 77 steps, about 10 h. `npm run check:study git` ends in "All good." Bodies explain causes in place. Exercises do not copy the worked command. Checks name a wrong answer that fails. `p-git` is a 6-step project on a local bare remote. |
| python | 17 | 475 | done: 66 lessons, 377 steps, about 50 h. `npm run check:study python` ends in "All good." Every farm id has its own lesson, including the async set. Sandbox stand-ins: no numpy, pandas, matplotlib, httpx, ruff, uv, mypy, or pytest binary. No sockets. SQLite is in-memory. Threads and asyncio are real. Overlap is a peak count, not a wall-clock limit. |
| typescript | 13 | 380 | done: 65 lessons, 387 steps, about 47 h. `npm run check:study typescript` ends in "All good." `npx tsc --noEmit -p tsconfig.json` and `npm run build` succeed. Every old course node is a lesson, in dependency order, with `p-ts` last. Zod, Next.js, Bun, Postgres, Docker, and a live model stay out of the exercises: schemas, HTTP, the database, and the chat loop are pure functions, and the store is in memory. |
| containers | 7 | 200 | not started |
| cloud | 9 | 280 | not started |
| terraform | 9 | 250 | not started |
| kubernetes | 13 | 390 | not started |
| sql | 0 | 0 | done: 14 lessons, 85 steps, about 10 h. `npm run check:study sql` ends in "All good." `npx tsc --noEmit -p tsconfig.json` and `npm run build` succeed. Exercises are Python `sqlite3` (in-memory, or a tempfile file when a second connection has to see a commit). No Postgres server and no psycopg. |

The containers, cloud, terraform, and kubernetes rows above are the baseline from before this pass. Those four files are already on disk and were not re-checked here.

`server.md` (Linux servers) is deep: 20 lessons, 103 steps, about 12 h. `npm run check:study server` ends in "All good." with the lab running, so the VM tasks were not skipped. Lesson ids and the original steps stay in place. Bodies now carry the mental model, a worked example, failure cases, work use, a decision table, and "You can now". New steps are appended. New shell tasks check machine state and name a wrong fix that fails. The existing "install jq" step now purges jq in setup first, because the lab image already has jq via `prometheus-node-exporter-collectors`.

## dev-essentials / shell → linux

| Old node | Lesson | Status |
|---|---|---|
| t-streams | linux/shell, linux/pipes | deep |
| shell-nav | linux/paths, linux/files, linux/perms, linux/editors | deep |
| pipes | linux/pipes, linux/grep, linux/textproc, linux/regex, linux/xargs | deep |
| processes | linux/processes, linux/env | deep |
| ssh | linux/ssh | deep |
| p-dotfiles | linux/p-dotfiles | deep |

Everyday lessons: editors, users, disks, archives, regex, xargs, cron, packages, proc, journal, net-tools. `reading` is about 1,100 words and `ssh` about 1,150, both complete for their idea. `p-logs` is about 1,600 words and eight steps: the sample report, a 404-only log, an empty log, a 499/500 boundary, an error-IP quiz, a tie broken by byte order, and a log whose busiest client is not the error client. Each of those shell steps re-runs `report.sh` after the log changes, so a hard-coded report fails. `ed` is taught, but the sandbox blocks its temporary file, so the exercise deletes a line with `sed`. `du` sizes are not used as answers, because the allocation unit depends on the machine. Idempotent steps (`install-line.sh`, `ensure-pager.sh`, `ensure-job.sh`, `setup.sh`, `harden.sh`) are run twice by the check. A comment in each of those steps names the wrong answer that was run against the check.

Everyday Linux added by the prompt (not separate old nodes): editors, users, disks, archives, cron, packages, journal, proc, net-tools. Each gets its own lesson.

## dev-essentials / sql → sql (new module)

| Old node | Lesson | Status |
|---|---|---|
| t-relations | sql/t-relations | deep |
| select | sql/select | deep |
| joins | sql/joins | deep |
| aggregates | sql/aggregates | deep |
| modeling | sql/modeling | deep |
| indexes | sql/indexes | deep |
| transactions | sql/transactions | deep |
| sql-app | sql/sql-app | deep |
| p-sql | sql/p-sql | deep |

Also deep, each its own lesson: nulls, windows, isolation, migrations, postgres. EXPLAIN and query plans are in indexes (SQLite `EXPLAIN QUERY PLAN`) and postgres (Postgres `EXPLAIN ANALYZE` runs the statement). `needs` starts at `python/sqlite`. One stage, `data`, ends with the project `p-sql`.

Sandbox: writes use stdlib `sqlite3` only. Foreign keys stay off until `PRAGMA foreign_keys = ON` on that connection. A second connection does not see an uncommitted file write. On `file:name?mode=memory&cache=shared` that second read raises `database table is locked` instead of returning the old commit (SQLite 3.53.3 on this machine). A Python read-modify-write still loses an update. The fix taught is `UPDATE ... SET col = col - ?`. Postgres facts are notes. No lesson opens a Postgres port.

## dev-essentials / web → web (new module)

| Old node | Lesson | Status |
|---|---|---|
| t-request | web/t-request | planned |
| http | web/http | planned |
| net | web/net | planned |
| rest | web/rest | planned |
| web-auth | web/web-auth | planned |
| web-security | web/web-security | planned |
| caching-web | web/caching-web | planned |

Also planned: authn vs authz, sessions vs JWT, OAuth/OIDC, CORS (with web-auth), OWASP (with web-security), rate limiting, idempotency, pagination, versioning.

## dev-essentials / dsa → dsa (new module, side track)

| Old node | Lesson | Status |
|---|---|---|
| t-bigo | dsa/t-bigo | planned |
| arrays-hash | dsa/arrays-hash | planned |
| stacks-queues | dsa/stacks-queues | planned |
| linked | dsa/linked | planned |
| recursion | dsa/recursion | planned |
| trees | dsa/trees | planned |
| graphs | dsa/graphs | planned |
| sort-search | dsa/sort-search | planned |
| dp | dsa/dp | planned |
| patterns | dsa/patterns | planned |
| p-interview | omitted: optional extra, 600 minutes of external interview practice, not a sandbox lesson | omitted |

## dev-essentials / design → system-design (new module)

| Old node | Lesson | Status |
|---|---|---|
| sd-basics | system-design/sd-basics | planned |
| sd-data | system-design/sd-data | planned |
| sd-async | system-design/sd-async | planned |
| sd-method | system-design/sd-method | planned |
| p-design | system-design/p-design | planned |

## git-docker / git → git

| Old node | Lesson | Status |
|---|---|---|
| t-snapshots | git/commits | deep |
| git-basics | git/commits, git/history | deep |
| branches | git/branches, git/stash | deep |
| merge-rebase | git/conflicts, git/rebase | deep (merge, conflict, rebase, interactive squash) |
| remotes | git/remotes | deep (fetch vs pull, rejected push, rebase onto a teammate) |
| github-flow | git/github-flow | deep (local bare remote; no `gh`, no network) |
| undo | git/undo | deep (amend, revert, reflog) |
| hygiene | git/hygiene | deep (attributes, pre-commit hook; signing is a quiz, no key is created) |
| p-git | git/p-git | deep (6 steps, about 70 min) |

Also deep, not separate old nodes: `git/bisect`, `git/cherry-pick`, `git/tags`. Bisect checks `refs/bisect/bad`, because Apple Git 2.54 leaves the worktree on the last commit the script tested. Interactive rebase uses `GIT_SEQUENCE_EDITOR` (no TTY). A squash with `GIT_EDITOR=true` keeps the first subject and leaves the second message in the body. Signing and gitleaks are not run: there is no signing key and no extra binary. A hook that greps the index is the stand-in. The basics stage ends with bisect. The module project is `p-git` on the team stage, one project, matching the old map.

## git-docker / docker → containers

| Old node | Lesson | Status |
|---|---|---|
| t-container | containers/what | thin |
| images | containers/images (new; small-images covers part) | planned |
| dockerfile | containers/dockerfile | thin |
| multistage | containers/small-images | thin |
| run-debug | containers/runtime | thin |
| compose | containers/compose | thin |
| registries | containers/registries | thin |
| image-security | containers/image-security (new; small-images covers part) | planned |
| p-containerize | containers/p-containerize | thin |

Also planned: namespaces/cgroups, buildkit, network modes, volumes, health/restart.

## python course → python

Farm ids that already exist stay. `numbers-strings` is numbers and strings. `tuples`, `sets`, and `collections` are their own lessons. `lists` and `dicts` are deep and no longer teach the peeled topics. The Python farm ids are all deep, including `p-downloader` and the async set through `p-crawler`. `p-orders` stays.

| Old node | Lesson | Status |
|---|---|---|
| t-names | python/t-names | deep |
| t-objects | python/t-objects | deep |
| run | python/run | deep |
| numbers-strings | python/numbers-strings | deep |
| control | python/control | deep |
| mutability | python/mutability | deep |
| p-quiz | python/p-quiz | deep |
| lists | python/lists | deep |
| tuples | python/tuples | deep |
| dicts | python/dicts | deep |
| sets | python/sets | deep |
| comprehensions | python/comprehensions | deep |
| text | python/text | deep |
| collections | python/collections | deep |
| p-gradebook | python/p-gradebook | deep |
| functions | python/functions | deep |
| args | python/args | deep |
| scope | python/scope | deep |
| first-class | python/first-class | deep |
| decorators | python/decorators | deep |
| modules | python/modules | deep |
| iteration | python/iteration | deep |
| generators | python/generators | deep |
| itertools | python/itertools | deep |
| exceptions | python/exceptions | deep |
| context-managers | python/context-managers | deep |
| files | python/files | deep |
| p-todo | python/p-todo | deep |
| classes | python/classes | deep |
| dataclasses | python/dataclasses | deep |
| inheritance | python/inheritance | deep |
| dunder | python/dunder | deep |
| properties | python/properties | deep |
| protocols | python/protocols | deep |
| match | python/match | deep |
| p-library | python/p-library | deep |
| type-hints | python/type-hints | deep |
| type-check | python/type-check | deep (no mypy or pyright binary; quizzes and a runtime predict) |
| generics-py | python/generics-py | deep (runtime cache; the type checker is not run) |
| uv-projects | python/uv-projects | deep (tomllib stand-in; uv is not run) |
| pytest | python/pytest | deep (plain asserts; pytest is not run) |
| ruff | python/ruff | deep (import-line stand-in; ruff is not run) |
| logging | python/logging | deep |
| p-package | python/p-package | deep (four independent functions; uv build is not run) |
| regex | python/regex | deep |
| datetime | python/datetime | deep |
| scripting | python/scripting | deep (argument lists and path checks; no real tar or git) |
| sqlite | python/sqlite | deep |
| http-client | python/http-client | deep (saved response dicts; no socket) |
| numpy | python/numpy | deep (list stand-in; numpy is not imported) |
| pandas | python/pandas | deep (group totals from dict rows; pandas is not imported) |
| plotting | python/plotting | deep (text bars; matplotlib is not imported) |
| p-report | python/p-report | deep (saved rows and an in-memory SQLite snapshot; no socket, cron, or pandas) |
| gil | python/gil | deep |
| futures | python/futures | deep |
| why-async | python/why-async | deep |
| p-downloader | python/p-downloader | deep (thread peak, retries, and a text progress line; no downloads and no timing assert) |

python-ai async stage (in this module, not Phase C):

| Old node | Lesson | Status |
|---|---|---|
| t-one-thread | python/t-one-thread | deep |
| coroutines | python/coroutines | deep |
| tasks | python/tasks | deep |
| cancellation | python/cancellation | deep |
| async-io | python/async-io | deep (async with and async for over saved chunks; no socket and no httpx) |
| backpressure | python/backpressure | deep |
| blocking | python/blocking | deep (`to_thread`; the blocking call is not left on the loop) |
| p-crawler | python/p-crawler | deep (cap, retry budget, timeout, and close; no socket and no speedup assert) |

Pydantic, FastAPI and the rest of python-ai stay Phase C (omitted until asked).

## typescript course + js-react / js → typescript

Kept ids: js-basics, js-async, erasure, everyday, unions, discriminated, functions-ts, generics, utility, boundary, errors-ts, testing-ts, p-ts. New ids sit in dependency order around them. `js-async` stays the promises lesson. `async-ts` is the later typing lesson. `modules-ts` is the TypeScript module lesson. `objects-ts` is the object-types lesson. Zod is a handwritten schema, with no `zod` import. Next.js, Bun, Postgres, Docker, and the AI SDK are explained in the lesson text. The exercises are pure functions: an in-memory store, a route function, and a chat turn that uppercases text. No socket, no Bun binary, and no live model.

| Old node | Lesson | Status |
|---|---|---|
| t-dynamic | typescript/t-dynamic | deep |
| js-basics | typescript/js-basics | deep |
| js-functions | typescript/js-functions | deep |
| this | typescript/this-binding | deep |
| prototypes | typescript/prototypes | deep |
| arrays-js | typescript/arrays-js | deep |
| modules-js | typescript/modules-js | deep |
| dom | typescript/dom | deep |
| event-loop | typescript/event-loop | deep. CommonJS `.ts` with no package.json drains nextTick, then microtasks, then timers. ESM evaluation drains microtasks first. `setTimeout(0)` versus `setImmediate` at the top of a script is not a predict. |
| promises | typescript/js-async | deep. The original print-order predict and `loadAll` stay first. `loadAll` still has its old wall-clock check. New steps do not. |
| fetch | typescript/fetch | deep. No socket. Status and JSON are pure functions. |
| js-debug | typescript/js-debug | deep |
| p-vanilla | typescript/p-vanilla | deep. State, render, and a JSON snapshot. No DOM and no network. |
| erasure | typescript/erasure | deep. Types are deleted before Node runs the file. `enum` and parameter properties are rejected by strip-only Node and by `erasableSyntaxOnly`. Needs `p-vanilla`. |
| type-set | typescript/type-set | deep. A type is a set of values. `unknown` is every value and must be narrowed. `any` turns checking off. `never` is empty. Needs `erasure`. |
| setup | typescript/setup | deep. `tsc --noEmit` checks and does not run. Node strips types and does not check. Needs `type-set`. |
| everyday | typescript/everyday | deep. Inference, literals, empty containers, optional and readonly fields, index reads as `T \| undefined`. Needs `setup`. The original `Invoice` steps stay first. |
| special | typescript/special | deep. `any` infects callers. `unknown` must be narrowed. `never` is empty. `void` means the caller ignores the return. Needs `everyday`. |
| objects | typescript/objects-ts | deep. Optional versus `undefined`, `readonly` is not `Object.freeze`, excess property checks, `type` versus `interface`. Needs `special`. |
| structural | typescript/structural | deep. Compatibility is by properties, not by the declared name. Needs `objects-ts`. |
| assignable | typescript/assignable | deep. Assignability is set inclusion. More required fields is a smaller set. Needs `structural`. |
| unions | typescript/unions | deep. `\|` is a choice, `&` is both at once. `string & number` is `never`. The original `len` quiz and `toCents` stay first. Needs `assignable`. |
| narrowing | typescript/narrowing | deep. `typeof`, equality, `in`, and `instanceof` shrink a union. Truthiness also drops `""` and `0`. Needs `unions`. |
| discriminated | typescript/discriminated | deep. A shared literal selects one member. The original `Payment` quiz and `Shape` / `area` stay first. Needs `narrowing`. |
| exhaustive | typescript/exhaustive | deep. The leftover of a finished switch is `never`, so a new member fails the build. Needs `discriminated`. |
| guards | typescript/guards | deep. `value is Word` narrows at the call. `satisfies` checks without widening literals. Needs `narrowing`. |
| classes | typescript/classes | deep. Private fields and an `as const` lane table. No `enum`. Needs `objects-ts`, `erasure`. |
| p-model | typescript/p-model | deep. Review cards, boxes, and grades. Needs `exhaustive`, `guards`, `classes`. |
| functions | typescript/functions-ts | deep. Call signatures. The original any/unknown quizzes stay first. Needs `unions`. |
| modules | typescript/modules-ts | deep. `import type` and a `.ts` specifier. Needs `erasure`, `objects-ts`. |
| p-cli | typescript/p-cli | deep. Parse a card line, score it, list due ids. No argv. Needs `setup`, `functions-ts`, `objects-ts`, `modules-ts`, `special`. |
| generics | typescript/generics | deep. The original `groupBy` write and `pluck` predict stay first. Needs `functions-ts`. |
| constraints | typescript/constraints | deep. `T extends { id: string }`. Needs `generics`. |
| keyof | typescript/keyof | deep. `get` follows the key. Needs `objects-ts`, `generics`. |
| conditional | typescript/conditional | deep. `UnwrapArray` with `infer`. Needs `constraints`, `unions`. |
| mapped | typescript/mapped | deep. A flags type built key by key. Needs `keyof`. |
| template | typescript/template | deep. Handler names from event names. Needs `conditional`, `mapped`. |
| utility | typescript/utility | deep. The original `Partial` quiz and user helpers stay first. Needs `mapped`, `conditional`. |
| strict-flags | typescript/strict-flags | deep. What `strict` turns on. Needs `special`, `narrowing`. |
| extra-flags | typescript/extra-flags | deep. `noUncheckedIndexedAccess`. `exactOptionalPropertyTypes` is off in this checker. Needs `strict-flags`. |
| tsconfig | typescript/tsconfig | deep. Read a config line by line. Needs `strict-flags`, `modules-ts`. |
| resolution | typescript/resolution | deep. How an import string becomes a file. Needs `modules-ts`, `tsconfig`. |
| p-migrate | typescript/p-migrate | deep. Strict helpers with no `any` and no `!`. Needs `extra-flags`, `tsconfig`, `p-cli`. |
| variance | typescript/variance | deep. Parameter positions reverse assignability. Needs `assignable`, `generics`, `strict-flags`. |
| p-emitter | typescript/p-emitter | deep. `on` and `emit` follow an event map. Needs `utility`, `template`, `variance`. |
| boundary | typescript/boundary | deep. The original `parseOrder` stays first. Needs `functions-ts`, `discriminated`. |
| zod | typescript/zod | deep. A handwritten user schema. No `zod` package. Needs `boundary`, `unions`, `objects-ts`. |
| async | typescript/async-ts | deep. A typed pair of promises. The predict prints without a top-level await. Needs `functions-ts`, `generics`. |
| errors | typescript/errors-ts | deep. The original `withdraw` stays first. Needs `boundary`, `async-ts`. |
| dts | typescript/dts | deep. A declaration for one untyped function. Needs `modules-ts`, `objects-ts`. |
| p-client | typescript/p-client | deep. Parse a post and load it through an injected getter. No network. Needs `zod`, `errors-ts`, `dts`. |
| node | typescript/node | deep. `requireEnv` takes a record. It does not read the real `process.env`. Needs `setup`, `resolution`, `classes`. |
| bun | typescript/bun | deep. Pick a test command from the host name. No Bun binary. Needs `node`. |
| testing | typescript/testing-ts | deep. The original `parseDuration` stays first. Needs `js-async`, `errors-ts`, `node`. |
| http | typescript/http | deep. `handle` returns status codes. No socket. Needs `node`, `zod`, `errors-ts`. |
| db | typescript/db | deep. An in-memory store. No Postgres. Needs `node`, `zod`. |
| p-service | typescript/p-service | deep. Stock plus `handleOrder`. No Docker. Needs `http`, `testing-ts`, `bun`, `db`. |
| nextjs | typescript/nextjs | deep. Path and id helpers. No `next` import. Needs `async-ts`, `modules-ts`. |
| server-client | typescript/server-client | deep. A wire object drops `passwordHash`. Needs `nextjs`, `erasure`. |
| ai-sdk | typescript/ai-sdk | deep. Collect deltas and parse an object. No model call. Needs `async-ts`, `zod`. |
| tools | typescript/tools | deep. `runTool` for add and done, with a cap. Needs `ai-sdk`, `generics`. |
| chat-ui | typescript/chat-ui | deep. `appendDelta` returns a new transcript. Needs `ai-sdk`, `server-client`. |
| mcp | typescript/mcp | deep. List tools and call echo. Needs `tools`, `zod`. |
| p-capstone | typescript/p-capstone | deep. A turn uppercases trimmed user text. No deploy and no live model. Needs `chat-ui`, `mcp`, `testing-ts`. |
| p-ts | typescript/p-ts | deep. The original `apply` stays. A `total` step is appended. Needs `testing-ts`, `utility`, `generics`. |

## aws-saa + aws-agents / base → cloud

Existing lessons stay. New lessons cover Organizations/SCPs, trust and STS, ECS/Fargate, Lambda and event-driven, Route 53/CloudFront/ALB/NLB/PrivateLink/TGW, KMS/Secrets Manager/WAF/GuardDuty, DynamoDB/Aurora/ElastiCache, the four SAA-C03 domains, and a 40-question saa-exam. aws-agents Bedrock/AgentCore stays Phase C.

## iac → terraform

Existing lessons stay. Add expressions, refactor (moved/import/removed), tf-test, envs, data sources, provider aliases, remote state between stacks, sensitive state. `cdk` stays one comparison lesson.

## k8s-agents → kubernetes

Existing lessons stay. Add Jobs/CronJobs, DaemonSets, init/sidecars, scheduling, rollout/PDB depth, Kustomize, CRDs, NetworkPolicy, RBAC, quotas. Agent-serving nodes (model-serving, gie, agent-workloads, spiffe, delegation, sandbox, p-inference-gw) are optional extras at the end, written after the core gaps.

## testing, cicd

From dach-remote quality and iac-cicd cicd plus dach-remote delivery. Ids assigned when those modules start.

## Phase C (not started)

python-ai beyond asyncio, ts-agents, agents-rag, ai-quality, aws-agents Bedrock/AgentCore, ml-fundamentals, mlops, AWS pro certs, js-react React stage, saas-builder, multilingual, contracting, Go.
