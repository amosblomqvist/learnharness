"""Book III, part 1: functions as values. Tuples, passing functions around, and recursion."""
from lib import L, Q, out, dedent, DOCS

T = "# Don't touch below this line\n"

DOCS["tuples"] = ("Python tutorial: Tuples and sequences", "https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences")
DOCS["sorted"] = ("Python docs: sorted()", "https://docs.python.org/3/library/functions.html#sorted")
DOCS["sortkey"] = ("Python HOWTO: Sorting (key functions)", "https://docs.python.org/3/howto/sorting.html#key-functions")
DOCS["lambda"] = ("Python reference: Lambdas", "https://docs.python.org/3/reference/expressions.html#lambda")
DOCS["map"] = ("Python docs: map()", "https://docs.python.org/3/library/functions.html#map")
DOCS["filter"] = ("Python docs: filter()", "https://docs.python.org/3/library/functions.html#filter")
DOCS["any"] = ("Python docs: any()", "https://docs.python.org/3/library/functions.html#any")
DOCS["all"] = ("Python docs: all()", "https://docs.python.org/3/library/functions.html#all")
DOCS["higher"] = ("Python FAQ: How do you make a higher order function?", "https://docs.python.org/3/faq/programming.html#how-do-you-make-a-higher-order-function-in-python")
DOCS["recursion"] = ("Python docs: sys.setrecursionlimit()", "https://docs.python.org/3/library/sys.html#sys.setrecursionlimit")

CHAPTERS = [
    ("tuples", "Tuples and unpacking", "Fixed records, unpacking, and functions that return several things."),
    ("functional", "Functions as values", "Pass functions around: keys, lambdas, map, filter, any and all."),
    ("recursion", "Recursion", "Solve a problem with a smaller copy of itself."),
]

NAMES = '["Sam", "Mira", "Bran", "Ada", "Ned"]'


# ============================================================ Tuples
L("tuples", "g1-tuple-record", "A fixed record", "tuples",
  "The Guild's card for Sam is a fixed record: name, hp, level.",
  "Write `sheet(hero)`. `hero` is a tuple `(name, hp, level)`. Index it and return a line like "
  "`sheet((\"Sam\", 40, 3))` equal to `\"Sam (level 3) has 40 hp\"`.",
  'def sheet(hero):\n    return ""\n',
  'def sheet(hero):\n    return f"{hero[0]} (level {hero[2]}) has {hero[1]} hp"\n',
  '`hero[0]` is the name, `hero[1]` the hp, `hero[2]` the level.',
  tests='''
from solution import sheet

def test_values():
    assert sheet(("Sam", 40, 3)) == "Sam (level 3) has 40 hp"
    assert sheet(("Mira", 0, 1)) == "Mira (level 1) has 0 hp"
    assert sheet(("Bran", 12, 10)) == "Bran (level 10) has 12 hp"
''',
  checks=[("node:Subscript", "Index the tuple, like `hero[0]`.")],
  fuzz=("sheet",
        'def ref(hero):\n    return f"{hero[0]} (level {hero[2]}) has {hero[1]} hp"\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [(r.choice(names), r.randint(0, 40), r.randint(1, 12))]\n'),
  wrong=[("unpacks the tuple instead of indexing it",
          'def sheet(hero):\n    name, hp, level = hero\n    return f"{name} (level {level}) has {hp} hp"\n'),
         ("swaps hp and level",
          'def sheet(hero):\n    return f"{hero[0]} (level {hero[1]}) has {hero[2]} hp"\n')])

L("tuples", "g1-unpack", "Unpacking", "tuples",
  "Sam's card won't open: the clerk unpacked two names from a three-part record.",
  "The starter crashes. `name, hp = hero` takes two names from a tuple of three values. "
  "Give every value a name so the console shows:\n\n```text\nSam 40 3\n```",
  'hero = ("Sam", 40, 3)\nname, hp = hero\n\n' + T + 'print(name, hp, level)\n',
  'hero = ("Sam", 40, 3)\nname, hp, level = hero\n\n' + T + 'print(name, hp, level)\n',
  '`name, hp, level = hero` needs one name per value.',
  expect="Sam 40 3",
  wrong=[("puts hp in the level name",
          'hero = ("Sam", 40, 3)\nname, level, hp = hero\n\n' + T + 'print(name, hp, level)\n'),
         ("reads hp twice",
          'hero = ("Sam", 40, 3)\nname, hp, level = hero[0], hero[1], hero[1]\n\n' + T + 'print(name, hp, level)\n')])

L("tuples", "g1-star-unpack", "Star unpacking", "tuples",
  "The queue at the gate has a first hero, a last hero, and everyone in between.",
  "Write `split_queue(queue)`. `queue` is a list of at least one name. Use both "
  "`first, *rest = queue` and `*body, last = queue`. Return `(first, rest, body, last)`. "
  "`rest` and `body` are lists. `split_queue([\"Sam\", \"Mira\", \"Bran\"])` is "
  "`(\"Sam\", [\"Mira\", \"Bran\"], [\"Sam\", \"Mira\"], \"Bran\")`. "
  "`split_queue([\"Sam\"])` is `(\"Sam\", [], [], \"Sam\")`.",
  'def split_queue(queue):\n    return None\n',
  'def split_queue(queue):\n    first, *rest = queue\n    *body, last = queue\n    return first, rest, body, last\n',
  '`first, *rest = queue` keeps the first item and a list of the rest. `*body, last = queue` does it from the other end.',
  tests='''
from solution import split_queue

def test_values():
    assert split_queue(["Sam", "Mira", "Bran"]) == ("Sam", ["Mira", "Bran"], ["Sam", "Mira"], "Bran")
    assert split_queue(["Sam"]) == ("Sam", [], [], "Sam")
    assert split_queue(["axe", "bow"]) == ("axe", ["bow"], ["axe"], "bow")

def test_star_makes_lists():
    _, rest, body, _ = split_queue(["Sam", "Mira"])
    assert type(rest) is list and type(body) is list
''',
  checks=[("tok:*", "Use `*` to unpack, as in `first, *rest = queue`.")],
  fuzz=("split_queue",
        'def ref(queue):\n    first, *rest = queue\n    *body, last = queue\n    return first, rest, body, last\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [[r.choice(names) for _ in range(r.randint(1, 6))]]\n'),
  wrong=[("slices instead of star-unpacking",
          'def split_queue(queue):\n    first, rest = queue[0], queue[1:]\n    body, last = queue[:-1], queue[-1]\n    return first, rest, body, last\n'),
         ("drops the first hero from the body",
          'def split_queue(queue):\n    first, *rest = queue\n    *body, last = rest if rest else queue\n    return first, rest, body, last\n')])

L("tuples", "g1-tuple-immutable", "Tuples can't be changed", "tuples",
  "Sam's card is a tuple, so a heal has to be written on a new card.",
  "The starter crashes: it tries to assign into the tuple. Write `heal(hero, amount)`. "
  "`hero` is `(name, hp, level)`. Return a new tuple with `amount` added to hp "
  "(amount may be negative). Leave the tuple you were given unchanged. "
  "`heal((\"Sam\", 40, 3), 5)` is `(\"Sam\", 45, 3)`.",
  'def heal(hero, amount):\n    hero[1] = hero[1] + amount\n    return hero\n',
  'def heal(hero, amount):\n    name, hp, level = hero\n    return (name, hp + amount, level)\n',
  'Build a new tuple: `(name, hp + amount, level)`.',
  tests='''
from solution import heal

def test_values():
    assert heal(("Sam", 40, 3), 5) == ("Sam", 45, 3)
    assert heal(("Mira", 2, 1), -2) == ("Mira", 0, 1)
    assert heal(("Bran", 0, 9), 0) == ("Bran", 0, 9)

def test_leaves_the_tuple_alone():
    hero = ("Sam", 40, 3)
    heal(hero, 5)
    assert hero == ("Sam", 40, 3), "heal changed the tuple it was given"

def test_returns_a_tuple():
    assert type(heal(("Sam", 1, 1), 1)) is tuple, "return a tuple, not a list"
''',
  fuzz=("heal",
        'def ref(hero, amount):\n    name, hp, level = hero\n    return (name, hp + amount, level)\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [(r.choice(names), r.randint(0, 40), r.randint(1, 10)), r.randint(-5, 12)]\n'),
  wrong=[("returns a list",
          'def heal(hero, amount):\n    name, hp, level = hero\n    return [name, hp + amount, level]\n'),
         ("adds the amount to the level",
          'def heal(hero, amount):\n    name, hp, level = hero\n    return (name, hp, level + amount)\n')])

L("tuples", "g1-enumerate-unpack", "Unpacking in a loop", "loops",
  "The roll call reads each hero's name and hp together.",
  "Write `still_fighting(party)`. `party` is a list of `(name, hp)` pairs. Return the names whose hp is above 0, "
  "in the same order. Unpack each pair: `for name, hp in party`. "
  "`still_fighting([(\"Sam\", 10), (\"Mira\", 0), (\"Bran\", 3)])` is `[\"Sam\", \"Bran\"]`. An empty party is `[]`.",
  'def still_fighting(party):\n    return []\n',
  'def still_fighting(party):\n    names = []\n    for name, hp in party:\n        if hp > 0:\n            names.append(name)\n    return names\n',
  '`for name, hp in party:` then keep the name when `hp > 0`.',
  tests='''
from solution import still_fighting

def test_values():
    assert still_fighting([("Sam", 10), ("Mira", 0), ("Bran", 3)]) == ["Sam", "Bran"]
    assert still_fighting([]) == []
    assert still_fighting([("Mira", 0), ("Bran", -1)]) == []
    assert still_fighting([("Sam", 1), ("Sam", 0), ("Sam", 2)]) == ["Sam", "Sam"]
''',
  checks=["node:For"],
  fuzz=("still_fighting",
        'def ref(party):\n    return [name for name, hp in party if hp > 0]\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [[(r.choice(names), r.randint(-2, 8)) for _ in range(r.randint(0, 8))]]\n'),
  wrong=[("a comprehension instead of a loop",
          'def still_fighting(party):\n    return [name for name, hp in party if hp > 0]\n'),
         ("keeps heroes on 0 hp",
          'def still_fighting(party):\n    names = []\n    for name, hp in party:\n        if hp >= 0:\n            names.append(name)\n    return names\n')])

L("tuples", "g1-namedtuple-lite", "Return several values", "tuples",
  "One swing of the fight deals damage and takes it, both at once.",
  "Write `fight_round(hero_atk, foe_atk)` that returns the pair `(dealt, taken)`. "
  "`dealt` is `hero_atk`. `taken` is `foe_atk // 2`. Then unpack the call "
  "`fight_round(7, 5)` into the names `dealt` and `taken`. The console shows:\n\n```text\n7\n2\n```",
  'def fight_round(hero_atk, foe_atk):\n    return None\n\ndealt, taken = fight_round(7, 5)\n\n' + T + 'print(dealt)\nprint(taken)\n',
  'def fight_round(hero_atk, foe_atk):\n    return hero_atk, foe_atk // 2\n\ndealt, taken = fight_round(7, 5)\n\n' + T + 'print(dealt)\nprint(taken)\n',
  '`return hero_atk, foe_atk // 2`, then `dealt, taken = fight_round(7, 5)`.',
  expect=out(["7", "2"]),
  extra='''
from solution import fight_round

def test_pair():
    assert fight_round(7, 5) == (7, 2)
    assert fight_round(0, 1) == (0, 0)
    assert fight_round(4, 8) == (4, 4)
    assert fight_round(3, 0) == (3, 0)
    assert type(fight_round(7, 5)) is tuple, "return a tuple so the caller can unpack it"
''',
  fuzz=("fight_round",
        'def ref(hero_atk, foe_atk):\n    return hero_atk, foe_atk // 2\n',
        'def gen(r):\n    return [r.randint(0, 30), r.randint(0, 30)]\n'),
  wrong=[("swaps dealt and taken",
          'def fight_round(hero_atk, foe_atk):\n    return foe_atk // 2, hero_atk\n\ndealt, taken = fight_round(7, 5)\n\n' + T + 'print(dealt)\nprint(taken)\n'),
         ("forgets to halve the blow",
          'def fight_round(hero_atk, foe_atk):\n    return hero_atk, foe_atk\n\ndealt, taken = fight_round(7, 5)\n\n' + T + 'print(dealt)\nprint(taken)\n')])

Q("tuples", "g1-quiz-tuple", "Quiz: the missing comma", "tuples",
  "The armory labels a single sword, and the comma goes missing.",
  'print(type(("sword")).__name__)\nprint(("sword",))\nprint(len(("sword",)))\n',
  "str\n('sword',)\n1",
  "Parentheses without a comma only group an expression, so (\"sword\") is a string. A one-item tuple needs the trailing comma, and its length is 1.")


# ============================================================ Functions as values
L("functional", "g1-fn-as-value", "Functions in a dictionary", "def",
  "Sam shouts a command, and the right action answers.",
  "Write `heal(hp)`, `hit(hp)` and `wait(hp)`. `heal` adds 4. `hit` subtracts 6 but never goes below 0. "
  "`wait` returns hp unchanged. Store the functions in a dict `COMMANDS = {\"heal\": heal, \"hit\": hit, \"wait\": wait}`. "
  "Write `act(command, hp)` that calls the function stored under that command. "
  "`act(\"heal\", 10)` is 14, `act(\"hit\", 10)` is 4, `act(\"hit\", 3)` is 0, and `act(\"wait\", 3)` is 3.",
  'def heal(hp):\n    return None\n\ndef hit(hp):\n    return None\n\ndef wait(hp):\n    return None\n\nCOMMANDS = {}\n\ndef act(command, hp):\n    return None\n',
  'def heal(hp):\n    return hp + 4\n\ndef hit(hp):\n    return max(0, hp - 6)\n\ndef wait(hp):\n    return hp\n\nCOMMANDS = {"heal": heal, "hit": hit, "wait": wait}\n\ndef act(command, hp):\n    return COMMANDS[command](hp)\n',
  '`COMMANDS = {"heal": heal, "hit": hit, "wait": wait}` and `return COMMANDS[command](hp)`.',
  tests='''
from solution import act, COMMANDS, heal, hit, wait

def test_commands_are_the_functions():
    assert COMMANDS["heal"] is heal, "COMMANDS['heal'] should be the heal function"
    assert COMMANDS["hit"] is hit, "COMMANDS['hit'] should be the hit function"
    assert COMMANDS["wait"] is wait, "COMMANDS['wait'] should be the wait function"

def test_values():
    assert act("heal", 10) == 14
    assert act("hit", 10) == 4
    assert act("hit", 3) == 0
    assert act("hit", 0) == 0
    assert act("hit", 6) == 0
    assert act("hit", 7) == 1
    assert act("wait", 3) == 3
    assert act("heal", 0) == 4
''',
  checks=["node:Dict", "name:COMMANDS", "def:heal", "def:hit", "def:wait", "def:act"],
  fuzz=("act",
        'def ref(command, hp):\n    if command == "heal":\n        return hp + 4\n    if command == "hit":\n        return max(0, hp - 6)\n    return hp\n',
        'def gen(r):\n    return [r.choice(["heal", "hit", "wait"]), r.randint(0, 30)]\n'),
  wrong=[("if/elif instead of a dictionary of functions",
          'def act(command, hp):\n    if command == "heal":\n        return hp + 4\n    if command == "hit":\n        return max(0, hp - 6)\n    return hp\n'),
         ("hit can drop hp below 0",
          'def heal(hp):\n    return hp + 4\n\ndef hit(hp):\n    return hp - 6\n\ndef wait(hp):\n    return hp\n\nCOMMANDS = {"heal": heal, "hit": hit, "wait": wait}\n\ndef act(command, hp):\n    return COMMANDS[command](hp)\n')])

L("functional", "g1-sort-key", "Sorting with a key function", "sortkey",
  "The healer wants the party ordered by hp.",
  "Write a named function `by_hp(hero)` that returns the hp of a `(name, hp)` pair. "
  "Write `rank(heroes)` using `sorted`, `min` and `max`, each with `key=by_hp`. "
  "Return `(ordered, frailest, toughest)`. `ordered` is the pairs sorted by hp, lowest first. "
  "Ties keep their original order. `frailest` is the first pair with the lowest hp, and `toughest` is the first pair with the highest hp. "
  "`rank([])` is `([], None, None)`. "
  "`rank([(\"Sam\", 5), (\"Mira\", 9), (\"Bran\", 5)])` is "
  "`([(\"Sam\", 5), (\"Bran\", 5), (\"Mira\", 9)], (\"Sam\", 5), (\"Mira\", 9))`.",
  'def rank(heroes):\n    return [], None, None\n',
  'def by_hp(hero):\n    return hero[1]\n\ndef rank(heroes):\n    if not heroes:\n        return [], None, None\n    ordered = sorted(heroes, key=by_hp)\n    return ordered, min(heroes, key=by_hp), max(heroes, key=by_hp)\n',
  '`def by_hp(hero): return hero[1]`, then pass `key=by_hp` to `sorted`, `min` and `max`. An empty list returns `[], None, None`.',
  tests='''
from solution import rank

def test_values():
    assert rank([]) == ([], None, None)
    assert rank([("Sam", 4)]) == ([("Sam", 4)], ("Sam", 4), ("Sam", 4))
    party = [("Sam", 5), ("Mira", 9), ("Bran", 5)]
    assert rank(party) == ([("Sam", 5), ("Bran", 5), ("Mira", 9)], ("Sam", 5), ("Mira", 9))
    assert rank([("Sam", 5), ("Mira", 5)]) == ([("Sam", 5), ("Mira", 5)], ("Sam", 5), ("Sam", 5))
    assert rank([("Bran", 2), ("Sam", 2), ("Mira", 8)])[0] == [("Bran", 2), ("Sam", 2), ("Mira", 8)]

def test_leaves_input_alone():
    party = [("Sam", 5), ("Mira", 1)]
    rank(party)
    assert party == [("Sam", 5), ("Mira", 1)], "rank changed the list it was given"
''',
  checks=["def:by_hp", "kw:key", "call:sorted", "call:min", "call:max",
          ("!node:Lambda", "Use a named function for the key, not a lambda.")],
  fuzz=("rank",
        'def ref(heroes):\n    if not heroes:\n        return [], None, None\n    return sorted(heroes, key=lambda h: h[1]), min(heroes, key=lambda h: h[1]), max(heroes, key=lambda h: h[1])\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [[(r.choice(names), r.randint(1, 6)) for _ in range(r.randint(0, 8))]]\n'),
  wrong=[("sorts by name instead of hp",
          'def by_hp(hero):\n    return hero[0]\n\ndef rank(heroes):\n    if not heroes:\n        return [], None, None\n    ordered = sorted(heroes, key=by_hp)\n    return ordered, min(heroes, key=by_hp), max(heroes, key=by_hp)\n'),
         ("a lambda instead of a named function",
          'def rank(heroes):\n    if not heroes:\n        return [], None, None\n    return sorted(heroes, key=lambda hero: hero[1]), min(heroes, key=lambda hero: hero[1]), max(heroes, key=lambda hero: hero[1])\n')])

L("functional", "g1-lambda", "Sorting with a lambda", "lambda",
  "The same order, with the key written in place.",
  "Write `rank(heroes)` again. `heroes` is a list of `(name, hp)` pairs. Return `(ordered, frailest, toughest)`: "
  "the pairs sorted by hp, lowest first; the first pair with the lowest hp; and the first pair with the highest hp. "
  "Ties keep their original order. Pass a `lambda` as `key` to `sorted`, `min` and `max`. Do not define `by_hp`. "
  "`rank([])` is `([], None, None)`. "
  "`rank([(\"Sam\", 5), (\"Mira\", 9), (\"Bran\", 5)])` is "
  "`([(\"Sam\", 5), (\"Bran\", 5), (\"Mira\", 9)], (\"Sam\", 5), (\"Mira\", 9))`.",
  'def rank(heroes):\n    return [], None, None\n',
  'def rank(heroes):\n    if not heroes:\n        return [], None, None\n    ordered = sorted(heroes, key=lambda hero: hero[1])\n    return ordered, min(heroes, key=lambda hero: hero[1]), max(heroes, key=lambda hero: hero[1])\n',
  '`key=lambda hero: hero[1]`',
  tests='''
from solution import rank

def test_values():
    assert rank([]) == ([], None, None)
    assert rank([("Sam", 4)]) == ([("Sam", 4)], ("Sam", 4), ("Sam", 4))
    party = [("Sam", 5), ("Mira", 9), ("Bran", 5)]
    assert rank(party) == ([("Sam", 5), ("Bran", 5), ("Mira", 9)], ("Sam", 5), ("Mira", 9))
    assert rank([("Sam", 5), ("Mira", 5)]) == ([("Sam", 5), ("Mira", 5)], ("Sam", 5), ("Sam", 5))

def test_leaves_input_alone():
    party = [("Sam", 5), ("Mira", 1)]
    rank(party)
    assert party == [("Sam", 5), ("Mira", 1)], "rank changed the list it was given"
''',
  checks=["node:Lambda", "kw:key", "call:sorted", "call:min", "call:max",
          ("!def:by_hp", "Use a lambda for the key, not a function named by_hp.")],
  fuzz=("rank",
        'def ref(heroes):\n    if not heroes:\n        return [], None, None\n    return sorted(heroes, key=lambda h: h[1]), min(heroes, key=lambda h: h[1]), max(heroes, key=lambda h: h[1])\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [[(r.choice(names), r.randint(1, 6)) for _ in range(r.randint(0, 8))]]\n'),
  wrong=[("a named function instead of a lambda",
          'def by_hp(hero):\n    return hero[1]\n\ndef rank(heroes):\n    if not heroes:\n        return [], None, None\n    ordered = sorted(heroes, key=by_hp)\n    return ordered, min(heroes, key=by_hp), max(heroes, key=by_hp)\n'),
         ("the lambda returns the name",
          'def rank(heroes):\n    if not heroes:\n        return [], None, None\n    ordered = sorted(heroes, key=lambda hero: hero[0])\n    return ordered, min(heroes, key=lambda hero: hero[0]), max(heroes, key=lambda hero: hero[0])\n')])

L("functional", "g1-map-filter", "map and filter", "map",
  "The bard names only the heroes still standing.",
  "Write `living_names(party)`. `party` is a list of `(name, hp)` pairs. Return a list of the names whose hp is above 0, in the same order. "
  "Use `map` and `filter`, not a list comprehension. `filter` keeps the heroes; `map` takes their names; `list` builds the list. "
  "`living_names([(\"Sam\", 5), (\"Mira\", 0), (\"Bran\", 2)])` is `[\"Sam\", \"Bran\"]`. An empty party is `[]`.",
  'def living_names(party):\n    return []\n',
  'def living_names(party):\n    return list(map(lambda hero: hero[0], filter(lambda hero: hero[1] > 0, party)))\n',
  '`list(map(lambda hero: hero[0], filter(lambda hero: hero[1] > 0, party)))`',
  tests='''
from solution import living_names

def test_values():
    assert living_names([("Sam", 5), ("Mira", 0), ("Bran", 2)]) == ["Sam", "Bran"]
    assert living_names([]) == []
    assert living_names([("Mira", 0), ("Bran", -1)]) == []
    assert living_names([("Sam", 1)]) == ["Sam"]
''',
  checks=["call:map", "call:filter", "!node:ListComp"],
  fuzz=("living_names",
        'def ref(party):\n    return [name for name, hp in party if hp > 0]\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [[(r.choice(names), r.randint(-2, 8)) for _ in range(r.randint(0, 8))]]\n'),
  wrong=[("a comprehension instead of map and filter",
          'def living_names(party):\n    return [name for name, hp in party if hp > 0]\n'),
         ("keeps heroes on 0 hp",
          'def living_names(party):\n    return list(map(lambda hero: hero[0], filter(lambda hero: hero[1] >= 0, party)))\n'),
         ("returns the map object without listing it",
          'def living_names(party):\n    return map(lambda hero: hero[0], filter(lambda hero: hero[1] > 0, party))\n')])

L("functional", "g1-any-all", "any and all", "any",
  "Before the gate opens: is anyone poisoned, and is everyone ready?",
  "Write `party_check(party)`. `party` is a list of `(name, poisoned, ready)`, and `poisoned` and `ready` are bools. "
  "Return `(anyone_poisoned, everyone_ready)`. Use `any` and `all` on generator expressions. "
  "An empty party has nobody poisoned, and `all` of no heroes is ready: `party_check([])` is `(False, True)`. "
  "`party_check([(\"Sam\", False, True), (\"Mira\", True, True)])` is `(True, True)`.",
  'def party_check(party):\n    return None\n',
  'def party_check(party):\n    return any(poisoned for _, poisoned, _ in party), all(ready for _, _, ready in party)\n',
  '`any(poisoned for _, poisoned, _ in party)` and `all(ready for _, _, ready in party)`.',
  tests='''
from solution import party_check

def test_values():
    assert party_check([]) == (False, True)
    assert party_check([("Sam", False, True), ("Mira", True, True)]) == (True, True)
    assert party_check([("Sam", False, True)]) == (False, True)
    assert party_check([("Sam", True, False)]) == (True, False)
    assert party_check([("Sam", False, False), ("Mira", False, True)]) == (False, False)
    assert party_check([("Sam", True, True), ("Mira", False, True)]) == (True, True)
''',
  checks=["call:any", "call:all",
          ("node:GeneratorExp", "Use a generator expression, like `any(poisoned for _, poisoned, _ in party)`.")],
  fuzz=("party_check",
        'def ref(party):\n    return any(p for _, p, _ in party), all(r for _, _, r in party)\n',
        'def gen(r):\n    names = ' + NAMES + '\n    return [[(r.choice(names), r.choice([True, False]), r.choice([True, False])) for _ in range(r.randint(0, 8))]]\n'),
  wrong=[("list comprehensions instead of generators",
          'def party_check(party):\n    return any([p for _, p, _ in party]), all([ready for _, _, ready in party])\n'),
         ("an empty party is not ready",
          'def party_check(party):\n    if not party:\n        return False, False\n    return any(poisoned for _, poisoned, _ in party), all(ready for _, _, ready in party)\n'),
         ("swaps any and all",
          'def party_check(party):\n    return any(ready for _, _, ready in party), all(poisoned for _, poisoned, _ in party)\n')])

L("functional", "g1-higher-order", "A function that takes a function", "higher",
  "Mira practices a spell by casting it again and again.",
  "Write `apply_n(f, x, n)`. Call `f` on `x`, then on that result, `n` times, and return the last result. "
  "`n == 0` returns `x` without calling `f`. "
  "`apply_n(lambda v: v + 1, 10, 4)` is 14. `apply_n(lambda v: v * 2, 3, 4)` is 48.",
  'def apply_n(f, x, n):\n    return None\n',
  'def apply_n(f, x, n):\n    result = x\n    for _ in range(n):\n        result = f(result)\n    return result\n',
  '`result = f(result)` inside `for _ in range(n)`.',
  tests='''
from solution import apply_n

def test_values():
    assert apply_n(lambda v: v + 1, 10, 0) == 10
    assert apply_n(lambda v: v + 1, 10, 1) == 11
    assert apply_n(lambda v: v + 1, 10, 4) == 14
    assert apply_n(lambda v: v * 2, 3, 4) == 48
    assert apply_n(lambda v: v - 3, 0, 2) == -6
''',
  fuzz=("apply_n",
        'def ref(f, x, n):\n    result = x\n    for _ in range(n):\n        result = f(result)\n    return result\n',
        'def gen(r):\n    op = r.choice(["inc", "dbl"])\n    def f(v):\n        if op == "inc":\n            return v + 1\n        return v * 2\n    return [f, r.randint(-3, 10), r.randint(0, 6)]\n'),
  wrong=[("stops one call early",
          'def apply_n(f, x, n):\n    result = x\n    for _ in range(n - 1):\n        result = f(result)\n    return result\n'),
         ("calls f once no matter what n is",
          'def apply_n(f, x, n):\n    if n == 0:\n        return x\n    return f(x)\n')])

L("functional", "g1-return-function", "A function that returns a function", "higher",
  "The enchanter builds a spell that remembers its factor.",
  "Write `make_multiplier(n)`. It returns a function. That function takes a number and returns it multiplied by `n`. "
  "Two multipliers keep their own `n`. `make_multiplier(2)(5)` is 10. `make_multiplier(3)(5)` is 15. "
  "`make_multiplier(0)(8)` is 0. `make_multiplier(-3)(4)` is -12.",
  'def make_multiplier(n):\n    return None\n',
  'def make_multiplier(n):\n    def multiply(x):\n        return x * n\n    return multiply\n',
  'Define `multiply(x)` inside `make_multiplier` so it returns `x * n`, then `return multiply`.',
  tests='''
import random
from solution import make_multiplier

def test_examples():
    twice = make_multiplier(2)
    thrice = make_multiplier(3)
    assert twice(5) == 10
    assert thrice(5) == 15
    assert twice(5) == 10, "the multiplier for 2 changed after making one for 3"
    assert make_multiplier(0)(8) == 0
    assert make_multiplier(-3)(4) == -12
    assert callable(twice), "make_multiplier should return a function"

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        n = r.randint(-8, 8)
        x = r.randint(-20, 20)
        got = make_multiplier(n)(x)
        assert got == n * x, "make_multiplier(%r)(%r) returned %r, expected %r" % (n, x, got, n * x)
''',
  wrong=[("every multiplier shares one factor",
          'factor = 0\n\ndef make_multiplier(n):\n    global factor\n    factor = n\n    def multiply(x):\n        return x * factor\n    return multiply\n'),
         ("adds n instead of multiplying by it",
          'def make_multiplier(n):\n    def multiply(x):\n        return x + n\n    return multiply\n')])

Q("functional", "g1-quiz-key", "Quiz: a stable sort", "sorted",
  "The scribe sorts the names by length and expects the ties to stay put.",
  'names = ["Mira", "Sam", "Bran", "Ada"]\nprint(sorted(names, key=len))\n',
  "['Sam', 'Ada', 'Mira', 'Bran']",
  "key=len compares lengths. sorted is stable, so equal lengths stay in their original order: Sam before Ada, Mira before Bran.")

L("functional", "g1-q-auction", "Quest: the auction", "sortkey",
  "The Guild auctions a relic, and the earliest bid wins a tie.",
  "Write `rank_bids(bids)`. Each bid is a tuple `(name, gold, arrival)`. `arrival` is a number; a smaller one was shouted earlier. "
  "Return a new list of the same tuples, highest gold first. When gold ties, the smaller arrival comes first. "
  "When gold and arrival both tie, keep the original order. Do not change the list you were given. "
  "`rank_bids([(\"Sam\", 10, 1), (\"Mira\", 10, 0), (\"Bran\", 12, 2)])` is "
  "`[(\"Bran\", 12, 2), (\"Mira\", 10, 0), (\"Sam\", 10, 1)]`. `rank_bids([])` is `[]`.",
  'def rank_bids(bids):\n    return []\n',
  'def rank_bids(bids):\n    return sorted(bids, key=lambda bid: (-bid[1], bid[2]))\n',
  'Pass `key=` to `sorted`. Higher gold first is `-gold`. On a tie, the smaller arrival comes first.',
  tests='''
from solution import rank_bids

def test_example():
    assert rank_bids([("Sam", 10, 1), ("Mira", 10, 0), ("Bran", 12, 2)]) == [("Bran", 12, 2), ("Mira", 10, 0), ("Sam", 10, 1)]

def test_edges():
    assert rank_bids([]) == []
    assert rank_bids([("Sam", 4, 1)]) == [("Sam", 4, 1)]
    assert rank_bids([("Sam", 5, 2), ("Mira", 5, 0)]) == [("Mira", 5, 0), ("Sam", 5, 2)]
    assert rank_bids([("Ned", 0, 3), ("Ada", 0, 1), ("Lux", 1, 2)]) == [("Lux", 1, 2), ("Ada", 0, 1), ("Ned", 0, 3)]
    assert rank_bids([("Sam", 4, 1), ("Mira", 4, 1)]) == [("Sam", 4, 1), ("Mira", 4, 1)]

def test_leaves_input_alone():
    bids = [("Sam", 5, 2), ("Mira", 9, 0)]
    rank_bids(bids)
    assert bids == [("Sam", 5, 2), ("Mira", 9, 0)], "rank_bids changed the list it was given"
''',
  checks=["kw:key", "call:sorted", "!call:sort"],
  fuzz=("rank_bids",
        'def ref(bids):\n    return sorted(bids, key=lambda b: (-b[1], b[2]))\n',
        'def gen(r):\n    names = ' + NAMES + ' + ["Lux"]\n    return [[(r.choice(names), r.randint(0, 20), r.randint(0, 10)) for _ in range(r.randint(0, 8))]]\n'),
  wrong=[("ties keep list order and ignore arrival",
          'def rank_bids(bids):\n    return sorted(bids, key=lambda bid: -bid[1])\n'),
         ("a later bid wins a tie",
          'def rank_bids(bids):\n    return sorted(bids, key=lambda bid: (-bid[1], -bid[2]))\n'),
         ("sorts the caller's list",
          'def rank_bids(bids):\n    bids.sort(key=lambda bid: (-bid[1], bid[2]))\n    return bids\n')],
  project=True)


# ============================================================ Recursion
COUNT_TAIL = T + 'countdown(3)\nprint("---")\ncountdown(1)\n'

L("recursion", "g1-countdown", "Countdown", "def",
  "The portal closes, counting down to zero.",
  "Write `countdown(n)` so it prints `n`, then `n - 1`, and so on down through `0`, one number per line. "
  "Call `countdown` again with `n - 1`. No `for` loop, no `while` loop, and no `range`. "
  "The lines below the marker call it. The console shows:\n\n```text\n3\n2\n1\n0\n---\n1\n0\n```",
  'def countdown(n):\n    print(n)\n\n' + COUNT_TAIL,
  'def countdown(n):\n    print(n)\n    if n == 0:\n        return\n    countdown(n - 1)\n\n' + COUNT_TAIL,
  'Print `n`, and if `n` is not 0, call `countdown(n - 1)`.',
  expect=out(["3", "2", "1", "0", "---", "1", "0"]),
  extra='''
from solution import countdown

def test_other_counts():
    assert printed(countdown, 0) == "0"
    assert printed(countdown, 2) == "2\\n1\\n0"
    assert printed(countdown, 6) == "6\\n5\\n4\\n3\\n2\\n1\\n0"
''',
  checks=["!node:For", "!node:While", "!call:range"],
  wrong=[("range instead of a recursive call",
          'def countdown(n):\n    print(*range(n, -1, -1), sep="\\n")\n\n' + COUNT_TAIL),
         ("a while loop",
          'def countdown(n):\n    while n >= 0:\n        print(n)\n        n -= 1\n\n' + COUNT_TAIL),
         ("stops before 0",
          'def countdown(n):\n    if n == 0:\n        return\n    print(n)\n    countdown(n - 1)\n\n' + COUNT_TAIL)])

L("recursion", "g1-sum-nested", "Nested gold", "recursion",
  "Chests of gold sit inside other chests.",
  "Write `total_gold(chests)`. `chests` is a list whose items are integers or lists of the same kind, nested any number of times. "
  "Return the sum of every integer. Call `total_gold` on each nested list. "
  "`total_gold([3, [4, [5]], 1])` is 13. `total_gold([])` is 0.",
  'def total_gold(chests):\n    return 0\n',
  'def total_gold(chests):\n    total = 0\n    for chest in chests:\n        if isinstance(chest, list):\n            total += total_gold(chest)\n        else:\n            total += chest\n    return total\n',
  'If an item is a list, add `total_gold(item)`. Otherwise add the number.',
  tests='''
from solution import total_gold

def test_values():
    assert total_gold([3, [4, [5]], 1]) == 13
    assert total_gold([]) == 0
    assert total_gold([1, 2, 3]) == 6
    assert total_gold([[], [[]]]) == 0
    assert total_gold([[1, 2], 3]) == 6
    assert total_gold([[[[4]]]]) == 4
''',
  checks=["call:total_gold"],
  fuzz=("total_gold", dedent("""\
    def ref(chests):
        total = 0
        for chest in chests:
            total += ref(chest) if isinstance(chest, list) else chest
        return total
    """), dedent("""\
    def gen(r):
        def tree(depth):
            out = []
            for _ in range(r.randint(0, 4)):
                if depth > 0 and r.randint(0, 1) == 1:
                    out.append(tree(depth - 1))
                else:
                    out.append(r.randint(0, 9))
            return out
        return [tree(3)]
    """)),
  wrong=[("adds only the numbers on the top level",
          'def total_gold(chests):\n    return sum(chest for chest in chests if not isinstance(chest, list))\n'),
         ("opens one level of chests and stops",
          'def total_gold(chests):\n    total = 0\n    for chest in chests:\n        if isinstance(chest, list):\n            for item in chest:\n                if not isinstance(item, list):\n                    total += item\n        else:\n            total += chest\n    return total\n')])

L("recursion", "g1-depth", "How deep the dungeon goes", "recursion",
  "The dungeon is a nest of rooms, and Sam asks how deep it goes.",
  "Write `depth(rooms)`. `rooms` is a dictionary whose values are more dictionaries like it. "
  "An empty dictionary is depth 0. Any other dictionary is 1 plus the deepest child. Call `depth` on each child. "
  "`depth({})` is 0. `depth({\"hall\": {}})` is 1. `depth({\"hall\": {\"cellar\": {}}})` is 2. "
  "`depth({\"hall\": {}, \"pit\": {\"den\": {}}})` is 2.",
  'def depth(rooms):\n    return 0\n',
  'def depth(rooms):\n    if not rooms:\n        return 0\n    return 1 + max(depth(child) for child in rooms.values())\n',
  '`1 + max(depth(child) for child in rooms.values())`, and `0` for an empty dictionary.',
  tests='''
from solution import depth

def test_values():
    assert depth({}) == 0
    assert depth({"hall": {}}) == 1
    assert depth({"hall": {"cellar": {}}}) == 2
    assert depth({"hall": {}, "pit": {"den": {}}}) == 2
    assert depth({"a": {}, "b": {}, "c": {"d": {}}}) == 2
    assert depth({"gate": {"hall": {"cellar": {}}}}) == 3
''',
  checks=["call:depth"],
  fuzz=("depth", dedent("""\
    def ref(rooms):
        if not rooms:
            return 0
        return 1 + max(ref(child) for child in rooms.values())
    """), dedent("""\
    def gen(r):
        names = ["hall", "pit", "den", "gate", "tower", "cellar"]
        def tree(depth, pool):
            if depth <= 0 or not pool:
                return {}
            k = r.randint(0, min(3, len(pool)))
            chosen = r.sample(pool, k)
            rest = [n for n in pool if n not in chosen]
            return {n: tree(depth - 1, rest) for n in chosen}
        return [tree(4, names)]
    """)),
  wrong=[("the shallowest branch, not the deepest",
          'def depth(rooms):\n    if not rooms:\n        return 0\n    return 1 + min(depth(child) for child in rooms.values())\n'),
         ("counts rooms instead of levels",
          'def depth(rooms):\n    if not isinstance(rooms, dict) or not rooms:\n        return 0\n    return len(rooms) + sum(depth(child) for child in rooms.values())\n')])

L("recursion", "g1-flood", "Rooms you can reach", "def",
  "From the entrance, Sam counts every room he can walk to.",
  "Write `reachable(rooms, start)`. `rooms` maps a room name to a list of names it leads to. "
  "Return how many rooms can be walked to from `start`, counting `start` when it is a key. "
  "A name that is not a key is not a room. Do not count a room twice: keep the rooms already seen in a `set`. "
  "Walk by calling a function on each next room. No `while` loop. "
  "From `hall` in this map the answer is 4, because `tower` only leads back toward `hall`:\n\n"
  "`{\"hall\": [\"pit\", \"den\"], \"pit\": [\"hall\"], \"den\": [\"cellar\"], \"cellar\": [], \"tower\": [\"hall\"]}`\n\n"
  "`reachable(rooms, \"attic\")` is 0 when `attic` is not a key. `reachable({\"hall\": [\"void\"]}, \"hall\")` is 1.",
  'def reachable(rooms, start):\n    return 0\n',
  'def reachable(rooms, start):\n    seen = set()\n    def walk(room):\n        if room in seen or room not in rooms:\n            return\n        seen.add(room)\n        for nxt in rooms[room]:\n            walk(nxt)\n    walk(start)\n    return len(seen)\n',
  'Recurse from `start`, and keep `seen = set()` so a cycle does not visit a room twice. Skip names that are not keys of `rooms`.',
  tests='''
from solution import reachable

ROOMS = {
    "hall": ["pit", "den"],
    "pit": ["hall"],
    "den": ["cellar"],
    "cellar": [],
    "tower": ["hall"],
}

def test_map():
    assert reachable(ROOMS, "hall") == 4
    assert reachable(ROOMS, "tower") == 5
    assert reachable(ROOMS, "cellar") == 1
    assert reachable(ROOMS, "attic") == 0

def test_edges():
    assert reachable({}, "hall") == 0
    assert reachable({"hall": ["void", "hall"]}, "hall") == 1
    assert reachable({"a": ["b"], "b": ["a"]}, "a") == 2
    assert reachable({"a": ["b"], "b": ["c"], "c": ["d"], "d": []}, "a") == 4
    assert reachable({"a": ["b"], "b": ["c"], "c": ["d"], "d": []}, "c") == 2
    assert reachable({"hall": []}, "hall") == 1
''',
  checks=["call:set", "!node:While"],
  fuzz=("reachable", dedent("""\
    def ref(rooms, start):
        seen = set()
        stack = [start]
        while stack:
            room = stack.pop()
            if room in seen or room not in rooms:
                continue
            seen.add(room)
            stack.extend(rooms[room])
        return len(seen)
    """), dedent("""\
    def gen(r):
        names = ["hall", "pit", "den", "gate", "tower", "cellar"]
        nodes = names[:r.randint(0, 6)]
        graph = {}
        for n in nodes:
            outs = [m for m in nodes if r.randint(0, 2) == 0]
            if r.randint(0, 4) == 0:
                outs.append("void")
            graph[n] = outs
        start = r.choice(names + ["attic"])
        return [graph, start]
    """)),
  wrong=[("counts every room in the map",
          'def reachable(rooms, start):\n    if start not in rooms:\n        return 0\n    return len(rooms)\n'),
         ("counts names that are not rooms",
          'def reachable(rooms, start):\n    seen = set()\n    def walk(room):\n        if room in seen:\n            return\n        seen.add(room)\n        for nxt in rooms.get(room, []):\n            walk(nxt)\n    walk(start)\n    return len(seen)\n')])

Q("recursion", "g1-quiz-recursion", "Quiz: the way back up", "def",
  "Mira's cheer echoes on the way down and on the way back up.",
  'def cheer(n):\n    if n == 0:\n        print("go")\n        return\n    print(n)\n    cheer(n - 1)\n    print(n)\n\ncheer(2)\n',
  "2\n1\ngo\n1\n2",
  "Each call prints n before the recursive call and again after it returns, so the way back up prints 1 then 2, with go in the middle.")
