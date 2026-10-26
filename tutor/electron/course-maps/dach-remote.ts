// DACH remote contractor path: SWE + product engineer. TypeScript-first (Python secondary),
// cloud, ops and product craft. Pedagogy assumes AI drafts most code — the learner's job is to
// understand every concept, diagnose and review, direct the AI, verify, and ship. Not a syntax
// typing course; not Deutschunterricht (German is already C2). Complements the TypeScript Field
// Course, js-react, aws-saa, contracting and saas-builder rather than replacing them.
import type { StrategyInput } from "../goals"
import { R } from "./util"

const NX = (page: string, title: string) => R(`Next.js: ${title}`, `https://nextjs.org/docs/${page}`)
const RD = (page: string, title: string) => R(`react.dev: ${title}`, `https://react.dev/${page}`)
const Nest = (page: string, title: string) => R(`NestJS: ${title}`, `https://docs.nestjs.com/${page}`)
const Z = (page: string, title: string) => R(`Zod: ${title}`, `https://zod.dev/${page}`)
const VT = (page: string, title: string) => R(`Vitest: ${title}`, `https://vitest.dev/${page}`)
const PW = (page: string, title: string) => R(`Playwright: ${title}`, `https://playwright.dev/docs/${page}`)
const FA = (page: string, title: string) => R(`FastAPI: ${title}`, `https://fastapi.tiangolo.com/${page}`)
const OW = (page: string, title: string) => R(`OWASP: ${title}`, `https://owasp.org/${page}`)

export const dachRemoteCore: StrategyInput = {
  summary:
    "Platform-leaning SWE, in this order: TypeScript, Python, cloud (Kubernetes and Terraform), Linux, Go, then the product and delivery work. Each node is a short lesson and a check.",
  approach:
    "You will not primarily type syntax by hand. AI drafts code; your edge is understanding every concept deeply enough to diagnose what's wrong, review a PR (including AI's), write a precise prompt or plan, verify with tests and traces, and ship. Each node is framed around understand → diagnose → review → direct AI → verify → ship. TypeScript is preferred over Python, but you learn enough FastAPI to read and fix Python services. Cloud stays AWS (SAA-shaped). German contexts for stakeholders and B2B UX are fine; this is not Deutschunterricht. Foundations that already exist as ready-made courses (TypeScript Field Course, js-react, Git/Docker, SQL, AWS SAA, Terraform/CI, contracting business) are reused or assumed — Tutor's opening probe marks what you already have.",
  stages: [
    { id: "mindset", title: "AI-assisted craft", outcome: "Work as the reviewer and director: explain, diagnose, verify, ship — not memorise syntax." },
    { id: "ts-craft", title: "TypeScript", outcome: "Use types to design and to catch bugs; read any error and fix AI-drafted TypeScript with confidence." },
    { id: "react-next", title: "React and Next mastery", outcome: "Explain and fix component model, hooks, data flow, RSC and performance issues in a real Next app." },
    { id: "node-api", title: "Node and Nest APIs", outcome: "Design, review and ship a typed HTTP API (Nest or equivalent) with clear boundaries." },
    { id: "quality", title: "Contracts and tests", outcome: "Zod at the edges, Vitest for behaviour, Playwright for journeys — find what's wrong before users do." },
    { id: "py-light", title: "Python", outcome: "Read, diagnose and extend a typed FastAPI service with pytest — enough for mixed stacks." },
    { id: "data-runtime", title: "Redis and queues", outcome: "Add cache and async work safely: Redis patterns, job queues, idempotency and failure modes." },
    { id: "product-craft", title: "Product craft for contractors", outcome: "Write PRDs, set MVP scope, pick metrics, design B2B UX and communicate with DACH stakeholders." },
    { id: "delivery", title: "Ship with CI and observability", outcome: "GitHub Actions, keyless deploys, and enough traces/metrics/logs to diagnose production." },
    { id: "secure", title: "Web security add-on", outcome: "Spot and fix OWASP Top 10 issues in code you review or AI generated." },
    { id: "k8s", title: "Kubernetes", outcome: "Declare a service, roll it out, and debug it when it is not ready." },
    { id: "go", title: "Go", outcome: "Read and change a small Go service: values, errors, interfaces, one HTTP handler." },
  ],
  nodes: [
    // ---------- AI-assisted craft ----------
    {
      id: "t-ai-drafts",
      title: "AI drafts; you own the result",
      kind: "truth",
      stage: "mindset",
      summary: "Models write most of the syntax; you are accountable for correctness, design, security and what ships.",
      check: "List three bugs an AI commonly introduces that a reviewer who understands the system would catch.",
      minutes: 15,
      resources: [R("Anthropic: Building effective agents (engineering)", "https://www.anthropic.com/engineering/building-effective-agents")]
    },
    {
      id: "review-ai",
      title: "Review like a senior",
      kind: "skill",
      stage: "mindset",
      summary: "A checklist for AI-generated diffs: intent, edge cases, types, errors, security, tests, and 'would I merge this?'.",
      why: "Accepting AI output blindly is how silent production bugs land.",
      requires: ["t-ai-drafts"],
      check: "Review a deliberately flawed AI PR: find at least five real issues and propose concrete fixes (you need not retype the whole file).",
      minutes: 35,
      resources: [R("Google: Code review developer guide", "https://google.github.io/eng-practices/review/")]
    },
    {
      id: "direct-verify",
      title: "Direct, then verify",
      kind: "skill",
      stage: "mindset",
      summary: "Write a short plan or prompt with constraints and acceptance checks; run tests, typecheck and a manual path before calling it done.",
      requires: ["review-ai"],
      check: "Given a vague feature request, produce a plan an AI could implement and a verification script (tests or checklist) that would catch a wrong implementation.",
      minutes: 30,
      resources: [R("OpenAI: Prompt engineering", "https://platform.openai.com/docs/guides/prompt-engineering")]
    },
    {
      id: "p-mindset",
      title: "Project: fix an AI-drafted feature",
      kind: "project",
      stage: "mindset",
      summary: "Take a broken AI-generated feature branch: diagnose, direct fixes (or patch), add a regression test, and write a short review note.",
      requires: ["direct-verify"],
      check: "A failing test that reproduced the bug, a green suite after the fix, and a 5-line review explaining root cause.",
      minutes: 90
    },

    // ---------- TypeScript as design (beyond Field Course basics) ----------
    {
      id: "t-types-design",
      title: "Types are a design tool",
      kind: "truth",
      stage: "ts-craft",
      summary: "Good types encode invariants so illegal states are hard to represent; bad types are wallpaper over `any`.",
      check: "Show one domain where a discriminated union prevents a class of bugs that runtime checks would miss.",
      minutes: 15,
      resources: [R("Handbook: Narrowing", "https://www.typescriptlang.org/docs/handbook/2/narrowing.html"), R("Parse, don't validate", "https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/")]
    },
    {
      id: "read-errors",
      title: "Read and fix type errors",
      kind: "skill",
      stage: "ts-craft",
      summary: "Translate long TS diagnostics into the actual mismatch (assignability, generics, excess property, narrowing gap).",
      why: "Most AI-drafted TS 'fixes' that add `as` or `any` hide the real bug.",
      requires: ["t-types-design"],
      check: "Given five real error messages, explain each root cause and the correct fix — without silencing the checker.",
      minutes: 40,
      resources: [R("Handbook: Type compatibility", "https://www.typescriptlang.org/docs/handbook/type-compatibility.html"), R("tsconfig: strict", "https://www.typescriptlang.org/tsconfig/#strict")]
    },
    {
      id: "domain-types",
      title: "Model a domain in types",
      kind: "concept",
      stage: "ts-craft",
      summary: "Branded IDs, result unions, exhaustive switches, and types that make partial updates and API DTOs honest.",
      requires: ["t-types-design"],
      check: "Model order states so a cancelled order cannot be shipped at compile time; show the switch that breaks when a state is added.",
      minutes: 40,
      resources: [R("Handbook: Discriminated unions", "https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions"), R("Handbook: Utility types", "https://www.typescriptlang.org/docs/handbook/utility-types.html")]
    },
    {
      id: "debug-ts",
      title: "Diagnose runtime vs type lies",
      kind: "skill",
      stage: "ts-craft",
      summary: "When typed code still crashes: find the boundary that skipped validation, the unsafe assertion, or the wrong mental model.",
      requires: ["read-errors", "domain-types"],
      check: "Debug a failing production-like stack: identify where types were erased or lied, and propose the boundary fix (schema or narrow).",
      minutes: 35,
      resources: [R("Zod basics", "https://zod.dev/basics"), R("Handbook: unknown", "https://www.typescriptlang.org/docs/handbook/2/functions.html#unknown")]
    },
    {
      id: "p-ts-review",
      title: "Project: type-harden an AI module",
      kind: "project",
      stage: "ts-craft",
      summary: "Take an AI-written module full of `any` and weak types; redesign types, remove assertions, keep behaviour, add type tests.",
      requires: ["debug-ts", "p-mindset"],
      check: "`tsc --noEmit` clean with strict + noUncheckedIndexedAccess; no `any`/`as` without a comment; one type test that fails if the API widens.",
      minutes: 120
    },

    // ---------- React / Next mastery ----------
    {
      id: "t-ui-state",
      title: "UI is a function of state (and where it lives)",
      kind: "truth",
      stage: "react-next",
      summary: "Bugs are usually wrong state location, impure render, or effects used as life events — not missing JSX.",
      check: "Given a buggy cart UI description, say whether the fix is state, derived data, or an effect — and why.",
      minutes: 15,
      resources: [RD("learn/thinking-in-react", "Thinking in React"), RD("learn/you-might-not-need-an-effect", "You Might Not Need an Effect")]
    },
    {
      id: "hooks-model",
      title: "Hooks: rules, identity and data flow",
      kind: "concept",
      stage: "react-next",
      summary: "Why hook order matters, what identity (deps) means, lifting state, and when context or a query library should own data.",
      requires: ["t-ui-state"],
      check: "Diagnose three classic bugs (stale closure, infinite effect, context spam) from short snippets and prescribe the fix.",
      minutes: 40,
      resources: [RD("reference/rules/rules-of-hooks", "Rules of Hooks"), RD("learn/lifecycle-of-reactive-effects", "Lifecycle of reactive effects")]
    },
    {
      id: "rsc-model",
      title: "Server Components and the boundary",
      kind: "concept",
      stage: "react-next",
      summary: "RSC run on the server; client components ship JS; only serializable props cross; data fetching belongs where secrets and DB live.",
      why: "AI often sprinkles `'use client'` everywhere or fetches in the wrong place.",
      requires: ["hooks-model"],
      check: "For a profile page with a private API key and a like button, say which parts are server vs client and what may cross the boundary.",
      minutes: 40,
      resources: [NX("app/getting-started/server-and-client-components", "Server and Client Components"), RD("reference/rsc/use-client", "'use client'")]
    },
    {
      id: "next-data",
      title: "Next data flow: fetch, cache, mutate",
      kind: "skill",
      stage: "react-next",
      summary: "App Router fetching, caching and revalidation, route handlers, and mutations that keep UI and server in sync.",
      requires: ["rsc-model"],
      check: "Spot what's wrong in an AI-drafted Next page that shows stale data after a mutation, and fix the invalidation strategy.",
      minutes: 45,
      resources: [NX("app/building-your-application/data-fetching", "Data Fetching"), NX("app/building-your-application/data-fetching/revalidating", "Revalidating")]
    },
    {
      id: "react-perf",
      title: "Performance: find and fix",
      kind: "skill",
      stage: "react-next",
      summary: "Profiler, unnecessary re-renders, bundle size, waterfalls, and when memo/virtualisation actually help.",
      requires: ["hooks-model"],
      check: "Given a slow page profile (described), name the top two causes and the smallest fix — not 'memo everything'.",
      minutes: 40,
      resources: [RD("reference/react/Profiler", "Profiler"), NX("app/building-your-application/optimizing", "Optimizing")]
    },
    {
      id: "diagnose-react",
      title: "Diagnose React and Next failures",
      kind: "skill",
      stage: "react-next",
      summary: "Hydration mismatches, wrong key bugs, effect loops, and 'works in dev only' cache issues — systematic debugging.",
      requires: ["next-data", "react-perf"],
      check: "Walk through diagnosing a hydration error and an infinite re-render from symptoms to root cause to patch.",
      minutes: 35,
      resources: [RD("reference/react-dom/client/hydrateRoot#hydrating-server-rendered-html", "Hydration"), R("Next.js: Debugging", "https://nextjs.org/docs/app/building-your-application/configuring/debugging")]
    },
    {
      id: "p-next-fix",
      title: "Project: rescue a Next app",
      kind: "project",
      stage: "react-next",
      summary: "A Next App Router app with planted bugs (RSC boundary, stale cache, perf, hydration). AI may propose patches; you must verify.",
      requires: ["diagnose-react", "p-ts-review"],
      check: "All planted bugs fixed with tests or clear repros; a short write-up of each root cause; Lighthouse/perf note on the worst issue.",
      minutes: 180
    },

    // ---------- Node / Nest APIs ----------
    {
      id: "t-boundaries-api",
      title: "APIs are contracts at a trust boundary",
      kind: "truth",
      stage: "node-api",
      summary: "Everything outside the process is hostile or at least untyped until you parse it; handlers should be thin over domain logic.",
      check: "Name three inputs that must be validated on a typical B2B SaaS endpoint and what fails if you don't.",
      minutes: 10,
      resources: [R("Parse, don't validate", "https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/")]
    },
    {
      id: "node-runtime",
      title: "Node services: modules, errors, async",
      kind: "skill",
      stage: "node-api",
      summary: "Structured logging, error types vs HTTP mapping, graceful shutdown, and reading stack traces in async code.",
      requires: ["t-boundaries-api"],
      check: "Diagnose a hanging request and an unhandled rejection from logs; propose the structural fix.",
      minutes: 35,
      resources: [R("Node.js: TypeScript", "https://nodejs.org/api/typescript.html"), R("Node.js: Diagnostics", "https://nodejs.org/en/learn/diagnostics/user-journey")]
    },
    {
      id: "nest-model",
      title: "Nest (or modular) architecture",
      kind: "concept",
      stage: "node-api",
      summary: "Modules, providers, DI, controllers vs services, pipes/filters/guards — enough to review and direct Nest (or Hono/Fastify modular) code.",
      why: "DACH codebases often use Nest; you must navigate and fix without memorising decorators.",
      requires: ["node-runtime"],
      check: "Given a Nest module diagram with a circular dependency and business logic in a controller, explain what's wrong and how you'd restructure.",
      minutes: 45,
      resources: [Nest("modules", "Modules"), Nest("providers", "Providers"), Nest("guards", "Guards")]
    },
    {
      id: "api-authz",
      title: "Authn and authz in APIs",
      kind: "concept",
      stage: "node-api",
      summary: "Sessions vs tokens, scopes/roles, tenant isolation, and why authz bugs are the expensive ones in B2B.",
      requires: ["nest-model"],
      check: "Find the authz hole in a sample 'get invoice by id' handler and write the correct check plus a regression test idea.",
      minutes: 40,
      resources: [R("OWASP: Authorization cheat sheet", "https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html"), Nest("security/authorization", "Authorization")]
    },
    {
      id: "api-design-review",
      title: "Review an API design",
      kind: "skill",
      stage: "node-api",
      summary: "Idempotency, pagination, error bodies, versioning and breaking changes — judge a PR or OpenAPI diff.",
      requires: ["api-authz", "t-boundaries-api"],
      check: "Mark up an AI-generated OpenAPI/patch set: what's unsafe, what's unclear, what you'd require before merge.",
      minutes: 35,
      resources: [R("HTTP Semantics (idempotency)", "https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods"), R("Microsoft: API design", "https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-design")]
    },
    {
      id: "p-nest-api",
      title: "Project: ship a Nest (or Node) API slice",
      kind: "project",
      stage: "node-api",
      summary: "One vertical slice: authz, validated input, domain service, tests. AI may scaffold; you own design review and green CI.",
      requires: ["api-design-review"],
      check: "Invalid bodies 400 with useful errors; cross-tenant access denied with a test; happy path documented in OpenAPI or equivalent.",
      minutes: 180
    },

    // ---------- Zod, Vitest, Playwright ----------
    {
      id: "zod-contracts",
      title: "Zod as the runtime contract",
      kind: "skill",
      stage: "quality",
      summary: "Schemas at HTTP/env/queue boundaries; `z.infer`; refine/superRefine; sharing types without drifting from validation.",
      requires: ["t-boundaries-api"],
      check: "Write (or review) schemas for an env file and a webhook body; show a case where the TypeScript type alone would have lied.",
      minutes: 40,
      resources: [Z("basics", "Basic usage"), Z("api", "API")]
    },
    {
      id: "vitest-behaviour",
      title: "Vitest: test behaviour, not implementation",
      kind: "skill",
      stage: "quality",
      summary: "Arrange–act–assert, fake timers, mocking boundaries, and type-aware tests — prefer catching regressions over asserting internals.",
      requires: ["zod-contracts"],
      check: "Critique three weak AI-written tests and rewrite one into a behaviour test that would fail on a real bug.",
      minutes: 40,
      resources: [VT("guide/", "Guide"), VT("guide/mocking", "Mocking")]
    },
    {
      id: "playwright-journeys",
      title: "Playwright: user journeys",
      kind: "skill",
      stage: "quality",
      summary: "Stable selectors, page objects sparingly, waiting correctly, and e2e for the paths that make money or lose data.",
      requires: ["vitest-behaviour"],
      check: "Design an e2e for 'invite teammate → accept → see tenant data'; explain what you'd mock vs hit for real.",
      minutes: 45,
      resources: [PW("intro", "Introduction"), PW("locators", "Locators"), PW("auth", "Authentication")]
    },
    {
      id: "test-strategy",
      title: "What to test at which layer",
      kind: "concept",
      stage: "quality",
      summary: "The testing pyramid for product engineers: unit vs integration vs e2e vs type tests; cost of false greens.",
      requires: ["playwright-journeys"],
      check: "For a billing webhook feature, assign each risk to a layer and justify skipping one layer.",
      minutes: 25,
      resources: [R("Kent C. Dodds: Testing Trophy", "https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications")]
    },
    {
      id: "p-quality",
      title: "Project: contracts and CI gates",
      kind: "project",
      stage: "quality",
      summary: "Add Zod boundaries, Vitest coverage for domain rules, and one Playwright journey; wire them as CI gates.",
      requires: ["test-strategy", "p-nest-api"],
      check: "CI fails on type error, unit failure and e2e failure separately; a README note on how to run each locally.",
      minutes: 150
    },

    // ---------- Light Python FastAPI ----------
    {
      id: "t-py-secondary",
      title: "Python is secondary — still must be readable",
      kind: "truth",
      stage: "py-light",
      summary: "You prefer TypeScript, but DACH estates ship FastAPI services; you need to read typing, fix bugs and extend safely.",
      check: "Explain when you'd choose FastAPI vs a Nest service on a mixed team (ops, hiring, existing code).",
      minutes: 10,
      resources: [FA("", "FastAPI")]
    },
    {
      id: "py-typing-read",
      title: "Reading typed Python",
      kind: "skill",
      stage: "py-light",
      summary: "Type hints, Pydantic models, Optional/Union, and how editors/mypy/pyright catch what tests miss.",
      requires: ["t-py-secondary"],
      check: "Given a Pydantic model and a failing request, explain the validation error and the fix — without rewriting the whole app.",
      minutes: 35,
      resources: [R("Pydantic: Ideas", "https://docs.pydantic.dev/latest/concepts/models/"), R("typing — Support for type hints", "https://docs.python.org/3/library/typing.html")]
    },
    {
      id: "fastapi-read",
      title: "FastAPI: routes, Depends, errors",
      kind: "skill",
      stage: "py-light",
      summary: "Enough FastAPI to navigate: path operations, dependencies, status codes and the auto docs — diagnose, don't memorise.",
      requires: ["py-typing-read"],
      check: "Find why an endpoint returns 422 vs 500 in a sample app, and where auth should live in Depends.",
      minutes: 40,
      resources: [FA("tutorial/", "Tutorial"), FA("tutorial/dependencies/", "Dependencies")]
    },
    {
      id: "pytest-read",
      title: "pytest for API fixes",
      kind: "skill",
      stage: "py-light",
      summary: "Write or extend pytest tests with TestClient/httpx; use failures to drive the fix you direct AI to make.",
      requires: ["fastapi-read"],
      check: "Add a regression test for a fixed bug and show it failed before the patch.",
      minutes: 35,
      resources: [FA("tutorial/testing/", "Testing"), R("pytest docs", "https://docs.pytest.org/")]
    },
    {
      id: "p-fastapi-fix",
      title: "Project: fix a FastAPI service",
      kind: "project",
      stage: "py-light",
      summary: "A small FastAPI service with bugs (validation, authz, async blocking). Prefer directing AI + verifying with pytest.",
      requires: ["pytest-read"],
      check: "All tests green; a short note of each root cause; no unexplained `# type: ignore`.",
      minutes: 120
    },

    // ---------- Redis & queues (SQL/Postgres comes from reused sql stage) ----------
    {
      id: "redis-patterns",
      title: "Redis: cache, locks and sessions",
      kind: "concept",
      stage: "data-runtime",
      summary: "When Redis helps vs hides DB problems; TTLs, stampedes, distributed locks, and what must not live only in cache.",
      check: "Diagnose a 'users see each other's data' report that started after a cache was added.",
      minutes: 35,
      resources: [R("Redis docs: Data types", "https://redis.io/docs/latest/develop/data-types/"), R("Redis: Caching best practices", "https://redis.io/docs/latest/develop/use/caching/")]
    },
    {
      id: "queues-jobs",
      title: "Queues and background jobs",
      kind: "skill",
      stage: "data-runtime",
      summary: "Why work leaves the request path; retries, dead letters, idempotency keys, and at-least-once delivery.",
      requires: ["redis-patterns"],
      check: "Design the job for 'send invoice PDF': failures, double-send prevention, and how the UI shows progress.",
      minutes: 40,
      resources: [R("pg-boss", "https://github.com/timgit/pg-boss"), R("BullMQ docs", "https://docs.bullmq.io/")]
    },
    {
      id: "data-consistency",
      title: "Consistency across DB, cache and queue",
      kind: "concept",
      stage: "data-runtime",
      summary: "Outbox pattern, cache invalidation, and reading your own writes — the bugs that pass unit tests.",
      requires: ["queues-jobs"],
      check: "Explain a race where a job runs before the committing transaction is visible, and how you'd fix it.",
      minutes: 30,
      resources: [R("Microservices.io: Transactional outbox", "https://microservices.io/patterns/data/transactional-outbox.html")]
    },
    {
      id: "p-jobs",
      title: "Project: reliable async work",
      kind: "project",
      stage: "data-runtime",
      summary: "Add a queued feature with retries, idempotency and a failure path you can demonstrate.",
      requires: ["data-consistency"],
      check: "Kill the worker mid-job and recover without duplicate side effects; document the failure drill.",
      minutes: 150
    },

    // ---------- Product craft (contractor / B2B; German contexts OK, not language lessons) ----------
    {
      id: "t-outcome-product",
      title: "Contractors sell outcomes, not tickets",
      kind: "truth",
      stage: "product-craft",
      summary: "Clients hire you to reduce risk on a business problem; code is the means. Scope and communication are the product.",
      check: "Rewrite a ticket list into an outcome statement a Geschäftsführer would recognise.",
      minutes: 15,
      resources: [R("Patrick McKenzie: Don't call yourself a programmer", "https://www.kalzumeus.com/2011/10/28/dont-call-yourself-a-programmer/")]
    },
    {
      id: "prd-writing",
      title: "PRDs that engineers and stakeholders share",
      kind: "skill",
      stage: "product-craft",
      summary: "Problem, users, non-goals, requirements, metrics, risks and open questions — short enough to read in one sitting.",
      requires: ["t-outcome-product"],
      check: "Write a one-page PRD for a B2B feature (German or English); have the non-goals kill at least two tempting extras.",
      minutes: 40,
      resources: [R("Length: How to write a PRD", "https://www.length.com/blog/how-to-write-a-prd"), R("SVPG: Product discovery", "https://www.svpg.com/product-discovery/")]
    },
    {
      id: "mvp-scope",
      title: "MVP scope under contract pressure",
      kind: "skill",
      stage: "product-craft",
      summary: "Cut to the learning or revenue slice; sequence milestones; say no without damaging the relationship.",
      requires: ["prd-writing"],
      check: "Given a bloated wishlist, produce a 2-week MVP and a parking lot, with the risk of each cut named.",
      minutes: 30,
      resources: [R("YC: How to plan an MVP", "https://www.ycombinator.com/library/6f-how-to-plan-an-mvp")]
    },
    {
      id: "b2b-ux",
      title: "B2B UX judgement",
      kind: "concept",
      stage: "product-craft",
      summary: "Roles, permissions, empty states, auditability and boring clarity beat consumer delight in enterprise tools.",
      requires: ["t-outcome-product"],
      check: "Critique a consumer-styled B2B settings page: list five fixes that reduce support load.",
      minutes: 30,
      resources: [R("NN/g: Enterprise UX", "https://www.nngroup.com/articles/enterprise-ux/")]
    },
    {
      id: "metrics-product",
      title: "Metrics that steer the work",
      kind: "concept",
      stage: "product-craft",
      summary: "Activation, retention, task success, error rate, lead time — pick one North Star and a few counter-metrics.",
      requires: ["mvp-scope"],
      check: "For your MVP, name the metric that would prove it worked and one vanity metric you'd ignore.",
      minutes: 25,
      resources: [R("a16z: 16 startup metrics", "https://a16z.com/16-startup-metrics/")]
    },
    {
      id: "stakeholder-comms",
      title: "Stakeholder communication (DACH context)",
      kind: "skill",
      stage: "product-craft",
      summary: "Status without noise, risk early, decision options with trade-offs; German or English business register — not grammar lessons.",
      requires: ["prd-writing", "metrics-product"],
      check: "Draft a weekly status (DE or EN) that surfaces a slipping risk and asks for a decision with two options.",
      minutes: 30,
      resources: [R("Manager Tools: Status updates", "https://www.manager-tools.com/")]
    },
    {
      id: "p-prd-slice",
      title: "Project: PRD → shipped slice",
      kind: "project",
      stage: "product-craft",
      summary: "One-pager PRD, MVP cut, implementation (AI-assisted), demo notes for a fictional DACH stakeholder.",
      requires: ["stakeholder-comms", "b2b-ux", "p-quality"],
      check: "PRD, working slice, demo script, and a retrospective: what you'd cut earlier next time.",
      minutes: 240
    },

    // ---------- Delivery: GHA + observability (Docker/IaC/AWS reused via composition) ----------
    {
      id: "gha-pipelines",
      title: "GitHub Actions that guard the trunk",
      kind: "skill",
      stage: "delivery",
      summary: "CI for typecheck, test, lint, build; caching; required checks; secrets vs OIDC — enough to review and fix workflows.",
      check: "Find three problems in a messy AI-written workflow (secrets, flaky setup, missing fail-fast) and patch them.",
      minutes: 40,
      resources: [R("GitHub Actions: Workflow syntax", "https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions"), R("GitHub: Security hardening for Actions", "https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions")]
    },
    {
      id: "oidc-deploy",
      title: "Keyless deploys with OIDC",
      kind: "skill",
      stage: "delivery",
      summary: "Short-lived cloud credentials from GitHub to AWS — no long-lived access keys in secrets if you can avoid them.",
      requires: ["gha-pipelines"],
      check: "Explain the trust chain from a workflow to an AWS role, and what a stolen long-lived key would allow that OIDC limits.",
      minutes: 30,
      resources: [R("GitHub: OIDC with AWS", "https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services")]
    },
    {
      id: "otel-apps",
      title: "Observability: logs, metrics, traces",
      kind: "skill",
      stage: "delivery",
      summary: "What to emit from an app so you can diagnose production: structured logs, golden signals, trace a request across API and job.",
      requires: ["gha-pipelines"],
      check: "Given a 'checkout is slow' incident, say which signal you'd check first and what a useful trace must include.",
      minutes: 40,
      resources: [R("OpenTelemetry: What is OpenTelemetry?", "https://opentelemetry.io/docs/what-is-opentelemetry/"), R("SRE book: Monitoring distributed systems", "https://sre.google/sre-book/monitoring-distributed-systems/")]
    },
    {
      id: "p-ship-path",
      title: "Project: path to production",
      kind: "project",
      stage: "delivery",
      summary: "Wire CI, a deploy (or deploy dry-run to AWS), and basic alerts/traces for one service from this path.",
      requires: ["oidc-deploy", "otel-apps", "p-jobs"],
      check: "A failing test blocks merge; a deploy runbook; one alert you'd wake up for and why.",
      minutes: 180
    },

    // ---------- Optional OWASP (after shipping skills) ----------
    {
      id: "owasp-top10",
      title: "OWASP Top 10 as a review lens",
      kind: "concept",
      stage: "secure",
      optional: true,
      summary: "Broken access control, injection, XSS, SSRF, misconfig, supply chain — recognise them in PRs and AI output.",
      check: "Map five Top 10 items to concrete places in an app you've built in this course.",
      minutes: 40,
      resources: [OW("www-project-top-ten/", "Top 10"), R("OWASP Cheat Sheet Series", "https://cheatsheetseries.owasp.org/")]
    },
    {
      id: "secure-review",
      title: "Security review of AI code",
      kind: "skill",
      stage: "secure",
      optional: true,
      summary: "A short threat pass on a diff: trust boundaries, authz, injection sinks, secrets, dependency risk.",
      requires: ["owasp-top10"],
      check: "Review an AI-generated endpoint and file at least three credible security findings with fixes.",
      minutes: 35,
      resources: [R("OWASP ASVS", "https://owasp.org/www-project-application-security-verification-standard/")]
    },
    {
      id: "p-secure",
      title: "Project: harden one surface",
      kind: "project",
      stage: "secure",
      optional: true,
      summary: "Pick one app surface from this path; fix the top risks; add at least one automated check (test or lint rule).",
      requires: ["secure-review", "p-ship-path"],
      check: "Before/after notes, regression test for the main hole, and no secrets in the repo history of the branch.",
      minutes: 120
    },

    // ---------- Kubernetes (cloud, with Terraform) ----------
    {
      id: "k8s-declare",
      title: "You declare what should exist",
      kind: "truth",
      stage: "k8s",
      summary: "You write the desired state. Controllers keep working until the cluster matches it.",
      check: "Delete a Pod from a Deployment and say who recreates it, and why.",
      minutes: 12,
      resources: [R("Kubernetes: Controllers", "https://kubernetes.io/docs/concepts/architecture/controller/")]
    },
    {
      id: "k8s-work",
      title: "Pods and Deployments",
      kind: "concept",
      stage: "k8s",
      summary: "A Pod runs your containers. A Deployment keeps the right number and rolls them out.",
      requires: ["k8s-declare"],
      check: "Say what happens to traffic during a rolling update, and how you roll back.",
      minutes: 15,
      resources: [R("Kubernetes: Deployments", "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/")]
    },
    {
      id: "k8s-svc",
      title: "Services",
      kind: "concept",
      stage: "k8s",
      summary: "Pods come and go. A Service is the stable name and address in front of them.",
      requires: ["k8s-work"],
      check: "Explain why you call a Service name, not a Pod IP.",
      minutes: 12,
      resources: [R("Kubernetes: Service", "https://kubernetes.io/docs/concepts/services-networking/service/")]
    },
    {
      id: "k8s-debug",
      title: "When it is not ready",
      kind: "skill",
      stage: "k8s",
      summary: "Read events, logs, and probes before you change the manifest again.",
      requires: ["k8s-svc"],
      check: "Given CrashLoopBackOff and a failing readiness probe, say which you look at first and why.",
      minutes: 15,
      resources: [R("Kubernetes: Debug applications", "https://kubernetes.io/docs/tasks/debug/debug-application/")]
    },

    // ---------- Go ----------
    {
      id: "go-small",
      title: "Go is small on purpose",
      kind: "truth",
      stage: "go",
      summary: "A Go program is packages, functions, and values. The standard library does the rest.",
      check: "Name what package main and func main are for.",
      minutes: 10,
      resources: [R("A Tour of Go", "https://go.dev/tour/welcome/1")]
    },
    {
      id: "go-values",
      title: "Types and zero values",
      kind: "concept",
      stage: "go",
      summary: "Variables start at a zero value. Structs, slices, and maps are the everyday types.",
      requires: ["go-small"],
      check: "Say the zero value of an int, a string, a slice, and a map, and which you must make before use.",
      minutes: 12,
      resources: [R("Go: zero values", "https://go.dev/tour/basics/12")]
    },
    {
      id: "go-errors",
      title: "Errors are values",
      kind: "skill",
      stage: "go",
      summary: "Functions return an error. You check it at the call. You do not ignore it.",
      requires: ["go-values"],
      check: "Show the two-return pattern and what you do when err is not nil.",
      minutes: 12,
      resources: [R("Go: errors", "https://go.dev/doc/effective_go#errors")]
    },
    {
      id: "go-ifaces",
      title: "Interfaces are small",
      kind: "concept",
      stage: "go",
      summary: "An interface is a set of methods. A type implements it by having those methods. There is no implements keyword.",
      requires: ["go-values"],
      check: "Explain why io.Reader is one method, and what that lets you pass.",
      minutes: 12,
      resources: [R("Go: interfaces", "https://go.dev/tour/methods/9")]
    },
    {
      id: "go-http",
      title: "One HTTP handler",
      kind: "skill",
      stage: "go",
      summary: "net/http serves a handler. The handler reads the request and writes the response.",
      requires: ["go-errors", "go-ifaces"],
      check: "Sketch a handler that returns 400 when the query is missing, and 200 when it is not.",
      minutes: 15,
      resources: [R("net/http", "https://pkg.go.dev/net/http")]
    }
  ]
}
