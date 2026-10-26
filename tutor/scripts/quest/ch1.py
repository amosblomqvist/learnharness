from lib import L, Q, out, dedent, MARK

T = "# Don't touch below this line\n"

# ============================================================ Introduction
L("intro", "welcome", "Welcome to Fantasy Quest", "print",
  "Every adventure starts with a banner on the gate.",
  "The welcome banner is missing its exclamation mark. Fix the code so the console shows:\n\n```text\nWelcome to Fantasy Quest!\n```\n\nPress **Run** to try it, then **Submit** to check it.",
  'print("Welcome to Fantasy Quest")\n',
  'print("Welcome to Fantasy Quest!")\n',
  "The text inside the quotes is printed exactly as you write it. Add the `!` before the closing quote.",
  expect="Welcome to Fantasy Quest!",
  wrong=[("prints it twice", 'print("Welcome to Fantasy Quest!")\nprint("Welcome to Fantasy Quest!")\n'),
         ("adds a space before the !", 'print("Welcome to Fantasy Quest !")\n')])

L("intro", "console", "The console", "print",
  "The town crier needs a voice.",
  "The line below is just a piece of text, so nothing shows up in the console. Use the `print()` function so the console shows:\n\n```text\nGreetings, adventurer!\n```",
  '"Greetings, adventurer!"\n',
  'print("Greetings, adventurer!")\n',
  "`print(...)` puts whatever is inside the parentheses in the console.",
  expect="Greetings, adventurer!", checks=["call:print"],
  wrong=[("prints the quotes too", "print('\"Greetings, adventurer!\"')\n")])

L("intro", "first-bug", "Fix your first bug", "numbers",
  "The combat system isn't working as intended: heroes are gaining health when poisoned.",
  "Fix the math bug on line 3. Sam should *lose* health when the poison hits.",
  'poison_damage = 7\nstart_health = 80\nend_health = start_health + poison_damage\n\n' + T + 'print(f"Sam\'s health is: {start_health}")\nprint(f"Sam takes {poison_damage} poison damage...")\nprint(f"Sam\'s health is: {end_health}")\n',
  'poison_damage = 7\nstart_health = 80\nend_health = start_health - poison_damage\n\n' + T + 'print(f"Sam\'s health is: {start_health}")\nprint(f"Sam takes {poison_damage} poison damage...")\nprint(f"Sam\'s health is: {end_health}")\n',
  "Losing health means subtracting: `-` instead of `+`.",
  expect=out(["Sam's health is: 80", "Sam takes 7 poison damage...", "Sam's health is: 73"]),
  wrong=[("hard-codes the answer instead of fixing the math", 'poison_damage = 7\nstart_health = 80\nend_health = 73\n\n' + T + 'print(f"Sam\'s health is: {start_health}")\nprint(f"Sam takes {poison_damage} poison damage...")\nprint(f"Sam\'s health is: {end_health}")\n'),
         ("edits the protected lines", 'poison_damage = 7\nstart_health = 80\nend_health = start_health + poison_damage\n\n' + T + 'print("Sam\'s health is: 80")\nprint("Sam takes 7 poison damage...")\nprint("Sam\'s health is: 73")\n')],
  checks=[("tok:-", "Subtract the damage with `-`.")])

L("intro", "comments", "Comments", "intro",
  "The old scribe commented out half the story.",
  "A line that starts with `#` is a comment, and Python skips it. The first line of the story is commented out. Make the console show both lines, in this order:\n\n```text\nThe gates creak open...\nA dragon blocks the road!\n```",
  '# print("The gates creak open...")\nprint("A dragon blocks the road!")\n',
  'print("The gates creak open...")\nprint("A dragon blocks the road!")\n',
  "Delete the `#` at the start of the first line.",
  expect=out(["The gates creak open...", "A dragon blocks the road!"]),
  wrong=[("wrong order", 'print("A dragon blocks the road!")\nprint("The gates creak open...")\n')])

L("intro", "multi-print", "Several lines", "print",
  "The innkeeper reads the notice board out loud.",
  "Add two more `print` calls so the console shows the whole notice:\n\n```text\nWANTED: dragon slayer\nReward: 500 gold\nAsk at the Rusty Tankard\n```",
  'print("WANTED: dragon slayer")\n',
  'print("WANTED: dragon slayer")\nprint("Reward: 500 gold")\nprint("Ask at the Rusty Tankard")\n',
  "Each `print(...)` call writes one line.",
  expect=out(["WANTED: dragon slayer", "Reward: 500 gold", "Ask at the Rusty Tankard"]),
  wrong=[("forgets a line", 'print("WANTED: dragon slayer")\nprint("Reward: 500 gold")\n')])

# ============================================================ Variables
L("vars", "assign", "Variables", "intro",
  "Every hero needs a name.",
  "Create a variable called `hero_name` that holds the text `\"Sam\"`. The print line below should then show:\n\n```text\nSam\n```",
  '# create hero_name here\n\n' + T + 'print(hero_name)\n',
  'hero_name = "Sam"\n\n' + T + 'print(hero_name)\n',
  "A variable is made with `name = value`.",
  expect="Sam",
  wrong=[("misspelled name", 'heroname = "Sam"\nhero_name = heroname.lower()\n\n' + T + 'print(hero_name)\n')])

L("vars", "numbers", "Numbers", "numbers",
  "Sam finds a treasure chest.",
  "Set `gold` to `250` so the console shows:\n\n```text\nSam has 250 gold\n```",
  'gold = 0\n\n' + T + 'print(f"Sam has {gold} gold")\n',
  'gold = 250\n\n' + T + 'print(f"Sam has {gold} gold")\n',
  "Change the number on the first line.",
  expect="Sam has 250 gold",
  wrong=[("stores text, not a number", 'gold = "250 "\n\n' + T + 'print(f"Sam has {gold} gold")\n')])

L("vars", "fstrings", "f-strings", "strings",
  "The herald announces every hero.",
  "Make `message` an f-string that puts `hero` and `level` into the text, so the console shows:\n\n```text\nSam is level 3\n```",
  'hero = "Sam"\nlevel = 3\nmessage = "hero is level level"\n\n' + T + 'print(message)\n',
  'hero = "Sam"\nlevel = 3\nmessage = f"{hero} is level {level}"\n\n' + T + 'print(message)\n',
  "Start the string with `f` and put names in curly braces: `f\"{hero} ...\"`.",
  expect="Sam is level 3", checks=["fname:hero", "fname:level"],
  wrong=[("types the text instead of using the variables", 'hero = "Sam"\nlevel = 3\nmessage = "Sam is level 3"\n\n' + T + 'print(message)\n'),
         ("puts the names in a comment", 'hero = "Sam"\nlevel = 3\nmessage = "Sam is level 3"  # f"{hero} {level}"\n\n' + T + 'print(message)\n')])

L("vars", "concat", "Joining text", "text",
  "Heroes earn titles.",
  "Build `full_title` by joining `name`, a space, and `title` with `+`, so the console shows:\n\n```text\nSam the Brave\n```",
  'name = "Sam"\ntitle = "the Brave"\nfull_title = name\n\n' + T + 'print(full_title)\n',
  'name = "Sam"\ntitle = "the Brave"\nfull_title = name + " " + title\n\n' + T + 'print(full_title)\n',
  "`\"a\" + \" \" + \"b\"` gives `\"a b\"`.",
  expect="Sam the Brave", checks=["tok:+", "name:title"],
  wrong=[("forgets the space", 'name = "Sam"\ntitle = "the Brave"\nfull_title = name + title\n\n' + T + 'print(full_title)\n')])

L("vars", "arithmetic", "Arithmetic", "numbers",
  "Sam has 17 potions to pack into bags that hold 5 each.",
  "Use `//` for the number of full bags and `%` for the potions left over, so the console shows:\n\n```text\n3 bags, 2 left\n```",
  'potions = 17\nfull_bags = 0\nleftover = 0\n\n' + T + 'print(f"{full_bags} bags, {leftover} left")\n',
  'potions = 17\nfull_bags = potions // 5\nleftover = potions % 5\n\n' + T + 'print(f"{full_bags} bags, {leftover} left")\n',
  "`17 // 5` is the whole number of times 5 fits. `17 % 5` is what remains.",
  expect="3 bags, 2 left", checks=["tok://", "tok:%", "name:potions"],
  wrong=[("hard-codes the numbers", 'potions = 17\nfull_bags = 3\nleftover = 2\n\n' + T + 'print(f"{full_bags} bags, {leftover} left")\n'),
         ("hides the operators in a comment", 'potions = 17\nfull_bags = 3  # potions // 5\nleftover = 2  # potions % 5\n\n' + T + 'print(f"{full_bags} bags, {leftover} left")\n')])

L("vars", "update", "Changing a variable", "numbers",
  "Sam sells a sword for 40 gold, then buys a potion for 15.",
  "Update `gold` with `+=` and `-=` so the console shows the gold Sam ends with:\n\n```text\n125\n```",
  'gold = 100\n\n# Update gold here\n\n' + T + 'print(gold)\n',
  'gold = 100\n\ngold += 40\ngold -= 15\n\n' + T + 'print(gold)\n',
  "`gold += 40` is short for `gold = gold + 40`.",
  expect="125", checks=["tok:+=", "tok:-="],
  wrong=[("sets the result directly", 'gold = 100\n\ngold = 125\n\n' + T + 'print(gold)\n')])

L("vars", "convert", "Converting types", "convert",
  "The shield level was saved as text.",
  "`shield_text` holds the text `\"7\"`, and you can't add 1 to text. Convert it to a number with `int()` so the console shows:\n\n```text\n8\n```",
  'shield_text = "7"\nshield_level = shield_text\n\n' + T + 'print(shield_level + 1)\n',
  'shield_text = "7"\nshield_level = int(shield_text)\n\n' + T + 'print(shield_level + 1)\n',
  "`int(\"7\")` gives the number 7.",
  expect="8", checks=["call:int", "name:shield_text"],
  wrong=[("types the number in", 'shield_text = "7"\nshield_level = 7\n\n' + T + 'print(shield_level + 1)\n')])

L("vars", "names", "Naming variables", "intro",
  "The scribe wrote `heroName`, but the rest of the book says `hero_name`.",
  "Python programmers write variable names in `snake_case`. Rename the first variable so the code runs and the console shows:\n\n```text\nSam 4\n```",
  'heroName = "Sam"\nhero_level = 4\n\n' + T + 'print(hero_name, hero_level)\n',
  'hero_name = "Sam"\nhero_level = 4\n\n' + T + 'print(hero_name, hero_level)\n',
  "The name on line 1 has to match the one used in the `print` line.",
  expect="Sam 4", checks=["!name:heroName"],
  wrong=[("keeps the old name around", 'heroName = "Sam"\nhero_name = heroName\nhero_level = 4\n\n' + T + 'print(hero_name, hero_level)\n')])

L("vars", "none", "None", "none",
  "Sam hasn't found a sword yet.",
  "`None` means \"no value yet\". Set `sword` to `None` instead of an empty string, so the console shows:\n\n```text\nTrue\n```",
  'sword = ""\n\n' + T + 'print(sword is None)\n',
  'sword = None\n\n' + T + 'print(sword is None)\n',
  "`None` is written without quotes.",
  expect="True",
  wrong=[("the text \"None\"", 'sword = "None"\n\n' + T + 'print(sword is None)\n')])

L("vars", "swap", "Swapping values", "assignment",
  "Sam and Mira swap weapons.",
  "Swap the values of `sam` and `mira` in one line with `sam, mira = mira, sam`, so the console shows:\n\n```text\nSam: bow, Mira: sword\n```",
  'sam = "sword"\nmira = "bow"\n\n# Swap them here\n\n' + T + 'print(f"Sam: {sam}, Mira: {mira}")\n',
  'sam = "sword"\nmira = "bow"\n\nsam, mira = mira, sam\n\n' + T + 'print(f"Sam: {sam}, Mira: {mira}")\n',
  "The right side is worked out first, then both names are assigned at once.",
  expect="Sam: bow, Mira: sword", checks=[("node:Tuple", "Swap with a tuple assignment: `sam, mira = mira, sam`.")],
  wrong=[("overwrites one before copying it", 'sam = "sword"\nmira = "bow"\n\nsam = mira\nmira = sam\n\n' + T + 'print(f"Sam: {sam}, Mira: {mira}")\n'),
         ("retypes the values", 'sam = "sword"\nmira = "bow"\n\nsam = "bow"\nmira = "sword"\n\n' + T + 'print(f"Sam: {sam}, Mira: {mira}")\n')])

# ============================================================ Functions
L("funcs", "def", "Defining functions", "def",
  "Guards at every gate greet travellers the same way.",
  "Define a function named `greet` that prints `Hail, adventurer!`. The code below calls it twice, so the console shows:\n\n```text\nHail, adventurer!\nHail, adventurer!\n```",
  '# define greet here\n\n' + T + 'greet()\ngreet()\n',
  'def greet():\n    print("Hail, adventurer!")\n\n' + T + 'greet()\ngreet()\n',
  "`def greet():` and then an indented body.",
  expect=out(["Hail, adventurer!", "Hail, adventurer!"]), checks=["def:greet"],
  extra='''
from solution import greet

def test_greet_itself_prints():
    assert printed(greet) == "Hail, adventurer!", "Calling greet() once should print the line once"
''',
  wrong=[("prints outside the function", 'def greet():\n    pass\n\nprint("Hail, adventurer!")\nprint("Hail, adventurer!")\n\n' + T + 'greet()\ngreet()\n')])

L("funcs", "params", "Parameters", "def",
  "Each guard greets each traveller by name.",
  "Write `describe(name, level)`, which **prints** `<name> is level <level>`. For example `describe(\"Sam\", 3)` prints `Sam is level 3`.",
  'def describe(name, level):\n    pass\n',
  'def describe(name, level):\n    print(f"{name} is level {level}")\n',
  "Use an f-string with `{name}` and `{level}` inside `print(...)`.",
  tests='''
from solution import describe

def cap(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        result = fn(*args)
    return buf.getvalue().strip(), result

def test_sam():
    assert cap(describe, "Sam", 3)[0] == "Sam is level 3"

def test_mira():
    assert cap(describe, "Mira", 12)[0] == "Mira is level 12"

def test_prints_not_returns():
    printed, result = cap(describe, "Bran", 1)
    assert printed == "Bran is level 1", "describe should print the line"
''',
  wrong=[("returns the text instead of printing it", 'def describe(name, level):\n    return f"{name} is level {level}"\n'),
         ("hard-codes Sam", 'def describe(name, level):\n    print("Sam is level 3")\n')])

L("funcs", "return", "Return values", "def",
  "A critical hit doubles the damage.",
  "Write `double_damage(damage)` that **returns** twice the damage. It doesn't print anything: the caller decides what to do with the result.",
  'def double_damage(damage):\n    pass\n',
  'def double_damage(damage):\n    return damage * 2\n',
  "`return` hands a value back to whoever called the function.",
  tests='''
from solution import double_damage

def test_values():
    assert double_damage(10) == 20
    assert double_damage(0) == 0
    assert double_damage(7) == 14
''',
  fuzz=("double_damage", "def ref(d):\n    return d * 2\n", "def gen(r):\n    return [r.randint(-50, 500)]\n"),
  wrong=[("prints instead of returning", 'def double_damage(damage):\n    print(damage * 2)\n'),
         ("adds 2 instead of doubling", 'def double_damage(damage):\n    return damage + 2\n')])

L("funcs", "print-vs-return", "Print is not return", "def",
  "The level-up screen shows `None`.",
  "`level_up` prints the new level instead of returning it, so `new_level` is `None`. Make it return the new level (and print nothing), so the console shows:\n\n```text\nSam is now level 6\n```",
  'def level_up(level):\n    print(level + 1)\n\n' + T + 'new_level = level_up(5)\nprint(f"Sam is now level {new_level}")\n',
  'def level_up(level):\n    return level + 1\n\n' + T + 'new_level = level_up(5)\nprint(f"Sam is now level {new_level}")\n',
  "Replace `print(...)` inside the function with `return ...`.",
  expect="Sam is now level 6", checks=["node:Return"],
  wrong=[("returns and also prints", 'def level_up(level):\n    print(level + 1)\n    return level + 1\n\n' + T + 'new_level = level_up(5)\nprint(f"Sam is now level {new_level}")\n')])

L("funcs", "default-args", "Default arguments", "defaults",
  "A small potion heals 25 health unless the shop says otherwise.",
  "Write `heal(health, potion=25)` that returns `health` plus the potion's strength.",
  'def heal(health, potion):\n    return health + potion\n',
  'def heal(health, potion=25):\n    return health + potion\n',
  "Give the parameter a default with `potion=25` in the `def` line.",
  tests='''
from solution import heal

def test_default():
    assert heal(10) == 35

def test_given():
    assert heal(10, 50) == 60
    assert heal(10, potion=5) == 15
''',
  wrong=[("ignores the potion it is given", 'def heal(health, potion=25):\n    return health + 25\n')])

L("funcs", "kwargs", "Keyword arguments", "kwargs",
  "The roster printed Mira as a level-\"mage\" fighter.",
  "The call at the bottom passes its arguments in the wrong order. Fix **the call** (not the function) with keyword arguments so the console shows:\n\n```text\nMira the mage, level 5\n```",
  'def describe_hero(name, level=1, role="fighter"):\n    return f"{name} the {role}, level {level}"\n\n# Fix the call below\nprint(describe_hero("Mira", "mage", 5))\n',
  'def describe_hero(name, level=1, role="fighter"):\n    return f"{name} the {role}, level {level}"\n\n# Fix the call below\nprint(describe_hero("Mira", level=5, role="mage"))\n',
  "Name the arguments: `level=5, role=\"mage\"`.",
  expect="Mira the mage, level 5", checks=["kw:level", "kw:role"],
  wrong=[("changes the function instead of the call", 'def describe_hero(name, role="fighter", level=1):\n    return f"{name} the {role}, level {level}"\n\n# Fix the call below\nprint(describe_hero("Mira", "mage", 5))\n')])

L("funcs", "multi-return", "Returning several values", "def",
  "The quartermaster wants the weakest and the strongest hit.",
  "Write `min_max(values)` that returns the smallest and the largest value as a pair, like `(1, 9)`.",
  'def min_max(values):\n    return None\n',
  'def min_max(values):\n    return min(values), max(values)\n',
  "A function can return `a, b`. The caller can unpack it with `low, high = min_max(...)`.",
  tests='''
from solution import min_max

def test_pair():
    low, high = min_max([3, 9, 1, 4])
    assert (low, high) == (1, 9)

def test_single():
    assert min_max([5]) == (5, 5)
''',
  fuzz=("min_max", "def ref(v):\n    return min(v), max(v)\n", "def gen(r):\n    return [[r.randint(-99, 99) for _ in range(r.randint(1, 8))]]\n"),
  wrong=[("first and last instead of smallest and largest", 'def min_max(values):\n    return values[0], values[-1]\n')])

L("funcs", "compose", "Functions calling functions", "def",
  "The damage formula has two steps.",
  "`crit` and `armor_reduce` are written for you. Write `final_damage(base, armor)` that first applies `crit` to `base`, then `armor_reduce` to the result with `armor`, and returns that. Call the two functions; don't copy their math.",
  'def crit(damage):\n    return damage * 2\n\ndef armor_reduce(damage, armor):\n    return max(0, damage - armor)\n\ndef final_damage(base, armor):\n    return base\n',
  'def crit(damage):\n    return damage * 2\n\ndef armor_reduce(damage, armor):\n    return max(0, damage - armor)\n\ndef final_damage(base, armor):\n    return armor_reduce(crit(base), armor)\n',
  "`armor_reduce(crit(base), armor)`: the inner call runs first.",
  tests='''
import solution
from solution import final_damage

def test_values():
    assert final_damage(10, 5) == 15
    assert final_damage(3, 10) == 0

def test_calls_the_helpers():
    seen = []
    old_crit, old_reduce = solution.crit, solution.armor_reduce
    solution.crit = lambda d: (seen.append("crit"), old_crit(d))[1]
    solution.armor_reduce = lambda d, a: (seen.append("reduce"), old_reduce(d, a))[1]
    try:
        final_damage(10, 1)
    finally:
        solution.crit, solution.armor_reduce = old_crit, old_reduce
    assert seen == ["crit", "reduce"], "final_damage should call crit, then armor_reduce"
''',
  wrong=[("copies the math", 'def crit(damage):\n    return damage * 2\n\ndef armor_reduce(damage, armor):\n    return max(0, damage - armor)\n\ndef final_damage(base, armor):\n    return max(0, base * 2 - armor)\n'),
         ("reduces before the crit", 'def crit(damage):\n    return damage * 2\n\ndef armor_reduce(damage, armor):\n    return max(0, damage - armor)\n\ndef final_damage(base, armor):\n    return crit(armor_reduce(base, armor))\n')])

L("funcs", "varargs", "Any number of arguments", "varargs",
  "A combo can be two hits or ten.",
  "Write `combo(*hits)` that returns the total of all the hits it is given, or 0 when there are none.",
  'def combo(hits):\n    return sum(hits)\n',
  'def combo(*hits):\n    return sum(hits)\n',
  "`*hits` collects every argument into a tuple.",
  tests='''
from solution import combo

def test_values():
    assert combo(3, 4, 5) == 12
    assert combo(10) == 10
    assert combo() == 0
''',
  wrong=[("takes one list", 'def combo(hits=()):\n    return sum(hits)\n')])

# ============================================================ Scope
L("scope", "local", "Local variables", "scope",
  "The damage roll vanished the moment the function ended.",
  "Variables made inside a function stay inside it. Change `roll_damage` so it **returns** `damage`, and store what it returns in a variable called `damage` below. The console should show:\n\n```text\nRolling...\n12\n```",
  'def roll_damage():\n    damage = 12\n    print("Rolling...")\n\nroll_damage()\nprint(damage)\n',
  'def roll_damage():\n    damage = 12\n    print("Rolling...")\n    return damage\n\ndamage = roll_damage()\nprint(damage)\n',
  "Add `return damage` inside the function, and `damage = roll_damage()` outside it.",
  expect=out(["Rolling...", "12"]), checks=["node:Return", "!node:Global"],
  wrong=[("makes damage global", 'def roll_damage():\n    global damage\n    damage = 12\n    print("Rolling...")\n\nroll_damage()\nprint(damage)\n'),
         ("prints 12 directly", 'def roll_damage():\n    damage = 12\n    print("Rolling...")\n\nroll_damage()\nprint(12)\n')])

L("scope", "read-global", "Reading global values", "scope",
  "Every potion in the kingdom costs the same.",
  "`POTION_PRICE` is defined outside the function. Write `full_price(count)` that returns the price of `count` potions, using `POTION_PRICE`.",
  'POTION_PRICE = 15\n\ndef full_price(count):\n    return 0\n',
  'POTION_PRICE = 15\n\ndef full_price(count):\n    return count * POTION_PRICE\n',
  "A function can read a global name without any special keyword.",
  tests='''
import solution
from solution import full_price

def test_prices():
    assert full_price(1) == 15
    assert full_price(4) == 60
    assert full_price(0) == 0

def test_uses_the_constant():
    solution.POTION_PRICE = 20
    try:
        assert full_price(3) == 60, "full_price should use POTION_PRICE, not the number 15"
    finally:
        solution.POTION_PRICE = 15
''',
  wrong=[("types 15 instead of using the constant", 'POTION_PRICE = 15\n\ndef full_price(count):\n    return count * 15\n')])

L("scope", "shadow", "Shadowing", "scope",
  "`take_hit` crashes with UnboundLocalError.",
  "Assigning to `health` inside the function makes it a *local* name, so reading it first fails. Don't use `global`: change `take_hit` to take the current health as a parameter, and pass `health` in at the call. The console should show:\n\n```text\n70\n```",
  'health = 100\n\ndef take_hit(damage):\n    health = health - damage\n    return health\n\nprint(take_hit(30))\n',
  'health = 100\n\ndef take_hit(current, damage):\n    return current - damage\n\nprint(take_hit(health, 30))\n',
  "`def take_hit(current, damage):` and `take_hit(health, 30)`.",
  expect="70", checks=["!node:Global"],
  wrong=[("uses global", 'health = 100\n\ndef take_hit(damage):\n    global health\n    health = health - damage\n    return health\n\nprint(take_hit(30))\n')])

L("scope", "global-kw", "The global keyword", "global",
  "The treasury counts gold across calls.",
  "`add_gold` should change the global `gold`, but it crashes. Add the one line it needs so the console shows:\n\n```text\n30\n```",
  'gold = 0\n\ndef add_gold(amount):\n    gold += amount\n\nadd_gold(10)\nadd_gold(20)\nprint(gold)\n',
  'gold = 0\n\ndef add_gold(amount):\n    global gold\n    gold += amount\n\nadd_gold(10)\nadd_gold(20)\nprint(gold)\n',
  "`global gold` goes at the top of the function body.",
  expect="30", checks=["node:Global"],
  wrong=[("sets gold outside the function instead", 'gold = 0\n\ndef add_gold(amount):\n    pass\n\nadd_gold(10)\nadd_gold(20)\ngold = 30\nprint(gold)\n')])

L("scope", "params-local", "Parameters are local", "scope",
  "Healing a copy doesn't heal the hero.",
  "`heal` changes its own `hp`, which is a local name, so the global `hp` stays 40. Make `heal` return the new value and assign it back at the call (no `global`), so the console shows:\n\n```text\n65\n```",
  'hp = 40\n\ndef heal(hp):\n    hp = hp + 25\n\nheal(hp)\nprint(hp)\n',
  'hp = 40\n\ndef heal(hp):\n    hp = hp + 25\n    return hp\n\nhp = heal(hp)\nprint(hp)\n',
  "`return hp` at the end of the function, and `hp = heal(hp)` at the call.",
  expect="65", checks=["node:Return", "!node:Global"],
  wrong=[("prints the sum instead", 'hp = 40\n\ndef heal(hp):\n    hp = hp + 25\n\nheal(hp)\nprint(hp + 25)\n')])

# ============================================================ Debugging
L("debug", "traceback", "Reading an error", "errors",
  "The bat never appears and the console shows a red error.",
  "Run the code and read the error message: it names the line and the problem. Fix the typo so the console shows:\n\n```text\nSam enters the cave\nA bat flies out!\n```",
  'print("Sam enters the cave")\nprnt("A bat flies out!")\n',
  'print("Sam enters the cave")\nprint("A bat flies out!")\n',
  "The error says `prnt` is not defined. Look at how it is spelled.",
  expect=out(["Sam enters the cave", "A bat flies out!"]), checks=["!name:prnt"],
  wrong=[("defines prnt instead of fixing the typo", 'prnt = print\nprint("Sam enters the cave")\nprnt("A bat flies out!")\n')])

L("debug", "syntax-error", "A syntax error", "errors",
  "The code won't even start.",
  "Python reports a `SyntaxError` before running anything. Find the missing piece and fix it so the console shows:\n\n```text\nThe torch is lit\n```",
  'torch_lit = True\nif torch_lit\n    print("The torch is lit")\n',
  'torch_lit = True\nif torch_lit:\n    print("The torch is lit")\n',
  "An `if` line ends with a colon.",
  expect="The torch is lit", checks=["node:If"],
  wrong=[("removes the if", 'torch_lit = True\nprint("The torch is lit")\n')])

L("debug", "type-error", "A type error", "errors",
  "The score line crashes with TypeError.",
  "You can't add a number to text. Fix the last line with an f-string so the console shows:\n\n```text\nScore: 42\n```",
  'score = 42\nprint("Score: " + score)\n',
  'score = 42\nprint(f"Score: {score}")\n',
  "`f\"Score: {score}\"` turns the number into text for you.",
  expect="Score: 42", checks=["fname:score"],
  wrong=[("types the number", 'score = 42\nprint("Score: 42")\n')])

L("debug", "off-by-one", "Off by one", "slices",
  "The inventory screen crashes on the last item.",
  "`last_item` raises an `IndexError`. Indexes start at 0, so the last item is not at `len(items)`. Fix it.",
  'def last_item(items):\n    return items[len(items)]\n',
  'def last_item(items):\n    return items[len(items) - 1]\n',
  "The last index is `len(items) - 1`, or simply `-1`.",
  tests='''
from solution import last_item

def test_last():
    assert last_item(["sword", "shield", "potion"]) == "potion"
    assert last_item(["only"]) == "only"
''',
  fuzz=("last_item", "def ref(items):\n    return items[-1]\n", "def gen(r):\n    return [[r.choice(['sword', 'bow', 'gem', 'map']) + str(i) for i in range(r.randint(1, 9))]]\n"),
  wrong=[("one too far back", 'def last_item(items):\n    return items[len(items) - 2]\n'),
         ("always the third item", 'def last_item(items):\n    return items[2]\n')])

L("debug", "assert", "Assertions", "assert",
  "Health must never go below zero.",
  "Add an `assert` to `apply_damage` so it raises an `AssertionError` when the damage is bigger than the health. Normal hits must still work.",
  'def apply_damage(health, damage):\n    return health - damage\n',
  'def apply_damage(health, damage):\n    assert damage <= health, "damage is bigger than health"\n    return health - damage\n',
  "`assert damage <= health` stops the program when the condition is false.",
  tests='''
from solution import apply_damage

def test_normal():
    assert apply_damage(10, 3) == 7
    assert apply_damage(5, 5) == 0

def test_too_much():
    try:
        apply_damage(10, 20)
    except AssertionError:
        return
    raise AssertionError("apply_damage(10, 20) should raise AssertionError")
''', checks=["node:Assert"],
  wrong=[("forbids exact kills too", 'def apply_damage(health, damage):\n    assert damage < health\n    return health - damage\n')])

L("debug", "print-debug", "Printing to debug", "print",
  "The average damage looks far too high.",
  "`average(a, b, c)` returns the wrong number. Print the pieces if it helps, then fix the bug. Hint: look at which operation runs first.",
  'def average(a, b, c):\n    return a + b + c / 3\n',
  'def average(a, b, c):\n    return (a + b + c) / 3\n',
  "Division happens before addition. Use parentheses.",
  tests='''
from solution import average

def test_values():
    assert average(3, 3, 3) == 3
    assert average(1, 2, 3) == 2
    assert average(10, 20, 30) == 20
''',
  fuzz=("average", "def ref(a, b, c):\n    return (a + b + c) / 3\n", "def gen(r):\n    return [r.randint(0, 99) * 3, r.randint(0, 99) * 3, r.randint(0, 99) * 3]\n"),
  wrong=[("divides by the wrong count", 'def average(a, b, c):\n    return (a + b + c) / 2\n')])
