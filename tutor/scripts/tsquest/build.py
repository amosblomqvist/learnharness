"""Writes src/study/content/tsquest.md, Fantasy Quest: the rebuild in TypeScript.

The generated twin of scripts/quest/ (which makes quest.md). Run: npm run build:tsquest

Rules the lessons below follow (the same contract as Fantasy Quest):
- one story line, one assignment, one link to the official page (MDN in Book I, the TypeScript
  Handbook in Book II). No explanations of our own: the linked page is the teacher.
- the starter owns every signature — noImplicitAny is on in the checker, so an unannotated
  parameter doesn't compile. The learner fills in bodies.
- every write lesson carries wrong answers. An optional fail: value says HOW the wrong answer
  must fail, and check:study enforces it: "runtime" (tsc accepts it, the tests catch it) or
  "types" (it passes the tests and the clerk — tsc — is what refuses it).
- tests may read solution.ts and reject @ts-ignore, @ts-expect-error and as any: the clerk
  doesn't accept escaped paperwork.
"""
import importlib, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ch1 import LESSONS

TITLE = "Fantasy Quest: the rebuild (TypeScript)"
HEADER = [
    "id: tsquest",
    "rewrite: true",
    "blurb: The Guild rebuilds its Python tools in TypeScript: the same tiny checked tasks, and a clerk (tsc) who reads every form you hand in.",
    "why: A second language is a port. You already own this game's rooms and rituals; each lesson moves one piece into TypeScript, the hidden tests replay your pure functions, and a type is rejected the day it is papered over.",
]
STAGES = [("js", "The runtime", "The delta from Python: the console, === surprises, objects, arrays, and one pure function — before an annotation you didn't write.")]


def fence(code, lang="ts"):
    code = code.rstrip("\n")
    assert "```" not in code
    return "```%s\n%s\n```" % (lang, code)


def emit():
    o = ["# " + TITLE] + HEADER
    for sid, t, out in STAGES:
        o.append("stage: %s | %s | %s" % (sid, t, out))
    o.append("")
    ids = [d["id"] for d in LESSONS]
    dup = {i for i in ids if ids.count(i) > 1}
    assert not dup, dup
    prev = None
    for d in LESSONS:
        where = "%s›%s" % (TITLE, d["title"])
        for w in d["wrong"]:
            if w[1] not in (None, "runtime", "types"):
                raise ValueError("%s: fail must be runtime or types, got %r" % (where, w[1]))
        o.append("## " + d["title"])
        o.append("id: " + d["id"])
        o.append("stage: " + d.get("stage", "js"))
        if prev:
            o.append("needs: " + prev)
        o.append("minutes: %d" % d.get("minutes", 5))
        o.append("goal: " + d["story"])
        o.append("source: %s | %s" % (d["doc"][0], d["doc"][1]))
        o.append("")
        o.append("### Assignment")
        o.append("")
        o.append(d["assign"])
        o.append("")
        o.append("::: write lang=typescript")
        o.append("task: Press **Run** to see the console, and **Submit** to check your code.")
        o.append("starter:")
        o.append(fence(d["starter"]))
        o.append("tests:")
        o.append(fence(d["tests"]))
        o.append("solution:")
        o.append(fence(d["solution"]))
        for why, fail, code in d["wrong"]:
            o.append("wrong: " + why)
            if fail:
                o.append("fail: " + fail)
            o.append(fence(code))
        o.append("hint: " + d["hint"])
        o.append(":::")
        o.append("")
        prev = d["id"]
    return "\n".join(o)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: build.py OUT.md")
    open(sys.argv[1], "w", encoding="utf-8").write(emit() + "\n")


if __name__ == "__main__":
    main()
