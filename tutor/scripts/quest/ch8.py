"""Book III, part 2: iterators, generators, closures and decorators. Values on demand, and functions that wrap functions."""
from lib import L, Q, out, dedent, DOCS

T = "# Don't touch below this line\n"

DOCS["iterators"] = ("Python tutorial: Iterators", "https://docs.python.org/3/tutorial/classes.html#iterators")
DOCS["generators"] = ("Python tutorial: Generators", "https://docs.python.org/3/tutorial/classes.html#generators")
DOCS["genexpr"] = ("Python reference: Generator expressions", "https://docs.python.org/3/reference/expressions.html#generator-expressions")
DOCS["yieldexpr"] = ("Python reference: Yield expressions", "https://docs.python.org/3/reference/expressions.html#yield-expressions")
DOCS["iterator-types"] = ("Python docs: Iterator types", "https://docs.python.org/3/library/stdtypes.html#iterator-types")
DOCS["itertools"] = ("Python docs: itertools", "https://docs.python.org/3/library/itertools.html")
DOCS["islice"] = ("Python docs: itertools.islice()", "https://docs.python.org/3/library/itertools.html#itertools.islice")
DOCS["groupby"] = ("Python docs: itertools.groupby()", "https://docs.python.org/3/library/itertools.html#itertools.groupby")
DOCS["accumulate"] = ("Python docs: itertools.accumulate()", "https://docs.python.org/3/library/itertools.html#itertools.accumulate")
DOCS["chain"] = ("Python docs: itertools.chain()", "https://docs.python.org/3/library/itertools.html#itertools.chain")
DOCS["zip"] = ("Python docs: zip()", "https://docs.python.org/3/library/functions.html#zip")
DOCS["enumerate"] = ("Python docs: enumerate()", "https://docs.python.org/3/library/functions.html#enumerate")
DOCS["nonlocal"] = ("Python reference: The nonlocal statement", "https://docs.python.org/3/reference/simple_stmts.html#the-nonlocal-statement")
DOCS["decorator"] = ("Python glossary: decorator", "https://docs.python.org/3/glossary.html#term-decorator")
DOCS["funcdef"] = ("Python reference: Function definitions", "https://docs.python.org/3/reference/compound_stmts.html#function-definitions")
DOCS["closures"] = ("Python FAQ: Why do lambdas in a loop all return the same value?", "https://docs.python.org/3/faq/programming.html#why-do-lambdas-defined-in-a-loop-with-different-values-all-return-the-same-result")
DOCS["wraps"] = ("Python docs: functools.wraps()", "https://docs.python.org/3/library/functools.html#functools.wraps")
DOCS["cache"] = ("Python docs: functools.cache()", "https://docs.python.org/3/library/functools.html#functools.cache")
DOCS["lru"] = ("Python docs: functools.lru_cache()", "https://docs.python.org/3/library/functools.html#functools.lru_cache")

CHAPTERS = [
    ("iterators", "Iterators and generators", "Make values one at a time, only when someone asks."),
    ("decorators", "Closures and decorators", "Functions that remember, and functions that wrap functions."),
]

NAMES = '["Sam", "Mira", "Bran", "Ada", "Ned"]'
ROOMS = '["hall", "pit", "den", "gate", "tower", "cellar"]'


# ============================================================ Iterators and generators
L("iterators", "g2-iter-next", "Walking the rooms by hand", "iterators",
  "The dungeon map is a list, and Sam walks it one room at a time.",
  "Write `walk(rooms)`. Start with `it = iter(rooms)`. Pull one room at a time with `next(it)` and append it to a list. "
  "If the room is `\"collapsed\"`, stop before adding it. If the iterator runs out, stop. Return the rooms you walked through. "
  "Use no `for` loop. `walk([\"hall\", \"pit\"])` is `[\"hall\", \"pit\"]`. "
  "`walk([\"hall\", \"collapsed\", \"den\"])` is `[\"hall\"]`. `walk([])` is `[]`.",
  'def walk(rooms):\n    return []\n',
  'def walk(rooms):\n    it = iter(rooms)\n    seen = []\n    while True:\n        try:\n            room = next(it)\n        except StopIteration:\n            break\n        if room == "collapsed":\n            break\n        seen.append(room)\n    return seen\n',
  '`it = iter(rooms)`, then `next(it)` inside a `try`. `StopIteration` means the map is finished.',
  tests='''
from solution import walk

def test_values():
    assert walk(["hall", "pit"]) == ["hall", "pit"]
    assert walk(["hall", "collapsed", "den"]) == ["hall"]
    assert walk([]) == []
    assert walk(["collapsed"]) == []
    assert walk(["hall", "pit", "collapsed"]) == ["hall", "pit"]
    assert walk(["gate", "tower", "cellar"]) == ["gate", "tower", "cellar"]
''',
  checks=[("call:iter", "Start with `iter(rooms)`."), ("call:next", "Pull each room with `next(it)`."),
          ("!node:For", "Walk with `iter` and `next`, not a `for` loop.")],
  fuzz=("walk",
        'def ref(rooms):\n    seen = []\n    for room in rooms:\n        if room == "collapsed":\n            break\n        seen.append(room)\n    return seen\n',
        'def gen(r):\n    rooms = ' + ROOMS + ' + ["collapsed"]\n    return [[r.choice(rooms) for _ in range(r.randint(0, 8))]]\n'),
  wrong=[("a for loop instead of iter and next",
          'def walk(rooms):\n    seen = []\n    for room in rooms:\n        if room == "collapsed":\n            break\n        seen.append(room)\n    return seen\n'),
         ("walks into the collapsed room",
          'def walk(rooms):\n    it = iter(rooms)\n    seen = []\n    while True:\n        try:\n            room = next(it)\n        except StopIteration:\n            break\n        seen.append(room)\n        if room == "collapsed":\n            break\n    return seen\n'),
         ("skips the first room",
          'def walk(rooms):\n    it = iter(rooms)\n    seen = []\n    try:\n        next(it)\n    except StopIteration:\n        return seen\n    while True:\n        try:\n            room = next(it)\n        except StopIteration:\n            break\n        seen.append(room)\n    return seen\n')])

L("iterators", "g2-yield", "A patrol generator", "generators",
  "Mira sends a scout through every room, but only when the scout is needed.",
  "Write `patrol(rooms)`. It is a generator that yields `\"scout \" + room` for each room, in order. "
  "Calling `patrol([\"hall\", \"pit\"])` must not build a list; it returns a generator. "
  "`list(patrol([\"hall\", \"pit\"]))` is `[\"scout hall\", \"scout pit\"]`. "
  "`patrol([])` gives nothing. The first `next` of `patrol([\"den\"])` is `\"scout den\"`.",
  'def patrol(rooms):\n    return []\n',
  'def patrol(rooms):\n    for room in rooms:\n        yield "scout " + room\n',
  'Inside the function, `for room in rooms:` and `yield "scout " + room`.',
  tests='''
import types
from solution import patrol

def test_values():
    assert list(patrol(["hall", "pit"])) == ["scout hall", "scout pit"]
    assert list(patrol([])) == []
    assert list(patrol(["den"])) == ["scout den"]

def test_is_a_generator():
    g = patrol(["hall"])
    assert isinstance(g, types.GeneratorType), "patrol must be a generator, not a list"
    assert next(g) == "scout hall"
    assert next(g, "done") == "done"
''',
  checks=[("node:Yield", "Use `yield` inside patrol."), ("!call:list", "Don't build a list; yield the rooms.")],
  wrong=[("returns a list",
          'def patrol(rooms):\n    return ["scout " + room for room in rooms]\n'),
         ("forgets the scout prefix",
          'def patrol(rooms):\n    for room in rooms:\n        yield room\n'),
         ("yields only the first room",
          'def patrol(rooms):\n    for room in rooms:\n        yield "scout " + room\n        return\n')])

L("iterators", "g2-genexpr", "Damage on demand", "genexpr",
  "The bard totals a battle without keeping every blow in memory.",
  "Write `battle_totals(hits)`. `hits` is a list of `(attacker, damage)` pairs. "
  "Return `(total, heaviest)`: the sum of all damage, and the largest damage. "
  "Use generator expressions straight inside `sum` and `max`, not a list comprehension. "
  "An empty battle is `(0, 0)`. `battle_totals([(\"Sam\", 5), (\"Mira\", 12), (\"Bran\", 2)])` is `(19, 12)`. "
  "Negative damage counts in the sum but never makes a new heaviest.",
  'def battle_totals(hits):\n    return 0, 0\n',
  'def battle_totals(hits):\n    return sum(damage for _, damage in hits), max((damage for _, damage in hits if damage > 0), default=0)\n',
  '`sum(damage for _, damage in hits)` and `max((damage for _, damage in hits if damage > 0), default=0)`.',
  tests='''
from solution import battle_totals

def test_values():
    assert battle_totals([]) == (0, 0)
    assert battle_totals([("Sam", 5)]) == (5, 5)
    assert battle_totals([("Sam", 5), ("Mira", 12), ("Bran", 2)]) == (19, 12)
    assert battle_totals([("Sam", -3), ("Mira", -1)]) == (-4, 0)
    assert battle_totals([("Sam", -3), ("Mira", 4)]) == (1, 4)
    assert battle_totals([("Sam", 7), ("Mira", 7)]) == (14, 7)
''',
  checks=[("node:GeneratorExp", "Use a generator expression, like `damage for _, damage in hits`."),
          ("!node:ListComp", "Pass the generator straight to sum and max; don't build a list.")],
  fuzz=("battle_totals",
        'def ref(hits):\n    return sum(d for _, d in hits), max((d for _, d in hits if d > 0), default=0)\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [[(r.choice(names), r.randint(-5, 20)) for _ in range(r.randint(0, 8))]]\n'),
  wrong=[("a list comprehension for both totals",
          'def battle_totals(hits):\n    return sum([d for _, d in hits]), max([d for _, d in hits])\n'),
         ("max crashes on an empty battle",
          'def battle_totals(hits):\n    return sum(d for _, d in hits), max(d for _, d in hits)\n'),
         ("negative damage is dropped from the sum",
          'def battle_totals(hits):\n    return sum(d for _, d in hits if d > 0), max((d for _, d in hits), default=0)\n')])

L("iterators", "g2-infinite", "An endless turn order", "islice",
  "The heroes take turns forever, and the scribe writes down only the first few.",
  "Write `turn_order(heroes)`, an endless generator that yields the heroes in a circle, forever. "
  "An empty party yields nothing. Write `first_turns(heroes, n)` that returns the first `n` turns as a list, "
  "using `itertools.islice`. `first_turns([\"Sam\", \"Mira\"], 5)` is `[\"Sam\", \"Mira\", \"Sam\", \"Mira\", \"Sam\"]`. "
  "`first_turns([\"Sam\"], 3)` is `[\"Sam\", \"Sam\", \"Sam\"]`. `first_turns([\"Sam\"], 0)` and `first_turns([], 4)` are `[]`.",
  'import itertools\n\ndef turn_order(heroes):\n    return []\n\ndef first_turns(heroes, n):\n    return []\n',
  'import itertools\n\ndef turn_order(heroes):\n    if not heroes:\n        return\n    while True:\n        for hero in heroes:\n            yield hero\n\ndef first_turns(heroes, n):\n    return list(itertools.islice(turn_order(heroes), n))\n',
  '`yield` inside an endless `while True`, and take `n` with `itertools.islice(turn_order(heroes), n)`.',
  tests='''
import itertools
from solution import first_turns, turn_order

def test_first_turns():
    assert first_turns(["Sam", "Mira"], 5) == ["Sam", "Mira", "Sam", "Mira", "Sam"]
    assert first_turns(["Sam"], 3) == ["Sam", "Sam", "Sam"]
    assert first_turns(["Sam"], 0) == []
    assert first_turns([], 4) == []

def test_turn_order_is_endless():
    turns = turn_order(["Sam", "Mira"])
    assert [next(turns) for _ in range(3)] == ["Sam", "Mira", "Sam"]
    assert list(itertools.islice(turn_order([]), 3)) == []
''',
  checks=[("call:islice", "Take the first n with `itertools.islice`."), ("node:Yield", "Yield each hero.")],
  fuzz=("first_turns",
        'def ref(heroes, n):\n    if n <= 0 or not heroes:\n        return []\n    return [heroes[i % len(heroes)] for i in range(n)]\n',
        'def gen(r):\n    names = ' + NAMES + '\n    n = r.randint(0, 8)\n    size = r.randint(0, 4)\n    if n > 0 and size == 0:\n        size = 1\n    return [[r.choice(names) for _ in range(size)], n]\n'),
  wrong=[("repeats the party once instead of circling",
          'import itertools\n\ndef turn_order(heroes):\n    for hero in heroes:\n        yield hero\n\ndef first_turns(heroes, n):\n    return list(itertools.islice(turn_order(heroes), n))\n'),
         ("takes from the list, not the endless turn order",
          'import itertools\n\ndef turn_order(heroes):\n    while True:\n        for hero in heroes:\n            yield hero\n\ndef first_turns(heroes, n):\n    return list(itertools.islice(heroes, n))\n'),
         ("off by one: n - 1 turns",
          'import itertools\n\ndef turn_order(heroes):\n    while True:\n        for hero in heroes:\n            yield hero\n\ndef first_turns(heroes, n):\n    return list(itertools.islice(turn_order(heroes), n - 1))\n')])

L("iterators", "g2-lazy", "Stop at the boss", "generators",
  "The scout should stop reading the map the moment the boss room appears.",
  "Write `take_until_boss(rooms)`, a generator that yields each room and stops after yielding `\"boss\"`. "
  "It must not read a room after the boss. The tests pass an iterator that raises if it is read too far, "
  "so read lazily: one room at a time, only while the caller asks. "
  "`list(take_until_boss([\"hall\", \"boss\", \"treasure\"]))` is `[\"hall\", \"boss\"]`. "
  "`list(take_until_boss([\"boss\", \"treasure\"]))` is `[\"boss\"]`. `list(take_until_boss([\"hall\"]))` is `[\"hall\"]`.",
  'def take_until_boss(rooms):\n    return []\n',
  'def take_until_boss(rooms):\n    for room in rooms:\n        yield room\n        if room == "boss":\n            return\n',
  '`yield room` first, then `if room == "boss": return` so the boss is included and nothing after it is read.',
  tests='''
import types
from solution import take_until_boss

class Bomb:
    def __init__(self, items):
        self.items = list(items)
        self.i = 0
    def __iter__(self):
        return self
    def __next__(self):
        if self.i >= len(self.items):
            raise AssertionError("read past the boss")
        item = self.items[self.i]
        self.i += 1
        return item

def test_stops_at_the_boss():
    assert list(take_until_boss(Bomb(["hall", "boss"]))) == ["hall", "boss"]
    assert list(take_until_boss(Bomb(["boss"]))) == ["boss"]
    assert list(take_until_boss(["hall", "pit"])) == ["hall", "pit"]
    assert list(take_until_boss([])) == []

def test_is_a_generator():
    g = take_until_boss(["boss"])
    assert isinstance(g, types.GeneratorType), "take_until_boss must be a generator"
''',
  checks=[("node:Yield", "Yield each room as it is read."), ("!call:list", "Don't collect all the rooms in a list.")],
  wrong=[("reads the whole map first",
          'def take_until_boss(rooms):\n    return [room for room in rooms]\n'),
         ("yields the rooms after the boss too",
          'def take_until_boss(rooms):\n    for room in rooms:\n        yield room\n'),
         ("stops before the boss",
          'def take_until_boss(rooms):\n    for room in rooms:\n        if room == "boss":\n            return\n        yield room\n')])

L("iterators", "g2-yield-from", "Flatten the levels", "yieldexpr",
  "The dungeon map arrives level by level, and Sam wants one long list of rooms.",
  "Write `rooms_by_level(levels)`, a generator. `levels` is a list of room lists. "
  "Yield every room from every level, in order, with `yield from`. "
  "`list(rooms_by_level([[\"hall\", \"pit\"], [\"den\"], []]))` is `[\"hall\", \"pit\", \"den\"]`. "
  "`list(rooms_by_level([]))` is `[]`. Do not build the whole list before yielding.",
  'def rooms_by_level(levels):\n    return []\n',
  'def rooms_by_level(levels):\n    for level in levels:\n        yield from level\n',
  'Inside `for level in levels:`, write `yield from level`.',
  tests='''
import types
from solution import rooms_by_level

def test_values():
    assert list(rooms_by_level([["hall", "pit"], ["den"], []])) == ["hall", "pit", "den"]
    assert list(rooms_by_level([])) == []
    assert list(rooms_by_level([[], []])) == []
    assert list(rooms_by_level([["gate"], ["tower", "cellar"]])) == ["gate", "tower", "cellar"]

def test_is_a_generator():
    assert isinstance(rooms_by_level([["hall"]]), types.GeneratorType), "yield rooms, don't return a list"
''',
  checks=[("node:YieldFrom", "Flatten each level with `yield from level`."), ("!call:list", "Don't build one big list.")],
  wrong=[("nested for loops with yield",
          'def rooms_by_level(levels):\n    for level in levels:\n        for room in level:\n            yield room\n'),
         ("returns a list",
          'def rooms_by_level(levels):\n    return [room for level in levels for room in level]\n'),
         ("yields the levels themselves",
          'def rooms_by_level(levels):\n    for level in levels:\n        yield from [level]\n')])

L("iterators", "g2-pipeline", "The damage pipeline", "genexpr",
  "Each line of the battle log is read, parsed, filtered, and written out in one pass.",
  "Write `report(lines, minimum)`. Each line looks like `\"Sam 12\"`: a name, a space, and a whole number. "
  "Read the log as a pipeline of generator expressions: parse each line into `(name, damage)`, keep the hits with "
  "`damage >= minimum`, then build the list `\"name hit for damage\"`. "
  "`report([\"Sam 12\", \"Mira 3\", \"Bran 10\"], 10)` is `[\"Sam hit for 12\", \"Bran hit for 10\"]`. "
  "`report([], 10)` is `[]`.",
  'def report(lines, minimum):\n    return []\n',
  'def report(lines, minimum):\n    parsed = ((line.split()[0], int(line.split()[1])) for line in lines)\n    kept = ((name, damage) for name, damage in parsed if damage >= minimum)\n    return [f"{name} hit for {damage}" for name, damage in kept]\n',
  'Build one generator expression for parsed hits, a second that filters them, then a list of the label strings.',
  tests='''
from solution import report

def test_values():
    assert report(["Sam 12", "Mira 3", "Bran 10"], 10) == ["Sam hit for 12", "Bran hit for 10"]
    assert report(["Sam 12"], 10) == ["Sam hit for 12"]
    assert report(["Sam 9"], 10) == []
    assert report([], 10) == []
    assert report(["Ada 1", "Ned 30", "Lux 7"], 0) == ["Ada hit for 1", "Ned hit for 30", "Lux hit for 7"]
''',
  checks=[("node:GeneratorExp", "Use a generator expression in the pipeline.")],
  fuzz=("report",
        'def ref(lines, minimum):\n    out = []\n    for line in lines:\n        name, damage = line.split()\n        if int(damage) >= minimum:\n            out.append("%s hit for %s" % (name, damage))\n    return out\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [[("%s %d" % (r.choice(names), r.randint(-5, 25))) for _ in range(r.randint(0, 8))], r.randint(-5, 20)]\n'),
  wrong=[("drops hits equal to the minimum",
          'def report(lines, minimum):\n    parsed = ((line.split()[0], int(line.split()[1])) for line in lines)\n    kept = ((name, damage) for name, damage in parsed if damage > minimum)\n    return [f"{name} hit for {damage}" for name, damage in kept]\n'),
         ("reads the damage as the name",
          'def report(lines, minimum):\n    parsed = ((line.split()[1], int(line.split()[0])) for line in lines)\n    kept = ((name, damage) for name, damage in parsed if damage >= minimum)\n    return [f"{name} hit for {damage}" for name, damage in kept]\n'),
         ("keeps every hit",
          'def report(lines, minimum):\n    parsed = ((line.split()[0], int(line.split()[1])) for line in lines)\n    return [f"{name} hit for {damage}" for name, damage in parsed]\n')])

L("iterators", "g2-enumerate-zip-lazy", "Roll call", "zip",
  "The quartermaster reads a name and a score together, and stops at the shorter list.",
  "Write `roll_call(names, scores)`. Pair the two with `zip`, number the pairs from 1 with `enumerate(..., start=1)`, "
  "and return `\"1. Sam: 12\"` style lines. `zip` stops at the shorter input. "
  "`roll_call([\"Sam\", \"Mira\"], [12, 7])` is `[\"1. Sam: 12\", \"2. Mira: 7\"]`. "
  "`roll_call([\"Sam\", \"Mira\"], [12])` is `[\"1. Sam: 12\"]`. "
  "`roll_call([], [1, 2])` is `[]`.",
  'def roll_call(names, scores):\n    return []\n',
  'def roll_call(names, scores):\n    return [f"{i}. {name}: {score}" for i, (name, score) in enumerate(zip(names, scores), start=1)]\n',
  '`enumerate(zip(names, scores), start=1)` gives the number and the pair.',
  tests='''
from solution import roll_call

def test_values():
    assert roll_call(["Sam", "Mira"], [12, 7]) == ["1. Sam: 12", "2. Mira: 7"]
    assert roll_call(["Sam", "Mira"], [12]) == ["1. Sam: 12"]
    assert roll_call([], [1, 2]) == []
    assert roll_call(["Sam"], []) == []
    assert roll_call(["Sam", "Mira", "Bran"], [1, 2, 3]) == ["1. Sam: 1", "2. Mira: 2", "3. Bran: 3"]

def test_works_with_generators():
    assert roll_call(iter(["Sam", "Mira"]), iter([4, 5])) == ["1. Sam: 4", "2. Mira: 5"]
''',
  checks=[("call:zip", "Pair names and scores with `zip`."), ("call:enumerate", "Number the pairs with `enumerate`.")],
  fuzz=("roll_call",
        'def ref(names, scores):\n    return ["%d. %s: %s" % (i, name, score) for i, (name, score) in enumerate(zip(names, scores), start=1)]\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [[r.choice(names) for _ in range(r.randint(0, 5))], [r.randint(0, 20) for _ in range(r.randint(0, 5))]]\n'),
  wrong=[("numbers from 0",
          'def roll_call(names, scores):\n    return [f"{i}. {name}: {score}" for i, (name, score) in enumerate(zip(names, scores))]\n'),
         ("keeps going past the shorter list",
          'import itertools\n\ndef roll_call(names, scores):\n    return [f"{i}. {name}: {score}" for i, (name, score) in enumerate(itertools.zip_longest(names, scores), start=1)]\n'),
         ("indexes names by position",
          'def roll_call(names, scores):\n    return [f"{i}. {names[i - 1]}: {score}" for i, score in enumerate(scores, start=1)]\n')])

L("iterators", "g2-itertools", "The guild ledger", "itertools",
  "Loot arrives in chests, and the treasurer wants a running total by day.",
  "Write `flatten(groups)` that returns one list from a list of lists, using `itertools.chain.from_iterable`. "
  "Write `daily_totals(entries)` where each entry is `(day, gold)`. Sort by day, group the days with "
  "`itertools.groupby`, total each day, then use `itertools.accumulate` for the running total. "
  "Return `(day, day_total, running_total)` tuples in day order. "
  "`daily_totals([(\"Mon\", 5), (\"Tue\", 3), (\"Mon\", 2)])` is "
  "`[(\"Mon\", 7, 7), (\"Tue\", 3, 10)]`. `flatten([[\"gem\"], [\"gold\", \"gem\"]])` is `[\"gem\", \"gold\", \"gem\"]`. "
  "`daily_totals([])` is `[]`.",
  'import itertools\n\ndef flatten(groups):\n    return []\n\ndef daily_totals(entries):\n    return []\n',
  'import itertools\n\ndef flatten(groups):\n    return list(itertools.chain.from_iterable(groups))\n\ndef daily_totals(entries):\n    ordered = sorted(entries, key=lambda entry: entry[0])\n    totals = [(day, sum(gold for _, gold in group)) for day, group in itertools.groupby(ordered, key=lambda entry: entry[0])]\n    running = itertools.accumulate(total for _, total in totals)\n    return [(day, total, run) for (day, total), run in zip(totals, running)]\n',
  'Sort before `groupby` (it only groups neighbours). `accumulate` turns day totals into a running total.',
  tests='''
from solution import daily_totals, flatten

def test_flatten():
    assert flatten([["gem"], ["gold", "gem"]]) == ["gem", "gold", "gem"]
    assert flatten([]) == []
    assert flatten([[], ["hall"], []]) == ["hall"]

def test_daily_totals():
    assert daily_totals([]) == []
    assert daily_totals([("Mon", 5), ("Tue", 3), ("Mon", 2)]) == [("Mon", 7, 7), ("Tue", 3, 10)]
    assert daily_totals([("Tue", 3), ("Mon", 5)]) == [("Mon", 5, 5), ("Tue", 3, 8)]
    assert daily_totals([("Mon", -2), ("Mon", 5)]) == [("Mon", 3, 3)]
    assert daily_totals([("Wed", 1), ("Mon", 2), ("Tue", 3)]) == [("Mon", 2, 2), ("Tue", 3, 5), ("Wed", 1, 6)]
''',
  checks=[("call:from_iterable", "Flatten with `itertools.chain.from_iterable`."),
          ("call:groupby", "Group the sorted days with `itertools.groupby`."),
          ("call:accumulate", "Build the running total with `itertools.accumulate`."),
          ("call:sorted", "Sort the entries by day before grouping.")],
  fuzz=("daily_totals",
        'def ref(entries):\n    ordered = sorted(entries, key=lambda e: e[0])\n    totals = []\n    for day, group in __import__("itertools").groupby(ordered, key=lambda e: e[0]):\n        totals.append((day, sum(gold for _, gold in group)))\n    out = []\n    run = 0\n    for day, total in totals:\n        run += total\n        out.append((day, total, run))\n    return out\n',
        'def gen(r):\n    days = ["Mon", "Tue", "Wed", "Thu"]\n    return [[(r.choice(days), r.randint(-5, 20)) for _ in range(r.randint(0, 10))]]\n'),
  wrong=[("groups without sorting first",
          'import itertools\n\ndef flatten(groups):\n    return list(itertools.chain.from_iterable(groups))\n\ndef daily_totals(entries):\n    totals = [(day, sum(gold for _, gold in group)) for day, group in itertools.groupby(entries, key=lambda entry: entry[0])]\n    running = itertools.accumulate(total for _, total in totals)\n    return [(day, total, run) for (day, total), run in zip(totals, running)]\n'),
         ("every day restarts the running total",
          'import itertools\n\ndef flatten(groups):\n    return list(itertools.chain.from_iterable(groups))\n\ndef daily_totals(entries):\n    ordered = sorted(entries, key=lambda entry: entry[0])\n    totals = [(day, sum(gold for _, gold in group)) for day, group in itertools.groupby(ordered, key=lambda entry: entry[0])]\n    return [(day, total, total) for day, total in totals]\n'),
         ("flattens one level with a loop",
          'import itertools\n\ndef flatten(groups):\n    out = []\n    for group in groups:\n        out.extend(group)\n    return out\n\ndef daily_totals(entries):\n    ordered = sorted(entries, key=lambda entry: entry[0])\n    totals = [(day, sum(gold for _, gold in group)) for day, group in itertools.groupby(ordered, key=lambda entry: entry[0])]\n    running = itertools.accumulate(total for _, total in totals)\n    return [(day, total, run) for (day, total), run in zip(totals, running)]\n')])

L("iterators", "g2-iter-class", "A dungeon that knows how to walk", "iterator-types",
  "A dungeon is not a list of rooms; it is an object with a position in it.",
  "Write a class `Dungeon`. `Dungeon(rooms)` keeps the list. `iter(dungeon)` returns the dungeon itself. "
  "`next(dungeon)` returns the next room, one at a time, and raises `StopIteration` when the rooms run out. "
  "`list(Dungeon([\"hall\", \"pit\"]))` is `[\"hall\", \"pit\"]`, and `iter(dungeon) is dungeon`. "
  "The dungeon is one-shot: after it runs out, `next(dungeon, \"done\")` is `\"done\"`.",
  'class Dungeon:\n    def __init__(self, rooms):\n        self.rooms = rooms\n\n    def __iter__(self):\n        return iter(self.rooms)\n\n    def __next__(self):\n        return None\n',
  'class Dungeon:\n    def __init__(self, rooms):\n        self.rooms = rooms\n        self.index = 0\n\n    def __iter__(self):\n        return self\n\n    def __next__(self):\n        if self.index >= len(self.rooms):\n            raise StopIteration\n        room = self.rooms[self.index]\n        self.index += 1\n        return room\n',
  '`__iter__` returns `self`. `__next__` returns `self.rooms[self.index]` and moves the index; at the end it raises `StopIteration`.',
  tests='''
from solution import Dungeon

def test_walks_the_rooms():
    d = Dungeon(["hall", "pit"])
    assert list(d) == ["hall", "pit"]
    assert next(d, "done") == "done", "a used dungeon should be exhausted"

def test_is_its_own_iterator():
    d = Dungeon(["hall"])
    assert iter(d) is d, "__iter__ must return the dungeon itself"
    assert next(d) == "hall"
    assert next(d, "done") == "done"

def test_empty_and_single():
    assert list(Dungeon([])) == []
    assert list(Dungeon(["den"])) == ["den"]
''',
  checks=[("def:__iter__", "Define `__iter__`."), ("def:__next__", "Define `__next__`."),
          ("node:Raise", "Raise `StopIteration` when the rooms run out.")],
  wrong=[("iter returns the list's iterator",
          'class Dungeon:\n    def __init__(self, rooms):\n        self.rooms = rooms\n        self.index = 0\n\n    def __iter__(self):\n        return iter(self.rooms)\n\n    def __next__(self):\n        if self.index >= len(self.rooms):\n            raise StopIteration\n        room = self.rooms[self.index]\n        self.index += 1\n        return room\n'),
         ("raises the wrong error at the end",
          'class Dungeon:\n    def __init__(self, rooms):\n        self.rooms = rooms\n        self.index = 0\n\n    def __iter__(self):\n        return self\n\n    def __next__(self):\n        if self.index >= len(self.rooms):\n            raise ValueError("the end")\n        room = self.rooms[self.index]\n        self.index += 1\n        return room\n'),
         ("skips the first room",
          'class Dungeon:\n    def __init__(self, rooms):\n        self.rooms = rooms\n        self.index = 1\n\n    def __iter__(self):\n        return self\n\n    def __next__(self):\n        if self.index >= len(self.rooms):\n            raise StopIteration\n        room = self.rooms[self.index]\n        self.index += 1\n        return room\n')])

Q("iterators", "g2-quiz-exhausted", "Quiz: a generator runs once", "generators",
  "Mira keeps the same lantern for two trips, and the second trip is dark.",
  'def rooms():\n    yield "hall"\n    yield "pit"\n\nr = rooms()\nprint(list(r))\nprint(list(r))\nprint(next(rooms()))\n',
  "['hall', 'pit']\n[]\nhall",
  "A generator is its own iterator: the first list uses it up, the second finds nothing. A new call to rooms() starts a fresh generator.")

L("iterators", "g2-q-spawner", "Quest: the monster spawner", "yieldexpr",
  "The dungeon needs waves of monsters that grow, but the dungeon master sets a cap.",
  "Write `spawn_wave(monster, start, step, cap)`, a generator. The first wave is a list with `start` copies of `monster`. "
  "Each next wave has `step` more, up to `cap`: never yield a wave larger than `cap`. "
  "`list(spawn_wave(\"goblin\", 1, 2, 7))` is `[[\"goblin\"], [\"goblin\", \"goblin\", \"goblin\"], "
  "[\"goblin\"] * 5, [\"goblin\"] * 7]`. If `start > cap`, nothing is yielded. "
  "Each wave is a new list, so changing one does not change the next.",
  'def spawn_wave(monster, start, step, cap):\n    return []\n',
  'def spawn_wave(monster, start, step, cap):\n    count = start\n    while count <= cap:\n        yield [monster] * count\n        count += step\n',
  'Keep `count = start`, `yield [monster] * count`, then `count += step` while `count <= cap`.',
  tests='''
import types
from solution import spawn_wave

def test_waves():
    assert list(spawn_wave("goblin", 1, 2, 7)) == [["goblin"], ["goblin"] * 3, ["goblin"] * 5, ["goblin"] * 7]
    assert list(spawn_wave("goblin", 4, 3, 10)) == [["goblin"] * 4, ["goblin"] * 7, ["goblin"] * 10]
    assert list(spawn_wave("goblin", 5, 1, 5)) == [["goblin"] * 5]
    assert list(spawn_wave("goblin", 6, 1, 5)) == []
    assert list(spawn_wave("goblin", 1, 10, 4)) == [["goblin"]]

def test_is_lazy_and_fresh():
    g = spawn_wave("goblin", 1000, 1000, 10**9)
    assert isinstance(g, types.GeneratorType), "spawn_wave must be a generator"
    first = next(g)
    assert len(first) == 1000
    second = next(g)
    assert len(second) == 2000
    first.append("dragon")
    assert "dragon" not in second, "each wave must be a new list"
''',
  checks=[("node:Yield", "Yield each wave instead of returning one list."), ("node:While", "Use a loop until the cap.")],
  wrong=[("starts one step too high",
          'def spawn_wave(monster, start, step, cap):\n    count = start + step\n    while count <= cap:\n        yield [monster] * count\n        count += step\n'),
         ("never yields the wave on the cap",
          'def spawn_wave(monster, start, step, cap):\n    count = start\n    while count < cap:\n        yield [monster] * count\n        count += step\n'),
         ("returns one list instead of a generator",
          'def spawn_wave(monster, start, step, cap):\n    return [[monster] * count for count in range(start, cap + 1, step)]\n'),
         ("reuses one list for every wave",
          'def spawn_wave(monster, start, step, cap):\n    wave = []\n    count = start\n    while count <= cap:\n        wave.extend([monster] * step)\n        yield wave\n        count += step\n')],
  project=True)


# ============================================================ Closures and decorators
L("decorators", "g2-closure", "A counter that remembers", "nonlocal",
  "Every time Sam opens the chest, the tally on the lid goes up.",
  "Write `make_counter()`. It returns a function. Each call of that function increases its own count and returns the new value: "
  "1, then 2, then 3. Two counters made by two calls keep separate counts. Use `nonlocal`. "
  "`make_counter` itself takes no arguments.",
  'def make_counter():\n    return lambda: 1\n',
  'def make_counter():\n    count = 0\n    def tick():\n        nonlocal count\n        count += 1\n        return count\n    return tick\n',
  '`count = 0`, then inside `tick` use `nonlocal count` before `count += 1`.',
  tests='''
from solution import make_counter

def test_counts_up():
    c = make_counter()
    assert c() == 1
    assert c() == 2
    assert c() == 3

def test_counters_are_independent():
    a = make_counter()
    b = make_counter()
    assert a() == 1
    assert a() == 2
    assert b() == 1, "the second counter should start at 1"
    assert a() == 3
''',
  checks=[("def:make_counter", "Define `make_counter`."), ("node:Nonlocal", "Use `nonlocal count` inside the inner function.")],
  wrong=[("one count shared by every counter",
          'count = 0\n\ndef make_counter():\n    def tick():\n        global count\n        count += 1\n        return count\n    return tick\n'),
         ("always returns 1",
          'def make_counter():\n    count = 0\n    def tick():\n        nonlocal count\n        count = 1\n        return count\n    return tick\n'),
         ("rebinds count as a local each call",
          'def make_counter():\n    count = 0\n    def tick():\n        count = 0\n        count += 1\n        return count\n    return tick\n')])

L("decorators", "g2-closure-late-binding", "The late-binding trap", "closures",
  "The Guild made a greeting for every hero, and every greeting said the last hero's name.",
  "Write `make_greeters(names)`. Return a list of functions, one per name. Each function takes no arguments and returns "
  "`\"Hello, NAME!\"` for its own name. The starter's lambdas all close over the same loop variable, so they all say the last name. "
  "Fix it by binding the current name as a default argument: `lambda name=name: ...`. "
  "`[g() for g in make_greeters([\"Sam\", \"Mira\"])]` is `[\"Hello, Sam!\", \"Hello, Mira!\"]`. "
  "`make_greeters([])` is `[]`.",
  'def make_greeters(names):\n    return [lambda: f"Hello, {name}!" for name in names]\n',
  'def make_greeters(names):\n    return [lambda name=name: f"Hello, {name}!" for name in names]\n',
  'Give the lambda a default: `lambda name=name: f"Hello, {name}!"`. The default is evaluated now, not when called.',
  tests='''
from solution import make_greeters

def test_each_greeter_has_its_own_name():
    greeters = make_greeters(["Sam", "Mira", "Bran"])
    assert [g() for g in greeters] == ["Hello, Sam!", "Hello, Mira!", "Hello, Bran!"]

def test_edges():
    assert make_greeters([]) == []
    assert [g() for g in make_greeters(["Ada"])] == ["Hello, Ada!"]
    assert [g() for g in make_greeters(["Sam", "Sam"])] == ["Hello, Sam!", "Hello, Sam!"]
    assert all(callable(g) for g in make_greeters(["Ned"]))
''',
  checks=[("node:Lambda", "Return lambdas, one per name."), ("def:make_greeters", "Keep the function called `make_greeters`.")],
  wrong=[("the classic late-binding bug",
          'def make_greeters(names):\n    return [lambda: f"Hello, {name}!" for name in names]\n'),
         ("every greeter uses the last name",
          'def make_greeters(names):\n    return [lambda: f"Hello, {names[-1]}!" for _ in names]\n'),
         ("returns strings instead of functions",
          'def make_greeters(names):\n    return [f"Hello, {name}!" for name in names]\n')])

L("decorators", "g2-decorator-basic", "The shouting decorator", "decorator",
  "The herald shouts every message, whatever the message was.",
  "Write `shout(fn)`. It returns a wrapper that calls `fn` with the same arguments and uppercases the result. "
  "Then decorate `greet(name)`, which returns `\"hello \" + name`, with `@shout`. "
  "`greet(\"sam\")` is `\"HELLO SAM\"`. `greet(\"\")` is `\"HELLO \"`. "
  "`shout` must also work on another function: `shout(lambda s: s + \"!\") (\"hi\")` is `\"HI!\"`.",
  'def shout(fn):\n    return fn\n\n@shout\ndef greet(name):\n    return "hello " + name\n',
  'def shout(fn):\n    def wrapper(*args, **kwargs):\n        return fn(*args, **kwargs).upper()\n    return wrapper\n\n@shout\ndef greet(name):\n    return "hello " + name\n',
  'The wrapper calls `fn(*args, **kwargs)` and returns `.upper()` of the result.',
  tests='''
from solution import greet, shout

def test_greet_is_shouted():
    assert greet("sam") == "HELLO SAM"
    assert greet("") == "HELLO "
    assert greet("Mira") == "HELLO MIRA"

def test_works_on_other_functions():
    excited = shout(lambda s: s + "!")
    assert excited("hi") == "HI!"
    assert shout(str.upper)("quiet") == "QUIET"

def test_calls_the_function_once():
    calls = []
    @shout
    def ping(value):
        calls.append(value)
        return value
    assert ping("hi") == "HI"
    assert calls == ["hi"], "the wrapper should call the function once"
''',
  checks=[("def:shout", "Define `shout`."), ("tok:*", "Pass arguments through with `*args` (and `**kwargs`).")],
  wrong=[("uppercases the argument instead of the result",
          'def shout(fn):\n    def wrapper(*args, **kwargs):\n        return fn(*[a.upper() for a in args])\n    return wrapper\n\n@shout\ndef greet(name):\n    return "hello " + name\n'),
         ("returns None",
          'def shout(fn):\n    def wrapper(*args, **kwargs):\n        fn(*args, **kwargs).upper()\n    return wrapper\n\n@shout\ndef greet(name):\n    return "hello " + name\n'),
         ("calls the function twice",
          'def shout(fn):\n    def wrapper(*args, **kwargs):\n        fn(*args, **kwargs)\n        return fn(*args, **kwargs).upper()\n    return wrapper\n\n@shout\ndef greet(name):\n    return "hello " + name\n')])

L("decorators", "g2-decorator-args", "A decorator that logs", "funcdef",
  "The quartermaster writes down every command, with every argument.",
  "Write `CALLS = []` and a decorator `logged(fn)`. Its wrapper appends `(fn.__name__, args, kwargs)` to `CALLS`, "
  "then calls `fn(*args, **kwargs)` and returns the result. Decorate `attack(hero, damage, *, crit=False)`, which returns "
  "`damage * 2` when `crit` is true and `damage` otherwise. "
  "`attack(\"Sam\", 5)` is 5 and logs `(\"attack\", (\"Sam\", 5), {})`. "
  "`attack(\"Mira\", 4, crit=True)` is 8 and logs the keyword. Pass every argument through; do not change them.",
  'CALLS = []\n\ndef logged(fn):\n    return fn\n\n@logged\ndef attack(hero, damage, *, crit=False):\n    return damage * 2 if crit else damage\n',
  'CALLS = []\n\ndef logged(fn):\n    def wrapper(*args, **kwargs):\n        CALLS.append((fn.__name__, args, kwargs))\n        return fn(*args, **kwargs)\n    return wrapper\n\n@logged\ndef attack(hero, damage, *, crit=False):\n    return damage * 2 if crit else damage\n',
  'In the wrapper, append `(fn.__name__, args, kwargs)` first, then `return fn(*args, **kwargs)`.',
  tests='''
from solution import CALLS, attack, logged

def test_logs_positional_arguments():
    CALLS.clear()
    assert attack("Sam", 5) == 5
    assert CALLS == [("attack", ("Sam", 5), {})]

def test_logs_keyword_arguments():
    CALLS.clear()
    assert attack("Mira", 4, crit=True) == 8
    assert CALLS == [("attack", ("Mira", 4), {"crit": True})]
    assert attack("Bran", 3, crit=False) == 3
    assert len(CALLS) == 2

def test_works_on_another_function():
    CALLS.clear()
    @logged
    def add(a, b=0):
        return a + b
    assert add(2, b=3) == 5
    assert CALLS == [("add", (2,), {"b": 3})]
''',
  checks=[("def:logged", "Define `logged`."), ("def:attack", "Define and decorate `attack`."), ("tok:**", "Accept `**kwargs` and pass them through.")],
  wrong=[("drops the keyword arguments from the call",
          'CALLS = []\n\ndef logged(fn):\n    def wrapper(*args, **kwargs):\n        CALLS.append((fn.__name__, args, kwargs))\n        return fn(*args)\n    return wrapper\n\n@logged\ndef attack(hero, damage, *, crit=False):\n    return damage * 2 if crit else damage\n'),
         ("logs only the arguments, not the keywords",
          'CALLS = []\n\ndef logged(fn):\n    def wrapper(*args, **kwargs):\n        CALLS.append((fn.__name__, args, {}))\n        return fn(*args, **kwargs)\n    return wrapper\n\n@logged\ndef attack(hero, damage, *, crit=False):\n    return damage * 2 if crit else damage\n'),
         ("the wrapper returns None",
          'CALLS = []\n\ndef logged(fn):\n    def wrapper(*args, **kwargs):\n        CALLS.append((fn.__name__, args, kwargs))\n        fn(*args, **kwargs)\n    return wrapper\n\n@logged\ndef attack(hero, damage, *, crit=False):\n    return damage * 2 if crit else damage\n')])

L("decorators", "g2-wraps", "Keep the function's name", "wraps",
  "The scribe wraps every spell, and the spellbook still needs the spell's real name.",
  "Write a decorator `logged(fn)` that returns a wrapper, but uses `functools.wraps(fn)` so the wrapper keeps the "
  "function's `__name__` and `__doc__`. Decorate `heal(hero, amount)` with a docstring `Heal a hero by amount.` "
  "that returns `hero + \" +\" + str(amount)`. "
  "`heal.__name__` must be `\"heal\"`, `heal.__doc__` must be the docstring, and `heal(\"Sam\", 2)` is `\"Sam +2\"`.",
  'import functools\n\ndef logged(fn):\n    def wrapper(*args, **kwargs):\n        return fn(*args, **kwargs)\n    return wrapper\n\n@logged\ndef heal(hero, amount):\n    """Heal a hero by amount."""\n    return f"{hero} +{amount}"\n',
  'import functools\n\ndef logged(fn):\n    @functools.wraps(fn)\n    def wrapper(*args, **kwargs):\n        return fn(*args, **kwargs)\n    return wrapper\n\n@logged\ndef heal(hero, amount):\n    """Heal a hero by amount."""\n    return f"{hero} +{amount}"\n',
  'Put `@functools.wraps(fn)` on the inner `wrapper` function.',
  tests='''
from solution import heal, logged

def test_name_and_doc_survive():
    assert heal.__name__ == "heal"
    assert heal.__doc__ == "Heal a hero by amount."

def test_still_calls_the_function():
    assert heal("Sam", 2) == "Sam +2"
    assert heal("Mira", 0) == "Mira +0"
    assert heal.__wrapped__("Bran", 3) == "Bran +3"

def test_returns_a_wrapper():
    def plain():
        return 1
    assert logged(plain) is not plain, "logged should return a wrapper"
''',
  checks=[("call:wraps", "Use `functools.wraps(fn)`."), ("def:logged", "Define `logged`.")],
  wrong=[("no wraps at all",
          'import functools\n\ndef logged(fn):\n    def wrapper(*args, **kwargs):\n        return fn(*args, **kwargs)\n    return wrapper\n\n@logged\ndef heal(hero, amount):\n    """Heal a hero by amount."""\n    return f"{hero} +{amount}"\n'),
         ("copies the name but not the docstring",
          'import functools\n\ndef logged(fn):\n    def wrapper(*args, **kwargs):\n        return fn(*args, **kwargs)\n    wrapper.__name__ = fn.__name__\n    return wrapper\n\n@logged\ndef heal(hero, amount):\n    """Heal a hero by amount."""\n    return f"{hero} +{amount}"\n'),
         ("returns the function itself",
          'import functools\n\ndef logged(fn):\n    return fn\n\n@logged\ndef heal(hero, amount):\n    """Heal a hero by amount."""\n    return f"{hero} +{amount}"\n')])

L("decorators", "g2-decorator-factory", "A decorator with arguments", "decorator",
  "The rogue keeps trying the locked chest, but only so many times.",
  "Write `retry(times)`, a decorator factory. It returns a decorator; that decorator wraps a function so it is called "
  "up to `times` times while it raises `ValueError`. The first success returns its value. If every try fails, raise the "
  "last `ValueError`. Do not retry other exceptions. "
  "`@retry(times=3)` around a function that succeeds on its third call returns that value after exactly 3 calls.",
  'def retry(times):\n    def decorate(fn):\n        return fn\n    return decorate\n',
  'def retry(times):\n    def decorate(fn):\n        def wrapper(*args, **kwargs):\n            last = None\n            for _ in range(times):\n                try:\n                    return fn(*args, **kwargs)\n                except ValueError as error:\n                    last = error\n            raise last\n        return wrapper\n    return decorate\n',
  'The inner wrapper loops `range(times)`, returns on success, keeps the last `ValueError`, and raises it after the loop.',
  tests='''
from solution import retry

def test_succeeds_on_the_third_try():
    tries = {"n": 0}
    @retry(times=3)
    def flaky():
        tries["n"] += 1
        if tries["n"] < 3:
            raise ValueError("locked")
        return "gold"
    assert flaky() == "gold"
    assert tries["n"] == 3

def test_gives_up_after_times():
    tries = {"n": 0}
    @retry(times=2)
    def locked():
        tries["n"] += 1
        raise ValueError("still locked")
    try:
        locked()
    except ValueError as error:
        assert str(error) == "still locked"
    else:
        raise AssertionError("locked should have raised ValueError")
    assert tries["n"] == 2

def test_other_errors_are_not_retried():
    tries = {"n": 0}
    @retry(times=5)
    def broken():
        tries["n"] += 1
        raise RuntimeError("boom")
    try:
        broken()
    except RuntimeError:
        pass
    else:
        raise AssertionError("broken should have raised RuntimeError")
    assert tries["n"] == 1, "RuntimeError should not be retried"

def test_one_try():
    tries = {"n": 0}
    @retry(times=1)
    def once():
        tries["n"] += 1
        return "done"
    assert once() == "done"
    assert tries["n"] == 1
''',
  checks=[("def:retry", "Define `retry`."), ("node:Try", "Catch `ValueError` inside the wrapper.")],
  wrong=[("retries every exception",
          'def retry(times):\n    def decorate(fn):\n        def wrapper(*args, **kwargs):\n            last = None\n            for _ in range(times):\n                try:\n                    return fn(*args, **kwargs)\n                except Exception as error:\n                    last = error\n            raise last\n        return wrapper\n    return decorate\n'),
         ("tries one time too few",
          'def retry(times):\n    def decorate(fn):\n        def wrapper(*args, **kwargs):\n            last = None\n            for _ in range(times - 1):\n                try:\n                    return fn(*args, **kwargs)\n                except ValueError as error:\n                    last = error\n            raise last\n        return wrapper\n    return decorate\n'),
         ("never retries",
          'def retry(times):\n    def decorate(fn):\n        def wrapper(*args, **kwargs):\n            try:\n                return fn(*args, **kwargs)\n            except ValueError as error:\n                raise error\n        return wrapper\n    return decorate\n')])

L("decorators", "g2-cache", "Remember the paths", "cache",
  "Mira counts the paths up the cliff, and the same short climbs keep coming back.",
  "Write `paths(n)`: the number of ways to climb `n` steps when each move is 1 or 2 steps. "
  "`paths(0)` is 1 (standing still), `paths(1)` is 1, and `paths(n)` is `paths(n - 1) + paths(n - 2)`. "
  "Decorate it with `functools.cache` (or `functools.lru_cache`) so repeated subproblems are computed once. "
  "The tests call `paths.cache_clear()` and `paths.cache_info()`, so keep the real decorator. "
  "`[paths(n) for n in range(8)]` is `[1, 1, 2, 3, 5, 8, 13, 21]`.",
  'def paths(n):\n    if n <= 1:\n        return 1\n    return paths(n - 1) + paths(n - 2)\n',
  'import functools\n\n@functools.cache\ndef paths(n):\n    if n <= 1:\n        return 1\n    return paths(n - 1) + paths(n - 2)\n',
  'Add `@functools.cache` above `paths`. The recursive calls then reuse the answers.',
  tests='''
from solution import paths

def test_values():
    assert [paths(n) for n in range(8)] == [1, 1, 2, 3, 5, 8, 13, 21]
    assert paths(10) == 89
    assert paths(20) == 10946

def test_cache_is_used():
    paths.cache_clear()
    paths(20)
    info = paths.cache_info()
    assert info.misses <= 21, f"paths computed {info.misses} results; the cache should keep it to 21"
    paths(20)
    assert paths.cache_info().hits >= 1, "the second paths(20) should hit the cache"
''',
  checks=[("def:paths", "Define `paths`.")],
  wrong=[("no cache at all",
          'def paths(n):\n    if n <= 1:\n        return 1\n    return paths(n - 1) + paths(n - 2)\n'),
         ("the wrong base case",
          'import functools\n\n@functools.cache\ndef paths(n):\n    if n == 0:\n        return 0\n    if n == 1:\n        return 1\n    return paths(n - 1) + paths(n - 2)\n'),
         ("a cache that keeps nothing",
          'import functools\n\n@functools.lru_cache(maxsize=0)\ndef paths(n):\n    if n <= 1:\n        return 1\n    return paths(n - 1) + paths(n - 2)\n')])

Q("decorators", "g2-quiz-decorator-order", "Quiz: the order of wrappers", "decorator",
  "Two enchanters wrap the same sword, and Sam wants to know which spell speaks first.",
  'def first(fn):\n    def wrapper(*args, **kwargs):\n        print("first before")\n        out = fn(*args, **kwargs)\n        print("first after")\n        return out\n    return wrapper\n\ndef second(fn):\n    def wrapper(*args, **kwargs):\n        print("second before")\n        out = fn(*args, **kwargs)\n        print("second after")\n        return out\n    return wrapper\n\n@first\n@second\ndef hit():\n    print("hit")\n\nhit()\n',
  "first before\nsecond before\nhit\nsecond after\nfirst after",
  "The decorator nearest the function applies first, so hit is first(second(hit)). The outermost wrapper speaks first and returns last.")

Q("decorators", "g2-quiz-nonlocal", "Quiz: the missing nonlocal", "nonlocal",
  "Mira's tally refuses to move, and the interpreter names the reason.",
  'def make_counter():\n    count = 0\n    def tick():\n        print("start")\n        count += 1\n        return count\n    return tick\n\ntry:\n    make_counter()()\nexcept UnboundLocalError as error:\n    print(type(error).__name__)\n',
  "start\nUnboundLocalError",
  "Because tick assigns to count, count is local to tick for the whole function. Reading it before that assignment raises UnboundLocalError. `nonlocal count` would make it the outer counter.")
