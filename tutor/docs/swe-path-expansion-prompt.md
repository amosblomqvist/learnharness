# Task: make the SWE path thorough

You're working in `~/Desktop/tutor`, an Electron + React + TypeScript app. It's now a **self-study app**: premade lessons, real exercises checked locally, spaced reviews, and no AI at runtime. The content lives in Markdown files in `src/study/content/`, one file per module.

The current modules are a solid but **thin first draft**: lessons average about 250 words and 2 practice steps. Your job is to make every module **thorough enough to build real technical understanding**, and to close every gap with the original course maps that the app used before (listed below). It's a long job. Do it module by module, check each one with the checker, and don't cut corners on depth or correctness.

---

## 1. Read these first

1. `README.md`: the "Modules" section explains the content format.
2. `src/study/parse.ts`: the exact format and all step fields.
3. `src/study/config.ts`: the YAML/HCL/JSON/Dockerfile parsers and the check language for `config` steps.
4. `src/study/types.ts`, `src/study/store.ts` (`SWE_PATH` is the module order), `src/study/Steps.tsx`.
5. All 8 files in `src/study/content/`. They're the style reference: plain, precise English, concrete examples, real commands.
6. The **old course maps**: `electron/course-maps/*.ts`, and the `typescript` course inline in `electron/courses.ts`. Each old node has `summary`, `why`, `check`, `minutes` and `resources`. They're your coverage target and a source of good material: the `check` texts are often perfect exercise ideas, and the resource URLs are already verified.

## 2. What "thorough" means (the depth standard)

Every lesson teaches **one idea completely**. If a topic needs more than about 40 minutes, split it into several lessons. Each lesson must have the following.

**In the body:**
1. **The problem first.** What breaks, or is painful, without this idea? "How would you have invented it?"
2. **The mental model.** How it really works underneath, not just the syntax. For example: how Python looks names up, what the event loop actually does, how the scheduler picks a node, what a Terraform plan compares against. Use a diagram where structure or flow matters. ` ```mermaid ` blocks render as diagrams (flowchart, sequenceDiagram, stateDiagram-v2), or use ` ```text ` ASCII.
3. **Worked examples, from simple to realistic**, each one annotated. Show real output where it helps.
4. **Where it breaks.** The gotchas, common bugs and misconceptions, each with *why* it happens.
5. **How it's used at work.** Production context, and links to other modules ("this is the same reconciliation idea as Terraform").
6. **A decision guide or comparison table** whenever there's a choice (X vs Y, when to use which).
7. **"You can now"**: a short checklist of what the learner can do after the lesson.

**Length:** concept lessons should be about **1,200–2,500 words** of body. Short is fine only for a genuinely small idea, and then the lesson should be short and *complete*, not padded.

**Practice: 5–9 steps per lesson**, in this order:
- 2–3 **recall** steps (`quiz` or `card`). Distractors must be the **real misconceptions** people have, not filler. Every `why` explains the right answer **and** why the tempting wrong one is wrong.
- 1–2 **predict** steps for any code topic: read code, type its exact output. Choose code that exposes the misconception.
- 1–3 **doing** steps: `write` (Python/TypeScript with hidden tests), `shell` (bash/git) or `config` (YAML/HCL/JSON/Dockerfile). Start with a small one, then one realistic one. Include **fix-the-bug** and **read-then-modify existing code** tasks, not only "write from scratch".
- Later lessons **reuse earlier skills** in their steps (interleaving). A Kubernetes step can ask for a correct Linux signal answer; a Terraform step can need IAM knowledge.

**Projects:** every **stage** ends with a project lesson (`project: yes`). It's 45–90 minutes, a realistic brief, and **several steps that build on each other**: for example, parse the data, then model it, then report on it, then handle bad input. It's graded by hidden tests or checks that cover edge cases.

**Review cards must stand alone.** Quiz, predict and card steps come back weeks later in a review session, **without the lesson text on screen**. Each one must make sense on its own: name the context ("In a Kubernetes Deployment, …"), and don't refer to "the example above".

**Accuracy is non-negotiable.**
- Every claim must be true **as of 2026**. Check version-specific facts (Terraform ≥ 1.10 S3 locking, Node type stripping, Python 3.12+ features, EKS Pod Identity, Gateway API status) against official docs.
- Every `source:` must be an official or highly reputable URL. **Link-check every source** with `curl -sIL -o /dev/null -w '%{http_code}' URL` and fix anything that isn't 200.
- If you aren't sure of a fact, look it up. Never guess.

## 3. Rules you must not break

- **Content only, mostly.** Change `src/study/content/*.md`. You may also append new module ids to `SWE_PATH` in `src/study/store.ts`. Don't change the engine (`parse.ts`, `config.ts`, `Steps.tsx`, `Study.tsx`, `electron/`) unless a step genuinely can't be expressed. In that case, stop and write down what you need, and don't hack around it.
- **Stable ids.** Never rename or delete an existing lesson `id`, and never reorder or delete **existing** steps inside an existing lesson. Progress is stored as `module/lesson#stepIndex`. You may **rewrite and extend the body** of existing lessons, **append** new steps at the end, and add new lessons anywhere.
- **Python lesson ids match the farm game.** These ids are used by the Root Access farm, so use exactly these for the matching Python topics: `run control numbers-strings t-names functions scope args modules first-class decorators lists tuples mutability dicts sets comprehensions collections generators itertools exceptions context-managers classes dataclasses inheritance dunder match type-hints pytest datetime files futures generics-py gil http-client iteration logging properties protocols regex ruff scripting sqlite t-objects text type-check uv-projects why-async numpy pandas plotting` and the projects `p-downloader p-gradebook p-library p-package p-quiz p-report p-todo`.
- **No git commits, no pushes, no `npm run app`.** Leave everything uncommitted; the owner commits.
- **Install and download nothing.** No pip, npm or brew installs.
- **Don't call any AI APIs** from the app or from scripts.

## 4. What the exercise sandbox can and can't do (design steps for this)

Everything runs locally under macOS `sandbox-exec`: **no network**, writes only in a scratch folder, no reading the home folder, an **8-second time limit** per run.

- **shell steps:**
  - The shell is **macOS `/bin/bash` 3.2** with **BSD** coreutils. That means no `grep -P`, no `find -printf`, no `head -n -1`, no bash 4 features (`declare -A`, `mapfile`), and `sed -i ''` instead of `sed -i`. Write tasks and solutions that work on both BSD and GNU, and say so in the lesson when they differ.
  - In `verify` scripts, use `LC_ALL=C sort` for stable ordering.
  - `wc` pads with spaces, but output comparison ignores spacing.
  - git is real (Command Line Tools git, with a fixed author and date, so commit hashes are deterministic). `setup:` can build repositories, branches, conflicts and a local bare remote in `../origin.git`.
  - Not available: no sudo, no systemd, no docker, kubectl, terraform, aws, jq-style network tools, or package managers. Teach those with quizzes, predict-from-text, and config steps.
- **write steps, Python:** Homebrew `python3`, **standard library only** (no pydantic, fastapi, requests, numpy or pandas). Tests are plain `def test_…(): assert …` functions in a file that does `from solution import …`. The harness shows got/expected for `assert a == b`.
- **write steps, TypeScript:**
  - Node 26 runs `.ts` by stripping types. Tests use `node:test` and `node:assert/strict`, and import from `"./solution"`.
  - The solution is type-checked with `tsc --strict --noUncheckedIndexedAccess --erasableSyntaxOnly`, so no `enum`, `namespace` or parameter properties.
  - **No npm packages** (no zod, no vitest) in solutions or tests.
  - The optional `types:` field is a type-only test file. Every `// @ts-expect-error: <reason>` line in it must be followed by code that should **fail** to type-check, and the reason is shown to the learner when their types are too loose.
- **config steps:**
  - **YAML** subset: maps, lists, scalars, block scalars, flow style, multi-document with `---`. No anchors.
  - **HCL**: blocks, attributes, lists and objects. Anything else (references, function calls, conditionals) becomes `{ expr: "source text" }`, so check it with `.expr`.
  - **Dockerfile**: `FROM[0]`, `CMD[-1]`, `FROM count 2`, and `seq ~ /regex/` over the normalized instruction sequence.
  - **JSON**.
  - Checks are `path op value | message`. The ops are `exists missing = != == ~ !~ has count >= <= > <`. Paths support `a.b[0].c`, `[-1]`, `[*]` (all must match), `[name=web]` (list filter), and, for YAML only, a leading `[kind=Service]` that selects a document.
- **predict steps:** the checker **runs the code** (Python, TypeScript, or `lang=shell` in the same sandbox) and requires its output to match `answer:` exactly, so answers can't be wrong.
- **Topics that really need third-party packages** (Pydantic, FastAPI, NumPy, pandas, Zod, React): teach the concepts fully, use stdlib re-implementations for hands-on steps where that teaches the same idea (for example a small validator that behaves like a Pydantic model), and use predict steps on described output. **Also list these topics in your report**, so the owner can decide whether to allow those packages in the sandbox later.

Known parser rules that bite:
- A lesson's header lines come straight after `## Title`, then a blank line, then the body.
- `## ` is reserved for lessons, so use `###` inside bodies.
- Inside a step, a line starting with a field name and a colon (`q:`, `why:`, `answer:`, `task:`, `hint:`, `code:`, `file:`, `check:`, `setup:`, `starter:`, `tests:`, `types:`, `solution:`, `expect:`, `verify:`) starts a new field.
- Inside a `quiz`, lines starting with `+ ` or `- ` are options, so no bullet lists inside quiz questions. Exactly one `+`.
- Text files given with `file:` get a trailing newline added.

## 5. Checking: after every module

```bash
npm run check:study            # or: npm run check:study <module-id>
npx tsc --noEmit -p tsconfig.json
npm run build
```

`check:study` must end with **"All good."** It runs every predict, proves every solution passes and every starter fails, and resolves every `needs` link. A module isn't done until it passes. Never weaken a check or a test just to make it pass; fix the content.

## 6. The gaps to close

Coverage target: **every node of the old maps below is covered by at least one lesson** (often a lesson of its own), at the depth standard above, unless you write down a reason to leave it out. Read each old node's `summary`, `why` and `check` in its file; they say what the lesson must achieve. Current lesson counts are in brackets, and the targets are rough.

### Phase A: deepen the 8 existing modules

**linux** [15 → about 24].
- Cover old `dev-essentials` stage `shell`: t-streams, shell-nav, pipes, processes, ssh, p-dotfiles.
- Also add the missing everyday Linux:
  - editors (vim survival, nano)
  - users and groups (`id`, `useradd`, `groups`, sudoers)
  - disks and space (`df`, `du`, mounts)
  - archives (`tar`, `gzip`)
  - `find -exec` and `xargs`
  - regular expressions for grep/sed
  - `cron` and timers
  - the package managers apt/dnf
  - log files and `journalctl` in depth
  - the `/proc` filesystem
  - networking tools in depth (`ip`, `ss`, `dig`, `curl -v` anatomy, TLS certificates)
  - the dotfiles project

**git** [6 → about 12]. Cover old `git-docker` stage `git`: t-snapshots, git-basics, branches, merge-rebase (rebase, interactive rebase, squash), remotes, github-flow, undo, hygiene (commit hygiene, `.gitattributes`, hooks, signing), p-git. Add `git bisect`, stash, cherry-pick, tags/releases, and a multi-step team project.

**python** [17 → about 55]. Cover every node of old `python` (`electron/course-maps/python.ts`):
- t-names t-objects run numbers-strings control mutability p-quiz
- lists tuples dicts sets comprehensions text collections p-gradebook
- functions args scope first-class decorators modules
- iteration generators itertools exceptions context-managers files p-todo
- classes dataclasses inheritance dunder properties protocols match p-library
- type-hints type-check generics-py uv-projects pytest ruff logging p-package
- regex datetime scripting sqlite http-client numpy pandas plotting p-report
- gil futures why-async p-downloader

From old `python-ai` stage `async`, add t-one-thread, coroutines, tasks, cancellation, async-io, backpressure, blocking and p-crawler, as lessons or as deepened async lessons. Keep the farm ids (rule above). Today, `numbers-strings` covers t-names and t-objects, `lists` covers tuples, and `dicts` covers sets and collections. Split them so each farm id has its own lesson.

**typescript** [13 → about 50]. Cover every node of old `typescript` (inline in `electron/courses.ts`):
- erasure type-set setup everyday special functions objects modules p-cli
- structural assignable unions narrowing discriminated exhaustive guards classes p-model
- strict-flags extra-flags tsconfig resolution p-migrate
- generics constraints keyof conditional mapped template utility variance p-emitter
- boundary zod async errors dts p-client
- node bun testing http db p-service
- nextjs server-client ai-sdk tools chat-ui mcp p-capstone

Also cover the JavaScript foundations from old `js-react` stage `js`: t-dynamic, js-basics, js-functions, this, prototypes, arrays-js, modules-js, dom, event-loop, promises, fetch, js-debug, p-vanilla. Network-bound topics (http, db, Next.js, AI SDK, MCP) get full concept lessons, plus stdlib-only hands-on steps where possible (for example routing and validation logic as pure functions), plus config/predict steps.

**containers** [7 → about 14]. Cover old `git-docker` stage `docker`: t-container, images (layers, union filesystem, image config), dockerfile, multistage, run-debug (logs, exec, inspect, exit codes), compose, registries, image-security (scanning, SBOM, secrets, distroless), p-containerize. Add namespaces and cgroups in depth, build context and BuildKit cache mounts, networking modes, volumes vs bind mounts, and health/restart policies.

**cloud** [9 → about 30]. Cover old `aws-saa`:
- t-api-iam account iam-deep regions compute containers-aws serverless storage databases networking security-aws observe-aws cost
- wa saa-1 saa-2 saa-3 saa-4 p-saas-aws saa-exam

Also cover `aws-agents` stage `base`: iam, cli-sdk, vpc, cloudwatch. Specifically:
- Organizations and SCPs; trust policies, STS and permission boundaries
- ECS/ECR/Fargate; Lambda + API Gateway + SQS/SNS/EventBridge + Step Functions
- Route 53, CloudFront, ALB vs NLB, PrivateLink and Transit Gateway
- KMS, Secrets Manager, WAF/Shield and GuardDuty
- DynamoDB modelling, Aurora and ElastiCache

For the four **SAA-C03 exam domains** (secure, resilient, high-performing, cost-optimized), write lessons with many **scenario questions in the exam's style**: long stems, four plausible options, explanations. The `saa-exam` node becomes a lesson of 40+ mixed scenario questions.

**terraform** [9 → about 16]. Cover old `iac-cicd`/`mlops-iac` stage `iac`: t-declarative, tf-basics, state, modules, expressions (for expressions, `dynamic` blocks, functions, conditionals, splat), refactor (moved, import, removed), tf-test (`terraform test`, validate, tflint, checkov), envs, p-tf. Add data sources, provider aliases (multi-region), remote state and outputs between stacks, and sensitive values in state. Keep `cdk` as an optional comparison lesson.

**kubernetes** [13 → about 28]. Cover old `k8s-agents`:
- t-desired kind pods deployments services config probes resources storage debug helm p-deploy-agent
- gateway-api autoscale
- t-least rbac netpol quotas pss ext-secrets p-secure-ns

The agent- and model-serving-specific nodes (model-serving, gie, agent-workloads, spiffe, delegation, sandbox, p-inference-gw) are optional extras at the end of the module. Also add:
- Jobs and CronJobs, DaemonSets
- init containers and sidecars
- scheduling: affinity, taints and tolerations, topology spread
- rollout strategies; PodDisruptionBudgets in depth
- Kustomize
- CRDs and operators
- a NetworkPolicy exercise, an RBAC exercise, and ResourceQuota/LimitRange exercises

### Phase B: new modules (add the ids to `SWE_PATH` in this order)

The final path order is:

1. linux
2. git
3. python
4. **sql**
5. typescript
6. **web**
7. **testing**
8. containers
9. cloud
10. terraform
11. **cicd**
12. kubernetes
13. **system-design**
14. **dsa** (an optional side track at the end)

- **sql** (about 14 lessons), from old `dev-essentials` stage `sql`: t-relations, select, joins, aggregates, modeling, indexes, transactions, sql-app, p-sql. Python's built-in `sqlite3` makes **real SQL exercises** possible: write steps where the learner writes queries that hidden tests run against a seeded in-memory database. Add NULL semantics, window functions, EXPLAIN and query plans, isolation levels and anomalies, migrations, and Postgres-specific notes.
- **web** (about 14), HTTP and APIs, from old `dev-essentials` stage `web`: t-request, http, net, rest, web-auth, web-security, caching-web. Also cover `dach-remote` node-api/quality ideas: API design, authn vs authz, sessions vs JWT, OAuth 2/OIDC flows, CORS, the OWASP Top 10 basics, rate limiting, idempotency, pagination and versioning. Practice through pure-function exercises (parse requests, route, validate, sign and verify an HMAC with stdlib).
- **testing** (about 8): the test pyramid, unit vs integration vs end-to-end, test doubles, property-based thinking, testing async code, flaky tests, coverage vs confidence. Use `dach-remote` quality: zod-contracts, vitest-behaviour, playwright-journeys, test-strategy.
- **cicd** (about 10), from old `iac-cicd` stage `cicd` (gha, oidc, progressive) and `dach-remote` delivery (gha-pipelines, oidc-deploy, otel-apps, p-ship-path): GitHub Actions workflow YAML (config steps on real workflow files), caching, matrices, environments and approvals, OIDC to AWS, building and pushing images, deployment strategies (rolling, blue/green, canary, feature flags), and OpenTelemetry basics.
- **system-design** (about 8), from old `dev-essentials` stage `design`: sd-basics, sd-data, sd-async, sd-method, p-design. Cover back-of-the-envelope numbers, caching, sharding and replication, queues and streams, consistency, and rate limiters, with scenario quizzes and one full design walkthrough.
- **dsa** (about 12, optional side track), from old `dev-essentials` stage `dsa`: t-bigo, arrays-hash, stacks-queues, linked, recursion, trees, graphs, sort-search, dp, patterns. Python write steps with tests that include large inputs, so slow solutions time out against the 8-second limit.

### Phase C: only if the owner asks later (don't start these)

python-ai (Pydantic, FastAPI, LLM APIs), ts-agents, agents-rag, ai-quality, aws-agents (Bedrock/AgentCore), ml-fundamentals, mlops, the AWS certification tracks, js-react's React stage, saas-builder, multilingual, contracting, Go. Most need packages or network the sandbox doesn't allow.

## 7. How to work

1. Start with a **coverage table** in `docs/study-coverage.md`: every old node id (from the lists above) → the new lesson id(s) that cover it, or "omitted: reason". Update it as you go; it's how the owner checks your work.
2. Then work **one module at a time**, Phase A in path order, then Phase B. For each module:
   1. Outline its stages and lessons, with needs and minutes, in a comment at the top of your working notes, not in the file.
   2. Write or extend the lessons.
   3. Run the checks (section 5) until they say "All good."
   4. Link-check its sources.
   5. Do a self-review pass, asking for every lesson:
      - Does it meet the depth standard?
      - Does every quiz encode a real misconception?
      - Do the steps make the learner *do* the thing?
      - Can every review card stand alone?
      - Is anything only true for old versions?
3. Don't stop to ask before each module. Do ask (and stop) if you hit something that needs an engine change, a package, or a judgement call about scope.

## 8. When you finish (or pause), report

- The lessons, steps and hours per module, before and after (from `check:study` output).
- The coverage table summary: covered, omitted, and why.
- Topics where practice was limited by the sandbox, and which packages or tools would unlock better exercises.
- Anything you weren't sure was correct and want checked.
- The final output of `npm run check:study`, `tsc` and `npm run build`.
