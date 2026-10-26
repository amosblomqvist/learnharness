// Ready-made courses: a complete strategy map you can start from right away (no drafting wait).
// They form the product engineer path in priority order, with side quests (course-maps/ holds the maps).
// Tutor then probes where you are and marks what you already have, like any goal.
// The TypeScript course follows the TypeScript Field Course (claude.ai/artifact/DtKt6haaqLV7PhHznqJHfx),
// extended to the whole language; every node points at its chapter there and at the official docs.
import type { StrategyInput } from "./goals"
import type { CourseNode } from "./course-maps/util"
import { saasBuilder } from "./course-maps/saas-builder"
import { multilingual } from "./course-maps/multilingual"
import { awsSaa } from "./course-maps/aws-saa"
import { contracting } from "./course-maps/contracting"
import { python } from "./course-maps/python"
import { gitDocker } from "./course-maps/git-docker"
import { pythonAi } from "./course-maps/python-ai"
import { tsAgents } from "./course-maps/ts-agents"
import { agentsRag } from "./course-maps/agents-rag"
import { k8sAgents } from "./course-maps/k8s-agents"
import { awsAgents } from "./course-maps/aws-agents"
import { mlopsIac } from "./course-maps/mlops-iac"
import { awsCerts } from "./course-maps/aws-certs"
import { jsReact } from "./course-maps/js-react"
import { devEssentials } from "./course-maps/dev-essentials"
import { mlFundamentals } from "./course-maps/ml-fundamentals"
import { aiQuality } from "./course-maps/ai-quality"
import { dachRemoteCore } from "./course-maps/dach-remote"

// practice: nodes (all, or those stages) that need a passed exercise before they turn solid.
export type Course = { id: string; phase: number; step: number; after?: string[]; exam?: boolean; practice?: true | string[]; title: string; blurb: string; ask: string; hours: number; realHours: number; strategy: StrategyInput }

const FC = (ch: number, title: string) => ({ title: `Field Course ${ch}: ${title}`, url: `https://claude.ai/artifact/DtKt6haaqLV7PhHznqJHfx#c${ch}` })
const HB = (page: string, title: string) => ({ title: `Handbook: ${title}`, url: `https://www.typescriptlang.org/docs/handbook/${page}` })

const typescript: StrategyInput = {
  summary: "The whole of TypeScript, from what a type is to shipping a typed AI app on Node, Next.js, the AI SDK and MCP.",
  approach:
    "Everything rests on three facts you can take as given: types are erased before code runs, a type is a set of values, and TypeScript compares shapes rather than names. From the set view, unions, narrowing and never fall out almost by themselves; generics and type-level programming are functions over those sets. Then the runtime boundary (where types can't reach), and TypeScript on the server, the web and AI apps. Each stage ends in something you build.",
  stages: [
    { id: "found", title: "Foundations", outcome: "Read and write everyday TypeScript, and run it three ways." },
    { id: "model", title: "The type system's model", outcome: "Predict what the checker accepts, and say why." },
    { id: "strict", title: "Strict, modern setup", outcome: "Configure a strict modern project and read any tsconfig." },
    { id: "generic", title: "Generics and type-level", outcome: "Write reusable generic code and compute types from types." },
    { id: "runtime", title: "Types meet runtime", outcome: "Validate outside data, and handle async work and errors safely." },
    { id: "server", title: "TypeScript on the server", outcome: "Build and test a typed HTTP service on Node or Bun." },
    { id: "web", title: "Web and AI apps", outcome: "Ship a Next.js app that talks to Claude with tools over MCP." }
  ],
  nodes: [
    // ---------- Foundations ----------
    { id: "erasure", title: "Types vanish before running", kind: "truth", stage: "found", summary: "TypeScript's types are checked before the program runs and then removed; what runs is plain JavaScript.", check: "Say what's left of `function f(x: number): string` after compiling, and why a typed program can still get a string where it expects a number.", minutes: 15, resources: [FC(1, "What TypeScript is"), HB("2/basic-types.html", "The Basics")] },
    { id: "type-set", title: "A type is a set of values", kind: "truth", stage: "found", summary: "Every type names a set of possible values: `number` is all numbers, `\"good\"` is exactly one string, `never` is the empty set.", check: "Name the set each of `boolean`, `\"a\" | \"b\"`, `unknown` and `never` stands for.", minutes: 15, resources: [HB("2/everyday-types.html", "Everyday Types")] },
    { id: "setup", title: "Set up, check and run", kind: "skill", stage: "found", summary: "`tsc --noEmit` checks a project; Node, Bun or a bundler runs it by stripping the types.", why: "Checking and running are separate jobs, so a project needs both wired up.", requires: ["erasure"], check: "Create a project, make `tsc --noEmit` report one error, fix it, and run the file with `node`.", minutes: 30, resources: [FC(2, "Setting up")] },
    { id: "everyday", title: "Everyday types and inference", kind: "concept", stage: "found", summary: "Primitives, arrays, tuples, object and literal types, and inference that works them out from values.", why: "Annotating everything is noise; you need to know what TypeScript can work out itself.", requires: ["type-set"], check: "Predict the inferred type of `const x = 5`, `let y = 5` and `[1, \"a\"] as const`.", minutes: 30, resources: [FC(3, "The everyday types"), HB("2/everyday-types.html", "Everyday Types")] },
    { id: "special", title: "any, unknown, never, void", kind: "concept", stage: "found", summary: "`unknown` is every value (check before use), `never` is none, `void` is no useful result, and `any` switches checking off.", why: "Untyped data has to go somewhere; which of these you pick decides whether bugs surface now or at runtime.", requires: ["type-set", "everyday"], check: "Explain why `unknown` is safe and `any` isn't, using the set picture.", minutes: 20, resources: [FC(3, "The everyday types")] },
    { id: "functions", title: "Typing functions", kind: "concept", stage: "found", summary: "Parameter and return types, optional and rest parameters, function types, overloads and contextual typing.", why: "Functions are the edges of your code; that's where types pay for themselves.", requires: ["everyday"], check: "Type a callback parameter so the caller gets inference without annotations.", minutes: 30, resources: [FC(4, "Functions"), HB("2/functions.html", "More on Functions")] },
    { id: "objects", title: "Object types: interface and type", kind: "concept", stage: "found", summary: "Describe object shapes with `interface` or `type`, with optional, readonly and index-signature members.", why: "Real data is objects; you need one vocabulary to describe them.", requires: ["everyday"], check: "Model a record with an optional field, a readonly id and a map of tags, and say when you'd pick interface over type.", minutes: 30, resources: [FC(5, "Object types"), HB("2/objects.html", "Object Types")] },
    { id: "modules", title: "Modules and import type", kind: "concept", stage: "found", summary: "ES modules split code into files; `import type` marks imports that disappear when types are erased.", why: "Once types are erased, tools need to know which imports still exist at runtime.", requires: ["erasure", "objects"], check: "Explain what `verbatimModuleSyntax` forces you to write, and why.", minutes: 20, resources: [FC(7, "Modules, classes"), HB("2/modules.html", "Modules")] },
    { id: "p-cli", title: "Project: typed flashcard CLI", kind: "project", stage: "found", summary: "A small command-line flashcard tool in strict TypeScript, split into modules and run with Node.", requires: ["setup", "functions", "objects", "modules", "special"], check: "`tsc --noEmit` is clean, and it runs with `node src/main.ts`.", minutes: 90 },

    // ---------- The type system's model ----------
    { id: "structural", title: "Shapes, not names", kind: "truth", stage: "model", summary: "TypeScript decides compatibility by comparing properties, never by the name a type was declared with.", check: "Say why a `{ hanzi, pinyin, due }` object passes where `{ hanzi: string }` is expected.", minutes: 15, resources: [FC(5, "Structural typing"), HB("type-compatibility.html", "Type Compatibility")] },
    { id: "assignable", title: "Assignability is set inclusion", kind: "concept", stage: "model", summary: "A value of type A fits where B is expected exactly when A's set of values sits inside B's.", why: "Every \"is not assignable\" error is this one question; answer it and the error messages read themselves.", requires: ["type-set", "structural"], check: "Predict which of `\"a\"`, `string`, `\"a\" | \"b\"` can be assigned to which, and why an object with more properties is a smaller set.", minutes: 25, resources: [{ title: "Handbook: Type compatibility", url: "https://www.typescriptlang.org/docs/handbook/type-compatibility.html" }, { title: "Handbook: Types as sets", url: "https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes-oop.html#types-as-sets" }] },
    { id: "unions", title: "Unions and intersections", kind: "concept", stage: "model", summary: "`A | B` is the union of the two sets; `A & B` is their intersection, which for objects means having both shapes.", why: "Real values are often \"this or that\"; you need a way to say so.", requires: ["assignable"], check: "Explain why `string & number` is `never` but `{ a: 1 } & { b: 2 }` isn't.", minutes: 25, resources: [HB("2/everyday-types.html#union-types", "Union Types")] },
    { id: "narrowing", title: "Narrowing and control flow", kind: "concept", stage: "model", summary: "Runtime checks (`typeof`, `in`, `instanceof`, equality) shrink a union, and the checker follows every branch.", why: "You can only use what every member of a union has, until you prove which one you hold.", requires: ["unions", "erasure"], check: "Give the type of `x` on each line of a function that returns early on `typeof x === \"string\"`.", minutes: 30, resources: [FC(6, "Unions and narrowing"), HB("2/narrowing.html", "Narrowing")] },
    { id: "discriminated", title: "Discriminated unions", kind: "concept", stage: "model", summary: "Give every variant a shared literal field (`type`, `kind`); checking it narrows the whole object.", why: "It's how you model \"one of several kinds of thing\" so the checker can tell them apart.", requires: ["narrowing"], check: "Model three kinds of review event and switch over them with full inference.", minutes: 25, resources: [FC(6, "Discriminated unions")] },
    { id: "exhaustive", title: "Exhaustiveness with never", kind: "skill", stage: "model", summary: "Assign what's left after every case to `never`, so forgetting a new variant becomes a compile error.", requires: ["discriminated", "special"], check: "Add a variant to a union and show the compiler pointing at the switch that forgot it.", minutes: 15, resources: [{ title: "Handbook: Exhaustiveness checking", url: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking" }, { title: "Handbook: The never type", url: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html#the-never-type" }] },
    { id: "guards", title: "Type guards and satisfies", kind: "concept", stage: "model", summary: "`x is T` functions teach the checker your own narrowing; `satisfies` checks a value without widening its type.", requires: ["narrowing"], check: "Write `isWord(x: unknown): x is Word`, and say what `satisfies` keeps that an annotation throws away.", minutes: 25, resources: [FC(6, "Other narrowing tools")] },
    { id: "classes", title: "Classes and erasable syntax", kind: "concept", stage: "model", summary: "Classes, `#private` fields, and the modern rule: avoid `enum`, `namespace` and parameter properties, which generate code.", why: "Runtimes that just strip types can't run features that need code generated.", requires: ["objects", "erasure"], check: "Replace an `enum` with an `as const` object and a derived union type.", minutes: 25, resources: [FC(7, "Classes, briefly"), HB("2/classes.html", "Classes")] },
    { id: "p-model", title: "Project: model a domain", kind: "project", stage: "model", summary: "Model an SRS review flow as discriminated unions with exhaustive handling and type guards at the edges.", requires: ["exhaustive", "guards", "classes"], check: "Adding a new state is a compile error everywhere it isn't handled, and bad input is rejected at the edge.", minutes: 90 },

    // ---------- Strict, modern setup ----------
    { id: "strict-flags", title: "Strict mode, flag by flag", kind: "concept", stage: "strict", summary: "`strict` turns on strictNullChecks, noImplicitAny, strictFunctionTypes and the rest; each catches a class of bug.", why: "Without them, null and implicit any slip through and the safety net has holes.", requires: ["special", "narrowing"], check: "Name the flag behind \"'x' is possibly 'undefined'\" and the one behind \"implicitly has an 'any' type\".", minutes: 30, resources: [FC(8, "Strict mode"), { title: "tsconfig: strict", url: "https://www.typescriptlang.org/tsconfig/#strict" }] },
    { id: "extra-flags", title: "Beyond strict", kind: "concept", stage: "strict", summary: "noUncheckedIndexedAccess, exactOptionalPropertyTypes and noImplicitOverride close the gaps `strict` leaves.", requires: ["strict-flags"], check: "Show a bug `noUncheckedIndexedAccess` catches that `strict` misses.", minutes: 20, resources: [FC(8, "Strict mode")] },
    { id: "tsconfig", title: "Read any tsconfig", kind: "skill", stage: "strict", summary: "target, module, moduleResolution, lib, types, include and noEmit: what each one decides.", requires: ["strict-flags", "modules"], check: "Explain every line of a real project's tsconfig.json.", minutes: 30, resources: [{ title: "TSConfig reference", url: "https://www.typescriptlang.org/tsconfig/" }] },
    { id: "resolution", title: "Module resolution, ESM and CJS", kind: "concept", stage: "strict", summary: "How an import string becomes a file, and why ES modules and CommonJS still meet at the edges.", why: "\"Cannot find module\" and default-import surprises all come from here.", requires: ["modules", "tsconfig"], check: "Say what `module: nodenext` requires of relative import paths, and why.", minutes: 30, resources: [HB("modules/theory.html", "Modules: Theory")] },
    { id: "p-migrate", title: "Project: migrate JS to strict TS", kind: "project", stage: "strict", summary: "Take a small JavaScript module to strict TypeScript with the extra flags on and zero `any`.", requires: ["extra-flags", "tsconfig", "p-cli"], check: "`tsc --noEmit` is clean in strict mode with the extra flags, with no `any` and no ts-ignore.", minutes: 120 },

    // ---------- Generics and type-level ----------
    { id: "generics", title: "Generics: functions over types", kind: "concept", stage: "generic", summary: "A type parameter lets one function keep the caller's exact type instead of collapsing it to unknown.", why: "Without generics, reusable code loses type information at every call.", requires: ["functions", "assignable"], check: "Write `first<T>(xs: T[]): T | undefined` and show what the caller gets back.", minutes: 30, resources: [FC(9, "Generics"), HB("2/generics.html", "Generics")] },
    { id: "constraints", title: "Constraints and defaults", kind: "concept", stage: "generic", summary: "`T extends X` limits what a type parameter may be; defaults fill it in when inference can't.", requires: ["generics"], check: "Write a generic that only accepts objects with an `id`, and explain the error for one without.", minutes: 20, resources: [{ title: "Handbook: Generic constraints", url: "https://www.typescriptlang.org/docs/handbook/2/generics.html#generic-constraints" }, { title: "Handbook: Generic parameter defaults", url: "https://www.typescriptlang.org/docs/handbook/2/generics.html#generic-parameter-defaults" }] },
    { id: "keyof", title: "keyof, typeof, indexed access", kind: "concept", stage: "generic", summary: "`keyof T` is the union of T's keys, `typeof x` lifts a value's type, and `T[K]` looks a property's type up.", requires: ["objects", "generics"], check: "Type `get<T, K extends keyof T>(o: T, k: K)` so the return type follows the key.", minutes: 25, resources: [HB("2/keyof-types.html", "Keyof"), HB("2/indexed-access-types.html", "Indexed Access")] },
    { id: "conditional", title: "Conditional types and infer", kind: "concept", stage: "generic", summary: "`T extends U ? X : Y` chooses a type; `infer` pulls a piece out of a matched type; unions distribute.", why: "Some types depend on others, like \"the element type of this array\".", requires: ["constraints", "unions"], check: "Write `ElementOf<T>` with `infer`, and explain what distribution does to `ElementOf<string[] | number[]>`.", minutes: 35, resources: [FC(10, "Type-level programming"), HB("2/conditional-types.html", "Conditional Types")] },
    { id: "mapped", title: "Mapped types", kind: "concept", stage: "generic", summary: "`{ [K in keyof T]: … }` builds a new object type key by key, with modifiers and `as` key remapping.", requires: ["keyof"], check: "Write your own `Readonly<T>` and a type that prefixes every key with `get`.", minutes: 30, resources: [HB("2/mapped-types.html", "Mapped Types")] },
    { id: "template", title: "Template literal types", kind: "concept", stage: "generic", summary: "String types built from other string types, like `` `on${Capitalize<E>}` ``.", requires: ["conditional", "mapped"], check: "Type event handler names from a union of event names.", minutes: 25, resources: [HB("2/template-literal-types.html", "Template Literal Types")] },
    { id: "utility", title: "The utility types", kind: "skill", stage: "generic", summary: "Partial, Required, Pick, Omit, Record, Exclude, Extract, ReturnType, Parameters, Awaited and friends, and how each is built.", requires: ["mapped", "conditional"], check: "For each utility type, say what it's for and rebuild two of them yourself.", minutes: 40, resources: [FC(11, "Utility types"), HB("utility-types.html", "Utility Types")] },
    { id: "variance", title: "Variance", kind: "concept", stage: "generic", summary: "Arrays and return types keep the direction of assignability; function parameters reverse it.", why: "It explains the strangest strictFunctionTypes errors.", requires: ["assignable", "generics", "strict-flags"], check: "Show why a `(x: Dog) => void` can't stand in for `(x: Animal) => void`.", minutes: 25, resources: [{ title: "Handbook: Variance annotations", url: "https://www.typescriptlang.org/docs/handbook/2/generics.html#variance-annotations" }, { title: "Handbook: Function parameter bivariance", url: "https://www.typescriptlang.org/docs/handbook/type-compatibility.html#function-parameter-bivariance" }, { title: "tsconfig: strictFunctionTypes", url: "https://www.typescriptlang.org/tsconfig/#strictFunctionTypes" }] },
    { id: "p-emitter", title: "Project: type-safe event emitter", kind: "project", stage: "generic", summary: "An emitter whose `on` and `emit` are checked against an event map, with typed handler names.", requires: ["utility", "template", "variance"], check: "A wrong event name or payload fails to compile, and handler names autocomplete.", minutes: 120 },

    // ---------- Types meet runtime ----------
    { id: "boundary", title: "Outside data has no type", kind: "truth", stage: "runtime", summary: "Anything that arrives while the program runs (JSON, env vars, user input, files) is unknown until code checks it.", check: "List three places in an app where data crosses this boundary.", minutes: 10, resources: [{ title: "Handbook: unknown", url: "https://www.typescriptlang.org/docs/handbook/2/functions.html#unknown" }, { title: "Zod: Basic usage", url: "https://zod.dev/basics" }, { title: "Parse, don't validate", url: "https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/" }] },
    { id: "zod", title: "Validate with Zod", kind: "skill", stage: "runtime", summary: "One schema both checks data at runtime and gives you its TypeScript type with `z.infer`.", why: "Writing the type and the check separately lets them drift apart.", requires: ["boundary", "unions", "objects"], check: "Parse an API response with a schema, and show the type you get with and without a successful parse.", minutes: 40, resources: [FC(12, "Runtime validation with Zod"), { title: "Zod docs", url: "https://zod.dev" }] },
    { id: "async", title: "Promises and async typing", kind: "concept", stage: "runtime", summary: "`Promise<T>`, `await` and `Awaited<T>`; Promise.all and allSettled keep each element's type.", requires: ["functions", "generics"], check: "Type a function that fetches three resources in parallel and returns them as a tuple.", minutes: 30, resources: [FC(15, "Async TypeScript")] },
    { id: "errors", title: "Typed error handling", kind: "concept", stage: "runtime", summary: "`catch` gives you unknown; narrow it, or return errors as values with a Result union.", requires: ["async", "narrowing", "special"], check: "Rewrite a throwing function to return `{ ok: true, value } | { ok: false, error }`.", minutes: 30, resources: [FC(15, "Error handling")] },
    { id: "dts", title: "Declaration files", kind: "concept", stage: "runtime", summary: "`.d.ts` files describe JavaScript that has no types of its own; `@types` packages are made of them.", requires: ["modules", "objects"], check: "Write a `.d.ts` for a small untyped module and use it.", minutes: 30, resources: [HB("declaration-files/introduction.html", "Declaration Files")] },
    { id: "p-client", title: "Project: validated API client", kind: "project", stage: "runtime", summary: "A typed client for a public JSON API that validates every response and returns Result values, with a .d.ts for one untyped dependency.", requires: ["zod", "errors", "dts"], check: "A changed API response is caught at runtime with a typed error, never a crash deep inside.", minutes: 120 },

    // ---------- On the server ----------
    { id: "node", title: "Node runs TypeScript", kind: "skill", stage: "server", summary: "Node strips types and runs `.ts` files directly; `tsc` stays the checker. Files, env vars and streams, typed.", requires: ["setup", "resolution", "classes"], check: "Run a Node script that reads a file and an env var, with the env var validated.", minutes: 40, resources: [FC(13, "Node.js with TypeScript"), { title: "Node: TypeScript", url: "https://nodejs.org/api/typescript.html" }] },
    { id: "bun", title: "Bun as runtime and toolkit", kind: "skill", stage: "server", summary: "Bun runs TypeScript, installs packages and tests in one tool; know when to pick it over Node.", requires: ["node"], check: "Port a Node script to Bun and run its tests with `bun test`.", minutes: 30, resources: [FC(14, "Bun")] },
    { id: "testing", title: "Testing, including types", kind: "skill", stage: "server", summary: "Unit tests with Vitest or node:test, and type tests that fail the build when a type changes.", requires: ["node", "generics"], check: "Write a test for a function and a type test for its return type.", minutes: 40, resources: [{ title: "Vitest guide", url: "https://vitest.dev/guide/" }] },
    { id: "http", title: "A typed HTTP server", kind: "skill", stage: "server", summary: "Routes whose inputs are validated at the boundary and whose handlers return typed responses.", requires: ["node", "zod", "errors"], check: "Add a POST route that rejects a bad body with a 400 and a useful message.", minutes: 45, resources: [{ title: "Hono: Getting started (Node.js)", url: "https://hono.dev/docs/getting-started/nodejs" }, { title: "Hono: Validation", url: "https://hono.dev/docs/guides/validation" }] },
    { id: "db", title: "A typed database layer", kind: "skill", stage: "server", summary: "Postgres from TypeScript with a typed query builder or ORM (Drizzle), migrations, and parameterised queries.", requires: ["node", "zod"], check: "Schema, migration and typed queries for the REST service, with a test database.", minutes: 50, resources: [{ title: "Drizzle ORM docs", url: "https://orm.drizzle.team/docs/overview" }, { title: "Postgres tutorial", url: "https://www.postgresql.org/docs/current/tutorial.html" }] },
    { id: "p-service", title: "Project: typed REST service", kind: "project", stage: "server", summary: "A small REST service with validated input, typed errors and tests, runnable on Node or Bun.", requires: ["http", "testing", "bun", "db"], check: "Tests pass on Node and Bun, invalid requests get typed 4xx errors, and it runs in Docker.", minutes: 150 },

    // ---------- Web and AI apps ----------
    { id: "nextjs", title: "Next.js App Router", kind: "skill", stage: "web", summary: "Pages, layouts and route handlers in TypeScript, with Next's typed params and routes.", requires: ["async", "modules"], check: "Build a page with a typed dynamic segment and a route handler it calls.", minutes: 60, resources: [FC(16, "Next.js App Router"), { title: "Next.js docs", url: "https://nextjs.org/docs/app" }] },
    { id: "server-client", title: "Server vs client components", kind: "concept", stage: "web", summary: "Server components run only on the server; client components ship to the browser; props crossing between them must be serializable.", requires: ["nextjs", "erasure"], check: "Say which side a component runs on and what may cross the boundary.", minutes: 30, resources: [{ title: "Next.js: Server and Client Components", url: "https://nextjs.org/docs/app/getting-started/server-and-client-components" }, { title: "React: 'use client'", url: "https://react.dev/reference/rsc/use-client" }] },
    { id: "ai-sdk", title: "AI SDK: generate, stream, structure", kind: "skill", stage: "web", summary: "Call a model, stream its answer, and get output validated against a Zod schema.", requires: ["async", "zod"], check: "Stream an answer from Claude, then get a typed object back with a schema.", minutes: 45, resources: [FC(17, "AI SDK core"), { title: "AI SDK docs", url: "https://ai-sdk.dev/docs/introduction" }] },
    { id: "tools", title: "Tools and agents", kind: "skill", stage: "web", summary: "Typed tools the model can call, and an agent loop that runs until the task is done.", requires: ["ai-sdk", "generics"], check: "Give the model a typed tool and let it call it twice to finish a task.", minutes: 45, resources: [FC(18, "Tools and agents")] },
    { id: "chat-ui", title: "Streaming chat UI", kind: "skill", stage: "web", summary: "A route handler and a client component that stream a chat, typed end to end.", requires: ["ai-sdk", "server-client"], check: "Chat with the model in your own page, with the answer streaming in.", minutes: 60, resources: [FC(19, "A streaming chat UI")] },
    { id: "mcp", title: "MCP servers and clients", kind: "skill", stage: "web", summary: "Expose tools and data once over the Model Context Protocol, and use them from any AI app.", requires: ["tools", "zod"], check: "Build an MCP server with one tool and call it from the AI SDK.", minutes: 60, resources: [FC(20, "MCP"), { title: "MCP TypeScript SDK", url: "https://github.com/modelcontextprotocol/typescript-sdk" }] },
    { id: "p-capstone", title: "Capstone: ship an AI app", kind: "project", stage: "web", summary: "One app that uses it all: strict TypeScript, Zod, Next.js, the AI SDK and your own MCP server, deployed.", requires: ["chat-ui", "mcp", "testing"], check: "It's live, typed end to end, and `tsc --noEmit` is clean.", minutes: 300, resources: [FC(21, "Build and ship")] }
  ]
}

const minutes = (s: StrategyInput) => s.nodes.filter((n) => !n.optional).reduce((a, n) => a + (n.minutes ?? 30), 0)
// Realistic time, not lesson time: lessons x2 (practice, re-dos), projects x1.5 (they overrun),
// exam prep x3, plus 10% for spaced reviews. Extras don't count.
export function realHours(c: { exam?: boolean; strategy: StrategyInput }): number {
  let h = 0
  for (const n of c.strategy.nodes) {
    if (n.optional) continue
    const m = (n.minutes ?? 30) / 60
    h += c.exam ? m * 3 : n.kind === "project" ? m * 1.5 : m * 2
  }
  return Math.round(h * 1.1)
}
const course = (c: Omit<Course, "hours" | "step" | "realHours">): Omit<Course, "step"> => ({ ...c, hours: Math.round(minutes(c.strategy) / 60), realHours: realHours(c) })

// Pieces of a bigger map as a course of their own: the stages given, prerequisites outside them
// dropped, nodes patched or added.
function pick(s: StrategyInput, stages: string[], o: { summary: string; approach: string; patch?: Record<string, Partial<CourseNode>>; add?: CourseNode[] }): StrategyInput {
  const nodes = [...(o.add ?? []), ...s.nodes.filter((n) => stages.includes(n.stage))]
  const ids = new Set(nodes.map((n) => n.id))
  return {
    summary: o.summary,
    approach: o.approach,
    stages: s.stages.filter((st) => stages.includes(st.id)),
    nodes: nodes.map((n) => {
      const p = { ...n, ...o.patch?.[n.id] }
      return { ...p, requires: (p.requires ?? []).filter((r) => ids.has(r)) }
    })
  }
}
const iacCicd = pick(mlopsIac, ["iac", "script", "cicd"], {
  summary: "Automate infrastructure and delivery: expert-level Terraform (and when CDK or CloudFormation fit), Bash and Python tooling for self-service, and CI/CD built for AI apps with evals as gates, versioned prompts and progressive delivery.",
  approach: "Anything done by hand is undocumented, unrepeatable and unreviewable, so it becomes code in a repo that a pipeline runs. Terraform declares infrastructure and shows a plan before changing anything; pipelines declare how code, prompts and models reach production. Projects use the apps from earlier courses."
})
const mlops = pick(mlopsIac, ["mlops"], {
  summary: "The ML lifecycle as a loop: versioning data and models, experiment tracking, registries, deployment, monitoring, drift detection and retraining.",
  approach: "A model is a snapshot of past data, so as the world drifts its quality silently drops; MLOps is the machinery that notices and responds. Each node adds one piece of that loop, ending with a small model that retrains itself when drift is detected, with a human approving promotion."
})
const scenarios = awsCerts.nodes.find((n) => n.id === "t-scenarios")!
const awsProCerts = pick(awsCerts, ["sap", "aip"], {
  summary: "The two Professional certifications: Solutions Architect – Professional for enterprise design, and Generative AI Developer – Professional as the AI credential.",
  approach: "Professional exams are long scenarios where every answer is plausible and one constraint decides. Each domain is learned from the official guide, anchored in what you built in the path, and drilled with scenario questions where you say why each wrong option loses. A timed practice exam closes each stage.",
  add: [{ ...scenarios, stage: "sap" }],
  patch: { "sap-wa": { requires: ["t-scenarios"] }, "aip-1": { requires: ["t-scenarios"] } }
})
const awsMlCerts = pick(awsCerts, ["aif", "mla"], {
  summary: "The AI Practitioner and Machine Learning Engineer – Associate certifications, domain by domain.",
  approach: "Scenario questions test judgement, not trivia. Each domain is learned from the official exam guide and drilled with exam-style questions; a timed practice exam closes each stage. The ML Engineer exam assumes the ML fundamentals side quest."
})

// Join several maps into one course (unique stage/node ids required).
function merge(meta: { summary: string; approach: string }, parts: StrategyInput[], patch?: Record<string, Partial<CourseNode>>, stageOrder?: string[]): StrategyInput {
  const stages: StrategyInput["stages"] = []
  const seen = new Set<string>()
  for (const p of parts) for (const st of p.stages) if (!seen.has(st.id)) { seen.add(st.id); stages.push(st) }
  if (stageOrder?.length) stages.sort((a, b) => {
    const ia = stageOrder.indexOf(a.id), ib = stageOrder.indexOf(b.id)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
  })
  const nodes = parts.flatMap((p) => p.nodes)
  const ids = new Set(nodes.map((n) => n.id))
  if (ids.size !== nodes.length) throw new Error("merge: duplicate node ids")
  return {
    summary: meta.summary,
    approach: meta.approach,
    stages,
    nodes: nodes.map((n) => {
      const p = { ...n, ...patch?.[n.id] }
      return { ...p, requires: [...new Set(p.requires ?? [])].filter((r) => ids.has(r)) }
    })
  }
}
const _pick = { summary: "", approach: "" }
// Give a picked stage its own id and title (Linux is the shell stage, named as its own step).
function moved(s: StrategyInput, from: string, stage: { id: string; title: string; outcome: string }): StrategyInput {
  return {
    ...s,
    stages: s.stages.map((st) => (st.id === from ? stage : st)),
    nodes: s.nodes.map((n) => (n.stage === from ? { ...n, stage: stage.id } : n))
  }
}
const linux = moved(pick(devEssentials, ["shell"], _pick), "shell", {
  id: "linux",
  title: "Linux",
  outcome: "Work on a machine from the shell: files, processes, pipes, and SSH."
})
// One course, this order: TypeScript, Python, cloud (Terraform then Kubernetes), Linux, Go, platform SWE.
const dachRemote = merge(
  { summary: dachRemoteCore.summary, approach: dachRemoteCore.approach },
  [
    dachRemoteCore,
    linux,
    pick(devEssentials, ["sql"], _pick),
    pick(gitDocker, ["docker"], _pick),
    pick(awsSaa, ["core", "arch"], { ..._pick, patch: { "saa-exam": { optional: true } } }),
    pick(mlopsIac, ["iac"], _pick)
  ],
  {
    "redis-patterns": { requires: ["sql-app"] },
    "queues-jobs": { requires: ["redis-patterns", "transactions"] },
    "gha-pipelines": { requires: ["compose"] },
    "oidc-deploy": { requires: ["gha-pipelines", "iam-deep"] },
    "otel-apps": { requires: ["gha-pipelines", "observe-aws"] },
    "p-ship-path": { requires: ["oidc-deploy", "otel-apps", "p-jobs", "p-tf"] },
    "p-secure": { requires: ["secure-review", "p-ship-path"] }
  },
  ["ts-craft", "py-light", "iac", "k8s", "linux", "go", "mindset", "react-next", "node-api", "quality", "sql", "data-runtime", "docker", "core", "arch", "delivery", "product-craft", "secure"]
)

export const PHASES = [
  { id: 1, title: "Foundations", note: "The languages and tools everything else stands on." },
  { id: 2, title: "Billable product engineer", note: "After this phase you can take contracts: full-stack with AI features on AWS, your own SaaS as proof." },
  { id: 3, title: "Cloud and AI depth", note: "Agents, quality, infrastructure as code, Kubernetes and AWS for agents, learned while billing." },
  { id: 4, title: "Credentials", note: "The Professional certifications, on top of real experience." },
  { id: 0, title: "Side quests", note: "Worth doing, not on the critical path. Any time." }
]

// The product engineer path (cloud & AI), in priority order. `after` is advisory: a course can
// start any time, and Tutor's first probe finds what you already have.
const path = [
  // Phase 1: foundations
  course({ id: "python", phase: 1, practice: true, title: "Python, the whole language", blurb: "Names and objects to typed, tested, packaged code and concurrency, learned by writing code.", ask: "Learn Python properly, the whole language, by writing code: data structures, functions, objects and the data model, typing, testing, packaging and concurrency.", strategy: python }),
  course({ id: "git-docker", phase: 1, after: ["python"], title: "Git and Docker, for every project", blurb: "Branches, PRs and undoing anything; small, safe images and Compose. From here on every project is versioned and containerized.", ask: "Use Git, GitHub and Docker well enough that every project I build is versioned with pull requests and containerized.", strategy: gitDocker }),
  course({ id: "dev-essentials", phase: 1, practice: ["dsa"], after: ["python"], title: "Developer essentials", blurb: "The terminal and Linux, SQL and Postgres, HTTP and web security, data structures and algorithms (interview practice optional), and system design.", ask: "Get the working-developer essentials solid: the shell, SQL and Postgres, HTTP and web security, data structures and algorithms, and system design.", strategy: devEssentials }),
  course({ id: "js-react", phase: 1, practice: ["js"], after: ["git-docker"], title: "JavaScript, the web and React", blurb: "Semantic HTML and modern CSS, JavaScript's real model (closures, this, prototypes, the event loop, promises), the DOM, and React up to a tested app.", ask: "Learn the web platform, JavaScript itself and React properly, as the foundation for TypeScript.", strategy: jsReact }),
  course({ id: "typescript", phase: 1, practice: true, after: ["js-react"], title: "TypeScript, the whole language", blurb: "From what a type is to shipping a typed AI app: strict mode, generics, utility types and more, following your TypeScript Field Course.", ask: "Learn TypeScript properly, the whole language, well enough to build and ship typed server, web and AI apps.", strategy: typescript }),
  // Phase 2: billable product engineer
  course({ id: "python-ai", phase: 2, practice: ["async"], after: ["python", "dev-essentials"], title: "AI backends in Python", blurb: "Async Python, Pydantic v2, FastAPI, LLM fundamentals (context, routing, token economics, OpenAI/Anthropic/Gemini), and a fast tool-calling API on a cloud function.", ask: "Build AI backends in Python: async, Pydantic v2 for strict validation and tool schemas, FastAPI for agent APIs and tool servers, LLM fundamentals, and deploy a high-performance async tool-calling API on a cloud function.", strategy: pythonAi }),
  course({ id: "ts-agents", phase: 2, after: ["typescript", "python-ai"], title: "TypeScript agents: AI SDK and MCP", blurb: "ToolLoopAgent, loop control and approvals, MCP servers and clients with the official SDK, and a filesystem agent streaming into Next.js.", ask: "Build production agents in TypeScript with the AI SDK's ToolLoopAgent and the MCP SDK, and stream them into a Next.js frontend.", strategy: tsAgents }),
  course({ id: "aws-saa", phase: 2, after: ["dev-essentials", "git-docker"], exam: true, title: "AWS foundations and Solutions Architect – Associate", blurb: "The core AWS services hands-on (compute, containers, serverless, storage, databases, networking, security, cost), then the SAA-C03 exam domains, ending with your SaaS deployed well-architected.", ask: "Learn AWS properly and pass the Solutions Architect – Associate exam, deploying my own app well-architected.", strategy: awsSaa }),
  course({ id: "saas-builder", phase: 2, after: ["typescript", "aws-saa"], title: "Localized SaaS builder", blurb: "Find a niche English-only founders ignore, validate it, build it (auth, teams, billing through a merchant of record, jobs, analytics), make localization the moat, launch to paying users.", ask: "Build and launch a localized SaaS as a solo developer, from a validated niche to paying users in several languages.", strategy: saasBuilder }),
  course({ id: "multilingual", phase: 2, after: ["saas-builder", "python-ai"], title: "Multilingual software and language AI", blurb: "Your languages as an engineering specialty: Unicode in depth, internationalization engineering (CLDR, ICU, plurals, pipelines), and language AI measured across Hungarian, German, Spanish, Hebrew and Chinese.", ask: "Make languages my engineering specialty: Unicode, internationalization and multilingual AI, measured across my languages.", strategy: multilingual }),
  course({ id: "dach-remote", phase: 2, practice: ["ts-craft", "react-next", "node-api", "quality", "py-light"], after: ["typescript", "js-react"], title: "Platform path", blurb: "The standard path: TypeScript, Python, cloud (Kubernetes and Terraform), Linux, Go, then platform-leaning SWE. Short lessons, one check each.", ask: "Follow the platform path in order: TypeScript, Python, cloud with Kubernetes and Terraform, Linux, Go, then platform-leaning software engineering.", strategy: dachRemote }),
  course({ id: "contracting", phase: 2, title: "The contracting business", blurb: "Working as an egyéni vállalkozó for Austrian and Swiss clients: positioning, profiles, finding clients, rates, contracts, tax and VAT setup with your accountant, risks and money.", ask: "Run my engineering work as a contracting business for Austrian and Swiss clients, as a Hungarian sole trader.", strategy: contracting }),
  // Phase 3: cloud and AI depth
  course({ id: "agents-rag", phase: 3, after: ["python-ai"], title: "Agent orchestration and RAG", blurb: "LangGraph agents that loop, branch and pause for you; RAG from chunking to vector search with FastMCP and Pydantic; a multi-agent research system.", ask: "Orchestrate agents with LangGraph and build RAG pipelines (chunking, embeddings, vector search) with FastMCP and Pydantic, up to a multi-agent research system.", strategy: agentsRag }),
  course({ id: "ai-quality", phase: 3, after: ["agents-rag"], title: "AI quality: evals, observability, security", blurb: "Evals from real error analysis, validated LLM judges, agent evaluation, production tracing and budgets, prompt injection defences and a red-team of your own agent.", ask: "Make AI systems I can trust: evals, observability, and security against prompt injection and excessive agency.", strategy: aiQuality }),
  course({ id: "iac-cicd", phase: 3, after: ["aws-saa"], title: "Terraform and CI/CD", blurb: "Expert-level Terraform (modules, state, refactoring, testing, policy), Bash and Python tooling for self-service, and CI/CD for AI apps with evals as gates and progressive delivery.", ask: "Master infrastructure as code with Terraform and CI/CD for AI applications.", strategy: iacCicd }),
  course({ id: "k8s-agents", phase: 3, after: ["aws-saa", "python-ai"], title: "Kubernetes for AI agents", blurb: "Agents as containers, the Gateway API Inference Extension, SPIFFE/SPIRE agent identity, default-deny namespaces and resource limits.", ask: "Run AI agents as containers on Kubernetes, with inference routing, agent identity and locked-down namespaces.", strategy: k8sAgents }),
  course({ id: "aws-agents", phase: 3, after: ["k8s-agents", "agents-rag"], title: "AWS for agentic AI", blurb: "Bedrock multi-agent orchestration, AgentCore (microVM sessions, memory, gateway, identity, policy), agents on EKS with AWS's own path and workshops.", ask: "Go deep on AWS for agents: Amazon Bedrock multi-agent orchestration, Bedrock AgentCore, and deploying and scaling autonomous agents on Amazon EKS.", strategy: awsAgents }),
  // Phase 4: credentials
  course({ id: "aws-pro-certs", phase: 4, after: ["aws-saa", "aws-agents", "iac-cicd"], exam: true, title: "AWS Professional certifications", blurb: "Solutions Architect – Professional and Generative AI Developer – Professional, domain by domain with exam-style drills and timed practice exams.", ask: "Pass AWS Solutions Architect – Professional and Generative AI Developer – Professional.", strategy: awsProCerts }),
  // Side quests: worth it, not on the critical path
  course({ id: "ml-fundamentals", phase: 0, after: ["python"], title: "Machine learning and deep learning", blurb: "The math you need, classic ML with scikit-learn, PyTorch from backprop up, and inside LLMs: build a tiny GPT, fine-tune with LoRA, run models locally.", ask: "Understand how models actually work: the math, classic machine learning, deep learning with PyTorch, and how LLMs are built, fine-tuned and run.", strategy: mlFundamentals }),
  course({ id: "mlops", phase: 0, after: ["ml-fundamentals", "iac-cicd"], title: "MLOps", blurb: "The ML lifecycle: versioning data and models, experiment tracking with MLflow, registries, deployment, monitoring, drift detection and retraining.", ask: "Master MLOps: versioning, experiment tracking, deployment, monitoring and drift detection.", strategy: mlops }),
  course({ id: "aws-ml-certs", phase: 0, after: ["ml-fundamentals"], exam: true, title: "AWS AI Practitioner and ML Engineer – Associate", blurb: "The foundational AI certification and the ML engineering associate, domain by domain with drills and practice exams.", ask: "Pass AWS Certified AI Practitioner and Machine Learning Engineer – Associate.", strategy: awsMlCerts }),
]
let step = 0
export const COURSES: Course[] = path.map((c) => ({ ...c, step: c.phase ? ++step : 0 }))
