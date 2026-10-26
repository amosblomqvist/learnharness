"""Writes src/study/content/quest.md from the chapter files here. Run: npm run build:quest"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib
CHAPTERS = [
    ("intro", "Introduction", "Run code, read the console, fix your first bug."),
    ("vars", "Variables", "Store text and numbers, and change them."),
    ("funcs", "Functions", "Package an action, pass values in, get one back."),
    ("scope", "Scope", "Know which names a line of code can see."),
    ("debug", "Debugging", "Read an error, find the line, prove the fix."),
    ("computing", "Computing", "Binary, bits, flags, and why 0.1 + 0.2 isn't 0.3."),
    ("compare", "Comparisons", "Make decisions with booleans and if statements."),
    ("loops", "Loops", "Repeat work, and stop when you should."),
    ("strings", "Strings", "Clean, split, join, search and format text."),
    ("lists", "Lists", "Keep things in order."),
    ("dicts", "Dictionaries", "Look things up by name."),
    ("sets", "Sets", "Keep each thing once."),
    ("errors", "Errors", "Handle what goes wrong, and raise your own."),
    ("hints", "Type hints", "Say what goes in and what comes out."),
    ("testing", "Testing", "Write the tests yourself, and prove they catch real bugs."),
    ("practice", "Practice", "Put the chapters together in small quests."),
    ("classes", "Classes", "Model the world with types of your own: fields, methods and inheritance."),
    ("files", "Saves", "Write the game to disk, read it back, and keep it as JSON."),
    ("modules", "Modules", "Give a program a front door it can be run and imported through."),
    ("guild", "The Guild", "Assemble the pieces into a game you can play."),
    ("quiz", "Quiz", "Read code and say exactly what it prints."),
]
# Every chN.py here is a part of the course, read in number order. A file from ch7 on declares its
# own chapters in a CHAPTERS list; they go after the core chapters, before the closing Quiz, so
# several people can each add a file without touching this one.
here = os.path.dirname(os.path.abspath(__file__))
names = sys.argv[2:] or sorted((f[:-3] for f in os.listdir(here) if f.startswith("ch") and f[2:-3].isdigit() and f.endswith(".py")), key=lambda n: int(n[2:]))
for m in names:
    mod = importlib.import_module(m)
    for ch in getattr(mod, "CHAPTERS", []):
        assert ch[0] not in [c[0] for c in CHAPTERS], "chapter id %s is taken" % ch[0]
        CHAPTERS.insert(len(CHAPTERS) - 1, ch)
used = {c for c, _ in lib.LESSONS}
unknown = used - {c[0] for c in CHAPTERS}
assert not unknown, "lessons in chapters nobody declared: %s" % unknown
chapters = [c for c in CHAPTERS if c[0] in used]
header = [
    "id: quest",
    "rewrite: true",
    "blurb: A text-based RPG, one small task at a time. Every lesson is a short assignment and a coding exercise that is checked when you submit; the concept is in the Python docs it links to.",
    "why: Writing code is how you learn it. Each lesson gives you one thing to do in the editor, runs your code, and checks it, with the visualizer a click away. The reading is the official Python documentation, linked at the top of every lesson.",
]
open(sys.argv[1], "w", encoding="utf-8").write(lib.emit(chapters, "Learn Python: Fantasy Quest", header))
print(len(lib.LESSONS), "lessons,", len(chapters), "chapters")
