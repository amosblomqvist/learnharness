// Premade lesson bodies for dach-remote. Shown at once. No model call.
export type LessonBody = { idea: string; use: string; miss: string }

export const DACH_LESSONS: Record<string, LessonBody> = {
  "t-ai-drafts": {
    idea: 'The model writes most of the syntax. You own whether it is right, safe, and what you meant.',
    use: 'Before you accept a diff, name the invariant it must keep.',
    miss: 'A green build is not a review. The usual miss is an edge case, an auth check, or a silenced type.'
  },
  "review-ai": {
    idea: 'Review a diff for intent, edges, types, errors, security, and tests. Then decide if you would merge it.',
    use: 'Read the change as if you will be on call for it.',
    miss: 'Commenting on style and missing the bug that ships.'
  },
  "direct-verify": {
    idea: 'Write a short plan with constraints and a check. Run the check before you call it done.',
    use: 'A vague request becomes a plan, plus a test that fails if the plan was not followed.',
    miss: 'Trusting the summary in the reply instead of running the check.'
  },
  "p-mindset": {
    idea: 'Take a broken AI-drafted feature. Find the bug, fix it, and leave a regression test.',
    use: 'Start from a failing test that shows the bug, then make it pass.',
    miss: 'Rewriting the file without a test that failed first.'
  },
  "t-types-design": {
    idea: 'A good type makes an illegal state hard to write. any is wallpaper.',
    use: 'Model the cases as a union so a forgotten case is a compile error.',
    miss: 'Adding as or any to make the error go away.'
  },
  "read-errors": {
    idea: 'A long TypeScript error is one mismatch: assignability, a generic, or a missing narrow.',
    use: 'Read the first line that names the two types. Fix that, not the cascade under it.',
    miss: 'Silencing the checker instead of naming the mismatch.'
  },
  "domain-types": {
    idea: 'Branded ids, result unions, and exhaustive switches keep the domain honest.',
    use: 'A cancelled order should not type-check as shippable.',
    miss: 'A string status field that any string can sneak into.'
  },
  "debug-ts": {
    idea: 'Typed code still crashes when a boundary skipped validation or an assertion lied.',
    use: 'Find the place data entered the program and was trusted.',
    miss: 'Debugging the crash site instead of the boundary that let bad data in.'
  },
  "p-ts-review": {
    idea: 'Take a module full of any. Make the types tell the truth and keep the behaviour.',
    use: 'strict on, no unchecked any, one type test that fails if the API widens.',
    miss: 'A clean tsc that was bought with assertions.'
  },
  "t-ui-state": {
    idea: 'UI bugs are usually the wrong place for state, not missing JSX.',
    use: 'Ask whether the value is state, derived, or an effect. Most of the time it is derived.',
    miss: 'Copying props into state, or using an effect as an event handler.'
  },
  "hooks-model": {
    idea: 'Hook order is fixed. Deps are the identity of an effect. Stale closures come from skipping them.',
    use: 'Diagnose a stale value, an infinite effect, and a context that re-renders everyone.',
    miss: 'Empty deps to shut the lint up.'
  },
  "rsc-model": {
    idea: 'Server Components stay on the server. Client Components ship JavaScript. Only serializable props cross.',
    use: 'Put the secret and the database read on the server. Put the click handler on the client.',
    miss: 'Sprinkling use client on every file.'
  },
  "next-data": {
    idea: 'Fetch, cache, and revalidate are the data flow. A mutation must invalidate what it changed.',
    use: 'If the page is stale after a save, the cache was not told.',
    miss: 'Fetching in a client effect what the server component could have loaded.'
  },
  "react-perf": {
    idea: 'Measure first. The usual costs are a waterfall, a huge render, or a bundle, not a missing memo.',
    use: 'Name the top two causes and the smallest fix.',
    miss: 'Memoising everything.'
  },
  "diagnose-react": {
    idea: 'Hydration errors, bad keys, and effect loops have a trail from symptom to the line.',
    use: 'Walk one hydration mismatch and one infinite render down to the cause.',
    miss: 'Suppressing the warning.'
  },
  "p-next-fix": {
    idea: 'A Next app with planted bugs. You verify each fix. A patch you did not check does not count.',
    use: 'One note per bug: symptom, cause, check.',
    miss: 'Accepting an AI patch because the page looks fine once.'
  },
  "t-boundaries-api": {
    idea: 'Anything outside the process is untyped until you parse it. Handlers stay thin.',
    use: 'Name the inputs an endpoint must reject, and what happens if it does not.',
    miss: 'Trusting the JSON body because TypeScript said it was a type.'
  },
  "node-runtime": {
    idea: 'Services fail in logs: a hang, an unhandled rejection, a process that never shuts down.',
    use: 'Map an error type to an HTTP status. Log the cause, not only the status.',
    miss: 'A catch that logs and continues as if the request worked.'
  },
  "nest-model": {
    idea: 'Modules, providers, and controllers are a map. Business logic does not live in the controller.',
    use: 'Spot a circular dependency and a fat controller, and say where the code should move.',
    miss: 'Memorising decorators instead of the boundary.'
  },
  "api-authz": {
    idea: 'Authn says who you are. Authz says what you may touch. Tenant bugs are the expensive ones.',
    use: 'A get-by-id must check that this caller owns that id.',
    miss: 'Checking the token and then loading any row.'
  },
  "api-design-review": {
    idea: 'Judge an API by idempotency, pagination, error bodies, and what a change breaks.',
    use: 'Mark a diff: unsafe, unclear, or not ready.',
    miss: 'Approving a POST that retries would double-charge.'
  },
  "p-nest-api": {
    idea: 'One slice: validated input, a domain service, an authz test, a documented happy path.',
    use: 'Invalid bodies are 400. Cross-tenant reads are denied, with a test.',
    miss: 'A happy path and no test for the denial.'
  },
  "zod-contracts": {
    idea: 'A Zod schema is the runtime contract. z.infer is the type. They cannot drift.',
    use: 'Parse env and a webhook body. Show a case the TypeScript type alone would have trusted.',
    miss: 'A type annotation with no parse at the edge.'
  },
  "vitest-behaviour": {
    idea: 'Test what the caller observes, not which helper was called.',
    use: 'Rewrite one weak test so it fails when the bug returns.',
    miss: 'Asserting a mock was called and never the result.'
  },
  "playwright-journeys": {
    idea: 'An end-to-end test walks a path that makes money or loses data. Wait for the UI. Do not sleep.',
    use: 'Design the journey. Say what is real and what is fake.',
    miss: 'A brittle selector and a test that only passes on your machine.'
  },
  "test-strategy": {
    idea: 'Put each risk at the cheapest layer that can catch it. A false green is expensive.',
    use: 'Assign risks to unit, integration, or end-to-end, and skip one on purpose.',
    miss: 'Only end-to-end tests, or only unit tests of private functions.'
  },
  "p-quality": {
    idea: 'Zod at the edges, Vitest on the rules, one Playwright journey, and CI that fails on each.',
    use: 'A type error, a unit failure, and an end-to-end failure should fail separately.',
    miss: 'Tests that pass locally and are not in the pipeline.'
  },
  "t-py-secondary": {
    idea: 'You prefer TypeScript. You still have to read and fix a FastAPI service.',
    use: 'Choose FastAPI when the service already is Python. Choose Nest when the team is TypeScript.',
    miss: 'Treating Python as write-only.'
  },
  "py-typing-read": {
    idea: 'Type hints and Pydantic models are the contract. A 422 is the model rejecting the body.',
    use: 'Read a validation error and fix the field, not the whole app.',
    miss: 'A type ignore on the line that was telling the truth.'
  },
  "fastapi-read": {
    idea: 'Path operations, Depends, and status codes are enough to navigate a service.',
    use: 'Find why a route returns 422 instead of 500, and where auth belongs.',
    miss: 'Auth copied into every function instead of a dependency.'
  },
  "pytest-read": {
    idea: 'A regression test fails before the fix and passes after. That is the point.',
    use: 'Add the test first. Watch it fail. Then change the code.',
    miss: 'A test written after the fix that never failed.'
  },
  "p-fastapi-fix": {
    idea: 'A small FastAPI service with real bugs. You direct the fix and verify with pytest.',
    use: 'Green tests, a one-line cause for each bug, no unexplained type ignore.',
    miss: 'Patching until the error disappears without knowing why.'
  },
  "redis-patterns": {
    idea: "Cache is a copy. It can be stale, and it can leak one user's data to another.",
    use: 'Key by tenant. Set a TTL. Never store the only copy of something you must not lose.',
    miss: 'A cache key that forgets the user id.'
  },
  "queues-jobs": {
    idea: 'Slow work leaves the request. Delivery is at least once, so the job must be safe to run twice.',
    use: 'An idempotency key, retries, and a dead letter.',
    miss: 'A job that charges again on every retry.'
  },
  "data-consistency": {
    idea: 'The row, the cache, and the job can disagree. The job can run before the commit is visible.',
    use: 'Publish the job from the same transaction, or after you know the commit landed.',
    miss: 'Deleting the cache and assuming the next read is fresh.'
  },
  "p-jobs": {
    idea: 'A queued feature you can kill in the middle and restart without a double side effect.',
    use: 'Kill the worker, start it, show the side effect happened once.',
    miss: 'A demo that only works when nothing crashes.'
  },
  "t-outcome-product": {
    idea: 'A contractor is hired for an outcome. The ticket list is not the outcome.',
    use: 'Rewrite a ticket pile into one sentence a decision-maker would recognise.',
    miss: 'Reporting activity instead of the result.'
  },
  "prd-writing": {
    idea: 'A PRD is problem, users, non-goals, requirements, metric, and risks. One sitting.',
    use: 'Non-goals should kill at least two tempting extras.',
    miss: 'A spec that lists every idea and decides nothing.'
  },
  "mvp-scope": {
    idea: 'The MVP is the slice that teaches you something or makes money. The rest is a parking lot.',
    use: 'Cut a wishlist to two weeks. Name the risk of each cut.',
    miss: 'Saying yes to keep the relationship, then slipping the date.'
  },
  "b2b-ux": {
    idea: 'B2B tools need roles, empty states, and an audit trail. Clarity beats delight.',
    use: 'Find five changes that would cut support tickets.',
    miss: 'A consumer layout that hides who can do what.'
  },
  "metrics-product": {
    idea: 'One metric that would prove the slice worked. One vanity metric you will ignore.',
    use: 'Pick it before you build, or you will pick the number that moved.',
    miss: 'Page views as success.'
  },
  "stakeholder-comms": {
    idea: 'Status is short. Risk is early. A decision is two options and a recommendation.',
    use: 'Write a weekly note that asks for one decision.',
    miss: 'A surprise slip on the day it is due.'
  },
  "p-prd-slice": {
    idea: 'One-page PRD, a cut MVP, a working slice, and a demo note.',
    use: 'End with what you would have cut sooner.',
    miss: 'Building the parking lot.'
  },
  "gha-pipelines": {
    idea: 'CI runs typecheck, test, and build on the branch you want to merge. A red check blocks it.',
    use: 'Find secrets in the workflow, a flaky setup, and a job that should fail fast.',
    miss: 'A pipeline that is green because a step was skipped.'
  },
  "oidc-deploy": {
    idea: 'The workflow assumes a cloud role for a few minutes. No long-lived key in the repo.',
    use: 'Say what a stolen access key could do that this role cannot.',
    miss: 'An AWS key in GitHub secrets because it was faster.'
  },
  "otel-apps": {
    idea: 'Logs, metrics, and one trace across the API and the job. That is how you debug production.',
    use: 'For a slow checkout, name the first signal you open and what the trace must include.',
    miss: 'A log line with no request id.'
  },
  "p-ship-path": {
    idea: 'A failing test blocks merge. There is a deploy note. There is one alert you would wake up for.',
    use: 'Write why that alert, and what you do when it fires.',
    miss: 'An alert on CPU that pages you for nothing.'
  },
  "owasp-top10": {
    idea: 'Broken access control, injection, XSS, SSRF, misconfig, and supply chain. Look for them in the diff.',
    use: 'Point five of them at a real place in an app you have built.',
    miss: 'A checklist you never apply to the code in front of you.'
  },
  "secure-review": {
    idea: 'On a diff: trust boundary, authz, injection sink, secret, dependency.',
    use: 'File three findings with a fix each. Skip style.',
    miss: 'Nitpicks while the endpoint has no authz.'
  },
  "p-secure": {
    idea: 'Harden one surface. Add one automated check so the hole cannot come back quietly.',
    use: 'Before, after, and a test. No secrets in the branch history.',
    miss: 'A comment that says we should fix this later.'
  },
  "k8s-declare": {
    idea: 'You write what should exist. Controllers keep acting until the cluster matches.',
    use: 'Delete a Pod. The Deployment makes another. That is the model.',
    miss: 'Editing a live Pod and expecting it to stick.'
  },
  "k8s-work": {
    idea: 'A Pod runs the containers. A Deployment owns how many, and how a new version rolls out.',
    use: 'A bad rollout should stop, and a rollback should be one step.',
    miss: 'Treating a Pod name as something you deploy.'
  },
  "k8s-svc": {
    idea: 'Pods die. A Service is the name other code calls.',
    use: 'Call the Service. Do not store a Pod IP.',
    miss: 'A client hardcoded to one Pod.'
  },
  "k8s-debug": {
    idea: 'Events, logs, then the probe. Change the manifest after you know which of those failed.',
    use: 'CrashLoopBackOff is the process. A readiness failure means it is not ready for traffic.',
    miss: 'Applying a new YAML to see if the error changes.'
  },
  "go-small": {
    idea: 'A Go program is packages and functions. package main and func main are the start.',
    use: 'Read a small program from main outward.',
    miss: 'Looking for a framework before you can read the standard library.'
  },
  "go-values": {
    idea: 'Every variable starts at a zero value. A nil map cannot be written. A nil slice can be appended.',
    use: 'Say the zero of int, string, slice, and map before you use one.',
    miss: 'Assuming a missing value is an exception.'
  },
  "go-errors": {
    idea: 'An error is a return value. if err != nil is the handling.',
    use: 'Check it at the call. Wrap it with context if you pass it up.',
    miss: 'Assigning err to _.'
  },
  "go-ifaces": {
    idea: 'An interface is the methods you need. Any type with those methods fits. No declaration required.',
    use: 'io.Reader is one method, so a file, a buffer, and a request body all fit.',
    miss: 'A large interface that only one type will ever implement.'
  },
  "go-http": {
    idea: 'A handler is a function of request and response. net/http serves it.',
    use: 'Missing input is 400. The success path writes 200 and the body.',
    miss: 'Ignoring the error from writing the response.'
  },
}
