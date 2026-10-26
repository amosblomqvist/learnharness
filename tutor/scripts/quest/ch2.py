from lib import L, Q, out

T = "# Don't touch below this line\n"

# ============================================================ Computing
L("computing", "binary", "Binary", "bin",
  "The dwarves write their rune numbers in binary.",
  "Write `to_binary(n)` that returns `n` in binary as text without the `0b` prefix: `to_binary(5)` is `\"101\"`. Use `bin()`.",
  'def to_binary(n):\n    return str(n)\n',
  'def to_binary(n):\n    return bin(n)[2:]\n',
  "`bin(5)` is `\"0b101\"`. Slice off the first two characters.",
  tests='''
from solution import to_binary

def test_values():
    assert to_binary(5) == "101"
    assert to_binary(0) == "0"
    assert to_binary(255) == "11111111"
''',
  fuzz=("to_binary", "def ref(n):\n    return format(n, 'b')\n", "def gen(r):\n    return [r.randint(0, 10**6)]\n"),
  wrong=[("keeps the 0b", 'def to_binary(n):\n    return bin(n)\n')])

L("computing", "from-binary", "Reading binary", "convert",
  "A rune tablet reads `1011`.",
  "Write `from_binary(text)` that turns binary text like `\"1011\"` into the number it stands for (11). `int()` takes a base as its second argument.",
  'def from_binary(text):\n    return int(text)\n',
  'def from_binary(text):\n    return int(text, 2)\n',
  "`int(\"1011\", 2)` reads the text in base 2.",
  tests='''
from solution import from_binary

def test_values():
    assert from_binary("1011") == 11
    assert from_binary("0") == 0
    assert from_binary("100000000") == 256
''',
  fuzz=("from_binary", "def ref(t):\n    return int(t, 2)\n", "def gen(r):\n    return [format(r.randint(0, 10**6), 'b')]\n"),
  wrong=[("reads it as decimal", 'def from_binary(text):\n    return int(text)\n')])

L("computing", "flags", "Bit flags", "bitwise",
  "Each door in the castle has permission bits: 1 means read the map, 2 means open, 4 means lock.",
  "Write `has_flag(perms, flag)` that returns `True` when every bit of `flag` is set in `perms`, and `grant(perms, flag)` that returns `perms` with those bits switched on. Use `&` and `|`.",
  'READ, OPEN, LOCK = 1, 2, 4\n\ndef has_flag(perms, flag):\n    return False\n\ndef grant(perms, flag):\n    return perms\n',
  'READ, OPEN, LOCK = 1, 2, 4\n\ndef has_flag(perms, flag):\n    return perms & flag == flag\n\ndef grant(perms, flag):\n    return perms | flag\n',
  "`perms & flag` keeps only the bits both have. `perms | flag` switches the flag's bits on.",
  tests='''
from solution import has_flag, grant, READ, OPEN, LOCK

def test_has():
    assert has_flag(READ | OPEN, OPEN) is True
    assert has_flag(READ, OPEN) is False
    assert has_flag(READ | OPEN, READ | OPEN) is True
    assert has_flag(READ, READ | OPEN) is False

def test_grant():
    assert grant(READ, LOCK) == 5
    assert grant(READ | LOCK, LOCK) == 5
''', checks=["tok:&", "tok:|"],
  wrong=[("any shared bit counts", 'READ, OPEN, LOCK = 1, 2, 4\n\ndef has_flag(perms, flag):\n    return perms & flag != 0\n\ndef grant(perms, flag):\n    return perms | flag\n'),
         ("adds instead of setting bits", 'READ, OPEN, LOCK = 1, 2, 4\n\ndef has_flag(perms, flag):\n    return perms & flag == flag\n\ndef grant(perms, flag):\n    return perms + flag\n')])

L("computing", "floats", "Floats aren't exact", "floats",
  "The alchemist's scales say 0.1 + 0.2 isn't 0.3.",
  "Floats are stored in binary, so `0.1 + 0.2 == 0.3` is `False`. Write `same_weight(a, b)` that returns `True` when two weights are equal to within a tiny tolerance, using `math.isclose`.",
  'def same_weight(a, b):\n    return a == b\n',
  'import math\n\ndef same_weight(a, b):\n    return math.isclose(a, b)\n',
  "`import math`, then `math.isclose(a, b)`.",
  tests='''
from solution import same_weight

def test_values():
    assert same_weight(0.1 + 0.2, 0.3) is True
    assert same_weight(1.0, 1.0) is True
    assert same_weight(1.0, 1.1) is False
''', checks=["call:isclose"],
  wrong=[("rounds to whole numbers", 'def same_weight(a, b):\n    return round(a) == round(b)\n')])

L("computing", "divmod", "Quotient and remainder together", "divmod",
  "Five heroes split the loot in copper coins.",
  "Write `share(total, heroes)` that returns a pair: how many coins each hero gets, and how many are left over. Use `divmod`.",
  'def share(total, heroes):\n    return total / heroes, 0\n',
  'def share(total, heroes):\n    return divmod(total, heroes)\n',
  "`divmod(17, 5)` is `(3, 2)`.",
  tests='''
from solution import share

def test_values():
    assert share(17, 5) == (3, 2)
    assert share(10, 5) == (2, 0)
    assert share(3, 5) == (0, 3)
''',
  fuzz=("share", "def ref(t, h):\n    return (t // h, t % h)\n", "def gen(r):\n    return [r.randint(0, 5000), r.randint(1, 12)]\n"),
  checks=["call:divmod"],
  wrong=[("float division", 'def share(total, heroes):\n    return total / heroes, total % heroes\n')])

L("computing", "big-ints", "Big numbers", "numbers",
  "The dragon's hoard is enormous.",
  "Python integers don't overflow. Set `hoard` to 2 to the power of 100 using `**`, so the console shows:\n\n```text\n1267650600228229401496703205376\n```",
  'hoard = 2 * 100\n\n' + T + 'print(hoard)\n',
  'hoard = 2 ** 100\n\n' + T + 'print(hoard)\n',
  "`**` is the power operator.",
  expect="1267650600228229401496703205376", checks=["tok:**"],
  wrong=[("pastes the number", 'hoard = 1267650600228229401496703205376\n\n' + T + 'print(hoard)\n')])

# ============================================================ Comparisons
L("compare", "booleans", "Booleans", "bool",
  "The healer only helps the living.",
  "Write `is_alive(health)` that returns `True` when `health` is above 0 and `False` otherwise.",
  'def is_alive(health):\n    return None\n',
  'def is_alive(health):\n    return health > 0\n',
  "A comparison like `health > 0` is already a boolean.",
  tests='''
from solution import is_alive

def test_values():
    assert is_alive(1) is True
    assert is_alive(0) is False
    assert is_alive(-5) is False
''',
  fuzz=("is_alive", "def ref(h):\n    return h > 0\n", "def gen(r):\n    return [r.randint(-20, 20)]\n"),
  wrong=[("counts 0 as alive", 'def is_alive(health):\n    return health >= 0\n')])

L("compare", "if-else", "if and else", "if",
  "Sam decides whether to rest.",
  "Write `choose(health)` that returns `\"rest\"` when health is below 30 and `\"fight\"` otherwise.",
  'def choose(health):\n    return "fight"\n',
  'def choose(health):\n    if health < 30:\n        return "rest"\n    else:\n        return "fight"\n',
  "`if health < 30:` then `return \"rest\"`.",
  tests='''
from solution import choose

def test_values():
    assert choose(29) == "rest"
    assert choose(30) == "fight"
    assert choose(100) == "fight"
''',
  fuzz=("choose", "def ref(h):\n    return 'rest' if h < 30 else 'fight'\n", "def gen(r):\n    return [r.randint(-10, 120)]\n"),
  wrong=[("rests at exactly 30", 'def choose(health):\n    if health <= 30:\n        return "rest"\n    return "fight"\n')])

L("compare", "elif", "elif", "if",
  "Heroes are ranked by level.",
  "Write `rank(level)`: below 5 is `\"novice\"`, 5 to 9 is `\"adept\"`, and 10 or more is `\"master\"`.",
  'def rank(level):\n    return "novice"\n',
  'def rank(level):\n    if level < 5:\n        return "novice"\n    elif level < 10:\n        return "adept"\n    else:\n        return "master"\n',
  "Chain the checks: `if`, then `elif`, then `else`.",
  tests='''
from solution import rank

def test_values():
    assert rank(1) == "novice"
    assert rank(4) == "novice"
    assert rank(5) == "adept"
    assert rank(9) == "adept"
    assert rank(10) == "master"
    assert rank(40) == "master"
''',
  fuzz=("rank", "def ref(l):\n    return 'novice' if l < 5 else 'adept' if l < 10 else 'master'\n", "def gen(r):\n    return [r.randint(0, 30)]\n"),
  wrong=[("checks in the wrong order", 'def rank(level):\n    if level < 10:\n        return "adept"\n    elif level < 5:\n        return "novice"\n    return "master"\n')])

L("compare", "and-or-not", "and, or, not", "bool",
  "The castle gate opens for high levels carrying the key, and never for the cursed.",
  "Write `can_enter(level, has_key, cursed)` that returns `True` only when `level` is at least 5 **and** `has_key` is true **and** the hero is **not** `cursed`.",
  'def can_enter(level, has_key, cursed):\n    return False\n',
  'def can_enter(level, has_key, cursed):\n    return level >= 5 and has_key and not cursed\n',
  "Join the conditions with `and`, and flip `cursed` with `not`.",
  tests='''
from solution import can_enter

def test_values():
    assert can_enter(5, True, False) is True
    assert can_enter(4, True, False) is False
    assert can_enter(9, False, False) is False
    assert can_enter(9, True, True) is False
''',
  fuzz=("can_enter", "def ref(l, k, c):\n    return l >= 5 and k and not c\n", "def gen(r):\n    return [r.randint(0, 10), r.choice([True, False]), r.choice([True, False])]\n"),
  wrong=[("or instead of and", 'def can_enter(level, has_key, cursed):\n    return (level >= 5 or has_key) and not cursed\n'),
         ("forgets the curse", 'def can_enter(level, has_key, cursed):\n    return level >= 5 and has_key\n')])

L("compare", "chained", "Chained comparisons", "comparisons",
  "Some quests are only for a band of levels.",
  "Write `in_band(level, low, high)` that returns `True` when `low <= level <= high`. Python lets you chain the comparisons exactly like that.",
  'def in_band(level, low, high):\n    return level > low\n',
  'def in_band(level, low, high):\n    return low <= level <= high\n',
  "`low <= level <= high` checks both sides at once.",
  tests='''
from solution import in_band

def test_values():
    assert in_band(5, 1, 10) is True
    assert in_band(1, 1, 10) is True
    assert in_band(10, 1, 10) is True
    assert in_band(11, 1, 10) is False
    assert in_band(0, 1, 10) is False
''',
  fuzz=("in_band", "def ref(l, a, b):\n    return a <= l <= b\n", "def gen(r):\n    a = r.randint(0, 20)\n    return [r.randint(-5, 40), a, a + r.randint(0, 10)]\n"),
  wrong=[("excludes the ends", 'def in_band(level, low, high):\n    return low < level < high\n')])

L("compare", "ternary", "One-line if", "ifexp",
  "The status bar needs one word.",
  "Write `status(hp)` that returns `\"alive\"` when `hp` is above 0 and `\"fallen\"` otherwise, in **one** `return` line using `x if condition else y`.",
  'def status(hp):\n    return "alive"\n',
  'def status(hp):\n    return "alive" if hp > 0 else "fallen"\n',
  "`return \"alive\" if hp > 0 else \"fallen\"`",
  tests='''
from solution import status

def test_values():
    assert status(5) == "alive"
    assert status(0) == "fallen"
    assert status(-1) == "fallen"
''', checks=["node:IfExp"],
  wrong=[("a full if statement", 'def status(hp):\n    if hp > 0:\n        return "alive"\n    return "fallen"\n')])

L("compare", "membership", "in", "in",
  "Only certain items count as loot.",
  "Write `is_loot(item)` that returns `True` when `item` is one of `\"gold\"`, `\"gem\"` or `\"scroll\"`.",
  'def is_loot(item):\n    return False\n',
  'def is_loot(item):\n    return item in ["gold", "gem", "scroll"]\n',
  "`x in [a, b, c]` is true when `x` is one of them.",
  tests='''
from solution import is_loot

def test_values():
    assert is_loot("gold") is True
    assert is_loot("scroll") is True
    assert is_loot("rock") is False
    assert is_loot("") is False
    assert is_loot("go") is False
''',
  wrong=[("searches inside one string", 'def is_loot(item):\n    return item in "gold gem scroll"\n')])

L("compare", "truthiness", "Truthiness", "truth",
  "An empty backpack counts as false.",
  "Write `has_items(bag)` that returns `True` when the list `bag` has anything in it and `False` when it is empty. Don't use `len`.",
  'def has_items(bag):\n    return None\n',
  'def has_items(bag):\n    return bool(bag)\n',
  "Empty lists are false, other lists are true. `bool(bag)` turns that into `True` or `False`.",
  tests='''
from solution import has_items

def test_values():
    assert has_items([]) is False
    assert has_items(["sword"]) is True
    assert has_items([0]) is True
''', checks=["!call:len"],
  wrong=[("returns the list itself", 'def has_items(bag):\n    return bag\n')])

L("compare", "string-compare", "Comparing text", "comparisons",
  "Names on the guild list don't care about capitals.",
  "Write `same_name(a, b)` that returns `True` when the two names are the same, ignoring upper and lower case: `same_name(\"Sam\", \"sAM\")` is `True`.",
  'def same_name(a, b):\n    return a == b\n',
  'def same_name(a, b):\n    return a.lower() == b.lower()\n',
  "Compare `a.lower()` with `b.lower()`.",
  tests='''
from solution import same_name

def test_values():
    assert same_name("Sam", "sAM") is True
    assert same_name("Sam", "Sam") is True
    assert same_name("Sam", "Mira") is False
    assert same_name("Sam", "Samwise") is False
''',
  wrong=[("only checks the first letter", 'def same_name(a, b):\n    return a[0].lower() == b[0].lower()\n')])

# ============================================================ Loops
L("loops", "for-range", "for loops", "range",
  "The arena announces each round.",
  "Use a `for` loop with `range()` so the console shows:\n\n```text\nRound 1\nRound 2\nRound 3\nRound 4\nRound 5\n```",
  'print("Round 1")\n',
  'for n in range(1, 6):\n    print(f"Round {n}")\n',
  "`range(1, 6)` counts 1, 2, 3, 4, 5. The end is not included.",
  expect=out(["Round %d" % i for i in range(1, 6)]), checks=["node:For", "call:range"],
  wrong=[("five print lines", 'print("Round 1")\nprint("Round 2")\nprint("Round 3")\nprint("Round 4")\nprint("Round 5")\n'),
         ("starts at 0", 'for n in range(5):\n    print(f"Round {n}")\n')])

L("loops", "range-step", "Counting down", "range",
  "The portal closes in a countdown of twos.",
  "Use `range()` with a step so the console shows:\n\n```text\n10\n8\n6\n4\n2\n0\n```",
  'for n in range(10):\n    print(n)\n',
  'for n in range(10, -1, -2):\n    print(n)\n',
  "`range(start, stop, step)`: start at 10, step by -2, and stop *before* -1.",
  expect=out([str(i) for i in range(10, -1, -2)]), checks=["node:For", "call:range"],
  wrong=[("stops too early", 'for n in range(10, 0, -2):\n    print(n)\n')])

L("loops", "sum-loop", "Adding up in a loop", "for",
  "Sam counts the gold in every chest.",
  "Write `total_gold(chests)` that adds up the numbers in the list `chests` using a `for` loop (no `sum()`).",
  'def total_gold(chests):\n    return 0\n',
  'def total_gold(chests):\n    total = 0\n    for chest in chests:\n        total += chest\n    return total\n',
  "Start with `total = 0`, add each chest to it, and return it after the loop.",
  tests='''
from solution import total_gold

def test_values():
    assert total_gold([10, 20, 30]) == 60
    assert total_gold([]) == 0
    assert total_gold([7]) == 7
''', checks=["node:For", "!call:sum"],
  fuzz=("total_gold", "def ref(c):\n    return sum(c)\n", "def gen(r):\n    return [[r.randint(0, 100) for _ in range(r.randint(0, 10))]]\n"),
  wrong=[("returns inside the loop", 'def total_gold(chests):\n    total = 0\n    for chest in chests:\n        total += chest\n        return total\n    return total\n')])

L("loops", "while", "while loops", "while",
  "How many swings does it take to fell the boss?",
  "Write `turns_to_win(boss_hp, damage)` that counts how many hits of `damage` it takes to bring `boss_hp` to 0 or less, using a `while` loop. A boss with 0 HP needs 0 turns.",
  'def turns_to_win(boss_hp, damage):\n    return 0\n',
  'def turns_to_win(boss_hp, damage):\n    turns = 0\n    while boss_hp > 0:\n        boss_hp -= damage\n        turns += 1\n    return turns\n',
  "Loop `while boss_hp > 0`: lower it, and count a turn each time.",
  tests='''
from solution import turns_to_win

def test_values():
    assert turns_to_win(100, 30) == 4
    assert turns_to_win(10, 10) == 1
    assert turns_to_win(0, 5) == 0
    assert turns_to_win(31, 30) == 2
''', checks=["node:While"],
  fuzz=("turns_to_win", "def ref(hp, d):\n    return max(0, -(-hp // d))\n", "def gen(r):\n    return [r.randint(-5, 500), r.randint(1, 60)]\n"),
  wrong=[("plain division", 'def turns_to_win(boss_hp, damage):\n    while False:\n        pass\n    return boss_hp // damage\n')])

L("loops", "regen", "Loops that build up", "while",
  "Resting restores health a little each turn, up to the maximum.",
  "Write `rest_turns(hp, max_hp, rate)` that returns how many turns of resting it takes to get `hp` to `max_hp`. Each turn adds `rate`, but health never goes above `max_hp`. Already full means 0 turns.",
  'def rest_turns(hp, max_hp, rate):\n    return 0\n',
  'def rest_turns(hp, max_hp, rate):\n    turns = 0\n    while hp < max_hp:\n        hp = min(max_hp, hp + rate)\n        turns += 1\n    return turns\n',
  "Loop while `hp < max_hp`; add `rate` each turn and count.",
  tests='''
from solution import rest_turns

def test_values():
    assert rest_turns(10, 50, 10) == 4
    assert rest_turns(45, 50, 10) == 1
    assert rest_turns(50, 50, 10) == 0
''',
  fuzz=("rest_turns", "def ref(hp, m, rate):\n    return max(0, -(-(m - hp) // rate))\n", "def gen(r):\n    m = r.randint(1, 200)\n    return [r.randint(0, m), m, r.randint(1, 30)]\n"),
  wrong=[("one turn too many", 'def rest_turns(hp, max_hp, rate):\n    turns = 0\n    while hp <= max_hp:\n        hp += rate\n        turns += 1\n    return turns\n')])

L("loops", "break", "break", "break",
  "Sam is looking for the first strong hit.",
  "Write `first_big_hit(hits, limit)` that returns the first number in `hits` that is at least `limit`, or `None` if there isn't one. Use a loop and stop early.",
  'def first_big_hit(hits, limit):\n    return None\n',
  'def first_big_hit(hits, limit):\n    for hit in hits:\n        if hit >= limit:\n            return hit\n    return None\n',
  "Loop over `hits`. When one is at least `limit`, return it.",
  tests='''
from solution import first_big_hit

def test_values():
    assert first_big_hit([3, 8, 15, 20], 10) == 15
    assert first_big_hit([1, 2], 10) is None
    assert first_big_hit([], 1) is None
''',
  fuzz=("first_big_hit", "def ref(h, l):\n    return next((x for x in h if x >= l), None)\n", "def gen(r):\n    return [[r.randint(0, 30) for _ in range(r.randint(0, 8))], r.randint(0, 30)]\n"),
  wrong=[("the biggest instead of the first", 'def first_big_hit(hits, limit):\n    big = [h for h in hits if h >= limit]\n    return max(big) if big else None\n')])

L("loops", "continue", "continue", "break",
  "Fallen monsters shouldn't count.",
  "Write `count_alive(healths)` that counts how many numbers in the list are above 0. Use `continue` to skip the fallen ones.",
  'def count_alive(healths):\n    return 0\n',
  'def count_alive(healths):\n    alive = 0\n    for health in healths:\n        if health <= 0:\n            continue\n        alive += 1\n    return alive\n',
  "Inside the loop: `if health <= 0: continue`, otherwise count it.",
  tests='''
from solution import count_alive

def test_values():
    assert count_alive([10, 0, 5, -3]) == 2
    assert count_alive([]) == 0
    assert count_alive([0, 0]) == 0
''', checks=["node:Continue"],
  fuzz=("count_alive", "def ref(h):\n    return sum(1 for x in h if x > 0)\n", "def gen(r):\n    return [[r.randint(-5, 5) for _ in range(r.randint(0, 10))]]\n"),
  wrong=[("counts the fallen", 'def count_alive(healths):\n    alive = 0\n    for health in healths:\n        if health < 0:\n            continue\n        alive += 1\n    return alive\n')])

L("loops", "loop-string", "Looping over text", "for",
  "Spells are stronger with more vowels.",
  "Write `count_vowels(word)` that counts the letters `a`, `e`, `i`, `o`, `u` in `word`, upper or lower case, using a loop over the text.",
  'def count_vowels(word):\n    return 0\n',
  'def count_vowels(word):\n    count = 0\n    for letter in word.lower():\n        if letter in "aeiou":\n            count += 1\n    return count\n',
  "`for letter in word:` goes through the text one character at a time.",
  tests='''
from solution import count_vowels

def test_values():
    assert count_vowels("Fireball") == 3
    assert count_vowels("AEIOU") == 5
    assert count_vowels("rhythm") == 0
    assert count_vowels("") == 0
''', checks=["node:For"],
  fuzz=("count_vowels", "def ref(w):\n    return sum(1 for c in w.lower() if c in 'aeiou')\n", "def gen(r):\n    return [''.join(r.choice('abcdeEIOUxyz ') for _ in range(r.randint(0, 15)))]\n"),
  wrong=[("ignores capitals", 'def count_vowels(word):\n    count = 0\n    for letter in word:\n        if letter in "aeiou":\n            count += 1\n    return count\n')])

L("loops", "progress-bar", "Building text in a loop", "for",
  "The loading screen shows a bar.",
  "Write `progress_bar(done, total)` that returns a 10-character bar in brackets: one `#` per tenth done, and `-` for the rest. `progress_bar(3, 10)` is `\"[###-------]\"`. Round down.",
  'def progress_bar(done, total):\n    return "[----------]"\n',
  'def progress_bar(done, total):\n    filled = done * 10 // total\n    bar = ""\n    for i in range(10):\n        bar += "#" if i < filled else "-"\n    return "[" + bar + "]"\n',
  "Work out how many `#` with `done * 10 // total`, then build the 10 characters.",
  tests='''
from solution import progress_bar

def test_values():
    assert progress_bar(3, 10) == "[###-------]"
    assert progress_bar(0, 5) == "[----------]"
    assert progress_bar(5, 5) == "[##########]"
    assert progress_bar(1, 3) == "[###-------]"
''',
  fuzz=("progress_bar", "def ref(d, t):\n    f = d * 10 // t\n    return '[' + '#' * f + '-' * (10 - f) + ']'\n", "def gen(r):\n    t = r.randint(1, 50)\n    return [r.randint(0, t), t]\n"),
  wrong=[("rounds to nearest", 'def progress_bar(done, total):\n    filled = round(done * 10 / total)\n    return "[" + "#" * filled + "-" * (10 - filled) + "]"\n')])

L("loops", "nested", "Nested loops", "for",
  "The dungeon map is drawn row by row.",
  "Use two `for` loops (one inside the other) to draw a 3 by 4 room, so the console shows:\n\n```text\n####\n####\n####\n```\n\nPrint one character at a time with `print(\"#\", end=\"\")`, and finish each row with `print()`.",
  'print("####")\n',
  'for row in range(3):\n    for col in range(4):\n        print("#", end="")\n    print()\n',
  "The inner loop prints a row of `#` without a newline. After it, `print()` ends the row.",
  expect=out(["####", "####", "####"]), checks=[("kw:end", "Print one character at a time with `end=\"\"`.")],
  extra='''
def test_two_loops():
    loops = [n for n in NODES if isinstance(n, ast.For)]
    assert any(isinstance(inner, ast.For) for outer in loops for inner in ast.walk(outer) if inner is not outer), "Put one for loop inside another"
''',
  wrong=[("three prints", 'print("####")\nprint("####")\nprint("####")\n'),
         ("one loop with whole rows", 'for row in range(3):\n    print("#" * 4, end="")\n    print()\n')])
