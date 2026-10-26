"""Writes src/study/content/workshop.md, the Fantasy Quest Workshop: open-ended projects you build in a
real folder, in your own editor, checked by hidden acceptance tests. Run: npm run build:workshop

Each project is a folder here, named like "p01-quest-log":
  meta.json    {"id", "title", "tier", "needs": ["quest/<lesson id>", ...], "minutes", "story", "folder",
                "sources": [[title, url], ...], "local": false}
  spec.md      what to build, written for the learner: the interface the tests rely on, exactly
  start/       the files the folder starts with (often nothing: README.md is added from spec.md)
  tests/       hidden acceptance tests: test_*.py, plain functions with assert (no pytest needed);
               the project folder is on sys.path and in os.environ["PROJECT_ROOT"]; write scratch
               files under os.environ["TEST_TMP"]
  solution/    a reference solution; check:study proves it passes and start/ doesn't
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TIERS = [
    ("tools", "Command-line tools", "Programs with a front door: arguments in, files on disk, a clear exit code."),
    ("games", "Interactive programs", "A loop that reads what you type and keeps state between turns."),
    ("data", "Working with data", "Logs, CSV and JSON in; answers and reports out."),
    ("packages", "Packages and tests", "A project in several modules, with tests you write yourself."),
    ("web", "Web services", "An HTTP API over a database, first with the standard library, then FastAPI."),
    ("ship", "Shipping", "A tool for your own machine: logging, configuration, and running it for real."),
]
FIELD_KEYS = {"q", "why", "answer", "task", "starter", "tests", "solution", "hint", "wrong", "test", "expect", "verify", "file", "check", "code", "setup", "types", "peersetup", "peerverify", "scripted"}


def read_tree(root):
    out = {}
    if not os.path.isdir(root):
        return out
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in ("__pycache__", ".venv", ".pytest_cache"))
        for f in sorted(files):
            if f.endswith(".pyc") or f == ".DS_Store":
                continue
            full = os.path.join(dirpath, f)
            out[os.path.relpath(full, root)] = open(full, encoding="utf-8").read()
    return out


def fenced(body, where):
    body = body.rstrip("\n")
    fence = "~~~" if "```" in body else "```"
    assert "~~~" not in body, "%s: a file can't contain ~~~" % where
    if fence == "~~~":
        assert body.count("```") % 2 == 0, "%s: unbalanced ``` fences" % where
    for line in body.split("\n"):
        key = line.split(":", 1)[0]
        assert not (":" in line and key in FIELD_KEYS and line.startswith(key + ":")), "%s: a line starts with '%s:', which the lesson parser would read as a field" % (where, key)
    return "%s\n%s\n%s" % (fence, body, fence)


def project(d):
    meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8"))
    spec = open(os.path.join(d, "spec.md"), encoding="utf-8").read().strip()
    start = read_tree(os.path.join(d, "start"))
    start.setdefault("README.md", spec + "\n")
    tests = read_tree(os.path.join(d, "tests"))
    solution = read_tree(os.path.join(d, "solution"))
    assert tests and all(os.path.basename(t).startswith("test_") for t in tests), "%s: tests/ needs test_*.py files" % d
    assert solution, "%s: solution/ is empty" % d
    assert meta["tier"] in [t[0] for t in TIERS], "%s: unknown tier" % d
    o = ["## " + meta["title"], "id: " + meta["id"], "stage: " + meta["tier"]]
    if meta.get("needs"):
        o.append("needs: " + ", ".join(meta["needs"]))
    o.append("minutes: %d" % meta.get("minutes", 180))
    o.append("goal: " + meta["story"])
    for t, u in meta.get("sources", []):
        o.append("source: %s | %s" % (t, u))
    o.append("project: true")
    o.append("")
    o.append("### The job")
    o.append("")
    o.append("Build it from a blank folder, in your own editor. The spec is on the right; it's also the folder's README. **Check** runs the hidden acceptance tests against your folder. Commit your work with git as you go.")
    o.append("")
    o.append("::: project folder=%s%s" % (meta["folder"], " local=true" if meta.get("local") else ""))
    o.append("task: |")
    o += ["  " + l if l.strip() else "" for l in spec.split("\n")]
    for rel, body in start.items():
        o.append("file: " + rel)
        o.append(fenced(body, d + "/start/" + rel))
    for rel, body in tests.items():
        o.append("test: " + os.path.basename(rel))
        o.append(fenced(body, d + "/tests/" + rel))
    for rel, body in solution.items():
        o.append("solution: " + rel)
        o.append(fenced(body, d + "/solution/" + rel))
    if meta.get("hint"):
        o.append("hint: " + meta["hint"])
    o.append(":::")
    o.append("")
    return meta["tier"], meta["id"], "\n".join(o)


def main(out_path):
    dirs = sorted(x for x in os.listdir(HERE) if os.path.isdir(os.path.join(HERE, x)) and os.path.exists(os.path.join(HERE, x, "meta.json")))
    parts = [project(os.path.join(HERE, x)) for x in dirs]
    ids = [p[1] for p in parts]
    assert len(ids) == len(set(ids)), "duplicate project ids"
    order = [t[0] for t in TIERS]
    parts.sort(key=lambda p: order.index(p[0]))  # stable: folder order within a tier
    used = {p[0] for p in parts}
    head = [
        "# Fantasy Quest: The Workshop",
        "id: workshop",
        "blurb: Real projects, built from a blank folder in your own editor and checked by hidden acceptance tests: command-line tools, an interactive game, data tools, a tested package, a web API, and a tool for your own machine.",
        "why: You learn to program by writing a lot of code from nothing. Each project unlocks when Fantasy Quest has taught what it needs; then it's your design, your files, your git history.",
    ]
    for t in TIERS:
        if t[0] in used:
            head.append("stage: %s | %s | %s" % t)
    open(out_path, "w", encoding="utf-8").write("\n".join(head) + "\n\n" + "\n".join(p[2] for p in parts))
    print(len(parts), "projects")


if __name__ == "__main__":
    main(sys.argv[1])
