from lib import L, Q, out

T = "# Don't touch below this line\n"

# ============================================================ Errors
L("errors", "try-except", "try and except", "handling",
  "Player input is messy.",
  "Write `safe_int(text, default=0)` that turns text into an `int`, or returns `default` when the text isn't a whole number.",
  'def safe_int(text, default=0):\n    return int(text)\n',
  'def safe_int(text, default=0):\n    try:\n        return int(text)\n    except ValueError:\n        return default\n',
  "Put `int(text)` in a `try:` block and catch `ValueError`.",
  tests='''
from solution import safe_int

def test_values():
    assert safe_int("42") == 42
    assert safe_int(" 7 ") == 7
    assert safe_int("nope") == 0
    assert safe_int("", default=-1) == -1
''', checks=["node:Try"],
  wrong=[("only digits count", 'def safe_int(text, default=0):\n    try:\n        return int(text) if text.isdigit() else default\n    except ValueError:\n        return default\n')])

L("errors", "raise", "Raising errors", "raise",
  "No hero starts below level 1.",
  "Write `check_level(level)` that returns `level` when it is 1 or more, and raises a `ValueError` otherwise.",
  'def check_level(level):\n    return level\n',
  'def check_level(level):\n    if level < 1:\n        raise ValueError("level must be at least 1")\n    return level\n',
  "`raise ValueError(\"...\")` stops the function with an error.",
  tests='''
from solution import check_level

def test_ok():
    assert check_level(1) == 1
    assert check_level(8) == 8

def test_bad():
    for bad in (0, -3):
        try:
            check_level(bad)
        except ValueError:
            continue
        raise AssertionError("check_level(%r) should raise ValueError" % bad)
''', checks=["node:Raise"],
  wrong=[("returns None instead of raising", 'def check_level(level):\n    if level < 1:\n        return None\n    return level\n'),
         ("the wrong kind of error", 'def check_level(level):\n    if level < 1:\n        raise TypeError("bad level")\n    return level\n')])

L("errors", "specific", "Catching the right error", "handling",
  "A slot number may point past the end of the bag.",
  "Write `read_slot(bag, index)` that returns the item at `index`, or the text `\"empty\"` when the index is out of range. Catch `IndexError`, not every error.",
  'def read_slot(bag, index):\n    return bag[index]\n',
  'def read_slot(bag, index):\n    try:\n        return bag[index]\n    except IndexError:\n        return "empty"\n',
  "`except IndexError:` only catches the out-of-range case.",
  tests='''
from solution import read_slot

def test_values():
    assert read_slot(["sword", "shield"], 1) == "shield"
    assert read_slot(["sword"], 5) == "empty"

def test_other_errors_still_raise():
    try:
        read_slot(["sword"], "x")
    except TypeError:
        return
    raise AssertionError("a TypeError must not be hidden")
''',
  wrong=[("catches everything", 'def read_slot(bag, index):\n    try:\n        return bag[index]\n    except Exception:\n        return "empty"\n')])

L("errors", "message", "Error messages", "raise",
  "The shopkeeper explains why the sale failed.",
  "Write `buy(gold, price)`. It returns the gold left after paying. If `price` is more than `gold`, raise a `ValueError` whose message is exactly `not enough gold`.",
  'def buy(gold, price):\n    return gold - price\n',
  'def buy(gold, price):\n    if price > gold:\n        raise ValueError("not enough gold")\n    return gold - price\n',
  "`raise ValueError(\"not enough gold\")`",
  tests='''
from solution import buy

def test_ok():
    assert buy(50, 20) == 30
    assert buy(10, 10) == 0

def test_message():
    try:
        buy(5, 20)
    except ValueError as err:
        assert str(err) == "not enough gold", "The message is %r" % str(err)
        return
    raise AssertionError("buy(5, 20) should raise ValueError")
''',
  wrong=[("a different message", 'def buy(gold, price):\n    if price > gold:\n        raise ValueError("Not enough gold!")\n    return gold - price\n')])

L("errors", "finally", "Cleaning up with finally", "cleanup",
  "Whatever happens in a turn, the turn ends.",
  "Write `take_turn(log, action)`: it calls `action()` and returns its result, and **always** appends `\"turn over\"` to the list `log` afterwards, even when `action()` raises. Don't swallow the error: it must still reach the caller.",
  'def take_turn(log, action):\n    result = action()\n    log.append("turn over")\n    return result\n',
  'def take_turn(log, action):\n    try:\n        return action()\n    finally:\n        log.append("turn over")\n',
  "`try:` call the action, `finally:` append to the log.",
  tests='''
from solution import take_turn

def test_normal():
    log = []
    assert take_turn(log, lambda: 7) == 7
    assert log == ["turn over"]

def test_error_still_logs_and_raises():
    log = []
    def boom():
        raise RuntimeError("trap!")
    try:
        take_turn(log, boom)
    except RuntimeError:
        assert log == ["turn over"], "the log should still get 'turn over'"
        return
    raise AssertionError("the RuntimeError should reach the caller")
''', checks=[("node:Try", "Use try and finally.")],
  wrong=[("swallows the error", 'def take_turn(log, action):\n    try:\n        return action()\n    except Exception:\n        return None\n    finally:\n        log.append("turn over")\n')])

L("errors", "custom", "Your own exception", "userexc",
  "Spells fail for a reason the game wants to name.",
  "Define an exception class `NotEnoughMana` (a subclass of `Exception`), and write `cast(mana, cost)` that returns the mana left, or raises `NotEnoughMana` when `cost` is more than `mana`.",
  'def cast(mana, cost):\n    if cost > mana:\n        raise Exception("not enough mana")\n    return mana - cost\n',
  'class NotEnoughMana(Exception):\n    pass\n\ndef cast(mana, cost):\n    if cost > mana:\n        raise NotEnoughMana(f"need {cost}, have {mana}")\n    return mana - cost\n',
  "`class NotEnoughMana(Exception):` with `pass` as its body, then `raise NotEnoughMana(...)`.",
  tests='''
import solution

def test_class():
    assert isinstance(getattr(solution, "NotEnoughMana", None), type), "Define a class NotEnoughMana"
    assert issubclass(solution.NotEnoughMana, Exception)

def test_cast():
    assert solution.cast(10, 3) == 7
    try:
        solution.cast(2, 5)
    except solution.NotEnoughMana:
        return
    raise AssertionError("cast(2, 5) should raise NotEnoughMana")
''',
  wrong=[("defines the class but raises a plain Exception", 'class NotEnoughMana(Exception):\n    pass\n\ndef cast(mana, cost):\n    if cost > mana:\n        raise Exception("not enough mana")\n    return mana - cost\n')])

L("errors", "reraise", "Adding context to an error", "chaining",
  "A broken save file should say which line was bad.",
  "Write `parse_level(line)` that returns `int(line)`. When that fails, raise a new `ValueError` whose message is `bad level: ` followed by the line in quotes, like `bad level: 'ten'`, chained to the original with `from`.",
  'def parse_level(line):\n    return int(line)\n',
  'def parse_level(line):\n    try:\n        return int(line)\n    except ValueError as err:\n        raise ValueError(f"bad level: {line!r}") from err\n',
  "`raise ValueError(f\"bad level: {line!r}\") from err` inside the `except` block.",
  tests='''
from solution import parse_level

def test_ok():
    assert parse_level("12") == 12

def test_message_and_cause():
    try:
        parse_level("ten")
    except ValueError as err:
        assert str(err) == "bad level: 'ten'", "The message is %r" % str(err)
        assert isinstance(err.__cause__, ValueError), "Chain it with `from err`"
        return
    raise AssertionError("parse_level('ten') should raise ValueError")
''',
  wrong=[("no chaining", 'def parse_level(line):\n    try:\n        return int(line)\n    except ValueError:\n        raise ValueError(f"bad level: {line!r}") from None\n')])

# ============================================================ Type hints
L("hints", "annotate", "Annotating functions", "typing",
  "The guild requires every function to say what it takes.",
  "Add type hints to `heal`: `health` and `amount` are `int`, and it returns an `int`. The body stays as it is.",
  'def heal(health, amount):\n    return health + amount\n',
  'def heal(health: int, amount: int) -> int:\n    return health + amount\n',
  "`def heal(health: int, amount: int) -> int:`",
  tests='''
from typing import get_type_hints
from solution import heal

def test_hints():
    assert get_type_hints(heal) == {"health": int, "amount": int, "return": int}

def test_body():
    assert heal(10, 5) == 15
''',
  wrong=[("forgets the return type", 'def heal(health: int, amount: int):\n    return health + amount\n')])

L("hints", "collections", "Hints for lists and dictionaries", "typing",
  "Collections can say what they hold.",
  "Annotate `total(values)` to take a `list[int]` and return an `int`, and `names_by_level(heroes)` to take a `dict[str, int]` and return a `list[str]`.",
  'def total(values):\n    return sum(values)\n\ndef names_by_level(heroes):\n    return sorted(heroes, key=heroes.get)\n',
  'def total(values: list[int]) -> int:\n    return sum(values)\n\ndef names_by_level(heroes: dict[str, int]) -> list[str]:\n    return sorted(heroes, key=heroes.get)\n',
  "`list[int]` and `dict[str, int]` go right after the parameter name and colon.",
  tests='''
from typing import get_type_hints
from solution import total, names_by_level

def test_total():
    assert get_type_hints(total) == {"values": list[int], "return": int}
    assert total([1, 2]) == 3

def test_names():
    assert get_type_hints(names_by_level) == {"heroes": dict[str, int], "return": list[str]}
    assert names_by_level({"Sam": 3, "Mira": 1}) == ["Mira", "Sam"]
''',
  wrong=[("bare list and dict", 'def total(values: list) -> int:\n    return sum(values)\n\ndef names_by_level(heroes: dict) -> list:\n    return sorted(heroes, key=heroes.get)\n')])

L("hints", "optional", "Values that may be missing", "typing",
  "A search either finds a hero or doesn't.",
  "`find_hero` returns the hero's level, or `None` when the name isn't there. Annotate it: `levels` is a `dict[str, int]`, `name` is a `str`, and the return type is `int | None`.",
  'def find_hero(levels, name):\n    return levels.get(name)\n',
  'def find_hero(levels: dict[str, int], name: str) -> int | None:\n    return levels.get(name)\n',
  "A value that may be `None` is written `int | None`.",
  tests='''
from typing import get_type_hints
from solution import find_hero

def test_hints():
    assert get_type_hints(find_hero) == {"levels": dict[str, int], "name": str, "return": (int | None)}

def test_body():
    assert find_hero({"Sam": 3}, "Sam") == 3
    assert find_hero({"Sam": 3}, "Bran") is None
''',
  wrong=[("says it always returns an int", 'def find_hero(levels: dict[str, int], name: str) -> int:\n    return levels.get(name)\n')])

L("hints", "tuple-hint", "Hints for tuples", "typing",
  "Coordinates on the map are pairs.",
  "Annotate `step(pos, dx, dy)`: `pos` is a `tuple[int, int]`, `dx` and `dy` are `int`, and it returns a `tuple[int, int]`.",
  'def step(pos, dx, dy):\n    return pos[0] + dx, pos[1] + dy\n',
  'def step(pos: tuple[int, int], dx: int, dy: int) -> tuple[int, int]:\n    return pos[0] + dx, pos[1] + dy\n',
  "`tuple[int, int]` is a pair of ints.",
  tests='''
from typing import get_type_hints
from solution import step

def test_hints():
    assert get_type_hints(step) == {"pos": tuple[int, int], "dx": int, "dy": int, "return": tuple[int, int]}

def test_body():
    assert step((1, 2), 3, -1) == (4, 1)
''',
  wrong=[("a list instead of a tuple", 'def step(pos: list[int], dx: int, dy: int) -> list[int]:\n    return pos[0] + dx, pos[1] + dy\n')])

# ============================================================ Testing
HARNESS = '''
import solution

def learner_tests():
    tests = [f for n, f in vars(solution).items() if n.startswith("test_") and callable(f)]
    assert tests, "Write at least one function whose name starts with test_"
    return tests

def passes_with(name, impl):
    old = getattr(solution, name)
    setattr(solution, name, impl)
    try:
        for t in learner_tests():
            t()
        return True
    except Exception:
        return False
    finally:
        setattr(solution, name, old)
'''


def mutation_tests(fn, real, bugs):
    lines = [HARNESS, real]
    lines.append('def test_your_tests_pass_on_the_real_code():\n    assert passes_with(%r, REAL), "Your tests fail on the correct %s. Check what you expect."\n' % (fn, fn))
    for i, (desc, code) in enumerate(bugs):
        lines.append(code)
        slug = "".join(c if c.isalnum() else "_" for c in desc.lower()).strip("_")
        lines.append('def test_catches_%s():\n    assert not passes_with(%r, BUG_%d), "Your tests don\'t catch this bug: %s"\n' % (slug, fn, i, desc))
    return "\n".join(lines)


L("testing", "first-test", "Your first test", "unittest",
  "The healer's spell has a cap: health never goes above 100.",
  "`heal` is written for you. Below it, write a function `test_heal()` with `assert` lines that check `heal` works, including the cap. Your test is run against the real `heal` (it must pass) and against three broken versions (it must catch each one).",
  'def heal(health, amount):\n    return min(100, health + amount)\n\ndef test_heal():\n    pass\n',
  'def heal(health, amount):\n    return min(100, health + amount)\n\ndef test_heal():\n    assert heal(50, 20) == 70\n    assert heal(90, 20) == 100\n    assert heal(100, 0) == 100\n',
  "Test a normal heal, a heal that would pass 100, and one that lands exactly on 100.",
  tests=mutation_tests("heal", "def REAL(health, amount):\n    return min(100, health + amount)\n", [
      ("heal ignores the amount", "def BUG_0(health, amount):\n    return health\n"),
      ("heal has no cap", "def BUG_1(health, amount):\n    return health + amount\n"),
      ("heal subtracts", "def BUG_2(health, amount):\n    return min(100, health - amount)\n"),
  ]),
  wrong=[("only checks a normal heal, so the missing cap slips through", 'def heal(health, amount):\n    return min(100, health + amount)\n\ndef test_heal():\n    assert heal(50, 20) == 70\n'),
         ("asserts something always true", 'def heal(health, amount):\n    return min(100, health + amount)\n\ndef test_heal():\n    assert heal(50, 20) is not None\n')])

L("testing", "edge-cases", "Testing the edges", "unittest",
  "Bugs hide at the boundaries.",
  "`clamp(hp)` keeps health between 0 and 100. Write `test_clamp()` that checks the inside, both ends, and values beyond both ends. It must pass on the real `clamp` and catch three broken ones.",
  'def clamp(hp):\n    return max(0, min(100, hp))\n\ndef test_clamp():\n    assert clamp(50) == 50\n',
  'def clamp(hp):\n    return max(0, min(100, hp))\n\ndef test_clamp():\n    assert clamp(50) == 50\n    assert clamp(0) == 0\n    assert clamp(100) == 100\n    assert clamp(-5) == 0\n    assert clamp(150) == 100\n',
  "Check -5, 0, 50, 100 and 150.",
  tests=mutation_tests("clamp", "def REAL(hp):\n    return max(0, min(100, hp))\n", [
      ("no lower limit", "def BUG_0(hp):\n    return min(100, hp)\n"),
      ("the top is 99", "def BUG_1(hp):\n    return max(0, min(99, hp))\n"),
      ("no upper limit", "def BUG_2(hp):\n    return max(0, hp)\n"),
  ]),
  wrong=[("never tests above 100", 'def clamp(hp):\n    return max(0, min(100, hp))\n\ndef test_clamp():\n    assert clamp(50) == 50\n    assert clamp(-5) == 0\n')])

L("testing", "test-raises", "Testing errors", "handling",
  "A shop that lets you go into debt is a broken shop.",
  "`withdraw(gold, amount)` returns what's left, and raises `ValueError` when `amount` is more than `gold`. Write `test_withdraw()` that checks a normal withdrawal, taking exactly everything, and that too much raises `ValueError` (use `try`/`except`). It must catch three broken versions.",
  'def withdraw(gold, amount):\n    if amount > gold:\n        raise ValueError("not enough gold")\n    return gold - amount\n\ndef test_withdraw():\n    assert withdraw(10, 3) == 7\n',
  'def withdraw(gold, amount):\n    if amount > gold:\n        raise ValueError("not enough gold")\n    return gold - amount\n\ndef test_withdraw():\n    assert withdraw(10, 3) == 7\n    assert withdraw(10, 10) == 0\n    try:\n        withdraw(5, 6)\n    except ValueError:\n        pass\n    else:\n        raise AssertionError("withdraw(5, 6) should raise ValueError")\n',
  "Inside the test: `try: withdraw(5, 6)`, `except ValueError: pass`, and `else: raise AssertionError(...)`.",
  tests=mutation_tests("withdraw", "def REAL(gold, amount):\n    if amount > gold:\n        raise ValueError('not enough gold')\n    return gold - amount\n", [
      ("lets you go into debt", "def BUG_0(gold, amount):\n    return gold - amount\n"),
      ("refuses to take exactly everything", "def BUG_1(gold, amount):\n    if amount >= gold:\n        raise ValueError('not enough gold')\n    return gold - amount\n"),
      ("raises the wrong error", "def BUG_2(gold, amount):\n    if amount > gold:\n        raise KeyError('not enough gold')\n    return gold - amount\n"),
  ]),
  wrong=[("catches every error, so the wrong kind passes", 'def withdraw(gold, amount):\n    if amount > gold:\n        raise ValueError("not enough gold")\n    return gold - amount\n\ndef test_withdraw():\n    assert withdraw(10, 3) == 7\n    assert withdraw(10, 10) == 0\n    try:\n        withdraw(5, 6)\n    except Exception:\n        pass\n    else:\n        raise AssertionError("should raise")\n')])

L("testing", "table-test", "Table-driven tests", "unittest",
  "One test, many cases.",
  "`rank(level)` returns `\"novice\"` below 5, `\"adept\"` from 5 to 9, and `\"master\"` from 10. Write `test_rank()` with a list of `(level, expected)` pairs and a `for` loop that asserts each one. It must catch three broken versions.",
  'def rank(level):\n    if level < 5:\n        return "novice"\n    elif level < 10:\n        return "adept"\n    return "master"\n\ndef test_rank():\n    cases = []\n    for level, expected in cases:\n        assert rank(level) == expected\n',
  'def rank(level):\n    if level < 5:\n        return "novice"\n    elif level < 10:\n        return "adept"\n    return "master"\n\ndef test_rank():\n    cases = [(1, "novice"), (4, "novice"), (5, "adept"), (9, "adept"), (10, "master"), (50, "master")]\n    for level, expected in cases:\n        assert rank(level) == expected, (level, expected)\n',
  "Put the boundary levels in the list: 4 and 5, 9 and 10.",
  tests=mutation_tests("rank", "def REAL(level):\n    return 'novice' if level < 5 else 'adept' if level < 10 else 'master'\n", [
      ("5 counts as novice", "def BUG_0(level):\n    return 'novice' if level <= 5 else 'adept' if level < 10 else 'master'\n"),
      ("10 counts as adept", "def BUG_1(level):\n    return 'novice' if level < 5 else 'adept' if level <= 10 else 'master'\n"),
      ("Master with a capital", "def BUG_2(level):\n    return 'novice' if level < 5 else 'adept' if level < 10 else 'Master'\n"),
  ]) + '''
def test_uses_a_loop():
    assert has_node("For"), "Loop over the cases with a for loop"
''',
  wrong=[("misses the boundaries", 'def rank(level):\n    if level < 5:\n        return "novice"\n    elif level < 10:\n        return "adept"\n    return "master"\n\ndef test_rank():\n    cases = [(1, "novice"), (7, "adept"), (50, "master")]\n    for level, expected in cases:\n        assert rank(level) == expected\n')])

# ============================================================ Practice
L("practice", "p-fight", "Quest: the boss fight", "while",
  "The boss waits in the keep. The hero strikes first, then the boss, round after round.",
  "Write `fight(hero_hp, hero_damage, boss_hp, boss_damage)` that plays the fight and returns `\"hero\"` or `\"boss\"`, whoever is still standing. The hero attacks first each round. The fight stops as soon as someone's health reaches 0 or less, so a boss that falls never strikes back.",
  'def fight(hero_hp, hero_damage, boss_hp, boss_damage):\n    return "hero"\n',
  'def fight(hero_hp, hero_damage, boss_hp, boss_damage):\n    while True:\n        boss_hp -= hero_damage\n        if boss_hp <= 0:\n            return "hero"\n        hero_hp -= boss_damage\n        if hero_hp <= 0:\n            return "boss"\n',
  "Loop: the hero hits, check the boss; the boss hits, check the hero. Return as soon as one drops to 0 or less.",
  tests='''
from solution import fight

def test_hero_wins():
    assert fight(100, 30, 90, 10) == "hero"

def test_boss_wins():
    assert fight(20, 5, 100, 15) == "boss"

def test_hero_strikes_first():
    assert fight(10, 50, 50, 50) == "hero"
''',
  fuzz=("fight", "def ref(hh, hd, bh, bd):\n    while True:\n        bh -= hd\n        if bh <= 0:\n            return 'hero'\n        hh -= bd\n        if hh <= 0:\n            return 'boss'\n", "def gen(r):\n    return [r.randint(1, 120), r.randint(1, 40), r.randint(1, 120), r.randint(1, 40)]\n"),
  wrong=[("the boss strikes first", 'def fight(hero_hp, hero_damage, boss_hp, boss_damage):\n    while True:\n        hero_hp -= boss_damage\n        if hero_hp <= 0:\n            return "boss"\n        boss_hp -= hero_damage\n        if boss_hp <= 0:\n            return "hero"\n')],
  project=True)

L("practice", "p-shop", "Quest: the shop", "dicts",
  "The shopkeeper keeps prices in a dictionary.",
  "Write `buy_item(gold, bag, prices, item)` that returns the gold left after buying `item`, and adds the item to the list `bag`. If the item isn't sold, raise a `KeyError`. If Sam can't afford it, raise a `ValueError` and leave `bag` as it was.",
  'def buy_item(gold, bag, prices, item):\n    return gold\n',
  'def buy_item(gold, bag, prices, item):\n    price = prices[item]\n    if price > gold:\n        raise ValueError("not enough gold")\n    bag.append(item)\n    return gold - price\n',
  "Look the price up first (that raises `KeyError` by itself), compare it with `gold`, and only then change the bag.",
  tests='''
from solution import buy_item

PRICES = {"potion": 15, "sword": 80}

def test_buy():
    bag = []
    assert buy_item(100, bag, PRICES, "potion") == 85
    assert bag == ["potion"]
    assert buy_item(80, bag, PRICES, "sword") == 0
    assert bag == ["potion", "sword"]

def test_unknown():
    try:
        buy_item(100, [], PRICES, "dragon")
    except KeyError:
        return
    raise AssertionError("unknown items should raise KeyError")

def test_too_expensive():
    bag = []
    try:
        buy_item(10, bag, PRICES, "sword")
    except ValueError:
        assert bag == [], "the bag should be unchanged"
        return
    raise AssertionError("should raise ValueError")
''',
  wrong=[("adds to the bag before checking the gold", 'def buy_item(gold, bag, prices, item):\n    bag.append(item)\n    price = prices[item]\n    if price > gold:\n        raise ValueError("not enough gold")\n    return gold - price\n')],
  project=True)

L("practice", "p-loot", "Quest: the loot table", "dicts",
  "The monsters dropped a heap of loot.",
  "Write `loot_report(drops)` that returns the loot as a list of strings like `\"gem x3\"`, most common first, ties in alphabetical order.",
  'def loot_report(drops):\n    return []\n',
  'def loot_report(drops):\n    counts = {}\n    for item in drops:\n        counts[item] = counts.get(item, 0) + 1\n    ordered = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))\n    return [f"{item} x{count}" for item, count in ordered]\n',
  "Count first, then `sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))`.",
  tests='''
from solution import loot_report

def test_values():
    assert loot_report(["gem", "gold", "gem", "map", "gold", "gem"]) == ["gem x3", "gold x2", "map x1"]

def test_ties():
    assert loot_report(["rope", "axe"]) == ["axe x1", "rope x1"]

def test_empty():
    assert loot_report([]) == []
''',
  fuzz=("loot_report", "def ref(d):\n    c = {}\n    for x in d:\n        c[x] = c.get(x, 0) + 1\n    return [f'{k} x{v}' for k, v in sorted(c.items(), key=lambda p: (-p[1], p[0]))]\n", "def gen(r):\n    return [[r.choice(['gem', 'gold', 'map', 'axe', 'rope']) for _ in range(r.randint(0, 14))]]\n"),
  wrong=[("ties in the order they appeared", 'def loot_report(drops):\n    counts = {}\n    for item in drops:\n        counts[item] = counts.get(item, 0) + 1\n    ordered = sorted(counts.items(), key=lambda pair: -pair[1])\n    return [f"{item} x{count}" for item, count in ordered]\n')],
  project=True)

L("practice", "p-log", "Quest: the quest log", "dicts",
  "The guild keeps a log of every quest.",
  "`log` maps a quest name to a dictionary with `\"done\"` (a boolean) and `\"gold\"` (the reward). Write `finish(log, name)` that marks the quest done and returns its reward; raise a `ValueError` if it was already done and a `KeyError` if the quest doesn't exist. Then write `unclaimed(log)` that returns the total reward of quests that are not done.",
  'def finish(log, name):\n    return 0\n\ndef unclaimed(log):\n    return 0\n',
  'def finish(log, name):\n    quest = log[name]\n    if quest["done"]:\n        raise ValueError("already done")\n    quest["done"] = True\n    return quest["gold"]\n\ndef unclaimed(log):\n    return sum(q["gold"] for q in log.values() if not q["done"])\n',
  "`log[name]` raises `KeyError` for free. Then check `quest[\"done\"]`.",
  tests='''
from solution import finish, unclaimed

def make():
    return {"rats": {"done": False, "gold": 20}, "dragon": {"done": False, "gold": 500}, "herbs": {"done": True, "gold": 5}}

def test_finish():
    log = make()
    assert finish(log, "rats") == 20
    assert log["rats"]["done"] is True

def test_already_done():
    try:
        finish(make(), "herbs")
    except ValueError:
        return
    raise AssertionError("should raise ValueError")

def test_missing():
    try:
        finish(make(), "ghost")
    except KeyError:
        return
    raise AssertionError("should raise KeyError")

def test_unclaimed():
    log = make()
    assert unclaimed(log) == 520
    finish(log, "dragon")
    assert unclaimed(log) == 20
''',
  wrong=[("can finish a quest twice", 'def finish(log, name):\n    quest = log[name]\n    quest["done"] = True\n    return quest["gold"]\n\ndef unclaimed(log):\n    return sum(q["gold"] for q in log.values() if not q["done"])\n')],
  project=True)

L("practice", "p-walk", "Quest: the map walk", "dicts",
  "Sam follows a list of directions through the wilds.",
  "Write `walk(moves)` that starts at `(0, 0)` and returns the final position after a string of moves: `N` adds 1 to y, `S` takes 1 from y, `E` adds 1 to x, `W` takes 1 from x. Any other letter raises a `ValueError`. `walk(\"NNE\")` is `(1, 2)`.",
  'def walk(moves):\n    return (0, 0)\n',
  'STEPS = {"N": (0, 1), "S": (0, -1), "E": (1, 0), "W": (-1, 0)}\n\ndef walk(moves):\n    x, y = 0, 0\n    for move in moves:\n        if move not in STEPS:\n            raise ValueError(f"unknown move: {move}")\n        dx, dy = STEPS[move]\n        x, y = x + dx, y + dy\n    return (x, y)\n',
  "A dictionary from letter to `(dx, dy)` keeps the loop short.",
  tests='''
from solution import walk

def test_values():
    assert walk("NNE") == (1, 2)
    assert walk("") == (0, 0)
    assert walk("NESW") == (0, 0)
    assert walk("WWS") == (-2, -1)

def test_bad_move():
    try:
        walk("NX")
    except ValueError:
        return
    raise AssertionError("walk('NX') should raise ValueError")
''',
  fuzz=("walk", "def ref(m):\n    x = m.count('E') - m.count('W')\n    y = m.count('N') - m.count('S')\n    return (x, y)\n", "def gen(r):\n    return [''.join(r.choice('NSEW') for _ in range(r.randint(0, 20)))]\n"),
  wrong=[("ignores unknown moves", 'def walk(moves):\n    return (moves.count("E") - moves.count("W"), moves.count("N") - moves.count("S"))\n'),
         ("swaps the axes", 'def walk(moves):\n    for m in moves:\n        if m not in "NSEW":\n            raise ValueError(m)\n    return (moves.count("N") - moves.count("S"), moves.count("E") - moves.count("W"))\n')],
  project=True)

L("practice", "p-carry", "Quest: the heavy pack", "lists",
  "Sam can only carry so much.",
  "Write `pack(items, limit)`. `items` is a list of `(name, weight)` pairs in the order Sam picks them up. Take each item if it still fits under the weight `limit` (a total equal to the limit is fine), skip it if it doesn't, and return the list of names taken.",
  'def pack(items, limit):\n    return [name for name, weight in items]\n',
  'def pack(items, limit):\n    taken = []\n    load = 0\n    for name, weight in items:\n        if load + weight <= limit:\n            taken.append(name)\n            load += weight\n    return taken\n',
  "Keep a running `load`. Add an item only when `load + weight <= limit`.",
  tests='''
from solution import pack

def test_values():
    items = [("armor", 15), ("sword", 5), ("anvil", 50), ("rope", 2)]
    assert pack(items, 22) == ["armor", "sword", "rope"]
    assert pack(items, 20) == ["armor", "sword"]
    assert pack([], 10) == []
''',
  fuzz=("pack", "def ref(items, limit):\n    out, load = [], 0\n    for n, w in items:\n        if load + w <= limit:\n            out.append(n)\n            load += w\n    return out\n", "def gen(r):\n    return [[(r.choice(['axe', 'rope', 'gem', 'tent', 'pot']), r.randint(1, 20)) for _ in range(r.randint(0, 8))], r.randint(0, 50)]\n"),
  wrong=[("stops at the first item that doesn't fit", 'def pack(items, limit):\n    taken, load = [], 0\n    for name, weight in items:\n        if load + weight > limit:\n            break\n        taken.append(name)\n        load += weight\n    return taken\n')],
  project=True)

L("practice", "p-save", "Quest: saving the game", "json",
  "A quest is no good if it can't be saved.",
  "Write `save(state)` that turns the game state (a dictionary) into JSON text, and `load(text)` that turns that text back into the same dictionary. Use the `json` module.",
  'def save(state):\n    return str(state)\n\ndef load(text):\n    return {}\n',
  'import json\n\ndef save(state):\n    return json.dumps(state)\n\ndef load(text):\n    return json.loads(text)\n',
  "`json.dumps` makes text; `json.loads` reads it back.",
  tests='''
import json
from solution import save, load

STATE = {"hero": "Sam", "hp": 42, "bag": ["rope", "gem"], "quests": {"rats": True}}

def test_round_trip():
    assert load(save(STATE)) == STATE

def test_is_json():
    assert json.loads(save(STATE)) == STATE, "save should produce real JSON text"
''', checks=["call:dumps", "call:loads"],
  wrong=[("Python's repr is not JSON", 'import ast\nimport json\n\ndef save(state):\n    return repr(state)\n\ndef load(text):\n    return ast.literal_eval(text)\n')],
  project=True)

L("practice", "p-engine", "Quest: the adventure engine", "strmethods",
  "Time to run a tiny text adventure.",
  "Write `play(commands)`. Sam starts in the `\"hall\"` with an empty bag. Each command is a line: `go <room>` moves Sam, `take <item>` adds the item to the bag, and anything else is ignored. Return a pair: the room Sam ends in, and the bag as a sorted list. Commands may have stray spaces and capitals.",
  'def play(commands):\n    return "hall", []\n',
  'def play(commands):\n    room = "hall"\n    bag = []\n    for line in commands:\n        parts = line.strip().lower().split(maxsplit=1)\n        if len(parts) < 2:\n            continue\n        verb, rest = parts\n        if verb == "go":\n            room = rest\n        elif verb == "take":\n            bag.append(rest)\n    return room, sorted(bag)\n',
  "Reuse what you did in *Splitting commands*: lower-case and split each line into a verb and the rest.",
  tests='''
from solution import play

def test_story():
    commands = ["take lamp", "go cellar", "  TAKE Rusty Key ", "dance", "go tower"]
    assert play(commands) == ("tower", ["lamp", "rusty key"])

def test_nothing():
    assert play([]) == ("hall", [])

def test_ignores_bare_verbs():
    assert play(["go", "take"]) == ("hall", [])
''',
  wrong=[("keeps the capitals", 'def play(commands):\n    room, bag = "hall", []\n    for line in commands:\n        parts = line.strip().split(maxsplit=1)\n        if len(parts) < 2:\n            continue\n        verb, rest = parts\n        if verb.lower() == "go":\n            room = rest\n        elif verb.lower() == "take":\n            bag.append(rest)\n    return room, sorted(bag)\n')],
  show=('play(["go cellar", "take axe"])', "room-bag"),
  project=True)

# ============================================================ Quiz
Q("quiz", "quiz-names", "Quiz: two names, one list", "assignment",
  "The quartermaster tests your memory.",
  'bag = ["rope"]\nspare = bag\nspare.append("torch")\nprint(len(bag))\n',
  "2",
  "`spare = bag` doesn't copy the list. Both names point at one list, so the append through `spare` shows up in `bag` too.")

Q("quiz", "quiz-range", "Quiz: range", "range",
  "The arena master counts the rounds.",
  'total = 0\nfor n in range(1, 4):\n    total += n\nprint(total)\n',
  "6",
  "`range(1, 4)` is 1, 2, 3; the stop value isn't included. 1 + 2 + 3 is 6.")

Q("quiz", "quiz-scope", "Quiz: local or global", "scope",
  "A riddle from the sphinx.",
  'gold = 10\n\ndef spend():\n    gold = 3\n    return gold\n\nprint(spend(), gold)\n',
  "3 10",
  "The `gold = 3` inside the function makes a new local name. The global `gold` is still 10.")

Q("quiz", "quiz-default", "Quiz: the mutable default", "defaults",
  "An old trap that has caught many heroes.",
  'def add_loot(item, bag=[]):\n    bag.append(item)\n    return bag\n\nadd_loot("gem")\nprint(add_loot("gold"))\n',
  "['gem', 'gold']",
  "The default list is made once, when `def` runs, and every call without a `bag` shares it. Use `bag=None` and make a new list inside instead.")

Q("quiz", "quiz-truthy", "Quiz: truthiness", "truth",
  "The gatekeeper checks your pockets.",
  'for thing in [0, "", [], "0", [0]]:\n    print(bool(thing))\n',
  "False\nFalse\nFalse\nTrue\nTrue",
  "Zero, the empty string and the empty list are false. `\"0\"` is a non-empty string and `[0]` is a non-empty list, so both are true.")

Q("quiz", "quiz-dict", "Quiz: dictionary keys", "dicts",
  "The scribe keeps updating the same page.",
  'scores = {"Sam": 1}\nscores["Sam"] = 5\nscores["sam"] = 2\nprint(len(scores), scores["Sam"])\n',
  "2 5",
  "Keys are case-sensitive, so `\"sam\"` is a second key. Assigning to `\"Sam\"` again replaces its value.")

Q("quiz", "quiz-except", "Quiz: try, except, finally", "cleanup",
  "Follow the trap through the dungeon.",
  'def open_chest():\n    try:\n        print("open")\n        return 1 / 0\n    except ZeroDivisionError:\n        print("trap!")\n        return -1\n    finally:\n        print("close")\n\nprint(open_chest())\n',
  "open\ntrap!\nclose\n-1",
  "The division fails, so the `except` block prints and returns -1. `finally` still runs before the function really returns, so `close` prints before the -1.")

Q("quiz", "quiz-slices", "Quiz: slicing", "slices",
  "The scout reads the road backwards.",
  'road = "dragon"\nprint(road[1:4], road[-1], road[::-1])\n',
  "rag n nogard",
  "`[1:4]` is indexes 1, 2, 3: `rag`. `[-1]` is the last letter. `[::-1]` steps backwards through the whole string.")

Q("quiz", "quiz-sets", "Quiz: sets", "sets",
  "Counting the kinds of loot.",
  'loot = ["gem", "gold", "gem", "Gem"]\nprint(len(set(loot)))\n',
  "3",
  "A set keeps each value once, but `\"gem\"` and `\"Gem\"` are different strings: gem, gold and Gem.")

Q("quiz", "quiz-int-div", "Quiz: division", "numbers",
  "The treasurer splits the gold.",
  'print(7 / 2, 7 // 2, -7 // 2, 7 % 3)\n',
  "3.5 3 -4 1",
  "`/` always gives a float. `//` rounds down, toward minus infinity, so `-7 // 2` is -4, not -3. `7 % 3` is the remainder, 1.")
