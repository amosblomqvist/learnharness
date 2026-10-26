from lib import L, Q, out

T = "# Don't touch below this line\n"

# ============================================================ Strings
L("strings", "upper-lower", "Changing case", "strmethods",
  "The war cry must be shouted.",
  "Write `war_cry(text)` that returns the text in capitals with an exclamation mark at the end: `war_cry(\"for the king\")` is `\"FOR THE KING!\"`.",
  'def war_cry(text):\n    return text\n',
  'def war_cry(text):\n    return text.upper() + "!"\n',
  "`text.upper()` returns a capitalised copy.",
  tests='''
from solution import war_cry

def test_values():
    assert war_cry("for the king") == "FOR THE KING!"
    assert war_cry("") == "!"
''',
  fuzz=("war_cry", "def ref(t):\n    return t.upper() + '!'\n", "def gen(r):\n    return [''.join(r.choice('abc XYZ') for _ in range(r.randint(0, 12)))]\n"),
  wrong=[("title case", 'def war_cry(text):\n    return text.title() + "!"\n')])

L("strings", "strip", "Cleaning up input", "strmethods",
  "Players type their names with stray spaces and odd capitals.",
  "Write `clean_name(raw)` that removes spaces from both ends and capitalises it like a name: `clean_name(\"  mIRA \")` is `\"Mira\"`.",
  'def clean_name(raw):\n    return raw\n',
  'def clean_name(raw):\n    return raw.strip().capitalize()\n',
  "`.strip()` removes the spaces at the ends; `.capitalize()` makes the first letter upper case and the rest lower.",
  tests='''
from solution import clean_name

def test_values():
    assert clean_name("  mIRA ") == "Mira"
    assert clean_name("sam") == "Sam"
    assert clean_name("BRAN") == "Bran"
''',
  wrong=[("only strips", 'def clean_name(raw):\n    return raw.strip()\n'),
         ("capitalises before stripping", 'def clean_name(raw):\n    return raw.capitalize().strip()\n')])

L("strings", "split", "Splitting commands", "strmethods",
  "The text adventure reads commands like `go north`.",
  "Write `parse_command(line)` that returns a pair `(verb, rest)`: the first word in lower case, and everything after it (or `\"\"` when there's nothing). `parse_command(\"Take golden key\")` is `(\"take\", \"golden key\")`. Extra spaces around the line don't matter.",
  'def parse_command(line):\n    return line, ""\n',
  'def parse_command(line):\n    parts = line.strip().split(" ", 1)\n    verb = parts[0].lower()\n    rest = parts[1].strip() if len(parts) > 1 else ""\n    return verb, rest\n',
  "`line.strip().split(\" \", 1)` splits at the first space only.",
  tests='''
from solution import parse_command

def test_values():
    assert parse_command("go north") == ("go", "north")
    assert parse_command("Take golden key") == ("take", "golden key")
    assert parse_command("look") == ("look", "")
    assert parse_command("  LOOK  ") == ("look", "")
''',
  wrong=[("splits every word", 'def parse_command(line):\n    words = line.split()\n    return words[0].lower(), words[1] if len(words) > 1 else ""\n')])

L("strings", "join", "Joining a list", "strmethods",
  "The bard lists the party.",
  "Write `party_line(names)` that returns the names joined with `\", \"`, except the last two are joined with `\" and \"`: `[\"Sam\", \"Mira\", \"Bran\"]` gives `\"Sam, Mira and Bran\"`. One name is just that name; no names is `\"\"`.",
  'def party_line(names):\n    return str(names)\n',
  'def party_line(names):\n    if len(names) <= 1:\n        return "".join(names)\n    return ", ".join(names[:-1]) + " and " + names[-1]\n',
  "`\", \".join(names[:-1])` joins all but the last.",
  tests='''
from solution import party_line

def test_values():
    assert party_line(["Sam", "Mira", "Bran"]) == "Sam, Mira and Bran"
    assert party_line(["Sam", "Mira"]) == "Sam and Mira"
    assert party_line(["Sam"]) == "Sam"
    assert party_line([]) == ""
''', checks=["call:join"],
  wrong=[("commas everywhere", 'def party_line(names):\n    return ", ".join(names)\n')])

L("strings", "string-slices", "Slicing text", "text",
  "Every hero signs with their initials.",
  "Write `initials(full_name)` that returns the first letter of each word, in capitals, joined with dots and ending with a dot: `initials(\"sam the brave\")` is `\"S.T.B.\"`.",
  'def initials(full_name):\n    return full_name\n',
  'def initials(full_name):\n    return "".join(word[0].upper() + "." for word in full_name.split())\n',
  "Split into words, take `word[0]` of each, and join.",
  tests='''
from solution import initials

def test_values():
    assert initials("sam the brave") == "S.T.B."
    assert initials("Mira") == "M."
    assert initials("  bran   stark ") == "B.S."
''',
  wrong=[("only the first word", 'def initials(full_name):\n    return full_name[0].upper() + "."\n')])

L("strings", "format-spec", "Formatting numbers", "formatspec",
  "The shop's price list lines up in columns.",
  "Write `price_line(item, price)` that returns the item name padded to 12 characters on the left, then the price with two decimals, right-aligned in 8 characters: `price_line(\"potion\", 4.5)` is `\"potion          4.50\"`. Use an f-string format spec like `{item:<12}`.",
  'def price_line(item, price):\n    return f"{item} {price}"\n',
  'def price_line(item, price):\n    return f"{item:<12}{price:>8.2f}"\n',
  "`{item:<12}` pads to 12 on the right of the text; `{price:>8.2f}` gives 2 decimals in 8 characters.",
  tests='''
from solution import price_line

def test_values():
    assert price_line("potion", 4.5) == "potion          4.50"
    assert price_line("sword", 120) == "sword         120.00"
    assert len(price_line("x", 1)) == 20
''', checks=["node:JoinedStr"],
  fuzz=("price_line", "def ref(i, p):\n    return f'{i:<12}{p:>8.2f}'\n", "def gen(r):\n    return [r.choice(['axe', 'bow', 'map', 'rope']), r.randint(0, 99999) / 100]\n"),
  wrong=[("no decimals", 'def price_line(item, price):\n    return f"{item:<12}{price:>8}"\n')])

L("strings", "replace", "Replacing text", "strmethods",
  "The royal censor hides the dragon's true name.",
  "Write `censor(text, word)` that replaces every `word` in `text` with as many `*` as the word has letters: `censor(\"Smaug is near, Smaug!\", \"Smaug\")` is `\"***** is near, *****!\"`.",
  'def censor(text, word):\n    return text\n',
  'def censor(text, word):\n    return text.replace(word, "*" * len(word))\n',
  "`text.replace(old, new)`, and `\"*\" * len(word)` makes the stars.",
  tests='''
from solution import censor

def test_values():
    assert censor("Smaug is near, Smaug!", "Smaug") == "***** is near, *****!"
    assert censor("all clear", "orc") == "all clear"
    assert censor("the orc and the orc king", "orc") == "the *** and the *** king"
''', checks=["call:replace"],
  wrong=[("only the first one", 'def censor(text, word):\n    return text.replace(word, "*" * len(word), 1)\n'),
         ("always five stars", 'def censor(text, word):\n    return text.replace(word, "*****")\n')])

L("strings", "find-in", "Searching text", "strmethods",
  "The scouts' reports mention dragons in all sorts of ways.",
  "Write `mentions(report, word)` that returns `True` when `word` appears anywhere in `report`, ignoring upper and lower case.",
  'def mentions(report, word):\n    return word in report\n',
  'def mentions(report, word):\n    return word.lower() in report.lower()\n',
  "Lower both, then use `in`.",
  tests='''
from solution import mentions

def test_values():
    assert mentions("A DRAGON was seen", "dragon") is True
    assert mentions("All quiet", "dragon") is False
    assert mentions("dragons!", "Dragon") is True
''',
  wrong=[("lowers only the report", 'def mentions(report, word):\n    return word in report.lower()\n')])

L("strings", "count-words", "Counting words", "strmethods",
  "The scribe is paid per word.",
  "Write `scribe_fee(text, rate)` that returns the number of words in `text` times `rate`. Words are separated by any amount of whitespace.",
  'def scribe_fee(text, rate):\n    return len(text) * rate\n',
  'def scribe_fee(text, rate):\n    return len(text.split()) * rate\n',
  "`text.split()` with no argument splits on any whitespace and drops empty pieces.",
  tests='''
from solution import scribe_fee

def test_values():
    assert scribe_fee("the dragon sleeps", 2) == 6
    assert scribe_fee("  lots   of\\n space ", 1) == 3
    assert scribe_fee("", 5) == 0
''',
  wrong=[("splits on single spaces", 'def scribe_fee(text, rate):\n    return len(text.split(" ")) * rate\n')])
