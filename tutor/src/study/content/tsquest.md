# Fantasy Quest: the rebuild (TypeScript)
id: tsquest
rewrite: true
blurb: The Guild rebuilds its Python tools in TypeScript: the same tiny checked tasks, and a clerk (tsc) who reads every form you hand in.
why: A second language is a port. You already own this game's rooms and rituals; each lesson moves one piece into TypeScript, the hidden tests replay your pure functions, and a type is rejected the day it is papered over.
stage: js | The runtime | The delta from Python: the console, === surprises, objects, arrays, and one pure function — before an annotation you didn't write.

## The Guild banner
id: t1-banner
stage: js
minutes: 5
goal: The clerk stamps one printed line onto Sam's registration form.
source: MDN: console | https://developer.mozilla.org/en-US/docs/Web/API/console

### Assignment

Write `banner()`. It prints exactly `The Guild Board: Fantasy Quest` — one line on the console. In Python you had `print`; the console calls here are `console.log`. It returns nothing: the clerk reads what a form prints, not what it keeps.

::: write lang=typescript
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```ts
export function banner() {
  return ""
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { banner } from "./solution"

test("the banner is one printed line", () => {
  const lines: string[] = []
  const shout = console.log
  console.log = (s: string) => void lines.push(s)
  try {
    banner()
  } finally {
    console.log = shout
  }
  assert.deepEqual(lines, ["The Guild Board: Fantasy Quest"])
})
```
solution:
```ts
export function banner() {
  console.log("The Guild Board: Fantasy Quest")
}
```
wrong: the form returns the banner instead of printing it
fail: runtime
```ts
export function banner() {
  return "The Guild Board: Fantasy Quest"
}
```
hint: `console.log(line)` prints. Say the line exactly — capital G, capital B: the board hangs by it.
:::

## The ledger of hits
id: t2-ledger
stage: js
needs: t1-banner
minutes: 5
goal: The clerk totals the battle without a `sum` field: every receipt is added by hand.
source: MDN: Array.prototype.reduce() | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce

### Assignment

Write `total(hits)`. `hits` is a list of whole numbers; return their total, starting from `0`. Python had `sum`; TypeScript has no `sum` — `reduce` is the clerk's field for a running total. An empty list totals `0`. Don't rearrange the list.

::: write lang=typescript
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```ts
export function total(hits: number[]): number {
  return 0
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { total } from "./solution"

const src = readFileSync(new URL("./solution.ts", import.meta.url), "utf8")

test("the paperwork stays clean", () => {
  for (const banned of ["@ts-ignore", "@ts-expect-error", "as any"]) {
    assert.ok(!src.includes(banned), `The clerk doesn't accept "${banned}". Make the types honest instead.`)
  }
})

test("the ledger adds a row of hits", () => {
  assert.equal(total([4, 2, 7]), 13)
  assert.equal(total([1, 1, 1, 1, 1, 1, 1, 1]), 8)
  assert.equal(total([-3, 3, 1]), 1)
})

test("an empty ledger is 0", () => {
  assert.equal(total([]), 0)
})
```
solution:
```ts
export function total(hits: number[]): number {
  return hits.reduce((acc, n) => acc + n, 0)
}
```
wrong: reduce without a starting value: it falls over on an empty ledger
fail: runtime
```ts
export function total(hits: number[]): number {
  return hits.reduce((acc, n) => acc + n)
}
```
wrong: the form came in unannotated, so the clerk can't read it hit by hit
fail: types
```ts
export function total(hits) {
  return hits.reduce((acc, n) => acc + n, 0)
}
```
hint: `hits.reduce((acc, n) => acc + n, 0)` walks the list and carries the total; the starting `0` is what an empty list totals.
:::

