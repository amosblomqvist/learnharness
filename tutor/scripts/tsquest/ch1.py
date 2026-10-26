"""Book I of the rebuild: the runtime. The delta from Python, one task at a time.

Everything here is plain JS-flavored TypeScript first: the starter owns every signature, and the
clerk (tsc --strict) refuses unannotated forms. Wrong answers come with a fail mark:
"runtime" — tsc accepts it and the tests catch it; "types" — it runs and passes the tests,
and the clerk is what refuses it.
"""

LESSONS = []


def W(id, title, doc, story, assign, starter, tests, solution, hint, wrong=(), minutes=5, stage="js"):
    LESSONS.append(
        dict(id=id, title=title, doc=doc, story=story, assign=assign, starter=starter, tests=tests, solution=solution, hint=hint, wrong=list(wrong), minutes=minutes, stage=stage)
    )


CONSOLE_TESTS = '''import { test } from "node:test"
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
'''

LEDGER_TESTS = '''import { test } from "node:test"
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
'''

W("t1-banner",
  "The Guild banner",
  ("MDN: console", "https://developer.mozilla.org/en-US/docs/Web/API/console"),
  "The clerk stamps one printed line onto Sam's registration form.",
  "Write `banner()`. It prints exactly `The Guild Board: Fantasy Quest` — one line on the console. In Python you had `print`; the console calls here are `console.log`. It returns nothing: the clerk reads what a form prints, not what it keeps.",
  'export function banner() {\n  return ""\n}\n',
  CONSOLE_TESTS,
  'export function banner() {\n  console.log("The Guild Board: Fantasy Quest")\n}\n',
  "`console.log(line)` prints. Say the line exactly — capital G, capital B: the board hangs by it.",
  wrong=[("the form returns the banner instead of printing it", "runtime", 'export function banner() {\n  return "The Guild Board: Fantasy Quest"\n}\n')])

W("t2-ledger",
  "The ledger of hits",
  ("MDN: Array.prototype.reduce()", "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce"),
  "The clerk totals the battle without a `sum` field: every receipt is added by hand.",
  "Write `total(hits)`. `hits` is a list of whole numbers; return their total, starting from `0`. Python had `sum`; TypeScript has no `sum` — `reduce` is the clerk's field for a running total. An empty list totals `0`. Don't rearrange the list.",
  'export function total(hits: number[]): number {\n  return 0\n}\n',
  LEDGER_TESTS,
  'export function total(hits: number[]): number {\n  return hits.reduce((acc, n) => acc + n, 0)\n}\n',
  "`hits.reduce((acc, n) => acc + n, 0)` walks the list and carries the total; the starting `0` is what an empty list totals.",
  wrong=[
      ("reduce without a starting value: it falls over on an empty ledger", "runtime", 'export function total(hits: number[]): number {\n  return hits.reduce((acc, n) => acc + n)\n}\n'),
      ("the form came in unannotated, so the clerk can't read it hit by hit", "types", 'export function total(hits) {\n  return hits.reduce((acc, n) => acc + n, 0)\n}\n'),
  ])
