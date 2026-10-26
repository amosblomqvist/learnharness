from lib import L, Q, out

T = "# Don't touch below this line\n"
WORDS = "['sword', 'shield', 'potion', 'gem', 'map', 'rope', 'torch', 'axe']"

# ============================================================ Lists
L("lists", "index", "Indexing", "slices",
  "Sam checks the first and last item in the bag.",
  "Write `ends(bag)` that returns the first and last items as a pair.",
  'def ends(bag):\n    return None\n',
  'def ends(bag):\n    return bag[0], bag[-1]\n',
  "`bag[0]` is the first item, `bag[-1]` is the last.",
  tests='''
from solution import ends

def test_values():
    assert ends(["sword", "shield", "potion"]) == ("sword", "potion")
    assert ends(["lamp"]) == ("lamp", "lamp")
''',
  fuzz=("ends", "def ref(b):\n    return b[0], b[-1]\n", "def gen(r):\n    return [[r.randint(0, 99) for _ in range(r.randint(1, 9))]]\n"),
  wrong=[("second instead of first", 'def ends(bag):\n    return bag[1] if len(bag) > 1 else bag[0], bag[-1]\n')])

L("lists", "append-remove", "Adding and removing", "lists",
  "Sam picks up a shield and a potion, and drops the sword.",
  "Use `append` and `remove` on `inventory` so the console shows:\n\n```text\n['shield', 'potion']\n```",
  'inventory = ["sword"]\n\n# Change inventory here\n\n' + T + 'print(inventory)\n',
  'inventory = ["sword"]\n\ninventory.append("shield")\ninventory.append("potion")\ninventory.remove("sword")\n\n' + T + 'print(inventory)\n',
  "`inventory.append(\"shield\")` adds to the end; `inventory.remove(\"sword\")` takes it out.",
  expect="['shield', 'potion']", checks=["call:append", "call:remove"],
  wrong=[("builds a new list", 'inventory = ["sword"]\n\ninventory = ["shield", "potion"]\n\n' + T + 'print(inventory)\n')])

L("lists", "find-slot", "Finding an item", "lists",
  "Which slot holds the key?",
  "Write `find_slot(bag, item)` that returns the index of `item` in `bag`, or `-1` when it isn't there.",
  'def find_slot(bag, item):\n    return bag.index(item)\n',
  'def find_slot(bag, item):\n    if item in bag:\n        return bag.index(item)\n    return -1\n',
  "Check `item in bag` before calling `bag.index(item)`, which raises an error when the item is missing.",
  tests='''
from solution import find_slot

def test_values():
    assert find_slot(["sword", "key", "map"], "key") == 1
    assert find_slot(["sword"], "key") == -1
    assert find_slot([], "key") == -1
    assert find_slot(["key", "key"], "key") == 0
''',
  fuzz=("find_slot", "def ref(b, i):\n    return b.index(i) if i in b else -1\n", "def gen(r):\n    w = " + WORDS + "\n    return [[r.choice(w) for _ in range(r.randint(0, 6))], r.choice(w)]\n"),
  wrong=[("the last match instead of the first", 'def find_slot(bag, item):\n    for i in range(len(bag) - 1, -1, -1):\n        if bag[i] == item:\n            return i\n    return -1\n')])

L("lists", "slices", "Slicing", "slices",
  "The scouts report the middle of the road.",
  "Write `middle(items)` that returns a list without the first and last items. Use a slice.",
  'def middle(items):\n    return items\n',
  'def middle(items):\n    return items[1:-1]\n',
  "`items[1:-1]` starts at index 1 and stops before the last item.",
  tests='''
from solution import middle

def test_values():
    assert middle([1, 2, 3, 4, 5]) == [2, 3, 4]
    assert middle([1, 2]) == []
    assert middle([]) == []
''', checks=["node:Slice"],
  fuzz=("middle", "def ref(i):\n    return i[1:-1]\n", "def gen(r):\n    return [[r.randint(0, 9) for _ in range(r.randint(0, 9))]]\n"),
  wrong=[("drops only the first", 'def middle(items):\n    return items[1:]\n')])

L("lists", "len-sum-max", "len, sum and max", "lists",
  "The captain wants a report on the party's hits.",
  "Write `hit_report(damages)` that returns a tuple of how many hits there were, the total damage, and the biggest hit.",
  'def hit_report(damages):\n    return None\n',
  'def hit_report(damages):\n    return len(damages), sum(damages), max(damages)\n',
  "`len`, `sum` and `max` all take the list.",
  tests='''
from solution import hit_report

def test_values():
    assert hit_report([5, 12, 3]) == (3, 20, 12)
    assert hit_report([9]) == (1, 9, 9)
''',
  fuzz=("hit_report", "def ref(d):\n    return len(d), sum(d), max(d)\n", "def gen(r):\n    return [[r.randint(0, 99) for _ in range(r.randint(1, 9))]]\n"),
  wrong=[("the last hit instead of the biggest", 'def hit_report(damages):\n    return len(damages), sum(damages), damages[-1]\n')])

L("lists", "enumerate", "enumerate", "loops",
  "The inventory screen numbers every line.",
  "Write `numbered(items)` that returns a list of strings like `\"1. sword\"`, counting from 1. Use `enumerate`.",
  'def numbered(items):\n    return []\n',
  'def numbered(items):\n    lines = []\n    for number, item in enumerate(items, start=1):\n        lines.append(f"{number}. {item}")\n    return lines\n',
  "`enumerate(items, start=1)` gives `(1, first)`, `(2, second)`, and so on.",
  tests='''
from solution import numbered

def test_values():
    assert numbered(["sword", "shield"]) == ["1. sword", "2. shield"]
    assert numbered([]) == []
''', checks=["call:enumerate"],
  wrong=[("counts from 0", 'def numbered(items):\n    return [f"{n}. {item}" for n, item in enumerate(items)]\n')])

L("lists", "zip", "Pairing lists with zip", "loops",
  "Each hero gets the weapon in the same position.",
  "Write `arm(heroes, weapons)` that returns strings like `\"Sam: sword\"`, pairing the lists position by position with `zip`. If one list is longer, the extras are ignored.",
  'def arm(heroes, weapons):\n    return []\n',
  'def arm(heroes, weapons):\n    return [f"{hero}: {weapon}" for hero, weapon in zip(heroes, weapons)]\n',
  "`for hero, weapon in zip(heroes, weapons):`",
  tests='''
from solution import arm

def test_values():
    assert arm(["Sam", "Mira"], ["sword", "bow"]) == ["Sam: sword", "Mira: bow"]
    assert arm(["Sam", "Mira", "Bran"], ["axe"]) == ["Sam: axe"]
    assert arm([], ["axe"]) == []
''', checks=["call:zip"],
  wrong=[("every hero with every weapon", 'def arm(heroes, weapons):\n    return [f"{h}: {w}" for h in heroes for w in weapons]\n')])

L("lists", "comprehension", "List comprehensions", "listcomp",
  "Only the big hits make the bard's song.",
  "Write `big_hits(damages)` that returns the damages that are 10 or more, using a list comprehension.",
  'def big_hits(damages):\n    return []\n',
  'def big_hits(damages):\n    return [d for d in damages if d >= 10]\n',
  "`[d for d in damages if d >= 10]`",
  tests='''
from solution import big_hits

def test_values():
    assert big_hits([3, 10, 25, 9]) == [10, 25]
    assert big_hits([]) == []
''', checks=["node:ListComp"],
  fuzz=("big_hits", "def ref(d):\n    return [x for x in d if x >= 10]\n", "def gen(r):\n    return [[r.randint(0, 20) for _ in range(r.randint(0, 10))]]\n"),
  wrong=[("a loop instead of a comprehension", 'def big_hits(damages):\n    out = []\n    for d in damages:\n        if d >= 10:\n            out.append(d)\n    return out\n'),
         ("over 10 instead of 10 or more", 'def big_hits(damages):\n    return [d for d in damages if d > 10]\n')])

L("lists", "map-comp", "Transforming with a comprehension", "listcomp",
  "The blacksmith sharpens every blade by 3.",
  "Write `sharpen(damages)` that returns a new list with 3 added to every damage, using a list comprehension. Don't change the list passed in.",
  'def sharpen(damages):\n    for i in range(len(damages)):\n        damages[i] += 3\n    return damages\n',
  'def sharpen(damages):\n    return [d + 3 for d in damages]\n',
  "`[d + 3 for d in damages]` builds a new list.",
  tests='''
from solution import sharpen

def test_values():
    assert sharpen([1, 10]) == [4, 13]
    assert sharpen([]) == []

def test_leaves_input_alone():
    blades = [5, 6]
    sharpen(blades)
    assert blades == [5, 6], "sharpen changed the list it was given"
''', checks=["node:ListComp"],
  wrong=[("changes the input too", 'def sharpen(damages):\n    damages[:] = [d + 3 for d in damages]\n    return damages\n')])

L("lists", "sorting", "Sorting", "sorting",
  "The leaderboard shows the three best scores.",
  "Write `top_three(scores)` that returns the three highest scores, highest first. Don't change the list that was passed in.",
  'def top_three(scores):\n    return []\n',
  'def top_three(scores):\n    return sorted(scores, reverse=True)[:3]\n',
  "`sorted(scores, reverse=True)` gives a new list, highest first. Then slice `[:3]`.",
  tests='''
from solution import top_three

def test_values():
    assert top_three([5, 90, 12, 40, 7]) == [90, 40, 12]
    assert top_three([3, 1]) == [3, 1]

def test_does_not_change_input():
    scores = [5, 90, 12, 40]
    top_three(scores)
    assert scores == [5, 90, 12, 40], "top_three changed the list it was given"
''',
  fuzz=("top_three", "def ref(s):\n    return sorted(s, reverse=True)[:3]\n", "def gen(r):\n    return [[r.randint(0, 100) for _ in range(r.randint(0, 9))]]\n"),
  wrong=[("sorts the caller's list", 'def top_three(scores):\n    scores.sort(reverse=True)\n    return scores[:3]\n')])

L("lists", "sort-key", "Sorting by a key", "sorting",
  "The roster is ordered by level, then by name.",
  "`heroes` is a list of `(name, level)` pairs. Write `roster(heroes)` that returns them sorted by level, highest first, and by name A to Z when levels tie. Use `sorted` with a `key`.",
  'def roster(heroes):\n    return sorted(heroes)\n',
  'def roster(heroes):\n    return sorted(heroes, key=lambda h: (-h[1], h[0]))\n',
  "`key=lambda h: (-h[1], h[0])` sorts by level going down, then by name.",
  tests='''
from solution import roster

def test_values():
    assert roster([("Sam", 3), ("Mira", 7), ("Bran", 3)]) == [("Mira", 7), ("Bran", 3), ("Sam", 3)]
    assert roster([]) == []
''', checks=[("kw:key", "Pass `key=` to sorted.")],
  fuzz=("roster", "def ref(h):\n    return sorted(h, key=lambda x: (-x[1], x[0]))\n", "def gen(r):\n    return [[(r.choice(['Sam', 'Mira', 'Bran', 'Ada', 'Zed']), r.randint(1, 5)) for _ in range(r.randint(0, 7))]]\n"),
  wrong=[("ties in reverse name order", 'def roster(heroes):\n    return sorted(heroes, key=lambda h: (h[1], h[0]), reverse=True)\n')])

L("lists", "aliasing", "Two names, one list", "copy",
  "Sam kept a backup of the bag, but the backup changed too.",
  "`backup = bag` doesn't copy the list: both names point at the same list. Make `backup` a real copy so the console shows:\n\n```text\n['sword', 'map']\n['sword', 'map', 'cursed ring']\n```",
  'bag = ["sword", "map"]\nbackup = bag\n\n' + T + 'bag.append("cursed ring")\nprint(backup)\nprint(bag)\n',
  'bag = ["sword", "map"]\nbackup = bag.copy()\n\n' + T + 'bag.append("cursed ring")\nprint(backup)\nprint(bag)\n',
  "`bag.copy()` (or `bag[:]` or `list(bag)`) makes a new list with the same items.",
  expect=out(["['sword', 'map']", "['sword', 'map', 'cursed ring']"]),
  wrong=[("retypes the backup", 'bag = ["sword", "map"]\nbackup = ["sword", "map"]\nbackup = bag\n\n' + T + 'bag.append("cursed ring")\nprint(backup)\nprint(bag)\n')])

L("lists", "grid", "Lists of lists", "nestedlist",
  "The dungeon map is a grid: `#` is wall, `.` is floor.",
  "Write `count_walls(grid)` that returns how many `\"#\"` cells there are in a list of rows, where each row is a list of one-character strings.",
  'def count_walls(grid):\n    return 0\n',
  'def count_walls(grid):\n    walls = 0\n    for row in grid:\n        for cell in row:\n            if cell == "#":\n                walls += 1\n    return walls\n',
  "Loop over the rows, and inside that over the cells of each row.",
  tests='''
from solution import count_walls

def test_values():
    grid = [["#", "#", "#"], ["#", ".", "#"], ["#", "#", "#"]]
    assert count_walls(grid) == 8
    assert count_walls([]) == 0
    assert count_walls([[".", "."]]) == 0
''',
  fuzz=("count_walls", "def ref(g):\n    return sum(row.count('#') for row in g)\n", "def gen(r):\n    w = r.randint(0, 6)\n    return [[[r.choice('#.') for _ in range(w)] for _ in range(r.randint(0, 6))]]\n"),
  wrong=[("counts only the first row", 'def count_walls(grid):\n    return grid[0].count("#") if grid else 0\n')])

L("lists", "queue", "Taking turns", "lists",
  "In battle, whoever acts goes to the back of the line.",
  "Write `next_turn(order)` that removes the first name from the list `order`, puts it at the end, and returns it. It changes `order` in place.",
  'def next_turn(order):\n    return order[0]\n',
  'def next_turn(order):\n    who = order.pop(0)\n    order.append(who)\n    return who\n',
  "`order.pop(0)` removes and returns the first item; `append` puts it at the end.",
  tests='''
from solution import next_turn

def test_rotation():
    order = ["Sam", "Mira", "Bran"]
    assert next_turn(order) == "Sam"
    assert order == ["Mira", "Bran", "Sam"]
    assert next_turn(order) == "Mira"
    assert order == ["Bran", "Sam", "Mira"]

def test_one():
    order = ["Sam"]
    assert next_turn(order) == "Sam"
    assert order == ["Sam"]
''',
  wrong=[("returns a new list instead of changing it", 'def next_turn(order):\n    who = order[0]\n    order = order[1:] + [who]\n    return who\n')])

# ============================================================ Dictionaries
L("dicts", "create", "Creating dictionaries", "dicts",
  "Every hero has a sheet.",
  "Create a dictionary named `hero` with the keys `\"name\"` (value `\"Sam\"`) and `\"level\"` (value `3`). The code below prints them:\n\n```text\nSam 3\n```",
  '# create hero here\n\n' + T + 'print(hero["name"], hero["level"])\n',
  'hero = {"name": "Sam", "level": 3}\n\n' + T + 'print(hero["name"], hero["level"])\n',
  "`{\"key\": value, \"other\": value}`",
  expect="Sam 3", checks=["node:Dict"],
  extra='''
def test_level_is_a_number():
    import solution
    assert solution.hero["level"] == 3, "level should be the number 3, not text"
''',
  wrong=[("level as text", 'hero = {"name": "Sam", "level": "3"}\n\n' + T + 'print(hero["name"], hero["level"])\n')])

L("dicts", "get", "Missing keys", "mapping",
  "The bank checks what a hero owns.",
  "Write `gold_of(wallets, who)` that returns the gold stored under `who` in `wallets`, or `0` when `who` isn't in there. It must not raise a `KeyError`.",
  'def gold_of(wallets, who):\n    return wallets[who]\n',
  'def gold_of(wallets, who):\n    return wallets.get(who, 0)\n',
  "`wallets.get(who, 0)` returns 0 when the key is missing.",
  tests='''
from solution import gold_of

def test_values():
    wallets = {"Sam": 120, "Mira": 40, "Zed": 0}
    assert gold_of(wallets, "Sam") == 120
    assert gold_of(wallets, "Bran") == 0
    assert gold_of(wallets, "Zed") == 0
    assert gold_of({}, "Sam") == 0
''',
  wrong=[("returns None for a missing key", 'def gold_of(wallets, who):\n    return wallets.get(who)\n')])

L("dicts", "add-delete", "Adding and deleting keys", "dicts",
  "Sam spends his arrows and finds a rope.",
  "Change `bag` so it ends up as `{'torch': 2, 'rope': 1}`: remove the `\"arrows\"` entry and add `\"rope\"` with the value 1.",
  'bag = {"torch": 2, "arrows": 10}\n\n# Change bag here\n\n' + T + 'print(bag)\n',
  'bag = {"torch": 2, "arrows": 10}\n\ndel bag["arrows"]\nbag["rope"] = 1\n\n' + T + 'print(bag)\n',
  "`bag[\"rope\"] = 1` adds a key. `del bag[\"arrows\"]` removes one.",
  expect="{'torch': 2, 'rope': 1}", checks=[("node:Delete", "Remove the key with `del bag[\"arrows\"]`.")],
  wrong=[("rebuilds the dictionary", 'bag = {"torch": 2, "arrows": 10}\n\nbag = {"torch": 2, "rope": 1}\n\n' + T + 'print(bag)\n')])

L("dicts", "items", "Looping over a dictionary", "loops",
  "The quartermaster reads the bag aloud.",
  "Write `bag_lines(bag)` that returns a list of strings like `\"torch: 2\"`, one per entry, in the dictionary's order. Use `.items()`.",
  'def bag_lines(bag):\n    return []\n',
  'def bag_lines(bag):\n    lines = []\n    for name, count in bag.items():\n        lines.append(f"{name}: {count}")\n    return lines\n',
  "`for name, count in bag.items():`",
  tests='''
from solution import bag_lines

def test_values():
    assert bag_lines({"torch": 2, "rope": 1}) == ["torch: 2", "rope: 1"]
    assert bag_lines({}) == []
''', checks=["call:items"],
  wrong=[("sorted instead of in order", 'def bag_lines(bag):\n    return [f"{k}: {v}" for k, v in sorted(bag.items())]\n')])

L("dicts", "counting", "Counting with a dictionary", "dicts",
  "How many of each drop did the monsters leave?",
  "Write `count_loot(drops)` that returns a dictionary of how many times each item appears in the list `drops`. Build it with a loop (don't import anything).",
  'def count_loot(drops):\n    return {}\n',
  'def count_loot(drops):\n    counts = {}\n    for item in drops:\n        counts[item] = counts.get(item, 0) + 1\n    return counts\n',
  "For each item: `counts[item] = counts.get(item, 0) + 1`.",
  tests='''
from solution import count_loot

def test_values():
    assert count_loot(["gem", "gold", "gem", "gem"]) == {"gem": 3, "gold": 1}
    assert count_loot([]) == {}
''', checks=["!node:Import", "!node:ImportFrom"],
  fuzz=("count_loot", "def ref(d):\n    out = {}\n    for x in d:\n        out[x] = out.get(x, 0) + 1\n    return out\n", "def gen(r):\n    return [[r.choice(" + WORDS + ") for _ in range(r.randint(0, 12))]]\n"),
  wrong=[("uses Counter", 'from collections import Counter\n\ndef count_loot(drops):\n    return dict(Counter(drops))\n'),
         ("marks presence, not count", 'def count_loot(drops):\n    return {item: 1 for item in drops}\n')])

L("dicts", "dict-comp", "Dictionary comprehensions", "dicts",
  "The king raises every price by 10%.",
  "Write `with_tax(prices)` that returns a new dictionary with every price multiplied by 1.1 and rounded to 2 decimals, using a dict comprehension.",
  'def with_tax(prices):\n    return prices\n',
  'def with_tax(prices):\n    return {item: round(price * 1.1, 2) for item, price in prices.items()}\n',
  "`{key: value for key, value in prices.items()}`",
  tests='''
from solution import with_tax

def test_values():
    assert with_tax({"potion": 10, "sword": 80}) == {"potion": 11.0, "sword": 88.0}
    assert with_tax({}) == {}

def test_new_dict():
    prices = {"rope": 5}
    with_tax(prices)
    assert prices == {"rope": 5}, "with_tax changed the dictionary it was given"
''', checks=["node:DictComp"],
  wrong=[("changes the prices in place", 'def with_tax(prices):\n    for k in prices:\n        prices[k] = round(prices[k] * 1.1, 2)\n    return {k: v for k, v in prices.items()}\n')])

L("dicts", "leaderboard", "Sorting a dictionary", "sorting",
  "The arena keeps scores by name.",
  "Write `leaderboard(scores)` that returns the names, highest score first, and A to Z when scores tie.",
  'def leaderboard(scores):\n    return list(scores)\n',
  'def leaderboard(scores):\n    return sorted(scores, key=lambda name: (-scores[name], name))\n',
  "Sort the names with `key=lambda name: (-scores[name], name)`.",
  tests='''
from solution import leaderboard

def test_values():
    assert leaderboard({"Sam": 30, "Mira": 50, "Bran": 30}) == ["Mira", "Bran", "Sam"]
    assert leaderboard({}) == []
''',
  fuzz=("leaderboard", "def ref(s):\n    return sorted(s, key=lambda n: (-s[n], n))\n", "def gen(r):\n    return [{n: r.randint(0, 5) for n in r.sample(['Sam', 'Mira', 'Bran', 'Ada', 'Zed', 'Ola'], r.randint(0, 6))}]\n"),
  wrong=[("sorted by name only", 'def leaderboard(scores):\n    return sorted(scores)\n')])

L("dicts", "group", "Grouping", "dicts",
  "The guild sorts heroes by class.",
  "`heroes` is a list of `(name, role)` pairs. Write `by_role(heroes)` that returns a dictionary from each role to the list of names with that role, in the order they appear.",
  'def by_role(heroes):\n    return {}\n',
  'def by_role(heroes):\n    groups = {}\n    for name, role in heroes:\n        groups.setdefault(role, []).append(name)\n    return groups\n',
  "`groups.setdefault(role, []).append(name)` makes the list the first time a role shows up.",
  tests='''
from solution import by_role

def test_values():
    heroes = [("Sam", "fighter"), ("Mira", "mage"), ("Bran", "fighter")]
    assert by_role(heroes) == {"fighter": ["Sam", "Bran"], "mage": ["Mira"]}
    assert by_role([]) == {}
''',
  fuzz=("by_role", "def ref(h):\n    g = {}\n    for n, ro in h:\n        g.setdefault(ro, []).append(n)\n    return g\n", "def gen(r):\n    return [[(r.choice(['Sam', 'Mira', 'Bran', 'Ada']), r.choice(['mage', 'rogue', 'fighter'])) for _ in range(r.randint(0, 8))]]\n"),
  wrong=[("keeps only the last name per role", 'def by_role(heroes):\n    return {role: [name] for name, role in heroes}\n')])

L("dicts", "merge", "Merging counts", "dicts",
  "Two heroes empty their bags onto one table.",
  "Write `merge_bags(a, b)` that returns a new dictionary with the counts from both bags added together. Don't change `a` or `b`.",
  'def merge_bags(a, b):\n    a.update(b)\n    return a\n',
  'def merge_bags(a, b):\n    total = dict(a)\n    for item, count in b.items():\n        total[item] = total.get(item, 0) + count\n    return total\n',
  "Start from a copy of `a`, then add each of `b`'s counts to it.",
  tests='''
from solution import merge_bags

def test_values():
    assert merge_bags({"gem": 2, "rope": 1}, {"gem": 3, "torch": 4}) == {"gem": 5, "rope": 1, "torch": 4}
    assert merge_bags({}, {}) == {}

def test_inputs_unchanged():
    a, b = {"gem": 1}, {"gem": 2}
    merge_bags(a, b)
    assert a == {"gem": 1} and b == {"gem": 2}, "merge_bags changed a bag it was given"
''',
  wrong=[("overwrites instead of adding", 'def merge_bags(a, b):\n    return {**a, **b}\n')])

L("dicts", "nested-dicts", "Dictionaries inside dictionaries", "dicts",
  "The whole party's health on one screen.",
  "`party` maps each hero's name to their own dictionary, like `{\"Sam\": {\"hp\": 30}, \"Mira\": {\"hp\": 22}}`. Write `party_hp(party)` that returns the total of all the `\"hp\"` values.",
  'def party_hp(party):\n    return 0\n',
  'def party_hp(party):\n    total = 0\n    for hero in party.values():\n        total += hero["hp"]\n    return total\n',
  "Loop over `party.values()`; each one is a dictionary with an `\"hp\"` key.",
  tests='''
from solution import party_hp

def test_values():
    assert party_hp({"Sam": {"hp": 30}, "Mira": {"hp": 22}}) == 52
    assert party_hp({"Sam": {"hp": 30, "mp": 99}}) == 30
    assert party_hp({}) == 0
''',
  wrong=[("adds every stat", 'def party_hp(party):\n    return sum(sum(h.values()) for h in party.values())\n')])

# ============================================================ Sets
L("sets", "dedupe", "Removing duplicates", "sets",
  "The loot list has the same item many times.",
  "Write `unique_loot(items)` that returns the items with duplicates removed, as a sorted list.",
  'def unique_loot(items):\n    return items\n',
  'def unique_loot(items):\n    return sorted(set(items))\n',
  "`set(items)` keeps each value once. `sorted(...)` turns it back into an ordered list.",
  tests='''
from solution import unique_loot

def test_values():
    assert unique_loot(["gem", "gold", "gem", "map"]) == ["gem", "gold", "map"]
    assert unique_loot([]) == []
''', checks=["call:set"],
  fuzz=("unique_loot", "def ref(i):\n    return sorted(set(i))\n", "def gen(r):\n    return [[r.choice(" + WORDS + ") for _ in range(r.randint(0, 12))]]\n"),
  wrong=[("a set, not a sorted list", 'def unique_loot(items):\n    return set(items)\n')])

L("sets", "visited", "Remembering what you've seen", "sets",
  "Sam never searches the same room twice.",
  "Write `visit(visited, room)`. If `room` is new, add it to the set `visited` and return `True`. If Sam has been there already, return `False`.",
  'def visit(visited, room):\n    return False\n',
  'def visit(visited, room):\n    if room in visited:\n        return False\n    visited.add(room)\n    return True\n',
  "Check with `in`, then call `visited.add(room)`.",
  tests='''
from solution import visit

def test_values():
    seen = set()
    assert visit(seen, "hall") is True
    assert visit(seen, "hall") is False
    assert visit(seen, "crypt") is True
    assert seen == {"hall", "crypt"}
''',
  wrong=[("adds but always says new", 'def visit(visited, room):\n    visited.add(room)\n    return True\n')])

L("sets", "operations", "Set operations", "sets",
  "Two scouts compare notes on the rooms they found.",
  "Write `compare(a, b)` that returns a pair of sorted lists: the rooms **both** scouts found, and the rooms **either** scout found. Use `&` and `|`.",
  'def compare(a, b):\n    return [], []\n',
  'def compare(a, b):\n    return sorted(a & b), sorted(a | b)\n',
  "`a & b` is the overlap, `a | b` is everything.",
  tests='''
from solution import compare

def test_values():
    both, either = compare({"hall", "crypt"}, {"crypt", "tower"})
    assert both == ["crypt"]
    assert either == ["crypt", "hall", "tower"]

def test_disjoint():
    assert compare({"a"}, {"b"}) == ([], ["a", "b"])
''', checks=["tok:&", "tok:|"],
  wrong=[("swapped", 'def compare(a, b):\n    return sorted(a | b), sorted(a & b)\n')])

L("sets", "difference", "What's missing", "settypes",
  "The quest needs certain items.",
  "Write `still_needed(needed, have)` that returns, as a sorted list, the items in `needed` that aren't in `have`. Both are sets. Use `-`.",
  'def still_needed(needed, have):\n    return sorted(needed)\n',
  'def still_needed(needed, have):\n    return sorted(needed - have)\n',
  "`needed - have` keeps what is only in `needed`.",
  tests='''
from solution import still_needed

def test_values():
    assert still_needed({"key", "map", "torch"}, {"map", "rope"}) == ["key", "torch"]
    assert still_needed({"key"}, {"key"}) == []
''', checks=["tok:-"],
  wrong=[("the other way round", 'def still_needed(needed, have):\n    return sorted(have - needed)\n')])

L("sets", "subset", "Subsets", "settypes",
  "The blacksmith can only craft what the recipe allows.",
  "Write `can_craft(recipe, bag)` that returns `True` when every item in the set `recipe` is also in the set `bag`.",
  'def can_craft(recipe, bag):\n    return len(recipe) <= len(bag)\n',
  'def can_craft(recipe, bag):\n    return recipe <= bag\n',
  "For sets, `recipe <= bag` means \"every item of recipe is in bag\".",
  tests='''
from solution import can_craft

def test_values():
    assert can_craft({"iron", "coal"}, {"iron", "coal", "wood"}) is True
    assert can_craft({"iron", "gold"}, {"iron", "coal", "wood"}) is False
    assert can_craft(set(), {"iron"}) is True
''',
  wrong=[("any overlap counts", 'def can_craft(recipe, bag):\n    return bool(recipe & bag) or not recipe\n')])

L("sets", "set-comp", "Set comprehensions", "sets",
  "The herald wants to know which letters start the heroes' names.",
  "Write `first_letters(names)` that returns the set of first letters, upper case, using a set comprehension. Skip empty names.",
  'def first_letters(names):\n    return set()\n',
  'def first_letters(names):\n    return {name[0].upper() for name in names if name}\n',
  "`{name[0].upper() for name in names if name}`",
  tests='''
from solution import first_letters

def test_values():
    assert first_letters(["sam", "Sara", "mira", ""]) == {"S", "M"}
    assert first_letters([]) == set()
''', checks=["node:SetComp"],
  wrong=[("keeps the case", 'def first_letters(names):\n    return {name[0] for name in names if name}\n')])
