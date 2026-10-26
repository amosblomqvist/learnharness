# Learn Python: Fantasy Quest
id: quest
rewrite: true
blurb: A text-based RPG, one small task at a time. Every lesson is a short assignment and a coding exercise that is checked when you submit; the concept is in the Python docs it links to.
why: Writing code is how you learn it. Each lesson gives you one thing to do in the editor, runs your code, and checks it, with the visualizer a click away. The reading is the official Python documentation, linked at the top of every lesson.
stage: intro | Introduction | Run code, read the console, fix your first bug.
stage: vars | Variables | Store text and numbers, and change them.
stage: funcs | Functions | Package an action, pass values in, get one back.
stage: scope | Scope | Know which names a line of code can see.
stage: debug | Debugging | Read an error, find the line, prove the fix.
stage: computing | Computing | Binary, bits, flags, and why 0.1 + 0.2 isn't 0.3.
stage: compare | Comparisons | Make decisions with booleans and if statements.
stage: loops | Loops | Repeat work, and stop when you should.
stage: strings | Strings | Clean, split, join, search and format text.
stage: lists | Lists | Keep things in order.
stage: dicts | Dictionaries | Look things up by name.
stage: sets | Sets | Keep each thing once.
stage: errors | Errors | Handle what goes wrong, and raise your own.
stage: hints | Type hints | Say what goes in and what comes out.
stage: testing | Testing | Write the tests yourself, and prove they catch real bugs.
stage: practice | Practice | Put the chapters together in small quests.
stage: classes | Classes | Model the world with types of your own: fields, methods and inheritance.
stage: files | Saves | Write the game to disk, read it back, and keep it as JSON.
stage: modules | Modules | Give a program a front door it can be run and imported through.
stage: guild | The Guild | Assemble the pieces into a game you can play.
stage: tuples | Tuples and unpacking | Fixed records, unpacking, and functions that return several things.
stage: functional | Functions as values | Pass functions around: keys, lambdas, map, filter, any and all.
stage: recursion | Recursion | Solve a problem with a smaller copy of itself.
stage: iterators | Iterators and generators | Make values one at a time, only when someone asks.
stage: decorators | Closures and decorators | Functions that remember, and functions that wrap functions.
stage: quiz | Quiz | Read code and say exactly what it prints.

## Welcome to Fantasy Quest
id: welcome
stage: intro
minutes: 5
goal: Every adventure starts with a banner on the gate.
source: Python docs: print() | https://docs.python.org/3/library/functions.html#print

### Assignment

The welcome banner is missing its exclamation mark. Fix the code so the console shows:

```text
Welcome to Fantasy Quest!
```

Press **Run** to try it, then **Submit** to check it.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
print("Welcome to Fantasy Quest")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Welcome to Fantasy Quest!'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED
```
solution:
```python
print("Welcome to Fantasy Quest!")
```
wrong: prints it twice
```python
print("Welcome to Fantasy Quest!")
print("Welcome to Fantasy Quest!")
```
wrong: adds a space before the !
```python
print("Welcome to Fantasy Quest !")
```
hint: The text inside the quotes is printed exactly as you write it. Add the `!` before the closing quote.
:::

## The console
id: console
stage: intro
needs: welcome
minutes: 5
goal: The town crier needs a voice.
source: Python docs: print() | https://docs.python.org/3/library/functions.html#print

### Assignment

The line below is just a piece of text, so nothing shows up in the console. Use the `print()` function so the console shows:

```text
Greetings, adventurer!
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
"Greetings, adventurer!"
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Greetings, adventurer!'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert calls('print'), 'Call `print()` in your code.'
```
solution:
```python
print("Greetings, adventurer!")
```
wrong: prints the quotes too
```python
print('"Greetings, adventurer!"')
```
hint: `print(...)` puts whatever is inside the parentheses in the console.
:::

## Fix your first bug
id: first-bug
stage: intro
needs: console
minutes: 5
goal: The combat system isn't working as intended: heroes are gaining health when poisoned.
source: Python tutorial: Numbers | https://docs.python.org/3/tutorial/introduction.html#numbers

### Assignment

Fix the math bug on line 3. Sam should *lose* health when the poison hits.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
poison_damage = 7
start_health = 80
end_health = start_health + poison_damage

# Don't touch below this line
print(f"Sam's health is: {start_health}")
print(f"Sam takes {poison_damage} poison damage...")
print(f"Sam's health is: {end_health}")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "Sam's health is: 80\nSam takes 7 poison damage...\nSam's health is: 73"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(f"Sam\'s health is: {start_health}")\nprint(f"Sam takes {poison_damage} poison damage...")\nprint(f"Sam\'s health is: {end_health}")', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_token('-'), 'Subtract the damage with `-`.'
```
solution:
```python
poison_damage = 7
start_health = 80
end_health = start_health - poison_damage

# Don't touch below this line
print(f"Sam's health is: {start_health}")
print(f"Sam takes {poison_damage} poison damage...")
print(f"Sam's health is: {end_health}")
```
wrong: hard-codes the answer instead of fixing the math
```python
poison_damage = 7
start_health = 80
end_health = 73

# Don't touch below this line
print(f"Sam's health is: {start_health}")
print(f"Sam takes {poison_damage} poison damage...")
print(f"Sam's health is: {end_health}")
```
wrong: edits the protected lines
```python
poison_damage = 7
start_health = 80
end_health = start_health + poison_damage

# Don't touch below this line
print("Sam's health is: 80")
print("Sam takes 7 poison damage...")
print("Sam's health is: 73")
```
hint: Losing health means subtracting: `-` instead of `+`.
:::

## Comments
id: comments
stage: intro
needs: first-bug
minutes: 5
goal: The old scribe commented out half the story.
source: Python tutorial: An informal introduction | https://docs.python.org/3/tutorial/introduction.html

### Assignment

A line that starts with `#` is a comment, and Python skips it. The first line of the story is commented out. Make the console show both lines, in this order:

```text
The gates creak open...
A dragon blocks the road!
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
# print("The gates creak open...")
print("A dragon blocks the road!")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'The gates creak open...\nA dragon blocks the road!'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED
```
solution:
```python
print("The gates creak open...")
print("A dragon blocks the road!")
```
wrong: wrong order
```python
print("A dragon blocks the road!")
print("The gates creak open...")
```
hint: Delete the `#` at the start of the first line.
:::

## Several lines
id: multi-print
stage: intro
needs: comments
minutes: 5
goal: The innkeeper reads the notice board out loud.
source: Python docs: print() | https://docs.python.org/3/library/functions.html#print

### Assignment

Add two more `print` calls so the console shows the whole notice:

```text
WANTED: dragon slayer
Reward: 500 gold
Ask at the Rusty Tankard
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
print("WANTED: dragon slayer")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'WANTED: dragon slayer\nReward: 500 gold\nAsk at the Rusty Tankard'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED
```
solution:
```python
print("WANTED: dragon slayer")
print("Reward: 500 gold")
print("Ask at the Rusty Tankard")
```
wrong: forgets a line
```python
print("WANTED: dragon slayer")
print("Reward: 500 gold")
```
hint: Each `print(...)` call writes one line.
:::

## Variables
id: assign
stage: vars
needs: multi-print
minutes: 5
goal: Every hero needs a name.
source: Python tutorial: An informal introduction | https://docs.python.org/3/tutorial/introduction.html

### Assignment

Create a variable called `hero_name` that holds the text `"Sam"`. The print line below should then show:

```text
Sam
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
# create hero_name here

# Don't touch below this line
print(hero_name)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(hero_name)', "The code under # Don't touch below this line must stay as it was"
```
solution:
```python
hero_name = "Sam"

# Don't touch below this line
print(hero_name)
```
wrong: misspelled name
```python
heroname = "Sam"
hero_name = heroname.lower()

# Don't touch below this line
print(hero_name)
```
hint: A variable is made with `name = value`.
:::

## Numbers
id: numbers
stage: vars
needs: assign
minutes: 5
goal: Sam finds a treasure chest.
source: Python tutorial: Numbers | https://docs.python.org/3/tutorial/introduction.html#numbers

### Assignment

Set `gold` to `250` so the console shows:

```text
Sam has 250 gold
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
gold = 0

# Don't touch below this line
print(f"Sam has {gold} gold")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam has 250 gold'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(f"Sam has {gold} gold")', "The code under # Don't touch below this line must stay as it was"
```
solution:
```python
gold = 250

# Don't touch below this line
print(f"Sam has {gold} gold")
```
wrong: stores text, not a number
```python
gold = "250 "

# Don't touch below this line
print(f"Sam has {gold} gold")
```
hint: Change the number on the first line.
:::

## f-strings
id: fstrings
stage: vars
needs: numbers
minutes: 5
goal: The herald announces every hero.
source: Python tutorial: Formatted string literals | https://docs.python.org/3/tutorial/inputoutput.html#formatted-string-literals

### Assignment

Make `message` an f-string that puts `hero` and `level` into the text, so the console shows:

```text
Sam is level 3
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
hero = "Sam"
level = 3
message = "hero is level level"

# Don't touch below this line
print(message)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam is level 3'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(message)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert fstring_uses('hero'), 'Put `hero` inside an f-string: `f"{hero}"`.'

def test_code_1():
    assert fstring_uses('level'), 'Put `level` inside an f-string: `f"{level}"`.'
```
solution:
```python
hero = "Sam"
level = 3
message = f"{hero} is level {level}"

# Don't touch below this line
print(message)
```
wrong: types the text instead of using the variables
```python
hero = "Sam"
level = 3
message = "Sam is level 3"

# Don't touch below this line
print(message)
```
wrong: puts the names in a comment
```python
hero = "Sam"
level = 3
message = "Sam is level 3"  # f"{hero} {level}"

# Don't touch below this line
print(message)
```
hint: Start the string with `f` and put names in curly braces: `f"{hero} ..."`.
:::

## Joining text
id: concat
stage: vars
needs: fstrings
minutes: 5
goal: Heroes earn titles.
source: Python tutorial: Text | https://docs.python.org/3/tutorial/introduction.html#text

### Assignment

Build `full_title` by joining `name`, a space, and `title` with `+`, so the console shows:

```text
Sam the Brave
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
name = "Sam"
title = "the Brave"
full_title = name

# Don't touch below this line
print(full_title)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam the Brave'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(full_title)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_token('+'), 'Use `+` in your code.'

def test_code_1():
    assert uses_name('title'), 'Use the name `title`.'
```
solution:
```python
name = "Sam"
title = "the Brave"
full_title = name + " " + title

# Don't touch below this line
print(full_title)
```
wrong: forgets the space
```python
name = "Sam"
title = "the Brave"
full_title = name + title

# Don't touch below this line
print(full_title)
```
hint: `"a" + " " + "b"` gives `"a b"`.
:::

## Arithmetic
id: arithmetic
stage: vars
needs: concat
minutes: 5
goal: Sam has 17 potions to pack into bags that hold 5 each.
source: Python tutorial: Numbers | https://docs.python.org/3/tutorial/introduction.html#numbers

### Assignment

Use `//` for the number of full bags and `%` for the potions left over, so the console shows:

```text
3 bags, 2 left
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
potions = 17
full_bags = 0
leftover = 0

# Don't touch below this line
print(f"{full_bags} bags, {leftover} left")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '3 bags, 2 left'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(f"{full_bags} bags, {leftover} left")', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_token('//'), 'Use `//` in your code.'

def test_code_1():
    assert has_token('%'), 'Use `%` in your code.'

def test_code_2():
    assert uses_name('potions'), 'Use the name `potions`.'
```
solution:
```python
potions = 17
full_bags = potions // 5
leftover = potions % 5

# Don't touch below this line
print(f"{full_bags} bags, {leftover} left")
```
wrong: hard-codes the numbers
```python
potions = 17
full_bags = 3
leftover = 2

# Don't touch below this line
print(f"{full_bags} bags, {leftover} left")
```
wrong: hides the operators in a comment
```python
potions = 17
full_bags = 3  # potions // 5
leftover = 2  # potions % 5

# Don't touch below this line
print(f"{full_bags} bags, {leftover} left")
```
hint: `17 // 5` is the whole number of times 5 fits. `17 % 5` is what remains.
:::

## Changing a variable
id: update
stage: vars
needs: arithmetic
minutes: 5
goal: Sam sells a sword for 40 gold, then buys a potion for 15.
source: Python tutorial: Numbers | https://docs.python.org/3/tutorial/introduction.html#numbers

### Assignment

Update `gold` with `+=` and `-=` so the console shows the gold Sam ends with:

```text
125
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
gold = 100

# Update gold here

# Don't touch below this line
print(gold)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '125'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(gold)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_token('+='), 'Use `+=` in your code.'

def test_code_1():
    assert has_token('-='), 'Use `-=` in your code.'
```
solution:
```python
gold = 100

gold += 40
gold -= 15

# Don't touch below this line
print(gold)
```
wrong: sets the result directly
```python
gold = 100

gold = 125

# Don't touch below this line
print(gold)
```
hint: `gold += 40` is short for `gold = gold + 40`.
:::

## Converting types
id: convert
stage: vars
needs: update
minutes: 5
goal: The shield level was saved as text.
source: Python docs: int() | https://docs.python.org/3/library/functions.html#int

### Assignment

`shield_text` holds the text `"7"`, and you can't add 1 to text. Convert it to a number with `int()` so the console shows:

```text
8
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
shield_text = "7"
shield_level = shield_text

# Don't touch below this line
print(shield_level + 1)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '8'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(shield_level + 1)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert calls('int'), 'Call `int()` in your code.'

def test_code_1():
    assert uses_name('shield_text'), 'Use the name `shield_text`.'
```
solution:
```python
shield_text = "7"
shield_level = int(shield_text)

# Don't touch below this line
print(shield_level + 1)
```
wrong: types the number in
```python
shield_text = "7"
shield_level = 7

# Don't touch below this line
print(shield_level + 1)
```
hint: `int("7")` gives the number 7.
:::

## Naming variables
id: names
stage: vars
needs: convert
minutes: 5
goal: The scribe wrote `heroName`, but the rest of the book says `hero_name`.
source: Python tutorial: An informal introduction | https://docs.python.org/3/tutorial/introduction.html

### Assignment

Python programmers write variable names in `snake_case`. Rename the first variable so the code runs and the console shows:

```text
Sam 4
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
heroName = "Sam"
hero_level = 4

# Don't touch below this line
print(hero_name, hero_level)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam 4'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(hero_name, hero_level)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert not uses_name('heroName'), 'The name `heroName` should be gone.'
```
solution:
```python
hero_name = "Sam"
hero_level = 4

# Don't touch below this line
print(hero_name, hero_level)
```
wrong: keeps the old name around
```python
heroName = "Sam"
hero_name = heroName
hero_level = 4

# Don't touch below this line
print(hero_name, hero_level)
```
hint: The name on line 1 has to match the one used in the `print` line.
:::

## None
id: none
stage: vars
needs: names
minutes: 5
goal: Sam hasn't found a sword yet.
source: Python docs: The None constant | https://docs.python.org/3/library/constants.html#None

### Assignment

`None` means "no value yet". Set `sword` to `None` instead of an empty string, so the console shows:

```text
True
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
sword = ""

# Don't touch below this line
print(sword is None)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'True'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(sword is None)', "The code under # Don't touch below this line must stay as it was"
```
solution:
```python
sword = None

# Don't touch below this line
print(sword is None)
```
wrong: the text "None"
```python
sword = "None"

# Don't touch below this line
print(sword is None)
```
hint: `None` is written without quotes.
:::

## Swapping values
id: swap
stage: vars
needs: none
minutes: 5
goal: Sam and Mira swap weapons.
source: Python reference: Assignment statements | https://docs.python.org/3/reference/simple_stmts.html#assignment-statements

### Assignment

Swap the values of `sam` and `mira` in one line with `sam, mira = mira, sam`, so the console shows:

```text
Sam: bow, Mira: sword
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
sam = "sword"
mira = "bow"

# Swap them here

# Don't touch below this line
print(f"Sam: {sam}, Mira: {mira}")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam: bow, Mira: sword'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(f"Sam: {sam}, Mira: {mira}")', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_node('Tuple'), 'Swap with a tuple assignment: `sam, mira = mira, sam`.'
```
solution:
```python
sam = "sword"
mira = "bow"

sam, mira = mira, sam

# Don't touch below this line
print(f"Sam: {sam}, Mira: {mira}")
```
wrong: overwrites one before copying it
```python
sam = "sword"
mira = "bow"

sam = mira
mira = sam

# Don't touch below this line
print(f"Sam: {sam}, Mira: {mira}")
```
wrong: retypes the values
```python
sam = "sword"
mira = "bow"

sam = "bow"
mira = "sword"

# Don't touch below this line
print(f"Sam: {sam}, Mira: {mira}")
```
hint: The right side is worked out first, then both names are assigned at once.
:::

## Defining functions
id: def
stage: funcs
needs: swap
minutes: 5
goal: Guards at every gate greet travellers the same way.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

Define a function named `greet` that prints `Hail, adventurer!`. The code below calls it twice, so the console shows:

```text
Hail, adventurer!
Hail, adventurer!
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
# define greet here

# Don't touch below this line
greet()
greet()
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Hail, adventurer!\nHail, adventurer!'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

from solution import greet

def test_greet_itself_prints():
    assert printed(greet) == "Hail, adventurer!", "Calling greet() once should print the line once"

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'greet()\ngreet()', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert defines('greet'), 'Define `greet`.'
```
solution:
```python
def greet():
    print("Hail, adventurer!")

# Don't touch below this line
greet()
greet()
```
wrong: prints outside the function
```python
def greet():
    pass

print("Hail, adventurer!")
print("Hail, adventurer!")

# Don't touch below this line
greet()
greet()
```
hint: `def greet():` and then an indented body.
:::

## Parameters
id: params
stage: funcs
needs: def
minutes: 5
goal: Each guard greets each traveller by name.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

Write `describe(name, level)`, which **prints** `<name> is level <level>`. For example `describe("Sam", 3)` prints `Sam is level 3`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def describe(name, level):
    pass
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
def describe(name, level):
    print(f"{name} is level {level}")
```
wrong: returns the text instead of printing it
```python
def describe(name, level):
    return f"{name} is level {level}"
```
wrong: hard-codes Sam
```python
def describe(name, level):
    print("Sam is level 3")
```
hint: Use an f-string with `{name}` and `{level}` inside `print(...)`.
:::

## Return values
id: return
stage: funcs
needs: params
minutes: 5
goal: A critical hit doubles the damage.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

Write `double_damage(damage)` that **returns** twice the damage. It doesn't print anything: the caller decides what to do with the result.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def double_damage(damage):
    pass
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import double_damage

def test_values():
    assert double_damage(10) == 20
    assert double_damage(0) == 0
    assert double_damage(7) == 14

import copy, random
from solution import double_damage as LEARNER
def ref(d):
    return d * 2

def gen(r):
    return [r.randint(-50, 500)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "double_damage%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def double_damage(damage):
    return damage * 2
```
wrong: prints instead of returning
```python
def double_damage(damage):
    print(damage * 2)
```
wrong: adds 2 instead of doubling
```python
def double_damage(damage):
    return damage + 2
```
hint: `return` hands a value back to whoever called the function.
:::

## Print is not return
id: print-vs-return
stage: funcs
needs: return
minutes: 5
goal: The level-up screen shows `None`.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

`level_up` prints the new level instead of returning it, so `new_level` is `None`. Make it return the new level (and print nothing), so the console shows:

```text
Sam is now level 6
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def level_up(level):
    print(level + 1)

# Don't touch below this line
new_level = level_up(5)
print(f"Sam is now level {new_level}")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam is now level 6'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'new_level = level_up(5)\nprint(f"Sam is now level {new_level}")', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_node('Return'), 'Your code needs a `return statement`.'
```
solution:
```python
def level_up(level):
    return level + 1

# Don't touch below this line
new_level = level_up(5)
print(f"Sam is now level {new_level}")
```
wrong: returns and also prints
```python
def level_up(level):
    print(level + 1)
    return level + 1

# Don't touch below this line
new_level = level_up(5)
print(f"Sam is now level {new_level}")
```
hint: Replace `print(...)` inside the function with `return ...`.
:::

## Default arguments
id: default-args
stage: funcs
needs: print-vs-return
minutes: 5
goal: A small potion heals 25 health unless the shop says otherwise.
source: Python tutorial: Default argument values | https://docs.python.org/3/tutorial/controlflow.html#default-argument-values

### Assignment

Write `heal(health, potion=25)` that returns `health` plus the potion's strength.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def heal(health, potion):
    return health + potion
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import heal

def test_default():
    assert heal(10) == 35

def test_given():
    assert heal(10, 50) == 60
    assert heal(10, potion=5) == 15
```
solution:
```python
def heal(health, potion=25):
    return health + potion
```
wrong: ignores the potion it is given
```python
def heal(health, potion=25):
    return health + 25
```
hint: Give the parameter a default with `potion=25` in the `def` line.
:::

## Keyword arguments
id: kwargs
stage: funcs
needs: default-args
minutes: 5
goal: The roster printed Mira as a level-"mage" fighter.
source: Python tutorial: Keyword arguments | https://docs.python.org/3/tutorial/controlflow.html#keyword-arguments

### Assignment

The call at the bottom passes its arguments in the wrong order. Fix **the call** (not the function) with keyword arguments so the console shows:

```text
Mira the mage, level 5
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def describe_hero(name, level=1, role="fighter"):
    return f"{name} the {role}, level {level}"

# Fix the call below
print(describe_hero("Mira", "mage", 5))
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Mira the mage, level 5'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert keyword_arg('level'), 'Pass `level=` as a keyword argument.'

def test_code_1():
    assert keyword_arg('role'), 'Pass `role=` as a keyword argument.'
```
solution:
```python
def describe_hero(name, level=1, role="fighter"):
    return f"{name} the {role}, level {level}"

# Fix the call below
print(describe_hero("Mira", level=5, role="mage"))
```
wrong: changes the function instead of the call
```python
def describe_hero(name, role="fighter", level=1):
    return f"{name} the {role}, level {level}"

# Fix the call below
print(describe_hero("Mira", "mage", 5))
```
hint: Name the arguments: `level=5, role="mage"`.
:::

## Returning several values
id: multi-return
stage: funcs
needs: kwargs
minutes: 5
goal: The quartermaster wants the weakest and the strongest hit.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

Write `min_max(values)` that returns the smallest and the largest value as a pair, like `(1, 9)`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def min_max(values):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import min_max

def test_pair():
    low, high = min_max([3, 9, 1, 4])
    assert (low, high) == (1, 9)

def test_single():
    assert min_max([5]) == (5, 5)

import copy, random
from solution import min_max as LEARNER
def ref(v):
    return min(v), max(v)

def gen(r):
    return [[r.randint(-99, 99) for _ in range(r.randint(1, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "min_max%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def min_max(values):
    return min(values), max(values)
```
wrong: first and last instead of smallest and largest
```python
def min_max(values):
    return values[0], values[-1]
```
hint: A function can return `a, b`. The caller can unpack it with `low, high = min_max(...)`.
:::

## Functions calling functions
id: compose
stage: funcs
needs: multi-return
minutes: 5
goal: The damage formula has two steps.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

`crit` and `armor_reduce` are written for you. Write `final_damage(base, armor)` that first applies `crit` to `base`, then `armor_reduce` to the result with `armor`, and returns that. Call the two functions; don't copy their math.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def crit(damage):
    return damage * 2

def armor_reduce(damage, armor):
    return max(0, damage - armor)

def final_damage(base, armor):
    return base
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
def crit(damage):
    return damage * 2

def armor_reduce(damage, armor):
    return max(0, damage - armor)

def final_damage(base, armor):
    return armor_reduce(crit(base), armor)
```
wrong: copies the math
```python
def crit(damage):
    return damage * 2

def armor_reduce(damage, armor):
    return max(0, damage - armor)

def final_damage(base, armor):
    return max(0, base * 2 - armor)
```
wrong: reduces before the crit
```python
def crit(damage):
    return damage * 2

def armor_reduce(damage, armor):
    return max(0, damage - armor)

def final_damage(base, armor):
    return crit(armor_reduce(base, armor))
```
hint: `armor_reduce(crit(base), armor)`: the inner call runs first.
:::

## Any number of arguments
id: varargs
stage: funcs
needs: compose
minutes: 5
goal: A combo can be two hits or ten.
source: Python tutorial: Arbitrary argument lists | https://docs.python.org/3/tutorial/controlflow.html#arbitrary-argument-lists

### Assignment

Write `combo(*hits)` that returns the total of all the hits it is given, or 0 when there are none.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def combo(hits):
    return sum(hits)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import combo

def test_values():
    assert combo(3, 4, 5) == 12
    assert combo(10) == 10
    assert combo() == 0
```
solution:
```python
def combo(*hits):
    return sum(hits)
```
wrong: takes one list
```python
def combo(hits=()):
    return sum(hits)
```
hint: `*hits` collects every argument into a tuple.
:::

## Local variables
id: local
stage: scope
needs: varargs
minutes: 5
goal: The damage roll vanished the moment the function ended.
source: Python tutorial: Scopes and namespaces | https://docs.python.org/3/tutorial/classes.html#python-scopes-and-namespaces

### Assignment

Variables made inside a function stay inside it. Change `roll_damage` so it **returns** `damage`, and store what it returns in a variable called `damage` below. The console should show:

```text
Rolling...
12
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def roll_damage():
    damage = 12
    print("Rolling...")

roll_damage()
print(damage)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Rolling...\n12'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert has_node('Return'), 'Your code needs a `return statement`.'

def test_code_1():
    assert not has_node('Global'), "Don't use a `global statement` here."
```
solution:
```python
def roll_damage():
    damage = 12
    print("Rolling...")
    return damage

damage = roll_damage()
print(damage)
```
wrong: makes damage global
```python
def roll_damage():
    global damage
    damage = 12
    print("Rolling...")

roll_damage()
print(damage)
```
wrong: prints 12 directly
```python
def roll_damage():
    damage = 12
    print("Rolling...")

roll_damage()
print(12)
```
hint: Add `return damage` inside the function, and `damage = roll_damage()` outside it.
:::

## Reading global values
id: read-global
stage: scope
needs: local
minutes: 5
goal: Every potion in the kingdom costs the same.
source: Python tutorial: Scopes and namespaces | https://docs.python.org/3/tutorial/classes.html#python-scopes-and-namespaces

### Assignment

`POTION_PRICE` is defined outside the function. Write `full_price(count)` that returns the price of `count` potions, using `POTION_PRICE`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
POTION_PRICE = 15

def full_price(count):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
POTION_PRICE = 15

def full_price(count):
    return count * POTION_PRICE
```
wrong: types 15 instead of using the constant
```python
POTION_PRICE = 15

def full_price(count):
    return count * 15
```
hint: A function can read a global name without any special keyword.
:::

## Shadowing
id: shadow
stage: scope
needs: read-global
minutes: 5
goal: `take_hit` crashes with UnboundLocalError.
source: Python tutorial: Scopes and namespaces | https://docs.python.org/3/tutorial/classes.html#python-scopes-and-namespaces

### Assignment

Assigning to `health` inside the function makes it a *local* name, so reading it first fails. Don't use `global`: change `take_hit` to take the current health as a parameter, and pass `health` in at the call. The console should show:

```text
70
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
health = 100

def take_hit(damage):
    health = health - damage
    return health

print(take_hit(30))
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '70'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert not has_node('Global'), "Don't use a `global statement` here."
```
solution:
```python
health = 100

def take_hit(current, damage):
    return current - damage

print(take_hit(health, 30))
```
wrong: uses global
```python
health = 100

def take_hit(damage):
    global health
    health = health - damage
    return health

print(take_hit(30))
```
hint: `def take_hit(current, damage):` and `take_hit(health, 30)`.
:::

## The global keyword
id: global-kw
stage: scope
needs: shadow
minutes: 5
goal: The treasury counts gold across calls.
source: Python reference: The global statement | https://docs.python.org/3/reference/simple_stmts.html#the-global-statement

### Assignment

`add_gold` should change the global `gold`, but it crashes. Add the one line it needs so the console shows:

```text
30
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
gold = 0

def add_gold(amount):
    gold += amount

add_gold(10)
add_gold(20)
print(gold)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '30'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert has_node('Global'), 'Your code needs a `global statement`.'
```
solution:
```python
gold = 0

def add_gold(amount):
    global gold
    gold += amount

add_gold(10)
add_gold(20)
print(gold)
```
wrong: sets gold outside the function instead
```python
gold = 0

def add_gold(amount):
    pass

add_gold(10)
add_gold(20)
gold = 30
print(gold)
```
hint: `global gold` goes at the top of the function body.
:::

## Parameters are local
id: params-local
stage: scope
needs: global-kw
minutes: 5
goal: Healing a copy doesn't heal the hero.
source: Python tutorial: Scopes and namespaces | https://docs.python.org/3/tutorial/classes.html#python-scopes-and-namespaces

### Assignment

`heal` changes its own `hp`, which is a local name, so the global `hp` stays 40. Make `heal` return the new value and assign it back at the call (no `global`), so the console shows:

```text
65
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
hp = 40

def heal(hp):
    hp = hp + 25

heal(hp)
print(hp)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '65'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert has_node('Return'), 'Your code needs a `return statement`.'

def test_code_1():
    assert not has_node('Global'), "Don't use a `global statement` here."
```
solution:
```python
hp = 40

def heal(hp):
    hp = hp + 25
    return hp

hp = heal(hp)
print(hp)
```
wrong: prints the sum instead
```python
hp = 40

def heal(hp):
    hp = hp + 25

heal(hp)
print(hp + 25)
```
hint: `return hp` at the end of the function, and `hp = heal(hp)` at the call.
:::

## Reading an error
id: traceback
stage: debug
needs: params-local
minutes: 5
goal: The bat never appears and the console shows a red error.
source: Python tutorial: Errors and exceptions | https://docs.python.org/3/tutorial/errors.html

### Assignment

Run the code and read the error message: it names the line and the problem. Fix the typo so the console shows:

```text
Sam enters the cave
A bat flies out!
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
print("Sam enters the cave")
prnt("A bat flies out!")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam enters the cave\nA bat flies out!'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert not uses_name('prnt'), 'The name `prnt` should be gone.'
```
solution:
```python
print("Sam enters the cave")
print("A bat flies out!")
```
wrong: defines prnt instead of fixing the typo
```python
prnt = print
print("Sam enters the cave")
prnt("A bat flies out!")
```
hint: The error says `prnt` is not defined. Look at how it is spelled.
:::

## A syntax error
id: syntax-error
stage: debug
needs: traceback
minutes: 5
goal: The code won't even start.
source: Python tutorial: Errors and exceptions | https://docs.python.org/3/tutorial/errors.html

### Assignment

Python reports a `SyntaxError` before running anything. Find the missing piece and fix it so the console shows:

```text
The torch is lit
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
torch_lit = True
if torch_lit
    print("The torch is lit")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'The torch is lit'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert has_node('If'), 'Your code needs a `if statement`.'
```
solution:
```python
torch_lit = True
if torch_lit:
    print("The torch is lit")
```
wrong: removes the if
```python
torch_lit = True
print("The torch is lit")
```
hint: An `if` line ends with a colon.
:::

## A type error
id: type-error
stage: debug
needs: syntax-error
minutes: 5
goal: The score line crashes with TypeError.
source: Python tutorial: Errors and exceptions | https://docs.python.org/3/tutorial/errors.html

### Assignment

You can't add a number to text. Fix the last line with an f-string so the console shows:

```text
Score: 42
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
score = 42
print("Score: " + score)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Score: 42'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert fstring_uses('score'), 'Put `score` inside an f-string: `f"{score}"`.'
```
solution:
```python
score = 42
print(f"Score: {score}")
```
wrong: types the number
```python
score = 42
print("Score: 42")
```
hint: `f"Score: {score}"` turns the number into text for you.
:::

## Off by one
id: off-by-one
stage: debug
needs: type-error
minutes: 5
goal: The inventory screen crashes on the last item.
source: Python tutorial: Lists | https://docs.python.org/3/tutorial/introduction.html#lists

### Assignment

`last_item` raises an `IndexError`. Indexes start at 0, so the last item is not at `len(items)`. Fix it.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def last_item(items):
    return items[len(items)]
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import last_item

def test_last():
    assert last_item(["sword", "shield", "potion"]) == "potion"
    assert last_item(["only"]) == "only"

import copy, random
from solution import last_item as LEARNER
def ref(items):
    return items[-1]

def gen(r):
    return [[r.choice(['sword', 'bow', 'gem', 'map']) + str(i) for i in range(r.randint(1, 9))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "last_item%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def last_item(items):
    return items[len(items) - 1]
```
wrong: one too far back
```python
def last_item(items):
    return items[len(items) - 2]
```
wrong: always the third item
```python
def last_item(items):
    return items[2]
```
hint: The last index is `len(items) - 1`, or simply `-1`.
:::

## Assertions
id: assert
stage: debug
needs: off-by-one
minutes: 5
goal: Health must never go below zero.
source: Python reference: The assert statement | https://docs.python.org/3/reference/simple_stmts.html#the-assert-statement

### Assignment

Add an `assert` to `apply_damage` so it raises an `AssertionError` when the damage is bigger than the health. Normal hits must still work.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def apply_damage(health, damage):
    return health - damage
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert has_node('Assert'), 'Your code needs a `assert statement`.'
```
solution:
```python
def apply_damage(health, damage):
    assert damage <= health, "damage is bigger than health"
    return health - damage
```
wrong: forbids exact kills too
```python
def apply_damage(health, damage):
    assert damage < health
    return health - damage
```
hint: `assert damage <= health` stops the program when the condition is false.
:::

## Printing to debug
id: print-debug
stage: debug
needs: assert
minutes: 5
goal: The average damage looks far too high.
source: Python docs: print() | https://docs.python.org/3/library/functions.html#print

### Assignment

`average(a, b, c)` returns the wrong number. Print the pieces if it helps, then fix the bug. Hint: look at which operation runs first.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def average(a, b, c):
    return a + b + c / 3
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import average

def test_values():
    assert average(3, 3, 3) == 3
    assert average(1, 2, 3) == 2
    assert average(10, 20, 30) == 20

import copy, random
from solution import average as LEARNER
def ref(a, b, c):
    return (a + b + c) / 3

def gen(r):
    return [r.randint(0, 99) * 3, r.randint(0, 99) * 3, r.randint(0, 99) * 3]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "average%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def average(a, b, c):
    return (a + b + c) / 3
```
wrong: divides by the wrong count
```python
def average(a, b, c):
    return (a + b + c) / 2
```
hint: Division happens before addition. Use parentheses.
:::

## Binary
id: binary
stage: computing
needs: print-debug
minutes: 5
goal: The dwarves write their rune numbers in binary.
source: Python docs: bin() | https://docs.python.org/3/library/functions.html#bin

### Assignment

Write `to_binary(n)` that returns `n` in binary as text without the `0b` prefix: `to_binary(5)` is `"101"`. Use `bin()`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def to_binary(n):
    return str(n)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import to_binary

def test_values():
    assert to_binary(5) == "101"
    assert to_binary(0) == "0"
    assert to_binary(255) == "11111111"

import copy, random
from solution import to_binary as LEARNER
def ref(n):
    return format(n, 'b')

def gen(r):
    return [r.randint(0, 10**6)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "to_binary%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def to_binary(n):
    return bin(n)[2:]
```
wrong: keeps the 0b
```python
def to_binary(n):
    return bin(n)
```
hint: `bin(5)` is `"0b101"`. Slice off the first two characters.
:::

## Reading binary
id: from-binary
stage: computing
needs: binary
minutes: 5
goal: A rune tablet reads `1011`.
source: Python docs: int() | https://docs.python.org/3/library/functions.html#int

### Assignment

Write `from_binary(text)` that turns binary text like `"1011"` into the number it stands for (11). `int()` takes a base as its second argument.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def from_binary(text):
    return int(text)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import from_binary

def test_values():
    assert from_binary("1011") == 11
    assert from_binary("0") == 0
    assert from_binary("100000000") == 256

import copy, random
from solution import from_binary as LEARNER
def ref(t):
    return int(t, 2)

def gen(r):
    return [format(r.randint(0, 10**6), 'b')]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "from_binary%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def from_binary(text):
    return int(text, 2)
```
wrong: reads it as decimal
```python
def from_binary(text):
    return int(text)
```
hint: `int("1011", 2)` reads the text in base 2.
:::

## Bit flags
id: flags
stage: computing
needs: from-binary
minutes: 5
goal: Each door in the castle has permission bits: 1 means read the map, 2 means open, 4 means lock.
source: Python docs: Bitwise operations on integer types | https://docs.python.org/3/library/stdtypes.html#bitwise-operations-on-integer-types

### Assignment

Write `has_flag(perms, flag)` that returns `True` when every bit of `flag` is set in `perms`, and `grant(perms, flag)` that returns `perms` with those bits switched on. Use `&` and `|`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
READ, OPEN, LOCK = 1, 2, 4

def has_flag(perms, flag):
    return False

def grant(perms, flag):
    return perms
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import has_flag, grant, READ, OPEN, LOCK

def test_has():
    assert has_flag(READ | OPEN, OPEN) is True
    assert has_flag(READ, OPEN) is False
    assert has_flag(READ | OPEN, READ | OPEN) is True
    assert has_flag(READ, READ | OPEN) is False

def test_grant():
    assert grant(READ, LOCK) == 5
    assert grant(READ | LOCK, LOCK) == 5

def test_code_0():
    assert has_token('&'), 'Use `&` in your code.'

def test_code_1():
    assert has_token('|'), 'Use `|` in your code.'
```
solution:
```python
READ, OPEN, LOCK = 1, 2, 4

def has_flag(perms, flag):
    return perms & flag == flag

def grant(perms, flag):
    return perms | flag
```
wrong: any shared bit counts
```python
READ, OPEN, LOCK = 1, 2, 4

def has_flag(perms, flag):
    return perms & flag != 0

def grant(perms, flag):
    return perms | flag
```
wrong: adds instead of setting bits
```python
READ, OPEN, LOCK = 1, 2, 4

def has_flag(perms, flag):
    return perms & flag == flag

def grant(perms, flag):
    return perms + flag
```
hint: `perms & flag` keeps only the bits both have. `perms | flag` switches the flag's bits on.
:::

## Floats aren't exact
id: floats
stage: computing
needs: flags
minutes: 5
goal: The alchemist's scales say 0.1 + 0.2 isn't 0.3.
source: Python tutorial: Floating-point arithmetic | https://docs.python.org/3/tutorial/floatingpoint.html

### Assignment

Floats are stored in binary, so `0.1 + 0.2 == 0.3` is `False`. Write `same_weight(a, b)` that returns `True` when two weights are equal to within a tiny tolerance, using `math.isclose`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def same_weight(a, b):
    return a == b
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import same_weight

def test_values():
    assert same_weight(0.1 + 0.2, 0.3) is True
    assert same_weight(1.0, 1.0) is True
    assert same_weight(1.0, 1.1) is False

def test_code_0():
    assert calls('isclose'), 'Call `isclose()` in your code.'
```
solution:
```python
import math

def same_weight(a, b):
    return math.isclose(a, b)
```
wrong: rounds to whole numbers
```python
def same_weight(a, b):
    return round(a) == round(b)
```
hint: `import math`, then `math.isclose(a, b)`.
:::

## Quotient and remainder together
id: divmod
stage: computing
needs: floats
minutes: 5
goal: Five heroes split the loot in copper coins.
source: Python docs: divmod() | https://docs.python.org/3/library/functions.html#divmod

### Assignment

Write `share(total, heroes)` that returns a pair: how many coins each hero gets, and how many are left over. Use `divmod`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def share(total, heroes):
    return total / heroes, 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import share

def test_values():
    assert share(17, 5) == (3, 2)
    assert share(10, 5) == (2, 0)
    assert share(3, 5) == (0, 3)

def test_code_0():
    assert calls('divmod'), 'Call `divmod()` in your code.'

import copy, random
from solution import share as LEARNER
def ref(t, h):
    return (t // h, t % h)

def gen(r):
    return [r.randint(0, 5000), r.randint(1, 12)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "share%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def share(total, heroes):
    return divmod(total, heroes)
```
wrong: float division
```python
def share(total, heroes):
    return total / heroes, total % heroes
```
hint: `divmod(17, 5)` is `(3, 2)`.
:::

## Big numbers
id: big-ints
stage: computing
needs: divmod
minutes: 5
goal: The dragon's hoard is enormous.
source: Python tutorial: Numbers | https://docs.python.org/3/tutorial/introduction.html#numbers

### Assignment

Python integers don't overflow. Set `hoard` to 2 to the power of 100 using `**`, so the console shows:

```text
1267650600228229401496703205376
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
hoard = 2 * 100

# Don't touch below this line
print(hoard)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '1267650600228229401496703205376'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(hoard)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_token('**'), 'Use `**` in your code.'
```
solution:
```python
hoard = 2 ** 100

# Don't touch below this line
print(hoard)
```
wrong: pastes the number
```python
hoard = 1267650600228229401496703205376

# Don't touch below this line
print(hoard)
```
hint: `**` is the power operator.
:::

## Booleans
id: booleans
stage: compare
needs: big-ints
minutes: 5
goal: The healer only helps the living.
source: Python docs: Boolean operations | https://docs.python.org/3/library/stdtypes.html#boolean-operations-and-or-not

### Assignment

Write `is_alive(health)` that returns `True` when `health` is above 0 and `False` otherwise.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def is_alive(health):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import is_alive

def test_values():
    assert is_alive(1) is True
    assert is_alive(0) is False
    assert is_alive(-5) is False

import copy, random
from solution import is_alive as LEARNER
def ref(h):
    return h > 0

def gen(r):
    return [r.randint(-20, 20)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "is_alive%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def is_alive(health):
    return health > 0
```
wrong: counts 0 as alive
```python
def is_alive(health):
    return health >= 0
```
hint: A comparison like `health > 0` is already a boolean.
:::

## if and else
id: if-else
stage: compare
needs: booleans
minutes: 5
goal: Sam decides whether to rest.
source: Python tutorial: if statements | https://docs.python.org/3/tutorial/controlflow.html#if-statements

### Assignment

Write `choose(health)` that returns `"rest"` when health is below 30 and `"fight"` otherwise.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def choose(health):
    return "fight"
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import choose

def test_values():
    assert choose(29) == "rest"
    assert choose(30) == "fight"
    assert choose(100) == "fight"

import copy, random
from solution import choose as LEARNER
def ref(h):
    return 'rest' if h < 30 else 'fight'

def gen(r):
    return [r.randint(-10, 120)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "choose%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def choose(health):
    if health < 30:
        return "rest"
    else:
        return "fight"
```
wrong: rests at exactly 30
```python
def choose(health):
    if health <= 30:
        return "rest"
    return "fight"
```
hint: `if health < 30:` then `return "rest"`.
:::

## elif
id: elif
stage: compare
needs: if-else
minutes: 5
goal: Heroes are ranked by level.
source: Python tutorial: if statements | https://docs.python.org/3/tutorial/controlflow.html#if-statements

### Assignment

Write `rank(level)`: below 5 is `"novice"`, 5 to 9 is `"adept"`, and 10 or more is `"master"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def rank(level):
    return "novice"
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import rank

def test_values():
    assert rank(1) == "novice"
    assert rank(4) == "novice"
    assert rank(5) == "adept"
    assert rank(9) == "adept"
    assert rank(10) == "master"
    assert rank(40) == "master"

import copy, random
from solution import rank as LEARNER
def ref(l):
    return 'novice' if l < 5 else 'adept' if l < 10 else 'master'

def gen(r):
    return [r.randint(0, 30)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "rank%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def rank(level):
    if level < 5:
        return "novice"
    elif level < 10:
        return "adept"
    else:
        return "master"
```
wrong: checks in the wrong order
```python
def rank(level):
    if level < 10:
        return "adept"
    elif level < 5:
        return "novice"
    return "master"
```
hint: Chain the checks: `if`, then `elif`, then `else`.
:::

## and, or, not
id: and-or-not
stage: compare
needs: elif
minutes: 5
goal: The castle gate opens for high levels carrying the key, and never for the cursed.
source: Python docs: Boolean operations | https://docs.python.org/3/library/stdtypes.html#boolean-operations-and-or-not

### Assignment

Write `can_enter(level, has_key, cursed)` that returns `True` only when `level` is at least 5 **and** `has_key` is true **and** the hero is **not** `cursed`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def can_enter(level, has_key, cursed):
    return False
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import can_enter

def test_values():
    assert can_enter(5, True, False) is True
    assert can_enter(4, True, False) is False
    assert can_enter(9, False, False) is False
    assert can_enter(9, True, True) is False

import copy, random
from solution import can_enter as LEARNER
def ref(l, k, c):
    return l >= 5 and k and not c

def gen(r):
    return [r.randint(0, 10), r.choice([True, False]), r.choice([True, False])]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "can_enter%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def can_enter(level, has_key, cursed):
    return level >= 5 and has_key and not cursed
```
wrong: or instead of and
```python
def can_enter(level, has_key, cursed):
    return (level >= 5 or has_key) and not cursed
```
wrong: forgets the curse
```python
def can_enter(level, has_key, cursed):
    return level >= 5 and has_key
```
hint: Join the conditions with `and`, and flip `cursed` with `not`.
:::

## Chained comparisons
id: chained
stage: compare
needs: and-or-not
minutes: 5
goal: Some quests are only for a band of levels.
source: Python docs: Comparisons | https://docs.python.org/3/library/stdtypes.html#comparisons

### Assignment

Write `in_band(level, low, high)` that returns `True` when `low <= level <= high`. Python lets you chain the comparisons exactly like that.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def in_band(level, low, high):
    return level > low
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import in_band

def test_values():
    assert in_band(5, 1, 10) is True
    assert in_band(1, 1, 10) is True
    assert in_band(10, 1, 10) is True
    assert in_band(11, 1, 10) is False
    assert in_band(0, 1, 10) is False

import copy, random
from solution import in_band as LEARNER
def ref(l, a, b):
    return a <= l <= b

def gen(r):
    a = r.randint(0, 20)
    return [r.randint(-5, 40), a, a + r.randint(0, 10)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "in_band%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def in_band(level, low, high):
    return low <= level <= high
```
wrong: excludes the ends
```python
def in_band(level, low, high):
    return low < level < high
```
hint: `low <= level <= high` checks both sides at once.
:::

## One-line if
id: ternary
stage: compare
needs: chained
minutes: 5
goal: The status bar needs one word.
source: Python reference: Conditional expressions | https://docs.python.org/3/reference/expressions.html#conditional-expressions

### Assignment

Write `status(hp)` that returns `"alive"` when `hp` is above 0 and `"fallen"` otherwise, in **one** `return` line using `x if condition else y`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def status(hp):
    return "alive"
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import status

def test_values():
    assert status(5) == "alive"
    assert status(0) == "fallen"
    assert status(-1) == "fallen"

def test_code_0():
    assert has_node('IfExp'), 'Your code needs a `one-line `x if cond else y``.'
```
solution:
```python
def status(hp):
    return "alive" if hp > 0 else "fallen"
```
wrong: a full if statement
```python
def status(hp):
    if hp > 0:
        return "alive"
    return "fallen"
```
hint: `return "alive" if hp > 0 else "fallen"`
:::

## in
id: membership
stage: compare
needs: ternary
minutes: 5
goal: Only certain items count as loot.
source: Python reference: Membership tests | https://docs.python.org/3/reference/expressions.html#membership-test-operations

### Assignment

Write `is_loot(item)` that returns `True` when `item` is one of `"gold"`, `"gem"` or `"scroll"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def is_loot(item):
    return False
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import is_loot

def test_values():
    assert is_loot("gold") is True
    assert is_loot("scroll") is True
    assert is_loot("rock") is False
    assert is_loot("") is False
    assert is_loot("go") is False
```
solution:
```python
def is_loot(item):
    return item in ["gold", "gem", "scroll"]
```
wrong: searches inside one string
```python
def is_loot(item):
    return item in "gold gem scroll"
```
hint: `x in [a, b, c]` is true when `x` is one of them.
:::

## Truthiness
id: truthiness
stage: compare
needs: membership
minutes: 5
goal: An empty backpack counts as false.
source: Python docs: Truth value testing | https://docs.python.org/3/library/stdtypes.html#truth-value-testing

### Assignment

Write `has_items(bag)` that returns `True` when the list `bag` has anything in it and `False` when it is empty. Don't use `len`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def has_items(bag):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import has_items

def test_values():
    assert has_items([]) is False
    assert has_items(["sword"]) is True
    assert has_items([0]) is True

def test_code_0():
    assert not calls('len'), "Don't call `len()` here."
```
solution:
```python
def has_items(bag):
    return bool(bag)
```
wrong: returns the list itself
```python
def has_items(bag):
    return bag
```
hint: Empty lists are false, other lists are true. `bool(bag)` turns that into `True` or `False`.
:::

## Comparing text
id: string-compare
stage: compare
needs: truthiness
minutes: 5
goal: Names on the guild list don't care about capitals.
source: Python docs: Comparisons | https://docs.python.org/3/library/stdtypes.html#comparisons

### Assignment

Write `same_name(a, b)` that returns `True` when the two names are the same, ignoring upper and lower case: `same_name("Sam", "sAM")` is `True`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def same_name(a, b):
    return a == b
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import same_name

def test_values():
    assert same_name("Sam", "sAM") is True
    assert same_name("Sam", "Sam") is True
    assert same_name("Sam", "Mira") is False
    assert same_name("Sam", "Samwise") is False
```
solution:
```python
def same_name(a, b):
    return a.lower() == b.lower()
```
wrong: only checks the first letter
```python
def same_name(a, b):
    return a[0].lower() == b[0].lower()
```
hint: Compare `a.lower()` with `b.lower()`.
:::

## for loops
id: for-range
stage: loops
needs: string-compare
minutes: 5
goal: The arena announces each round.
source: Python tutorial: The range() function | https://docs.python.org/3/tutorial/controlflow.html#the-range-function

### Assignment

Use a `for` loop with `range()` so the console shows:

```text
Round 1
Round 2
Round 3
Round 4
Round 5
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
print("Round 1")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Round 1\nRound 2\nRound 3\nRound 4\nRound 5'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert has_node('For'), 'Your code needs a `for loop`.'

def test_code_1():
    assert calls('range'), 'Call `range()` in your code.'
```
solution:
```python
for n in range(1, 6):
    print(f"Round {n}")
```
wrong: five print lines
```python
print("Round 1")
print("Round 2")
print("Round 3")
print("Round 4")
print("Round 5")
```
wrong: starts at 0
```python
for n in range(5):
    print(f"Round {n}")
```
hint: `range(1, 6)` counts 1, 2, 3, 4, 5. The end is not included.
:::

## Counting down
id: range-step
stage: loops
needs: for-range
minutes: 5
goal: The portal closes in a countdown of twos.
source: Python tutorial: The range() function | https://docs.python.org/3/tutorial/controlflow.html#the-range-function

### Assignment

Use `range()` with a step so the console shows:

```text
10
8
6
4
2
0
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
for n in range(10):
    print(n)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '10\n8\n6\n4\n2\n0'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_code_0():
    assert has_node('For'), 'Your code needs a `for loop`.'

def test_code_1():
    assert calls('range'), 'Call `range()` in your code.'
```
solution:
```python
for n in range(10, -1, -2):
    print(n)
```
wrong: stops too early
```python
for n in range(10, 0, -2):
    print(n)
```
hint: `range(start, stop, step)`: start at 10, step by -2, and stop *before* -1.
:::

## Adding up in a loop
id: sum-loop
stage: loops
needs: range-step
minutes: 5
goal: Sam counts the gold in every chest.
source: Python tutorial: for statements | https://docs.python.org/3/tutorial/controlflow.html#for-statements

### Assignment

Write `total_gold(chests)` that adds up the numbers in the list `chests` using a `for` loop (no `sum()`).

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def total_gold(chests):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import total_gold

def test_values():
    assert total_gold([10, 20, 30]) == 60
    assert total_gold([]) == 0
    assert total_gold([7]) == 7

def test_code_0():
    assert has_node('For'), 'Your code needs a `for loop`.'

def test_code_1():
    assert not calls('sum'), "Don't call `sum()` here."

import copy, random
from solution import total_gold as LEARNER
def ref(c):
    return sum(c)

def gen(r):
    return [[r.randint(0, 100) for _ in range(r.randint(0, 10))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "total_gold%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def total_gold(chests):
    total = 0
    for chest in chests:
        total += chest
    return total
```
wrong: returns inside the loop
```python
def total_gold(chests):
    total = 0
    for chest in chests:
        total += chest
        return total
    return total
```
hint: Start with `total = 0`, add each chest to it, and return it after the loop.
:::

## while loops
id: while
stage: loops
needs: sum-loop
minutes: 5
goal: How many swings does it take to fell the boss?
source: Python reference: The while statement | https://docs.python.org/3/reference/compound_stmts.html#the-while-statement

### Assignment

Write `turns_to_win(boss_hp, damage)` that counts how many hits of `damage` it takes to bring `boss_hp` to 0 or less, using a `while` loop. A boss with 0 HP needs 0 turns.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def turns_to_win(boss_hp, damage):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import turns_to_win

def test_values():
    assert turns_to_win(100, 30) == 4
    assert turns_to_win(10, 10) == 1
    assert turns_to_win(0, 5) == 0
    assert turns_to_win(31, 30) == 2

def test_code_0():
    assert has_node('While'), 'Your code needs a `while loop`.'

import copy, random
from solution import turns_to_win as LEARNER
def ref(hp, d):
    return max(0, -(-hp // d))

def gen(r):
    return [r.randint(-5, 500), r.randint(1, 60)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "turns_to_win%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def turns_to_win(boss_hp, damage):
    turns = 0
    while boss_hp > 0:
        boss_hp -= damage
        turns += 1
    return turns
```
wrong: plain division
```python
def turns_to_win(boss_hp, damage):
    while False:
        pass
    return boss_hp // damage
```
hint: Loop `while boss_hp > 0`: lower it, and count a turn each time.
:::

## Loops that build up
id: regen
stage: loops
needs: while
minutes: 5
goal: Resting restores health a little each turn, up to the maximum.
source: Python reference: The while statement | https://docs.python.org/3/reference/compound_stmts.html#the-while-statement

### Assignment

Write `rest_turns(hp, max_hp, rate)` that returns how many turns of resting it takes to get `hp` to `max_hp`. Each turn adds `rate`, but health never goes above `max_hp`. Already full means 0 turns.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def rest_turns(hp, max_hp, rate):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import rest_turns

def test_values():
    assert rest_turns(10, 50, 10) == 4
    assert rest_turns(45, 50, 10) == 1
    assert rest_turns(50, 50, 10) == 0

import copy, random
from solution import rest_turns as LEARNER
def ref(hp, m, rate):
    return max(0, -(-(m - hp) // rate))

def gen(r):
    m = r.randint(1, 200)
    return [r.randint(0, m), m, r.randint(1, 30)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "rest_turns%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def rest_turns(hp, max_hp, rate):
    turns = 0
    while hp < max_hp:
        hp = min(max_hp, hp + rate)
        turns += 1
    return turns
```
wrong: one turn too many
```python
def rest_turns(hp, max_hp, rate):
    turns = 0
    while hp <= max_hp:
        hp += rate
        turns += 1
    return turns
```
hint: Loop while `hp < max_hp`; add `rate` each turn and count.
:::

## break
id: break
stage: loops
needs: regen
minutes: 5
goal: Sam is looking for the first strong hit.
source: Python tutorial: break and continue | https://docs.python.org/3/tutorial/controlflow.html#break-and-continue-statements-and-else-clauses-on-loops

### Assignment

Write `first_big_hit(hits, limit)` that returns the first number in `hits` that is at least `limit`, or `None` if there isn't one. Use a loop and stop early.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def first_big_hit(hits, limit):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import first_big_hit

def test_values():
    assert first_big_hit([3, 8, 15, 20], 10) == 15
    assert first_big_hit([1, 2], 10) is None
    assert first_big_hit([], 1) is None

import copy, random
from solution import first_big_hit as LEARNER
def ref(h, l):
    return next((x for x in h if x >= l), None)

def gen(r):
    return [[r.randint(0, 30) for _ in range(r.randint(0, 8))], r.randint(0, 30)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "first_big_hit%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def first_big_hit(hits, limit):
    for hit in hits:
        if hit >= limit:
            return hit
    return None
```
wrong: the biggest instead of the first
```python
def first_big_hit(hits, limit):
    big = [h for h in hits if h >= limit]
    return max(big) if big else None
```
hint: Loop over `hits`. When one is at least `limit`, return it.
:::

## continue
id: continue
stage: loops
needs: break
minutes: 5
goal: Fallen monsters shouldn't count.
source: Python tutorial: break and continue | https://docs.python.org/3/tutorial/controlflow.html#break-and-continue-statements-and-else-clauses-on-loops

### Assignment

Write `count_alive(healths)` that counts how many numbers in the list are above 0. Use `continue` to skip the fallen ones.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def count_alive(healths):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import count_alive

def test_values():
    assert count_alive([10, 0, 5, -3]) == 2
    assert count_alive([]) == 0
    assert count_alive([0, 0]) == 0

def test_code_0():
    assert has_node('Continue'), 'Your code needs a `continue statement`.'

import copy, random
from solution import count_alive as LEARNER
def ref(h):
    return sum(1 for x in h if x > 0)

def gen(r):
    return [[r.randint(-5, 5) for _ in range(r.randint(0, 10))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "count_alive%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def count_alive(healths):
    alive = 0
    for health in healths:
        if health <= 0:
            continue
        alive += 1
    return alive
```
wrong: counts the fallen
```python
def count_alive(healths):
    alive = 0
    for health in healths:
        if health < 0:
            continue
        alive += 1
    return alive
```
hint: Inside the loop: `if health <= 0: continue`, otherwise count it.
:::

## Looping over text
id: loop-string
stage: loops
needs: continue
minutes: 5
goal: Spells are stronger with more vowels.
source: Python tutorial: for statements | https://docs.python.org/3/tutorial/controlflow.html#for-statements

### Assignment

Write `count_vowels(word)` that counts the letters `a`, `e`, `i`, `o`, `u` in `word`, upper or lower case, using a loop over the text.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def count_vowels(word):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import count_vowels

def test_values():
    assert count_vowels("Fireball") == 3
    assert count_vowels("AEIOU") == 5
    assert count_vowels("rhythm") == 0
    assert count_vowels("") == 0

def test_code_0():
    assert has_node('For'), 'Your code needs a `for loop`.'

import copy, random
from solution import count_vowels as LEARNER
def ref(w):
    return sum(1 for c in w.lower() if c in 'aeiou')

def gen(r):
    return [''.join(r.choice('abcdeEIOUxyz ') for _ in range(r.randint(0, 15)))]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "count_vowels%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def count_vowels(word):
    count = 0
    for letter in word.lower():
        if letter in "aeiou":
            count += 1
    return count
```
wrong: ignores capitals
```python
def count_vowels(word):
    count = 0
    for letter in word:
        if letter in "aeiou":
            count += 1
    return count
```
hint: `for letter in word:` goes through the text one character at a time.
:::

## Building text in a loop
id: progress-bar
stage: loops
needs: loop-string
minutes: 5
goal: The loading screen shows a bar.
source: Python tutorial: for statements | https://docs.python.org/3/tutorial/controlflow.html#for-statements

### Assignment

Write `progress_bar(done, total)` that returns a 10-character bar in brackets: one `#` per tenth done, and `-` for the rest. `progress_bar(3, 10)` is `"[###-------]"`. Round down.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def progress_bar(done, total):
    return "[----------]"
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import progress_bar

def test_values():
    assert progress_bar(3, 10) == "[###-------]"
    assert progress_bar(0, 5) == "[----------]"
    assert progress_bar(5, 5) == "[##########]"
    assert progress_bar(1, 3) == "[###-------]"

import copy, random
from solution import progress_bar as LEARNER
def ref(d, t):
    f = d * 10 // t
    return '[' + '#' * f + '-' * (10 - f) + ']'

def gen(r):
    t = r.randint(1, 50)
    return [r.randint(0, t), t]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "progress_bar%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def progress_bar(done, total):
    filled = done * 10 // total
    bar = ""
    for i in range(10):
        bar += "#" if i < filled else "-"
    return "[" + bar + "]"
```
wrong: rounds to nearest
```python
def progress_bar(done, total):
    filled = round(done * 10 / total)
    return "[" + "#" * filled + "-" * (10 - filled) + "]"
```
hint: Work out how many `#` with `done * 10 // total`, then build the 10 characters.
:::

## Nested loops
id: nested
stage: loops
needs: progress-bar
minutes: 5
goal: The dungeon map is drawn row by row.
source: Python tutorial: for statements | https://docs.python.org/3/tutorial/controlflow.html#for-statements

### Assignment

Use two `for` loops (one inside the other) to draw a 3 by 4 room, so the console shows:

```text
####
####
####
```

Print one character at a time with `print("#", end="")`, and finish each row with `print()`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
print("####")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '####\n####\n####'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_two_loops():
    loops = [n for n in NODES if isinstance(n, ast.For)]
    assert any(isinstance(inner, ast.For) for outer in loops for inner in ast.walk(outer) if inner is not outer), "Put one for loop inside another"

def test_code_0():
    assert keyword_arg('end'), 'Print one character at a time with `end=""`.'
```
solution:
```python
for row in range(3):
    for col in range(4):
        print("#", end="")
    print()
```
wrong: three prints
```python
print("####")
print("####")
print("####")
```
wrong: one loop with whole rows
```python
for row in range(3):
    print("#" * 4, end="")
    print()
```
hint: The inner loop prints a row of `#` without a newline. After it, `print()` ends the row.
:::

## Changing case
id: upper-lower
stage: strings
needs: nested
minutes: 5
goal: The war cry must be shouted.
source: Python docs: String methods | https://docs.python.org/3/library/stdtypes.html#string-methods

### Assignment

Write `war_cry(text)` that returns the text in capitals with an exclamation mark at the end: `war_cry("for the king")` is `"FOR THE KING!"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def war_cry(text):
    return text
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import war_cry

def test_values():
    assert war_cry("for the king") == "FOR THE KING!"
    assert war_cry("") == "!"

import copy, random
from solution import war_cry as LEARNER
def ref(t):
    return t.upper() + '!'

def gen(r):
    return [''.join(r.choice('abc XYZ') for _ in range(r.randint(0, 12)))]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "war_cry%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def war_cry(text):
    return text.upper() + "!"
```
wrong: title case
```python
def war_cry(text):
    return text.title() + "!"
```
hint: `text.upper()` returns a capitalised copy.
:::

## Cleaning up input
id: strip
stage: strings
needs: upper-lower
minutes: 5
goal: Players type their names with stray spaces and odd capitals.
source: Python docs: String methods | https://docs.python.org/3/library/stdtypes.html#string-methods

### Assignment

Write `clean_name(raw)` that removes spaces from both ends and capitalises it like a name: `clean_name("  mIRA ")` is `"Mira"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def clean_name(raw):
    return raw
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import clean_name

def test_values():
    assert clean_name("  mIRA ") == "Mira"
    assert clean_name("sam") == "Sam"
    assert clean_name("BRAN") == "Bran"
```
solution:
```python
def clean_name(raw):
    return raw.strip().capitalize()
```
wrong: only strips
```python
def clean_name(raw):
    return raw.strip()
```
wrong: capitalises before stripping
```python
def clean_name(raw):
    return raw.capitalize().strip()
```
hint: `.strip()` removes the spaces at the ends; `.capitalize()` makes the first letter upper case and the rest lower.
:::

## Splitting commands
id: split
stage: strings
needs: strip
minutes: 5
goal: The text adventure reads commands like `go north`.
source: Python docs: String methods | https://docs.python.org/3/library/stdtypes.html#string-methods

### Assignment

Write `parse_command(line)` that returns a pair `(verb, rest)`: the first word in lower case, and everything after it (or `""` when there's nothing). `parse_command("Take golden key")` is `("take", "golden key")`. Extra spaces around the line don't matter.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def parse_command(line):
    return line, ""
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import parse_command

def test_values():
    assert parse_command("go north") == ("go", "north")
    assert parse_command("Take golden key") == ("take", "golden key")
    assert parse_command("look") == ("look", "")
    assert parse_command("  LOOK  ") == ("look", "")
```
solution:
```python
def parse_command(line):
    parts = line.strip().split(" ", 1)
    verb = parts[0].lower()
    rest = parts[1].strip() if len(parts) > 1 else ""
    return verb, rest
```
wrong: splits every word
```python
def parse_command(line):
    words = line.split()
    return words[0].lower(), words[1] if len(words) > 1 else ""
```
hint: `line.strip().split(" ", 1)` splits at the first space only.
:::

## Joining a list
id: join
stage: strings
needs: split
minutes: 5
goal: The bard lists the party.
source: Python docs: String methods | https://docs.python.org/3/library/stdtypes.html#string-methods

### Assignment

Write `party_line(names)` that returns the names joined with `", "`, except the last two are joined with `" and "`: `["Sam", "Mira", "Bran"]` gives `"Sam, Mira and Bran"`. One name is just that name; no names is `""`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def party_line(names):
    return str(names)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import party_line

def test_values():
    assert party_line(["Sam", "Mira", "Bran"]) == "Sam, Mira and Bran"
    assert party_line(["Sam", "Mira"]) == "Sam and Mira"
    assert party_line(["Sam"]) == "Sam"
    assert party_line([]) == ""

def test_code_0():
    assert calls('join'), 'Call `join()` in your code.'
```
solution:
```python
def party_line(names):
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]
```
wrong: commas everywhere
```python
def party_line(names):
    return ", ".join(names)
```
hint: `", ".join(names[:-1])` joins all but the last.
:::

## Slicing text
id: string-slices
stage: strings
needs: join
minutes: 5
goal: Every hero signs with their initials.
source: Python tutorial: Text | https://docs.python.org/3/tutorial/introduction.html#text

### Assignment

Write `initials(full_name)` that returns the first letter of each word, in capitals, joined with dots and ending with a dot: `initials("sam the brave")` is `"S.T.B."`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def initials(full_name):
    return full_name
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import initials

def test_values():
    assert initials("sam the brave") == "S.T.B."
    assert initials("Mira") == "M."
    assert initials("  bran   stark ") == "B.S."
```
solution:
```python
def initials(full_name):
    return "".join(word[0].upper() + "." for word in full_name.split())
```
wrong: only the first word
```python
def initials(full_name):
    return full_name[0].upper() + "."
```
hint: Split into words, take `word[0]` of each, and join.
:::

## Formatting numbers
id: format-spec
stage: strings
needs: string-slices
minutes: 5
goal: The shop's price list lines up in columns.
source: Python docs: Format specification mini-language | https://docs.python.org/3/library/string.html#format-specification-mini-language

### Assignment

Write `price_line(item, price)` that returns the item name padded to 12 characters on the left, then the price with two decimals, right-aligned in 8 characters: `price_line("potion", 4.5)` is `"potion          4.50"`. Use an f-string format spec like `{item:<12}`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def price_line(item, price):
    return f"{item} {price}"
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import price_line

def test_values():
    assert price_line("potion", 4.5) == "potion          4.50"
    assert price_line("sword", 120) == "sword         120.00"
    assert len(price_line("x", 1)) == 20

def test_code_0():
    assert has_node('JoinedStr'), 'Your code needs a `f-string`.'

import copy, random
from solution import price_line as LEARNER
def ref(i, p):
    return f'{i:<12}{p:>8.2f}'

def gen(r):
    return [r.choice(['axe', 'bow', 'map', 'rope']), r.randint(0, 99999) / 100]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "price_line%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def price_line(item, price):
    return f"{item:<12}{price:>8.2f}"
```
wrong: no decimals
```python
def price_line(item, price):
    return f"{item:<12}{price:>8}"
```
hint: `{item:<12}` pads to 12 on the right of the text; `{price:>8.2f}` gives 2 decimals in 8 characters.
:::

## Replacing text
id: replace
stage: strings
needs: format-spec
minutes: 5
goal: The royal censor hides the dragon's true name.
source: Python docs: String methods | https://docs.python.org/3/library/stdtypes.html#string-methods

### Assignment

Write `censor(text, word)` that replaces every `word` in `text` with as many `*` as the word has letters: `censor("Smaug is near, Smaug!", "Smaug")` is `"***** is near, *****!"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def censor(text, word):
    return text
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import censor

def test_values():
    assert censor("Smaug is near, Smaug!", "Smaug") == "***** is near, *****!"
    assert censor("all clear", "orc") == "all clear"
    assert censor("the orc and the orc king", "orc") == "the *** and the *** king"

def test_code_0():
    assert calls('replace'), 'Call `replace()` in your code.'
```
solution:
```python
def censor(text, word):
    return text.replace(word, "*" * len(word))
```
wrong: only the first one
```python
def censor(text, word):
    return text.replace(word, "*" * len(word), 1)
```
wrong: always five stars
```python
def censor(text, word):
    return text.replace(word, "*****")
```
hint: `text.replace(old, new)`, and `"*" * len(word)` makes the stars.
:::

## Searching text
id: find-in
stage: strings
needs: replace
minutes: 5
goal: The scouts' reports mention dragons in all sorts of ways.
source: Python docs: String methods | https://docs.python.org/3/library/stdtypes.html#string-methods

### Assignment

Write `mentions(report, word)` that returns `True` when `word` appears anywhere in `report`, ignoring upper and lower case.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def mentions(report, word):
    return word in report
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import mentions

def test_values():
    assert mentions("A DRAGON was seen", "dragon") is True
    assert mentions("All quiet", "dragon") is False
    assert mentions("dragons!", "Dragon") is True
```
solution:
```python
def mentions(report, word):
    return word.lower() in report.lower()
```
wrong: lowers only the report
```python
def mentions(report, word):
    return word in report.lower()
```
hint: Lower both, then use `in`.
:::

## Counting words
id: count-words
stage: strings
needs: find-in
minutes: 5
goal: The scribe is paid per word.
source: Python docs: String methods | https://docs.python.org/3/library/stdtypes.html#string-methods

### Assignment

Write `scribe_fee(text, rate)` that returns the number of words in `text` times `rate`. Words are separated by any amount of whitespace.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def scribe_fee(text, rate):
    return len(text) * rate
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import scribe_fee

def test_values():
    assert scribe_fee("the dragon sleeps", 2) == 6
    assert scribe_fee("  lots   of\n space ", 1) == 3
    assert scribe_fee("", 5) == 0
```
solution:
```python
def scribe_fee(text, rate):
    return len(text.split()) * rate
```
wrong: splits on single spaces
```python
def scribe_fee(text, rate):
    return len(text.split(" ")) * rate
```
hint: `text.split()` with no argument splits on any whitespace and drops empty pieces.
:::

## Indexing
id: index
stage: lists
needs: count-words
minutes: 5
goal: Sam checks the first and last item in the bag.
source: Python tutorial: Lists | https://docs.python.org/3/tutorial/introduction.html#lists

### Assignment

Write `ends(bag)` that returns the first and last items as a pair.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def ends(bag):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import ends

def test_values():
    assert ends(["sword", "shield", "potion"]) == ("sword", "potion")
    assert ends(["lamp"]) == ("lamp", "lamp")

import copy, random
from solution import ends as LEARNER
def ref(b):
    return b[0], b[-1]

def gen(r):
    return [[r.randint(0, 99) for _ in range(r.randint(1, 9))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "ends%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def ends(bag):
    return bag[0], bag[-1]
```
wrong: second instead of first
```python
def ends(bag):
    return bag[1] if len(bag) > 1 else bag[0], bag[-1]
```
hint: `bag[0]` is the first item, `bag[-1]` is the last.
:::

## Adding and removing
id: append-remove
stage: lists
needs: index
minutes: 5
goal: Sam picks up a shield and a potion, and drops the sword.
source: Python tutorial: More on lists | https://docs.python.org/3/tutorial/datastructures.html#more-on-lists

### Assignment

Use `append` and `remove` on `inventory` so the console shows:

```text
['shield', 'potion']
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
inventory = ["sword"]

# Change inventory here

# Don't touch below this line
print(inventory)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "['shield', 'potion']"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(inventory)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert calls('append'), 'Call `append()` in your code.'

def test_code_1():
    assert calls('remove'), 'Call `remove()` in your code.'
```
solution:
```python
inventory = ["sword"]

inventory.append("shield")
inventory.append("potion")
inventory.remove("sword")

# Don't touch below this line
print(inventory)
```
wrong: builds a new list
```python
inventory = ["sword"]

inventory = ["shield", "potion"]

# Don't touch below this line
print(inventory)
```
hint: `inventory.append("shield")` adds to the end; `inventory.remove("sword")` takes it out.
:::

## Finding an item
id: find-slot
stage: lists
needs: append-remove
minutes: 5
goal: Which slot holds the key?
source: Python tutorial: More on lists | https://docs.python.org/3/tutorial/datastructures.html#more-on-lists

### Assignment

Write `find_slot(bag, item)` that returns the index of `item` in `bag`, or `-1` when it isn't there.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def find_slot(bag, item):
    return bag.index(item)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import find_slot

def test_values():
    assert find_slot(["sword", "key", "map"], "key") == 1
    assert find_slot(["sword"], "key") == -1
    assert find_slot([], "key") == -1
    assert find_slot(["key", "key"], "key") == 0

import copy, random
from solution import find_slot as LEARNER
def ref(b, i):
    return b.index(i) if i in b else -1

def gen(r):
    w = ['sword', 'shield', 'potion', 'gem', 'map', 'rope', 'torch', 'axe']
    return [[r.choice(w) for _ in range(r.randint(0, 6))], r.choice(w)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "find_slot%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def find_slot(bag, item):
    if item in bag:
        return bag.index(item)
    return -1
```
wrong: the last match instead of the first
```python
def find_slot(bag, item):
    for i in range(len(bag) - 1, -1, -1):
        if bag[i] == item:
            return i
    return -1
```
hint: Check `item in bag` before calling `bag.index(item)`, which raises an error when the item is missing.
:::

## Slicing
id: slices
stage: lists
needs: find-slot
minutes: 5
goal: The scouts report the middle of the road.
source: Python tutorial: Lists | https://docs.python.org/3/tutorial/introduction.html#lists

### Assignment

Write `middle(items)` that returns a list without the first and last items. Use a slice.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def middle(items):
    return items
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import middle

def test_values():
    assert middle([1, 2, 3, 4, 5]) == [2, 3, 4]
    assert middle([1, 2]) == []
    assert middle([]) == []

def test_code_0():
    assert has_node('Slice'), 'Your code needs a `slice like `[1:3]``.'

import copy, random
from solution import middle as LEARNER
def ref(i):
    return i[1:-1]

def gen(r):
    return [[r.randint(0, 9) for _ in range(r.randint(0, 9))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "middle%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def middle(items):
    return items[1:-1]
```
wrong: drops only the first
```python
def middle(items):
    return items[1:]
```
hint: `items[1:-1]` starts at index 1 and stops before the last item.
:::

## len, sum and max
id: len-sum-max
stage: lists
needs: slices
minutes: 5
goal: The captain wants a report on the party's hits.
source: Python tutorial: More on lists | https://docs.python.org/3/tutorial/datastructures.html#more-on-lists

### Assignment

Write `hit_report(damages)` that returns a tuple of how many hits there were, the total damage, and the biggest hit.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def hit_report(damages):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import hit_report

def test_values():
    assert hit_report([5, 12, 3]) == (3, 20, 12)
    assert hit_report([9]) == (1, 9, 9)

import copy, random
from solution import hit_report as LEARNER
def ref(d):
    return len(d), sum(d), max(d)

def gen(r):
    return [[r.randint(0, 99) for _ in range(r.randint(1, 9))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "hit_report%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def hit_report(damages):
    return len(damages), sum(damages), max(damages)
```
wrong: the last hit instead of the biggest
```python
def hit_report(damages):
    return len(damages), sum(damages), damages[-1]
```
hint: `len`, `sum` and `max` all take the list.
:::

## enumerate
id: enumerate
stage: lists
needs: len-sum-max
minutes: 5
goal: The inventory screen numbers every line.
source: Python tutorial: Looping techniques | https://docs.python.org/3/tutorial/datastructures.html#looping-techniques

### Assignment

Write `numbered(items)` that returns a list of strings like `"1. sword"`, counting from 1. Use `enumerate`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def numbered(items):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import numbered

def test_values():
    assert numbered(["sword", "shield"]) == ["1. sword", "2. shield"]
    assert numbered([]) == []

def test_code_0():
    assert calls('enumerate'), 'Call `enumerate()` in your code.'
```
solution:
```python
def numbered(items):
    lines = []
    for number, item in enumerate(items, start=1):
        lines.append(f"{number}. {item}")
    return lines
```
wrong: counts from 0
```python
def numbered(items):
    return [f"{n}. {item}" for n, item in enumerate(items)]
```
hint: `enumerate(items, start=1)` gives `(1, first)`, `(2, second)`, and so on.
:::

## Pairing lists with zip
id: zip
stage: lists
needs: enumerate
minutes: 5
goal: Each hero gets the weapon in the same position.
source: Python tutorial: Looping techniques | https://docs.python.org/3/tutorial/datastructures.html#looping-techniques

### Assignment

Write `arm(heroes, weapons)` that returns strings like `"Sam: sword"`, pairing the lists position by position with `zip`. If one list is longer, the extras are ignored.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def arm(heroes, weapons):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import arm

def test_values():
    assert arm(["Sam", "Mira"], ["sword", "bow"]) == ["Sam: sword", "Mira: bow"]
    assert arm(["Sam", "Mira", "Bran"], ["axe"]) == ["Sam: axe"]
    assert arm([], ["axe"]) == []

def test_code_0():
    assert calls('zip'), 'Call `zip()` in your code.'
```
solution:
```python
def arm(heroes, weapons):
    return [f"{hero}: {weapon}" for hero, weapon in zip(heroes, weapons)]
```
wrong: every hero with every weapon
```python
def arm(heroes, weapons):
    return [f"{h}: {w}" for h in heroes for w in weapons]
```
hint: `for hero, weapon in zip(heroes, weapons):`
:::

## List comprehensions
id: comprehension
stage: lists
needs: zip
minutes: 5
goal: Only the big hits make the bard's song.
source: Python tutorial: List comprehensions | https://docs.python.org/3/tutorial/datastructures.html#list-comprehensions

### Assignment

Write `big_hits(damages)` that returns the damages that are 10 or more, using a list comprehension.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def big_hits(damages):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import big_hits

def test_values():
    assert big_hits([3, 10, 25, 9]) == [10, 25]
    assert big_hits([]) == []

def test_code_0():
    assert has_node('ListComp'), 'Your code needs a `list comprehension`.'

import copy, random
from solution import big_hits as LEARNER
def ref(d):
    return [x for x in d if x >= 10]

def gen(r):
    return [[r.randint(0, 20) for _ in range(r.randint(0, 10))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "big_hits%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def big_hits(damages):
    return [d for d in damages if d >= 10]
```
wrong: a loop instead of a comprehension
```python
def big_hits(damages):
    out = []
    for d in damages:
        if d >= 10:
            out.append(d)
    return out
```
wrong: over 10 instead of 10 or more
```python
def big_hits(damages):
    return [d for d in damages if d > 10]
```
hint: `[d for d in damages if d >= 10]`
:::

## Transforming with a comprehension
id: map-comp
stage: lists
needs: comprehension
minutes: 5
goal: The blacksmith sharpens every blade by 3.
source: Python tutorial: List comprehensions | https://docs.python.org/3/tutorial/datastructures.html#list-comprehensions

### Assignment

Write `sharpen(damages)` that returns a new list with 3 added to every damage, using a list comprehension. Don't change the list passed in.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def sharpen(damages):
    for i in range(len(damages)):
        damages[i] += 3
    return damages
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import sharpen

def test_values():
    assert sharpen([1, 10]) == [4, 13]
    assert sharpen([]) == []

def test_leaves_input_alone():
    blades = [5, 6]
    sharpen(blades)
    assert blades == [5, 6], "sharpen changed the list it was given"

def test_code_0():
    assert has_node('ListComp'), 'Your code needs a `list comprehension`.'
```
solution:
```python
def sharpen(damages):
    return [d + 3 for d in damages]
```
wrong: changes the input too
```python
def sharpen(damages):
    damages[:] = [d + 3 for d in damages]
    return damages
```
hint: `[d + 3 for d in damages]` builds a new list.
:::

## Sorting
id: sorting
stage: lists
needs: map-comp
minutes: 5
goal: The leaderboard shows the three best scores.
source: Python HOWTO: Sorting | https://docs.python.org/3/howto/sorting.html

### Assignment

Write `top_three(scores)` that returns the three highest scores, highest first. Don't change the list that was passed in.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def top_three(scores):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import top_three

def test_values():
    assert top_three([5, 90, 12, 40, 7]) == [90, 40, 12]
    assert top_three([3, 1]) == [3, 1]

def test_does_not_change_input():
    scores = [5, 90, 12, 40]
    top_three(scores)
    assert scores == [5, 90, 12, 40], "top_three changed the list it was given"

import copy, random
from solution import top_three as LEARNER
def ref(s):
    return sorted(s, reverse=True)[:3]

def gen(r):
    return [[r.randint(0, 100) for _ in range(r.randint(0, 9))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "top_three%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def top_three(scores):
    return sorted(scores, reverse=True)[:3]
```
wrong: sorts the caller's list
```python
def top_three(scores):
    scores.sort(reverse=True)
    return scores[:3]
```
hint: `sorted(scores, reverse=True)` gives a new list, highest first. Then slice `[:3]`.
:::

## Sorting by a key
id: sort-key
stage: lists
needs: sorting
minutes: 5
goal: The roster is ordered by level, then by name.
source: Python HOWTO: Sorting | https://docs.python.org/3/howto/sorting.html

### Assignment

`heroes` is a list of `(name, level)` pairs. Write `roster(heroes)` that returns them sorted by level, highest first, and by name A to Z when levels tie. Use `sorted` with a `key`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def roster(heroes):
    return sorted(heroes)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import roster

def test_values():
    assert roster([("Sam", 3), ("Mira", 7), ("Bran", 3)]) == [("Mira", 7), ("Bran", 3), ("Sam", 3)]
    assert roster([]) == []

def test_code_0():
    assert keyword_arg('key'), 'Pass `key=` to sorted.'

import copy, random
from solution import roster as LEARNER
def ref(h):
    return sorted(h, key=lambda x: (-x[1], x[0]))

def gen(r):
    return [[(r.choice(['Sam', 'Mira', 'Bran', 'Ada', 'Zed']), r.randint(1, 5)) for _ in range(r.randint(0, 7))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "roster%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def roster(heroes):
    return sorted(heroes, key=lambda h: (-h[1], h[0]))
```
wrong: ties in reverse name order
```python
def roster(heroes):
    return sorted(heroes, key=lambda h: (h[1], h[0]), reverse=True)
```
hint: `key=lambda h: (-h[1], h[0])` sorts by level going down, then by name.
:::

## Two names, one list
id: aliasing
stage: lists
needs: sort-key
minutes: 5
goal: Sam kept a backup of the bag, but the backup changed too.
source: Python docs: copy | https://docs.python.org/3/library/copy.html

### Assignment

`backup = bag` doesn't copy the list: both names point at the same list. Make `backup` a real copy so the console shows:

```text
['sword', 'map']
['sword', 'map', 'cursed ring']
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
bag = ["sword", "map"]
backup = bag

# Don't touch below this line
bag.append("cursed ring")
print(backup)
print(bag)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "['sword', 'map']\n['sword', 'map', 'cursed ring']"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'bag.append("cursed ring")\nprint(backup)\nprint(bag)', "The code under # Don't touch below this line must stay as it was"
```
solution:
```python
bag = ["sword", "map"]
backup = bag.copy()

# Don't touch below this line
bag.append("cursed ring")
print(backup)
print(bag)
```
wrong: retypes the backup
```python
bag = ["sword", "map"]
backup = ["sword", "map"]
backup = bag

# Don't touch below this line
bag.append("cursed ring")
print(backup)
print(bag)
```
hint: `bag.copy()` (or `bag[:]` or `list(bag)`) makes a new list with the same items.
:::

## Lists of lists
id: grid
stage: lists
needs: aliasing
minutes: 5
goal: The dungeon map is a grid: `#` is wall, `.` is floor.
source: Python tutorial: Nested list comprehensions | https://docs.python.org/3/tutorial/datastructures.html#nested-list-comprehensions

### Assignment

Write `count_walls(grid)` that returns how many `"#"` cells there are in a list of rows, where each row is a list of one-character strings.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def count_walls(grid):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import count_walls

def test_values():
    grid = [["#", "#", "#"], ["#", ".", "#"], ["#", "#", "#"]]
    assert count_walls(grid) == 8
    assert count_walls([]) == 0
    assert count_walls([[".", "."]]) == 0

import copy, random
from solution import count_walls as LEARNER
def ref(g):
    return sum(row.count('#') for row in g)

def gen(r):
    w = r.randint(0, 6)
    return [[[r.choice('#.') for _ in range(w)] for _ in range(r.randint(0, 6))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "count_walls%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def count_walls(grid):
    walls = 0
    for row in grid:
        for cell in row:
            if cell == "#":
                walls += 1
    return walls
```
wrong: counts only the first row
```python
def count_walls(grid):
    return grid[0].count("#") if grid else 0
```
hint: Loop over the rows, and inside that over the cells of each row.
:::

## Taking turns
id: queue
stage: lists
needs: grid
minutes: 5
goal: In battle, whoever acts goes to the back of the line.
source: Python tutorial: More on lists | https://docs.python.org/3/tutorial/datastructures.html#more-on-lists

### Assignment

Write `next_turn(order)` that removes the first name from the list `order`, puts it at the end, and returns it. It changes `order` in place.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def next_turn(order):
    return order[0]
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
def next_turn(order):
    who = order.pop(0)
    order.append(who)
    return who
```
wrong: returns a new list instead of changing it
```python
def next_turn(order):
    who = order[0]
    order = order[1:] + [who]
    return who
```
hint: `order.pop(0)` removes and returns the first item; `append` puts it at the end.
:::

## Creating dictionaries
id: create
stage: dicts
needs: queue
minutes: 5
goal: Every hero has a sheet.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries

### Assignment

Create a dictionary named `hero` with the keys `"name"` (value `"Sam"`) and `"level"` (value `3`). The code below prints them:

```text
Sam 3
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
# create hero here

# Don't touch below this line
print(hero["name"], hero["level"])
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam 3'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_level_is_a_number():
    import solution
    assert solution.hero["level"] == 3, "level should be the number 3, not text"

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(hero["name"], hero["level"])', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_node('Dict'), 'Your code needs a `Dict`.'
```
solution:
```python
hero = {"name": "Sam", "level": 3}

# Don't touch below this line
print(hero["name"], hero["level"])
```
wrong: level as text
```python
hero = {"name": "Sam", "level": "3"}

# Don't touch below this line
print(hero["name"], hero["level"])
```
hint: `{"key": value, "other": value}`
:::

## Missing keys
id: get
stage: dicts
needs: create
minutes: 5
goal: The bank checks what a hero owns.
source: Python docs: Mapping types (dict) | https://docs.python.org/3/library/stdtypes.html#mapping-types-dict

### Assignment

Write `gold_of(wallets, who)` that returns the gold stored under `who` in `wallets`, or `0` when `who` isn't in there. It must not raise a `KeyError`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def gold_of(wallets, who):
    return wallets[who]
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import gold_of

def test_values():
    wallets = {"Sam": 120, "Mira": 40, "Zed": 0}
    assert gold_of(wallets, "Sam") == 120
    assert gold_of(wallets, "Bran") == 0
    assert gold_of(wallets, "Zed") == 0
    assert gold_of({}, "Sam") == 0
```
solution:
```python
def gold_of(wallets, who):
    return wallets.get(who, 0)
```
wrong: returns None for a missing key
```python
def gold_of(wallets, who):
    return wallets.get(who)
```
hint: `wallets.get(who, 0)` returns 0 when the key is missing.
:::

## Adding and deleting keys
id: add-delete
stage: dicts
needs: get
minutes: 5
goal: Sam spends his arrows and finds a rope.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries

### Assignment

Change `bag` so it ends up as `{'torch': 2, 'rope': 1}`: remove the `"arrows"` entry and add `"rope"` with the value 1.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
bag = {"torch": 2, "arrows": 10}

# Change bag here

# Don't touch below this line
print(bag)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "{'torch': 2, 'rope': 1}"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(bag)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_node('Delete'), 'Remove the key with `del bag["arrows"]`.'
```
solution:
```python
bag = {"torch": 2, "arrows": 10}

del bag["arrows"]
bag["rope"] = 1

# Don't touch below this line
print(bag)
```
wrong: rebuilds the dictionary
```python
bag = {"torch": 2, "arrows": 10}

bag = {"torch": 2, "rope": 1}

# Don't touch below this line
print(bag)
```
hint: `bag["rope"] = 1` adds a key. `del bag["arrows"]` removes one.
:::

## Looping over a dictionary
id: items
stage: dicts
needs: add-delete
minutes: 5
goal: The quartermaster reads the bag aloud.
source: Python tutorial: Looping techniques | https://docs.python.org/3/tutorial/datastructures.html#looping-techniques

### Assignment

Write `bag_lines(bag)` that returns a list of strings like `"torch: 2"`, one per entry, in the dictionary's order. Use `.items()`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def bag_lines(bag):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import bag_lines

def test_values():
    assert bag_lines({"torch": 2, "rope": 1}) == ["torch: 2", "rope: 1"]
    assert bag_lines({}) == []

def test_code_0():
    assert calls('items'), 'Call `items()` in your code.'
```
solution:
```python
def bag_lines(bag):
    lines = []
    for name, count in bag.items():
        lines.append(f"{name}: {count}")
    return lines
```
wrong: sorted instead of in order
```python
def bag_lines(bag):
    return [f"{k}: {v}" for k, v in sorted(bag.items())]
```
hint: `for name, count in bag.items():`
:::

## Counting with a dictionary
id: counting
stage: dicts
needs: items
minutes: 5
goal: How many of each drop did the monsters leave?
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries

### Assignment

Write `count_loot(drops)` that returns a dictionary of how many times each item appears in the list `drops`. Build it with a loop (don't import anything).

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def count_loot(drops):
    return {}
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import count_loot

def test_values():
    assert count_loot(["gem", "gold", "gem", "gem"]) == {"gem": 3, "gold": 1}
    assert count_loot([]) == {}

def test_code_0():
    assert not has_node('Import'), "Don't use a `Import` here."

def test_code_1():
    assert not has_node('ImportFrom'), "Don't use a `ImportFrom` here."

import copy, random
from solution import count_loot as LEARNER
def ref(d):
    out = {}
    for x in d:
        out[x] = out.get(x, 0) + 1
    return out

def gen(r):
    return [[r.choice(['sword', 'shield', 'potion', 'gem', 'map', 'rope', 'torch', 'axe']) for _ in range(r.randint(0, 12))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "count_loot%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def count_loot(drops):
    counts = {}
    for item in drops:
        counts[item] = counts.get(item, 0) + 1
    return counts
```
wrong: uses Counter
```python
from collections import Counter

def count_loot(drops):
    return dict(Counter(drops))
```
wrong: marks presence, not count
```python
def count_loot(drops):
    return {item: 1 for item in drops}
```
hint: For each item: `counts[item] = counts.get(item, 0) + 1`.
:::

## Dictionary comprehensions
id: dict-comp
stage: dicts
needs: counting
minutes: 5
goal: The king raises every price by 10%.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries

### Assignment

Write `with_tax(prices)` that returns a new dictionary with every price multiplied by 1.1 and rounded to 2 decimals, using a dict comprehension.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def with_tax(prices):
    return prices
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import with_tax

def test_values():
    assert with_tax({"potion": 10, "sword": 80}) == {"potion": 11.0, "sword": 88.0}
    assert with_tax({}) == {}

def test_new_dict():
    prices = {"rope": 5}
    with_tax(prices)
    assert prices == {"rope": 5}, "with_tax changed the dictionary it was given"

def test_code_0():
    assert has_node('DictComp'), 'Your code needs a `dict comprehension`.'
```
solution:
```python
def with_tax(prices):
    return {item: round(price * 1.1, 2) for item, price in prices.items()}
```
wrong: changes the prices in place
```python
def with_tax(prices):
    for k in prices:
        prices[k] = round(prices[k] * 1.1, 2)
    return {k: v for k, v in prices.items()}
```
hint: `{key: value for key, value in prices.items()}`
:::

## Sorting a dictionary
id: leaderboard
stage: dicts
needs: dict-comp
minutes: 5
goal: The arena keeps scores by name.
source: Python HOWTO: Sorting | https://docs.python.org/3/howto/sorting.html

### Assignment

Write `leaderboard(scores)` that returns the names, highest score first, and A to Z when scores tie.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def leaderboard(scores):
    return list(scores)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import leaderboard

def test_values():
    assert leaderboard({"Sam": 30, "Mira": 50, "Bran": 30}) == ["Mira", "Bran", "Sam"]
    assert leaderboard({}) == []

import copy, random
from solution import leaderboard as LEARNER
def ref(s):
    return sorted(s, key=lambda n: (-s[n], n))

def gen(r):
    return [{n: r.randint(0, 5) for n in r.sample(['Sam', 'Mira', 'Bran', 'Ada', 'Zed', 'Ola'], r.randint(0, 6))}]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "leaderboard%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def leaderboard(scores):
    return sorted(scores, key=lambda name: (-scores[name], name))
```
wrong: sorted by name only
```python
def leaderboard(scores):
    return sorted(scores)
```
hint: Sort the names with `key=lambda name: (-scores[name], name)`.
:::

## Grouping
id: group
stage: dicts
needs: leaderboard
minutes: 5
goal: The guild sorts heroes by class.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries

### Assignment

`heroes` is a list of `(name, role)` pairs. Write `by_role(heroes)` that returns a dictionary from each role to the list of names with that role, in the order they appear.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def by_role(heroes):
    return {}
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import by_role

def test_values():
    heroes = [("Sam", "fighter"), ("Mira", "mage"), ("Bran", "fighter")]
    assert by_role(heroes) == {"fighter": ["Sam", "Bran"], "mage": ["Mira"]}
    assert by_role([]) == {}

import copy, random
from solution import by_role as LEARNER
def ref(h):
    g = {}
    for n, ro in h:
        g.setdefault(ro, []).append(n)
    return g

def gen(r):
    return [[(r.choice(['Sam', 'Mira', 'Bran', 'Ada']), r.choice(['mage', 'rogue', 'fighter'])) for _ in range(r.randint(0, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "by_role%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def by_role(heroes):
    groups = {}
    for name, role in heroes:
        groups.setdefault(role, []).append(name)
    return groups
```
wrong: keeps only the last name per role
```python
def by_role(heroes):
    return {role: [name] for name, role in heroes}
```
hint: `groups.setdefault(role, []).append(name)` makes the list the first time a role shows up.
:::

## Merging counts
id: merge
stage: dicts
needs: group
minutes: 5
goal: Two heroes empty their bags onto one table.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries

### Assignment

Write `merge_bags(a, b)` that returns a new dictionary with the counts from both bags added together. Don't change `a` or `b`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def merge_bags(a, b):
    a.update(b)
    return a
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import merge_bags

def test_values():
    assert merge_bags({"gem": 2, "rope": 1}, {"gem": 3, "torch": 4}) == {"gem": 5, "rope": 1, "torch": 4}
    assert merge_bags({}, {}) == {}

def test_inputs_unchanged():
    a, b = {"gem": 1}, {"gem": 2}
    merge_bags(a, b)
    assert a == {"gem": 1} and b == {"gem": 2}, "merge_bags changed a bag it was given"
```
solution:
```python
def merge_bags(a, b):
    total = dict(a)
    for item, count in b.items():
        total[item] = total.get(item, 0) + count
    return total
```
wrong: overwrites instead of adding
```python
def merge_bags(a, b):
    return {**a, **b}
```
hint: Start from a copy of `a`, then add each of `b`'s counts to it.
:::

## Dictionaries inside dictionaries
id: nested-dicts
stage: dicts
needs: merge
minutes: 5
goal: The whole party's health on one screen.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries

### Assignment

`party` maps each hero's name to their own dictionary, like `{"Sam": {"hp": 30}, "Mira": {"hp": 22}}`. Write `party_hp(party)` that returns the total of all the `"hp"` values.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def party_hp(party):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import party_hp

def test_values():
    assert party_hp({"Sam": {"hp": 30}, "Mira": {"hp": 22}}) == 52
    assert party_hp({"Sam": {"hp": 30, "mp": 99}}) == 30
    assert party_hp({}) == 0
```
solution:
```python
def party_hp(party):
    total = 0
    for hero in party.values():
        total += hero["hp"]
    return total
```
wrong: adds every stat
```python
def party_hp(party):
    return sum(sum(h.values()) for h in party.values())
```
hint: Loop over `party.values()`; each one is a dictionary with an `"hp"` key.
:::

## Removing duplicates
id: dedupe
stage: sets
needs: nested-dicts
minutes: 5
goal: The loot list has the same item many times.
source: Python tutorial: Sets | https://docs.python.org/3/tutorial/datastructures.html#sets

### Assignment

Write `unique_loot(items)` that returns the items with duplicates removed, as a sorted list.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def unique_loot(items):
    return items
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import unique_loot

def test_values():
    assert unique_loot(["gem", "gold", "gem", "map"]) == ["gem", "gold", "map"]
    assert unique_loot([]) == []

def test_code_0():
    assert calls('set'), 'Call `set()` in your code.'

import copy, random
from solution import unique_loot as LEARNER
def ref(i):
    return sorted(set(i))

def gen(r):
    return [[r.choice(['sword', 'shield', 'potion', 'gem', 'map', 'rope', 'torch', 'axe']) for _ in range(r.randint(0, 12))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "unique_loot%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def unique_loot(items):
    return sorted(set(items))
```
wrong: a set, not a sorted list
```python
def unique_loot(items):
    return set(items)
```
hint: `set(items)` keeps each value once. `sorted(...)` turns it back into an ordered list.
:::

## Remembering what you've seen
id: visited
stage: sets
needs: dedupe
minutes: 5
goal: Sam never searches the same room twice.
source: Python tutorial: Sets | https://docs.python.org/3/tutorial/datastructures.html#sets

### Assignment

Write `visit(visited, room)`. If `room` is new, add it to the set `visited` and return `True`. If Sam has been there already, return `False`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def visit(visited, room):
    return False
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import visit

def test_values():
    seen = set()
    assert visit(seen, "hall") is True
    assert visit(seen, "hall") is False
    assert visit(seen, "crypt") is True
    assert seen == {"hall", "crypt"}
```
solution:
```python
def visit(visited, room):
    if room in visited:
        return False
    visited.add(room)
    return True
```
wrong: adds but always says new
```python
def visit(visited, room):
    visited.add(room)
    return True
```
hint: Check with `in`, then call `visited.add(room)`.
:::

## Set operations
id: operations
stage: sets
needs: visited
minutes: 5
goal: Two scouts compare notes on the rooms they found.
source: Python tutorial: Sets | https://docs.python.org/3/tutorial/datastructures.html#sets

### Assignment

Write `compare(a, b)` that returns a pair of sorted lists: the rooms **both** scouts found, and the rooms **either** scout found. Use `&` and `|`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def compare(a, b):
    return [], []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import compare

def test_values():
    both, either = compare({"hall", "crypt"}, {"crypt", "tower"})
    assert both == ["crypt"]
    assert either == ["crypt", "hall", "tower"]

def test_disjoint():
    assert compare({"a"}, {"b"}) == ([], ["a", "b"])

def test_code_0():
    assert has_token('&'), 'Use `&` in your code.'

def test_code_1():
    assert has_token('|'), 'Use `|` in your code.'
```
solution:
```python
def compare(a, b):
    return sorted(a & b), sorted(a | b)
```
wrong: swapped
```python
def compare(a, b):
    return sorted(a | b), sorted(a & b)
```
hint: `a & b` is the overlap, `a | b` is everything.
:::

## What's missing
id: difference
stage: sets
needs: operations
minutes: 5
goal: The quest needs certain items.
source: Python docs: Set types | https://docs.python.org/3/library/stdtypes.html#set-types-set-frozenset

### Assignment

Write `still_needed(needed, have)` that returns, as a sorted list, the items in `needed` that aren't in `have`. Both are sets. Use `-`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def still_needed(needed, have):
    return sorted(needed)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import still_needed

def test_values():
    assert still_needed({"key", "map", "torch"}, {"map", "rope"}) == ["key", "torch"]
    assert still_needed({"key"}, {"key"}) == []

def test_code_0():
    assert has_token('-'), 'Use `-` in your code.'
```
solution:
```python
def still_needed(needed, have):
    return sorted(needed - have)
```
wrong: the other way round
```python
def still_needed(needed, have):
    return sorted(have - needed)
```
hint: `needed - have` keeps what is only in `needed`.
:::

## Subsets
id: subset
stage: sets
needs: difference
minutes: 5
goal: The blacksmith can only craft what the recipe allows.
source: Python docs: Set types | https://docs.python.org/3/library/stdtypes.html#set-types-set-frozenset

### Assignment

Write `can_craft(recipe, bag)` that returns `True` when every item in the set `recipe` is also in the set `bag`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def can_craft(recipe, bag):
    return len(recipe) <= len(bag)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import can_craft

def test_values():
    assert can_craft({"iron", "coal"}, {"iron", "coal", "wood"}) is True
    assert can_craft({"iron", "gold"}, {"iron", "coal", "wood"}) is False
    assert can_craft(set(), {"iron"}) is True
```
solution:
```python
def can_craft(recipe, bag):
    return recipe <= bag
```
wrong: any overlap counts
```python
def can_craft(recipe, bag):
    return bool(recipe & bag) or not recipe
```
hint: For sets, `recipe <= bag` means "every item of recipe is in bag".
:::

## Set comprehensions
id: set-comp
stage: sets
needs: subset
minutes: 5
goal: The herald wants to know which letters start the heroes' names.
source: Python tutorial: Sets | https://docs.python.org/3/tutorial/datastructures.html#sets

### Assignment

Write `first_letters(names)` that returns the set of first letters, upper case, using a set comprehension. Skip empty names.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def first_letters(names):
    return set()
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import first_letters

def test_values():
    assert first_letters(["sam", "Sara", "mira", ""]) == {"S", "M"}
    assert first_letters([]) == set()

def test_code_0():
    assert has_node('SetComp'), 'Your code needs a `set comprehension`.'
```
solution:
```python
def first_letters(names):
    return {name[0].upper() for name in names if name}
```
wrong: keeps the case
```python
def first_letters(names):
    return {name[0] for name in names if name}
```
hint: `{name[0].upper() for name in names if name}`
:::

## try and except
id: try-except
stage: errors
needs: set-comp
minutes: 5
goal: Player input is messy.
source: Python tutorial: Handling exceptions | https://docs.python.org/3/tutorial/errors.html#handling-exceptions

### Assignment

Write `safe_int(text, default=0)` that turns text into an `int`, or returns `default` when the text isn't a whole number.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def safe_int(text, default=0):
    return int(text)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import safe_int

def test_values():
    assert safe_int("42") == 42
    assert safe_int(" 7 ") == 7
    assert safe_int("nope") == 0
    assert safe_int("", default=-1) == -1

def test_code_0():
    assert has_node('Try'), 'Your code needs a `try block`.'
```
solution:
```python
def safe_int(text, default=0):
    try:
        return int(text)
    except ValueError:
        return default
```
wrong: only digits count
```python
def safe_int(text, default=0):
    try:
        return int(text) if text.isdigit() else default
    except ValueError:
        return default
```
hint: Put `int(text)` in a `try:` block and catch `ValueError`.
:::

## Raising errors
id: raise
stage: errors
needs: try-except
minutes: 5
goal: No hero starts below level 1.
source: Python tutorial: Raising exceptions | https://docs.python.org/3/tutorial/errors.html#raising-exceptions

### Assignment

Write `check_level(level)` that returns `level` when it is 1 or more, and raises a `ValueError` otherwise.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def check_level(level):
    return level
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert has_node('Raise'), 'Your code needs a `raise statement`.'
```
solution:
```python
def check_level(level):
    if level < 1:
        raise ValueError("level must be at least 1")
    return level
```
wrong: returns None instead of raising
```python
def check_level(level):
    if level < 1:
        return None
    return level
```
wrong: the wrong kind of error
```python
def check_level(level):
    if level < 1:
        raise TypeError("bad level")
    return level
```
hint: `raise ValueError("...")` stops the function with an error.
:::

## Catching the right error
id: specific
stage: errors
needs: raise
minutes: 5
goal: A slot number may point past the end of the bag.
source: Python tutorial: Handling exceptions | https://docs.python.org/3/tutorial/errors.html#handling-exceptions

### Assignment

Write `read_slot(bag, index)` that returns the item at `index`, or the text `"empty"` when the index is out of range. Catch `IndexError`, not every error.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def read_slot(bag, index):
    return bag[index]
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
def read_slot(bag, index):
    try:
        return bag[index]
    except IndexError:
        return "empty"
```
wrong: catches everything
```python
def read_slot(bag, index):
    try:
        return bag[index]
    except Exception:
        return "empty"
```
hint: `except IndexError:` only catches the out-of-range case.
:::

## Error messages
id: message
stage: errors
needs: specific
minutes: 5
goal: The shopkeeper explains why the sale failed.
source: Python tutorial: Raising exceptions | https://docs.python.org/3/tutorial/errors.html#raising-exceptions

### Assignment

Write `buy(gold, price)`. It returns the gold left after paying. If `price` is more than `gold`, raise a `ValueError` whose message is exactly `not enough gold`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def buy(gold, price):
    return gold - price
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
def buy(gold, price):
    if price > gold:
        raise ValueError("not enough gold")
    return gold - price
```
wrong: a different message
```python
def buy(gold, price):
    if price > gold:
        raise ValueError("Not enough gold!")
    return gold - price
```
hint: `raise ValueError("not enough gold")`
:::

## Cleaning up with finally
id: finally
stage: errors
needs: message
minutes: 5
goal: Whatever happens in a turn, the turn ends.
source: Python tutorial: Defining clean-up actions | https://docs.python.org/3/tutorial/errors.html#defining-clean-up-actions

### Assignment

Write `take_turn(log, action)`: it calls `action()` and returns its result, and **always** appends `"turn over"` to the list `log` afterwards, even when `action()` raises. Don't swallow the error: it must still reach the caller.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def take_turn(log, action):
    result = action()
    log.append("turn over")
    return result
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert has_node('Try'), 'Use try and finally.'
```
solution:
```python
def take_turn(log, action):
    try:
        return action()
    finally:
        log.append("turn over")
```
wrong: swallows the error
```python
def take_turn(log, action):
    try:
        return action()
    except Exception:
        return None
    finally:
        log.append("turn over")
```
hint: `try:` call the action, `finally:` append to the log.
:::

## Your own exception
id: custom
stage: errors
needs: finally
minutes: 5
goal: Spells fail for a reason the game wants to name.
source: Python tutorial: User-defined exceptions | https://docs.python.org/3/tutorial/errors.html#user-defined-exceptions

### Assignment

Define an exception class `NotEnoughMana` (a subclass of `Exception`), and write `cast(mana, cost)` that returns the mana left, or raises `NotEnoughMana` when `cost` is more than `mana`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def cast(mana, cost):
    if cost > mana:
        raise Exception("not enough mana")
    return mana - cost
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
class NotEnoughMana(Exception):
    pass

def cast(mana, cost):
    if cost > mana:
        raise NotEnoughMana(f"need {cost}, have {mana}")
    return mana - cost
```
wrong: defines the class but raises a plain Exception
```python
class NotEnoughMana(Exception):
    pass

def cast(mana, cost):
    if cost > mana:
        raise Exception("not enough mana")
    return mana - cost
```
hint: `class NotEnoughMana(Exception):` with `pass` as its body, then `raise NotEnoughMana(...)`.
:::

## Adding context to an error
id: reraise
stage: errors
needs: custom
minutes: 5
goal: A broken save file should say which line was bad.
source: Python tutorial: Exception chaining | https://docs.python.org/3/tutorial/errors.html#exception-chaining

### Assignment

Write `parse_level(line)` that returns `int(line)`. When that fails, raise a new `ValueError` whose message is `bad level: ` followed by the line in quotes, like `bad level: 'ten'`, chained to the original with `from`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def parse_level(line):
    return int(line)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
def parse_level(line):
    try:
        return int(line)
    except ValueError as err:
        raise ValueError(f"bad level: {line!r}") from err
```
wrong: no chaining
```python
def parse_level(line):
    try:
        return int(line)
    except ValueError:
        raise ValueError(f"bad level: {line!r}") from None
```
hint: `raise ValueError(f"bad level: {line!r}") from err` inside the `except` block.
:::

## Annotating functions
id: annotate
stage: hints
needs: reraise
minutes: 5
goal: The guild requires every function to say what it takes.
source: Python docs: typing | https://docs.python.org/3/library/typing.html

### Assignment

Add type hints to `heal`: `health` and `amount` are `int`, and it returns an `int`. The body stays as it is.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def heal(health, amount):
    return health + amount
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from typing import get_type_hints
from solution import heal

def test_hints():
    assert get_type_hints(heal) == {"health": int, "amount": int, "return": int}

def test_body():
    assert heal(10, 5) == 15
```
solution:
```python
def heal(health: int, amount: int) -> int:
    return health + amount
```
wrong: forgets the return type
```python
def heal(health: int, amount: int):
    return health + amount
```
hint: `def heal(health: int, amount: int) -> int:`
:::

## Hints for lists and dictionaries
id: collections
stage: hints
needs: annotate
minutes: 5
goal: Collections can say what they hold.
source: Python docs: typing | https://docs.python.org/3/library/typing.html

### Assignment

Annotate `total(values)` to take a `list[int]` and return an `int`, and `names_by_level(heroes)` to take a `dict[str, int]` and return a `list[str]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def total(values):
    return sum(values)

def names_by_level(heroes):
    return sorted(heroes, key=heroes.get)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from typing import get_type_hints
from solution import total, names_by_level

def test_total():
    assert get_type_hints(total) == {"values": list[int], "return": int}
    assert total([1, 2]) == 3

def test_names():
    assert get_type_hints(names_by_level) == {"heroes": dict[str, int], "return": list[str]}
    assert names_by_level({"Sam": 3, "Mira": 1}) == ["Mira", "Sam"]
```
solution:
```python
def total(values: list[int]) -> int:
    return sum(values)

def names_by_level(heroes: dict[str, int]) -> list[str]:
    return sorted(heroes, key=heroes.get)
```
wrong: bare list and dict
```python
def total(values: list) -> int:
    return sum(values)

def names_by_level(heroes: dict) -> list:
    return sorted(heroes, key=heroes.get)
```
hint: `list[int]` and `dict[str, int]` go right after the parameter name and colon.
:::

## Values that may be missing
id: optional
stage: hints
needs: collections
minutes: 5
goal: A search either finds a hero or doesn't.
source: Python docs: typing | https://docs.python.org/3/library/typing.html

### Assignment

`find_hero` returns the hero's level, or `None` when the name isn't there. Annotate it: `levels` is a `dict[str, int]`, `name` is a `str`, and the return type is `int | None`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def find_hero(levels, name):
    return levels.get(name)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from typing import get_type_hints
from solution import find_hero

def test_hints():
    assert get_type_hints(find_hero) == {"levels": dict[str, int], "name": str, "return": (int | None)}

def test_body():
    assert find_hero({"Sam": 3}, "Sam") == 3
    assert find_hero({"Sam": 3}, "Bran") is None
```
solution:
```python
def find_hero(levels: dict[str, int], name: str) -> int | None:
    return levels.get(name)
```
wrong: says it always returns an int
```python
def find_hero(levels: dict[str, int], name: str) -> int:
    return levels.get(name)
```
hint: A value that may be `None` is written `int | None`.
:::

## Hints for tuples
id: tuple-hint
stage: hints
needs: optional
minutes: 5
goal: Coordinates on the map are pairs.
source: Python docs: typing | https://docs.python.org/3/library/typing.html

### Assignment

Annotate `step(pos, dx, dy)`: `pos` is a `tuple[int, int]`, `dx` and `dy` are `int`, and it returns a `tuple[int, int]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def step(pos, dx, dy):
    return pos[0] + dx, pos[1] + dy
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from typing import get_type_hints
from solution import step

def test_hints():
    assert get_type_hints(step) == {"pos": tuple[int, int], "dx": int, "dy": int, "return": tuple[int, int]}

def test_body():
    assert step((1, 2), 3, -1) == (4, 1)
```
solution:
```python
def step(pos: tuple[int, int], dx: int, dy: int) -> tuple[int, int]:
    return pos[0] + dx, pos[1] + dy
```
wrong: a list instead of a tuple
```python
def step(pos: list[int], dx: int, dy: int) -> list[int]:
    return pos[0] + dx, pos[1] + dy
```
hint: `tuple[int, int]` is a pair of ints.
:::

## Your first test
id: first-test
stage: testing
needs: tuple-hint
minutes: 5
goal: The healer's spell has a cap: health never goes above 100.
source: Python docs: unittest (basic example) | https://docs.python.org/3/library/unittest.html#basic-example

### Assignment

`heal` is written for you. Below it, write a function `test_heal()` with `assert` lines that check `heal` works, including the cap. Your test is run against the real `heal` (it must pass) and against three broken versions (it must catch each one).

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def heal(health, amount):
    return min(100, health + amount)

def test_heal():
    pass
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def REAL(health, amount):
    return min(100, health + amount)

def test_your_tests_pass_on_the_real_code():
    assert passes_with('heal', REAL), "Your tests fail on the correct heal. Check what you expect."

def BUG_0(health, amount):
    return health

def test_catches_heal_ignores_the_amount():
    assert not passes_with('heal', BUG_0), "Your tests don't catch this bug: heal ignores the amount"

def BUG_1(health, amount):
    return health + amount

def test_catches_heal_has_no_cap():
    assert not passes_with('heal', BUG_1), "Your tests don't catch this bug: heal has no cap"

def BUG_2(health, amount):
    return min(100, health - amount)

def test_catches_heal_subtracts():
    assert not passes_with('heal', BUG_2), "Your tests don't catch this bug: heal subtracts"
```
solution:
```python
def heal(health, amount):
    return min(100, health + amount)

def test_heal():
    assert heal(50, 20) == 70
    assert heal(90, 20) == 100
    assert heal(100, 0) == 100
```
wrong: only checks a normal heal, so the missing cap slips through
```python
def heal(health, amount):
    return min(100, health + amount)

def test_heal():
    assert heal(50, 20) == 70
```
wrong: asserts something always true
```python
def heal(health, amount):
    return min(100, health + amount)

def test_heal():
    assert heal(50, 20) is not None
```
hint: Test a normal heal, a heal that would pass 100, and one that lands exactly on 100.
:::

## Testing the edges
id: edge-cases
stage: testing
needs: first-test
minutes: 5
goal: Bugs hide at the boundaries.
source: Python docs: unittest (basic example) | https://docs.python.org/3/library/unittest.html#basic-example

### Assignment

`clamp(hp)` keeps health between 0 and 100. Write `test_clamp()` that checks the inside, both ends, and values beyond both ends. It must pass on the real `clamp` and catch three broken ones.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def clamp(hp):
    return max(0, min(100, hp))

def test_clamp():
    assert clamp(50) == 50
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def REAL(hp):
    return max(0, min(100, hp))

def test_your_tests_pass_on_the_real_code():
    assert passes_with('clamp', REAL), "Your tests fail on the correct clamp. Check what you expect."

def BUG_0(hp):
    return min(100, hp)

def test_catches_no_lower_limit():
    assert not passes_with('clamp', BUG_0), "Your tests don't catch this bug: no lower limit"

def BUG_1(hp):
    return max(0, min(99, hp))

def test_catches_the_top_is_99():
    assert not passes_with('clamp', BUG_1), "Your tests don't catch this bug: the top is 99"

def BUG_2(hp):
    return max(0, hp)

def test_catches_no_upper_limit():
    assert not passes_with('clamp', BUG_2), "Your tests don't catch this bug: no upper limit"
```
solution:
```python
def clamp(hp):
    return max(0, min(100, hp))

def test_clamp():
    assert clamp(50) == 50
    assert clamp(0) == 0
    assert clamp(100) == 100
    assert clamp(-5) == 0
    assert clamp(150) == 100
```
wrong: never tests above 100
```python
def clamp(hp):
    return max(0, min(100, hp))

def test_clamp():
    assert clamp(50) == 50
    assert clamp(-5) == 0
```
hint: Check -5, 0, 50, 100 and 150.
:::

## Testing errors
id: test-raises
stage: testing
needs: edge-cases
minutes: 5
goal: A shop that lets you go into debt is a broken shop.
source: Python tutorial: Handling exceptions | https://docs.python.org/3/tutorial/errors.html#handling-exceptions

### Assignment

`withdraw(gold, amount)` returns what's left, and raises `ValueError` when `amount` is more than `gold`. Write `test_withdraw()` that checks a normal withdrawal, taking exactly everything, and that too much raises `ValueError` (use `try`/`except`). It must catch three broken versions.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def withdraw(gold, amount):
    if amount > gold:
        raise ValueError("not enough gold")
    return gold - amount

def test_withdraw():
    assert withdraw(10, 3) == 7
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def REAL(gold, amount):
    if amount > gold:
        raise ValueError('not enough gold')
    return gold - amount

def test_your_tests_pass_on_the_real_code():
    assert passes_with('withdraw', REAL), "Your tests fail on the correct withdraw. Check what you expect."

def BUG_0(gold, amount):
    return gold - amount

def test_catches_lets_you_go_into_debt():
    assert not passes_with('withdraw', BUG_0), "Your tests don't catch this bug: lets you go into debt"

def BUG_1(gold, amount):
    if amount >= gold:
        raise ValueError('not enough gold')
    return gold - amount

def test_catches_refuses_to_take_exactly_everything():
    assert not passes_with('withdraw', BUG_1), "Your tests don't catch this bug: refuses to take exactly everything"

def BUG_2(gold, amount):
    if amount > gold:
        raise KeyError('not enough gold')
    return gold - amount

def test_catches_raises_the_wrong_error():
    assert not passes_with('withdraw', BUG_2), "Your tests don't catch this bug: raises the wrong error"
```
solution:
```python
def withdraw(gold, amount):
    if amount > gold:
        raise ValueError("not enough gold")
    return gold - amount

def test_withdraw():
    assert withdraw(10, 3) == 7
    assert withdraw(10, 10) == 0
    try:
        withdraw(5, 6)
    except ValueError:
        pass
    else:
        raise AssertionError("withdraw(5, 6) should raise ValueError")
```
wrong: catches every error, so the wrong kind passes
```python
def withdraw(gold, amount):
    if amount > gold:
        raise ValueError("not enough gold")
    return gold - amount

def test_withdraw():
    assert withdraw(10, 3) == 7
    assert withdraw(10, 10) == 0
    try:
        withdraw(5, 6)
    except Exception:
        pass
    else:
        raise AssertionError("should raise")
```
hint: Inside the test: `try: withdraw(5, 6)`, `except ValueError: pass`, and `else: raise AssertionError(...)`.
:::

## Table-driven tests
id: table-test
stage: testing
needs: test-raises
minutes: 5
goal: One test, many cases.
source: Python docs: unittest (basic example) | https://docs.python.org/3/library/unittest.html#basic-example

### Assignment

`rank(level)` returns `"novice"` below 5, `"adept"` from 5 to 9, and `"master"` from 10. Write `test_rank()` with a list of `(level, expected)` pairs and a `for` loop that asserts each one. It must catch three broken versions.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def rank(level):
    if level < 5:
        return "novice"
    elif level < 10:
        return "adept"
    return "master"

def test_rank():
    cases = []
    for level, expected in cases:
        assert rank(level) == expected
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def REAL(level):
    return 'novice' if level < 5 else 'adept' if level < 10 else 'master'

def test_your_tests_pass_on_the_real_code():
    assert passes_with('rank', REAL), "Your tests fail on the correct rank. Check what you expect."

def BUG_0(level):
    return 'novice' if level <= 5 else 'adept' if level < 10 else 'master'

def test_catches_5_counts_as_novice():
    assert not passes_with('rank', BUG_0), "Your tests don't catch this bug: 5 counts as novice"

def BUG_1(level):
    return 'novice' if level < 5 else 'adept' if level <= 10 else 'master'

def test_catches_10_counts_as_adept():
    assert not passes_with('rank', BUG_1), "Your tests don't catch this bug: 10 counts as adept"

def BUG_2(level):
    return 'novice' if level < 5 else 'adept' if level < 10 else 'Master'

def test_catches_master_with_a_capital():
    assert not passes_with('rank', BUG_2), "Your tests don't catch this bug: Master with a capital"

def test_uses_a_loop():
    assert has_node("For"), "Loop over the cases with a for loop"
```
solution:
```python
def rank(level):
    if level < 5:
        return "novice"
    elif level < 10:
        return "adept"
    return "master"

def test_rank():
    cases = [(1, "novice"), (4, "novice"), (5, "adept"), (9, "adept"), (10, "master"), (50, "master")]
    for level, expected in cases:
        assert rank(level) == expected, (level, expected)
```
wrong: misses the boundaries
```python
def rank(level):
    if level < 5:
        return "novice"
    elif level < 10:
        return "adept"
    return "master"

def test_rank():
    cases = [(1, "novice"), (7, "adept"), (50, "master")]
    for level, expected in cases:
        assert rank(level) == expected
```
hint: Put the boundary levels in the list: 4 and 5, 9 and 10.
:::

## Quest: the boss fight
id: p-fight
stage: practice
needs: table-test
minutes: 15
goal: The boss waits in the keep. The hero strikes first, then the boss, round after round.
source: Python reference: The while statement | https://docs.python.org/3/reference/compound_stmts.html#the-while-statement
project: true

### Assignment

Write `fight(hero_hp, hero_damage, boss_hp, boss_damage)` that plays the fight and returns `"hero"` or `"boss"`, whoever is still standing. The hero attacks first each round. The fight stops as soon as someone's health reaches 0 or less, so a boss that falls never strikes back.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def fight(hero_hp, hero_damage, boss_hp, boss_damage):
    return "hero"
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import fight

def test_hero_wins():
    assert fight(100, 30, 90, 10) == "hero"

def test_boss_wins():
    assert fight(20, 5, 100, 15) == "boss"

def test_hero_strikes_first():
    assert fight(10, 50, 50, 50) == "hero"

import copy, random
from solution import fight as LEARNER
def ref(hh, hd, bh, bd):
    while True:
        bh -= hd
        if bh <= 0:
            return 'hero'
        hh -= bd
        if hh <= 0:
            return 'boss'

def gen(r):
    return [r.randint(1, 120), r.randint(1, 40), r.randint(1, 120), r.randint(1, 40)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "fight%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def fight(hero_hp, hero_damage, boss_hp, boss_damage):
    while True:
        boss_hp -= hero_damage
        if boss_hp <= 0:
            return "hero"
        hero_hp -= boss_damage
        if hero_hp <= 0:
            return "boss"
```
wrong: the boss strikes first
```python
def fight(hero_hp, hero_damage, boss_hp, boss_damage):
    while True:
        hero_hp -= boss_damage
        if hero_hp <= 0:
            return "boss"
        boss_hp -= hero_damage
        if boss_hp <= 0:
            return "hero"
```
hint: Loop: the hero hits, check the boss; the boss hits, check the hero. Return as soon as one drops to 0 or less.
:::

## Quest: the shop
id: p-shop
stage: practice
needs: p-fight
minutes: 15
goal: The shopkeeper keeps prices in a dictionary.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries
project: true

### Assignment

Write `buy_item(gold, bag, prices, item)` that returns the gold left after buying `item`, and adds the item to the list `bag`. If the item isn't sold, raise a `KeyError`. If Sam can't afford it, raise a `ValueError` and leave `bag` as it was.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def buy_item(gold, bag, prices, item):
    return gold
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
def buy_item(gold, bag, prices, item):
    price = prices[item]
    if price > gold:
        raise ValueError("not enough gold")
    bag.append(item)
    return gold - price
```
wrong: adds to the bag before checking the gold
```python
def buy_item(gold, bag, prices, item):
    bag.append(item)
    price = prices[item]
    if price > gold:
        raise ValueError("not enough gold")
    return gold - price
```
hint: Look the price up first (that raises `KeyError` by itself), compare it with `gold`, and only then change the bag.
:::

## Quest: the loot table
id: p-loot
stage: practice
needs: p-shop
minutes: 15
goal: The monsters dropped a heap of loot.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries
project: true

### Assignment

Write `loot_report(drops)` that returns the loot as a list of strings like `"gem x3"`, most common first, ties in alphabetical order.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def loot_report(drops):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import loot_report

def test_values():
    assert loot_report(["gem", "gold", "gem", "map", "gold", "gem"]) == ["gem x3", "gold x2", "map x1"]

def test_ties():
    assert loot_report(["rope", "axe"]) == ["axe x1", "rope x1"]

def test_empty():
    assert loot_report([]) == []

import copy, random
from solution import loot_report as LEARNER
def ref(d):
    c = {}
    for x in d:
        c[x] = c.get(x, 0) + 1
    return [f'{k} x{v}' for k, v in sorted(c.items(), key=lambda p: (-p[1], p[0]))]

def gen(r):
    return [[r.choice(['gem', 'gold', 'map', 'axe', 'rope']) for _ in range(r.randint(0, 14))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "loot_report%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def loot_report(drops):
    counts = {}
    for item in drops:
        counts[item] = counts.get(item, 0) + 1
    ordered = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    return [f"{item} x{count}" for item, count in ordered]
```
wrong: ties in the order they appeared
```python
def loot_report(drops):
    counts = {}
    for item in drops:
        counts[item] = counts.get(item, 0) + 1
    ordered = sorted(counts.items(), key=lambda pair: -pair[1])
    return [f"{item} x{count}" for item, count in ordered]
```
hint: Count first, then `sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))`.
:::

## Quest: the quest log
id: p-log
stage: practice
needs: p-loot
minutes: 15
goal: The guild keeps a log of every quest.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries
project: true

### Assignment

`log` maps a quest name to a dictionary with `"done"` (a boolean) and `"gold"` (the reward). Write `finish(log, name)` that marks the quest done and returns its reward; raise a `ValueError` if it was already done and a `KeyError` if the quest doesn't exist. Then write `unclaimed(log)` that returns the total reward of quests that are not done.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def finish(log, name):
    return 0

def unclaimed(log):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
def finish(log, name):
    quest = log[name]
    if quest["done"]:
        raise ValueError("already done")
    quest["done"] = True
    return quest["gold"]

def unclaimed(log):
    return sum(q["gold"] for q in log.values() if not q["done"])
```
wrong: can finish a quest twice
```python
def finish(log, name):
    quest = log[name]
    quest["done"] = True
    return quest["gold"]

def unclaimed(log):
    return sum(q["gold"] for q in log.values() if not q["done"])
```
hint: `log[name]` raises `KeyError` for free. Then check `quest["done"]`.
:::

## Quest: the map walk
id: p-walk
stage: practice
needs: p-log
minutes: 15
goal: Sam follows a list of directions through the wilds.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries
project: true

### Assignment

Write `walk(moves)` that starts at `(0, 0)` and returns the final position after a string of moves: `N` adds 1 to y, `S` takes 1 from y, `E` adds 1 to x, `W` takes 1 from x. Any other letter raises a `ValueError`. `walk("NNE")` is `(1, 2)`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def walk(moves):
    return (0, 0)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

import copy, random
from solution import walk as LEARNER
def ref(m):
    x = m.count('E') - m.count('W')
    y = m.count('N') - m.count('S')
    return (x, y)

def gen(r):
    return [''.join(r.choice('NSEW') for _ in range(r.randint(0, 20)))]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "walk%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
STEPS = {"N": (0, 1), "S": (0, -1), "E": (1, 0), "W": (-1, 0)}

def walk(moves):
    x, y = 0, 0
    for move in moves:
        if move not in STEPS:
            raise ValueError(f"unknown move: {move}")
        dx, dy = STEPS[move]
        x, y = x + dx, y + dy
    return (x, y)
```
wrong: ignores unknown moves
```python
def walk(moves):
    return (moves.count("E") - moves.count("W"), moves.count("N") - moves.count("S"))
```
wrong: swaps the axes
```python
def walk(moves):
    for m in moves:
        if m not in "NSEW":
            raise ValueError(m)
    return (moves.count("N") - moves.count("S"), moves.count("E") - moves.count("W"))
```
hint: A dictionary from letter to `(dx, dy)` keeps the loop short.
:::

## Quest: the heavy pack
id: p-carry
stage: practice
needs: p-walk
minutes: 15
goal: Sam can only carry so much.
source: Python tutorial: More on lists | https://docs.python.org/3/tutorial/datastructures.html#more-on-lists
project: true

### Assignment

Write `pack(items, limit)`. `items` is a list of `(name, weight)` pairs in the order Sam picks them up. Take each item if it still fits under the weight `limit` (a total equal to the limit is fine), skip it if it doesn't, and return the list of names taken.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def pack(items, limit):
    return [name for name, weight in items]
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import pack

def test_values():
    items = [("armor", 15), ("sword", 5), ("anvil", 50), ("rope", 2)]
    assert pack(items, 22) == ["armor", "sword", "rope"]
    assert pack(items, 20) == ["armor", "sword"]
    assert pack([], 10) == []

import copy, random
from solution import pack as LEARNER
def ref(items, limit):
    out, load = [], 0
    for n, w in items:
        if load + w <= limit:
            out.append(n)
            load += w
    return out

def gen(r):
    return [[(r.choice(['axe', 'rope', 'gem', 'tent', 'pot']), r.randint(1, 20)) for _ in range(r.randint(0, 8))], r.randint(0, 50)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "pack%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def pack(items, limit):
    taken = []
    load = 0
    for name, weight in items:
        if load + weight <= limit:
            taken.append(name)
            load += weight
    return taken
```
wrong: stops at the first item that doesn't fit
```python
def pack(items, limit):
    taken, load = [], 0
    for name, weight in items:
        if load + weight > limit:
            break
        taken.append(name)
        load += weight
    return taken
```
hint: Keep a running `load`. Add an item only when `load + weight <= limit`.
:::

## Quest: saving the game
id: p-save
stage: practice
needs: p-carry
minutes: 15
goal: A quest is no good if it can't be saved.
source: Python docs: json | https://docs.python.org/3/library/json.html
project: true

### Assignment

Write `save(state)` that turns the game state (a dictionary) into JSON text, and `load(text)` that turns that text back into the same dictionary. Use the `json` module.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def save(state):
    return str(state)

def load(text):
    return {}
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

import json
from solution import save, load

STATE = {"hero": "Sam", "hp": 42, "bag": ["rope", "gem"], "quests": {"rats": True}}

def test_round_trip():
    assert load(save(STATE)) == STATE

def test_is_json():
    assert json.loads(save(STATE)) == STATE, "save should produce real JSON text"

def test_code_0():
    assert calls('dumps'), 'Call `dumps()` in your code.'

def test_code_1():
    assert calls('loads'), 'Call `loads()` in your code.'
```
solution:
```python
import json

def save(state):
    return json.dumps(state)

def load(text):
    return json.loads(text)
```
wrong: Python's repr is not JSON
```python
import ast
import json

def save(state):
    return repr(state)

def load(text):
    return ast.literal_eval(text)
```
hint: `json.dumps` makes text; `json.loads` reads it back.
:::

## Quest: the adventure engine
id: p-engine
stage: practice
needs: p-save
minutes: 15
goal: Time to run a tiny text adventure.
source: Python docs: String methods | https://docs.python.org/3/library/stdtypes.html#string-methods
show: play(["go cellar", "take axe"]) -> room-bag
project: true

### Assignment

Write `play(commands)`. Sam starts in the `"hall"` with an empty bag. Each command is a line: `go <room>` moves Sam, `take <item>` adds the item to the bag, and anything else is ignored. Return a pair: the room Sam ends in, and the bag as a sorted list. Commands may have stray spaces and capitals.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def play(commands):
    return "hall", []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import play

def test_story():
    commands = ["take lamp", "go cellar", "  TAKE Rusty Key ", "dance", "go tower"]
    assert play(commands) == ("tower", ["lamp", "rusty key"])

def test_nothing():
    assert play([]) == ("hall", [])

def test_ignores_bare_verbs():
    assert play(["go", "take"]) == ("hall", [])
```
solution:
```python
def play(commands):
    room = "hall"
    bag = []
    for line in commands:
        parts = line.strip().lower().split(maxsplit=1)
        if len(parts) < 2:
            continue
        verb, rest = parts
        if verb == "go":
            room = rest
        elif verb == "take":
            bag.append(rest)
    return room, sorted(bag)
```
wrong: keeps the capitals
```python
def play(commands):
    room, bag = "hall", []
    for line in commands:
        parts = line.strip().split(maxsplit=1)
        if len(parts) < 2:
            continue
        verb, rest = parts
        if verb.lower() == "go":
            room = rest
        elif verb.lower() == "take":
            bag.append(rest)
    return room, sorted(bag)
```
hint: Reuse what you did in *Splitting commands*: lower-case and split each line into a verb and the rest.
:::

## A blueprint for a hero
id: class-hero
stage: classes
needs: p-engine
minutes: 5
goal: The Guild keeps a card for every hero.
source: Python tutorial: Classes | https://docs.python.org/3/tutorial/classes.html

### Assignment

A **class** is a blueprint; an **instance** is one thing made from it. `Hero("Sam", 40)` builds a new instance and calls `__init__` with that instance as `self`, plus the arguments you passed. Store the arguments on `self` so each hero keeps its own name and health.

Define `class Hero` with an `__init__(self, name, hp)` that sets `self.name` and `self.hp`. The lines below the marker make one hero and print its name and health; they must show:

```text
Sam 40
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
class Hero:
    def __init__(self, name, hp):
        pass


# Don't touch below this line
sam = Hero("Sam", 40)
print(sam.name, sam.hp)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "Sam 40"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

from solution import Hero

def test_two_heroes():
    a, b = Hero("Sam", 40), Hero("Ada", 7)
    assert (a.name, a.hp) == ("Sam", 40)
    assert (b.name, b.hp) == ("Ada", 7)

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'sam = Hero("Sam", 40)\nprint(sam.name, sam.hp)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_node('ClassDef'), 'Your code needs a `class`.'

def test_code_1():
    assert defines('__init__'), 'Define `__init__`.'
```
solution:
```python
class Hero:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp


# Don't touch below this line
sam = Hero("Sam", 40)
print(sam.name, sam.hp)
```
wrong: stores the same values for every hero instead of the arguments
```python
class Hero:
    def __init__(self, name, hp):
        self.name = "Sam"
        self.hp = 40


# Don't touch below this line
sam = Hero("Sam", 40)
print(sam.name, sam.hp)
```
wrong: uses class attributes, so the arguments are refused
```python
class Hero:
    name = "Sam"
    hp = 40


# Don't touch below this line
sam = Hero("Sam", 40)
print(sam.name, sam.hp)
```
hint: Inside `__init__`, `self` is the new hero. `self.name = name` copies the argument onto that hero.
:::

## A method that changes the hero
id: class-method
stage: classes
needs: class-hero
minutes: 5
goal: A hero who cannot be hurt is no hero.
source: Python tutorial: Instance objects | https://docs.python.org/3/tutorial/classes.html#instance-objects

### Assignment

A **method** is a function that belongs to the class. Its first parameter is `self`, the instance it was called on, so it can read and change that instance's attributes.

Add `take_damage(self, amount)` to `Hero`. It must lower `self.hp` by `amount`, and never let health go below 0. The code below the marker hits a 10-health hero for 4 and then for 9; the console must show:

```text
0
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
class Hero:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def take_damage(self, amount):
        pass


# Don't touch below this line
sam = Hero("Sam", 10)
sam.take_damage(4)
sam.take_damage(9)
print(sam.hp)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "0"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

from solution import Hero

def test_damage():
    h = Hero("Ada", 10)
    h.take_damage(4)
    assert h.hp == 6
    h.take_damage(9)
    assert h.hp == 0

def test_two_heroes_are_separate():
    a, b = Hero("Sam", 10), Hero("Ada", 10)
    a.take_damage(3)
    assert (a.hp, b.hp) == (7, 10)

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'sam = Hero("Sam", 10)\nsam.take_damage(4)\nsam.take_damage(9)\nprint(sam.hp)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert defines('take_damage'), 'Define `take_damage`.'
```
solution:
```python
class Hero:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def take_damage(self, amount):
        self.hp = max(0, self.hp - amount)


# Don't touch below this line
sam = Hero("Sam", 10)
sam.take_damage(4)
sam.take_damage(9)
print(sam.hp)
```
wrong: lets health go negative
```python
class Hero:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def take_damage(self, amount):
        self.hp -= amount


# Don't touch below this line
sam = Hero("Sam", 10)
sam.take_damage(4)
sam.take_damage(9)
print(sam.hp)
```
wrong: returns the new health but never stores it
```python
class Hero:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def take_damage(self, amount):
        return max(0, self.hp - amount)


# Don't touch below this line
sam = Hero("Sam", 10)
sam.take_damage(4)
sam.take_damage(9)
print(sam.hp)
```
hint: `self.hp -= amount` changes the hero. Wrap the result in `max(0, ...)` so a big hit stops at 0.
:::

## Say what a hero looks like
id: class-repr
stage: classes
needs: class-method
minutes: 5
goal: The Guild's ledger prints a list of heroes and gets a wall of numbers.
source: Python docs: object.__repr__() | https://docs.python.org/3/reference/datamodel.html#object.__repr__

### Assignment

`print` and the REPL ask an object for its **repr**: the text that stands for the object. The default is an address like `<Hero object at 0x…>`, which tells a reader nothing. Define `__repr__(self)` to return `Hero(name, hp)` with the real name and health, so a list of heroes reads like a roster.

The code below the marker prints a list with one hero in it; it must show:

```text
[Hero(Sam, 40)]
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
class Hero:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def __repr__(self):
        return "Hero"


# Don't touch below this line
sam = Hero("Sam", 40)
print([sam])
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "[Hero(Sam, 40)]"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

from solution import Hero

def test_repr():
    assert repr(Hero("Ada", 7)) == "Hero(Ada, 7)"

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'sam = Hero("Sam", 40)\nprint([sam])', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert defines('__repr__'), 'Define `__repr__`.'
```
solution:
```python
class Hero:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def __repr__(self):
        return f"Hero({self.name}, {self.hp})"


# Don't touch below this line
sam = Hero("Sam", 40)
print([sam])
```
wrong: uses angle brackets and leaves out the health
```python
class Hero:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def __repr__(self):
        return f"<Hero {self.name}>"


# Don't touch below this line
sam = Hero("Sam", 40)
print([sam])
```
wrong: prints instead of returning, so repr gets None
```python
class Hero:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def __repr__(self):
        print(f"Hero({self.name}, {self.hp})")


# Don't touch below this line
sam = Hero("Sam", 40)
print([sam])
```
hint: `__repr__` must return a string, not print one. Build it with an f-string: `f"Hero({self.name}, {self.hp})"`.
:::

## Items as dataclasses
id: class-dataclass
stage: classes
needs: class-repr
minutes: 5
goal: Every rope, gem and key needs a name and a value.
source: Python docs: dataclasses | https://docs.python.org/3/library/dataclasses.html

### Assignment

A **dataclass** writes the boring parts of a class for you: `__init__`, `__repr__` and `__eq__` come from the fields you declare. The decorator is `@dataclass`, and the fields are annotated names: `name: str` and `value: int = 1`.

Turn `Item` into a dataclass with a `name: str` and a `value: int` that defaults to 1. The code below the marker prints a rope and a gem's value; it must show:

```text
Item(name='rope', value=1)
5
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
from dataclasses import dataclass


class Item:
    def __init__(self, name, value=1):
        self.name = name
        self.value = value


# Don't touch below this line
print(Item("rope"))
print(Item("gem", 5).value)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "Item(name='rope', value=1)\n5"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

import dataclasses
from solution import Item

def test_is_dataclass():
    assert dataclasses.is_dataclass(Item), "Item should be a dataclass."

def test_default():
    assert Item("rope").value == 1

def test_equality():
    assert Item("rope") == Item("rope")

def test_repr():
    assert repr(Item("gem", 5)) == "Item(name='gem', value=5)"

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(Item("rope"))\nprint(Item("gem", 5).value)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_node('ClassDef'), 'Your code needs a `class`.'
```
solution:
```python
from dataclasses import dataclass


@dataclass
class Item:
    name: str
    value: int = 1


# Don't touch below this line
print(Item("rope"))
print(Item("gem", 5).value)
```
wrong: keeps a hand-written __init__, so it is not a dataclass
```python
from dataclasses import dataclass


class Item:
    def __init__(self, name, value=1):
        self.name = name
        self.value = value


# Don't touch below this line
print(Item("rope"))
print(Item("gem", 5).value)
```
wrong: forgets the default value
```python
from dataclasses import dataclass


@dataclass
class Item:
    name: str
    value: int


# Don't touch below this line
print(Item("rope"))
print(Item("gem", 5).value)
```
wrong: defaults the value to 0
```python
from dataclasses import dataclass


@dataclass
class Item:
    name: str
    value: int = 0


# Don't touch below this line
print(Item("rope"))
print(Item("gem", 5).value)
```
hint: Put `@dataclass` on the line above `class Item`, then replace `__init__` with two annotated fields.
:::

## Monsters, and a dragon
id: class-inherit
stage: classes
needs: class-dataclass
minutes: 5
goal: The dragon is a monster with one more idea: fire.
source: Python tutorial: Inheritance | https://docs.python.org/3/tutorial/classes.html#inheritance

### Assignment

**Inheritance** lets one class build on another. `class Dragon(Monster)` gets every method `Monster` has. Its own `__init__` calls `super().__init__(name, hp)` to let the parent set the shared fields, then adds `self.fire`. A method with the same name in the child **overrides** the parent's.

Finish `Dragon`: call the parent's `__init__`, store `fire`, and override `describe()` to return `Smaug the dragon has 300 hp and breathes 40 fire`. The console must show:

```text
Goblin has 12 hp
Smaug the dragon has 300 hp and breathes 40 fire
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
class Monster:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def describe(self):
        return f"{self.name} has {self.hp} hp"


class Dragon(Monster):
    def __init__(self, name, hp, fire):
        pass


# Don't touch below this line
print(Monster("Goblin", 12).describe())
print(Dragon("Smaug", 300, 40).describe())
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "Goblin has 12 hp\nSmaug the dragon has 300 hp and breathes 40 fire"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

from solution import Monster, Dragon

def test_is_a_monster():
    assert issubclass(Dragon, Monster)

def test_fields():
    d = Dragon("Smaug", 300, 40)
    assert (d.name, d.hp, d.fire) == ("Smaug", 300, 40)

def test_override():
    assert Dragon("Smaug", 300, 40).describe() == "Smaug the dragon has 300 hp and breathes 40 fire"
    assert Monster("Goblin", 12).describe() == "Goblin has 12 hp"

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(Monster("Goblin", 12).describe())\nprint(Dragon("Smaug", 300, 40).describe())', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_node('ClassDef'), 'Your code needs a `class`.'

def test_code_1():
    assert calls('super'), 'Call `super()` in your code.'

def test_code_2():
    assert defines('describe'), 'Define `describe`.'
```
solution:
```python
class Monster:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def describe(self):
        return f"{self.name} has {self.hp} hp"


class Dragon(Monster):
    def __init__(self, name, hp, fire):
        super().__init__(name, hp)
        self.fire = fire

    def describe(self):
        return f"{self.name} the dragon has {self.hp} hp and breathes {self.fire} fire"


# Don't touch below this line
print(Monster("Goblin", 12).describe())
print(Dragon("Smaug", 300, 40).describe())
```
wrong: never runs the parent's __init__
```python
class Monster:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def describe(self):
        return f"{self.name} has {self.hp} hp"


class Dragon(Monster):
    def __init__(self, name, hp, fire):
        self.fire = fire

    def describe(self):
        return f"{self.name} the dragon has {self.hp} hp and breathes {self.fire} fire"


# Don't touch below this line
print(Monster("Goblin", 12).describe())
print(Dragon("Smaug", 300, 40).describe())
```
wrong: forgets to override describe
```python
class Monster:
    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def describe(self):
        return f"{self.name} has {self.hp} hp"


class Dragon(Monster):
    def __init__(self, name, hp, fire):
        super().__init__(name, hp)
        self.fire = fire


# Don't touch below this line
print(Monster("Goblin", 12).describe())
print(Dragon("Smaug", 300, 40).describe())
```
hint: `super().__init__(name, hp)` runs `Monster.__init__` for this dragon. Then add `self.fire = fire` and write a new `describe`.
:::

## Quiz: the dataclass's card
id: quiz-dataclass
stage: classes
needs: class-inherit
minutes: 5
goal: The Guild's clerk reads an item aloud.
source: Python docs: dataclasses | https://docs.python.org/3/library/dataclasses.html

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
from dataclasses import dataclass

@dataclass
class Item:
    name: str
    value: int = 1

print(Item("rope"))
```
answer:
```
Item(name='rope', value=1)
```
why: @dataclass writes __repr__ from the fields, so it shows the field names and the default value.
:::

## Write the banner to a file
id: file-write
stage: files
needs: quiz-dataclass
minutes: 5
goal: The Guild wants the notice on disk, not just on screen.
source: Python tutorial: Reading and writing files | https://docs.python.org/3/tutorial/inputoutput.html#reading-and-writing-files

### Assignment

`open(path, "w")` opens a file for writing and creates it if needed. Use it inside a `with` block: the block closes the file for you, even if something fails. `f.write(text)` writes exactly the characters you give it, with no newline added.

Write `save_text(path, text)` that writes `text` to `path`. The code below the marker saves a notice, reads the file back and prints it; the console must show:

```text
The Guild is open
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def save_text(path, text):
    pass


# Don't touch below this line
save_text("notice.txt", "The Guild is open")
with open("notice.txt", encoding="utf-8") as f:
    print(f.read())
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

import os
from solution import save_text

def test_writes_exactly():
    path = os.path.join(HERE, "a.txt")
    save_text(path, "hello")
    with open(path, encoding="utf-8") as f:
        assert f.read() == "hello"

def test_overwrites():
    path = os.path.join(HERE, "b.txt")
    save_text(path, "one")
    save_text(path, "two")
    with open(path, encoding="utf-8") as f:
        assert f.read() == "two"

import inspect

def test_uses_with():
    source = inspect.getsource(save_text)
    assert "with open" in source, "Use a with block so the file is closed for you."

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'save_text("notice.txt", "The Guild is open")\nwith open("notice.txt", encoding="utf-8") as f:\n    print(f.read())', "The code under # Don't touch below this line must stay as it was"
```
solution:
```python
def save_text(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


# Don't touch below this line
save_text("notice.txt", "The Guild is open")
with open("notice.txt", encoding="utf-8") as f:
    print(f.read())
```
wrong: adds a newline that was not asked for
```python
def save_text(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text + "\n")


# Don't touch below this line
save_text("notice.txt", "The Guild is open")
with open("notice.txt", encoding="utf-8") as f:
    print(f.read())
```
wrong: writes the repr with quotes
```python
def save_text(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(repr(text))


# Don't touch below this line
save_text("notice.txt", "The Guild is open")
with open("notice.txt", encoding="utf-8") as f:
    print(f.read())
```
wrong: opens without a with block
```python
def save_text(path, text):
    f = open(path, "w", encoding="utf-8")
    f.write(text)


# Don't touch below this line
save_text("notice.txt", "The Guild is open")
with open("notice.txt", encoding="utf-8") as f:
    print(f.read())
```
hint: Open with `"w"`, then call `f.write(text)` inside the `with` block.
:::

## Read the save, survive a missing one
id: file-read
stage: files
needs: file-write
minutes: 5
goal: A save file that isn't there is not a crash.
source: Python reference: The with statement | https://docs.python.org/3/reference/compound_stmts.html#the-with-statement

### Assignment

Reading works the same way: `open(path)` then `f.read()`. But the file may be missing, and then `open` raises `FileNotFoundError`. Catch **that** error and return `"empty"`; let every other error through, because a bug in the path should not look like an empty save.

Write `load_text(path)`. The code below the marker writes a file, reads it, then reads a file that does not exist; the console must show:

```text
The Guild is open
empty
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def load_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# Don't touch below this line
with open("notice.txt", "w", encoding="utf-8") as f:
    f.write("The Guild is open")
print(load_text("notice.txt"))
print(load_text("missing.txt"))
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

import os
from solution import load_text

def test_reads():
    path = os.path.join(HERE, "saved.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("The Guild is open")
    assert load_text(path) == "The Guild is open"

def test_missing():
    assert load_text(os.path.join(HERE, "nope.txt")) == "empty"

def test_other_errors_propagate():
    try:
        load_text(HERE)
    except IsADirectoryError:
        return
    raise AssertionError("load_text should not hide errors other than FileNotFoundError")

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'with open("notice.txt", "w", encoding="utf-8") as f:\n    f.write("The Guild is open")\nprint(load_text("notice.txt"))\nprint(load_text("missing.txt"))', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_node('Try'), 'Your code needs a `try block`.'
```
solution:
```python
def load_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return "empty"


# Don't touch below this line
with open("notice.txt", "w", encoding="utf-8") as f:
    f.write("The Guild is open")
print(load_text("notice.txt"))
print(load_text("missing.txt"))
```
wrong: does not catch the missing file
```python
def load_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# Don't touch below this line
with open("notice.txt", "w", encoding="utf-8") as f:
    f.write("The Guild is open")
print(load_text("notice.txt"))
print(load_text("missing.txt"))
```
wrong: catches every error, so real bugs look like empty saves
```python
def load_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except:
        return "empty"


# Don't touch below this line
with open("notice.txt", "w", encoding="utf-8") as f:
    f.write("The Guild is open")
print(load_text("notice.txt"))
print(load_text("missing.txt"))
```
wrong: returns an empty string instead of the word empty
```python
def load_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""


# Don't touch below this line
with open("notice.txt", "w", encoding="utf-8") as f:
    f.write("The Guild is open")
print(load_text("notice.txt"))
print(load_text("missing.txt"))
```
hint: Put the `with open(...)` inside `try:` and catch `FileNotFoundError` only.
:::

## Save the game as JSON
id: file-json
stage: files
needs: file-read
minutes: 5
goal: A bag and a quest log are not plain text.
source: Python docs: json | https://docs.python.org/3/library/json.html

### Assignment

**JSON** is a text format for lists, dictionaries, strings, numbers, booleans and null. `json.dump(state, f)` writes a dictionary to an open file; `json.load(f)` reads it back as a dictionary. That keeps the shape of the save: lists stay lists, nested dictionaries stay nested.

Write `save_game(path, state)` and `load_game(path)`. The code below the marker saves a hero and a bag, loads them, and prints the hero with the bag sorted; the console must show:

```text
Sam gem rope
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
import json


def save_game(path, state):
    pass


def load_game(path):
    pass


# Don't touch below this line
save_game("save.json", {"hero": "Sam", "bag": ["gem", "rope"]})
state = load_game("save.json")
print(state["hero"], " ".join(sorted(state["bag"])))
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

import json, os
from solution import save_game, load_game

def test_round_trip():
    path = os.path.join(HERE, "game.json")
    state = {"hero": "Sam", "hp": 42, "bag": ["gem", "rope"], "quests": {"rats": True}}
    save_game(path, state)
    assert load_game(path) == state

def test_real_json():
    path = os.path.join(HERE, "real.json")
    save_game(path, {"bag": ["gem"]})
    with open(path, encoding="utf-8") as f:
        assert json.load(f) == {"bag": ["gem"]}

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'save_game("save.json", {"hero": "Sam", "bag": ["gem", "rope"]})\nstate = load_game("save.json")\nprint(state["hero"], " ".join(sorted(state["bag"])))', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert calls('dump'), 'Call `dump()` in your code.'

def test_code_1():
    assert calls('load'), 'Call `load()` in your code.'

def test_code_2():
    assert has_node('With'), 'Your code needs a `with block`.'
```
solution:
```python
import json


def save_game(path, state):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f)


def load_game(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# Don't touch below this line
save_game("save.json", {"hero": "Sam", "bag": ["gem", "rope"]})
state = load_game("save.json")
print(state["hero"], " ".join(sorted(state["bag"])))
```
wrong: writes Python's repr, which is not JSON
```python
import json


def save_game(path, state):
    with open(path, "w", encoding="utf-8") as f:
        f.write(str(state))


def load_game(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# Don't touch below this line
save_game("save.json", {"hero": "Sam", "bag": ["gem", "rope"]})
state = load_game("save.json")
print(state["hero"], " ".join(sorted(state["bag"])))
```
wrong: builds the JSON text but never writes it
```python
import json


def save_game(path, state):
    json.dumps(state)


def load_game(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# Don't touch below this line
save_game("save.json", {"hero": "Sam", "bag": ["gem", "rope"]})
state = load_game("save.json")
print(state["hero"], " ".join(sorted(state["bag"])))
```
wrong: returns the raw text instead of a dictionary
```python
import json


def save_game(path, state):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f)


def load_game(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# Don't touch below this line
save_game("save.json", {"hero": "Sam", "bag": ["gem", "rope"]})
state = load_game("save.json")
print(state["hero"], " ".join(sorted(state["bag"])))
```
hint: `json.dump(state, f)` needs both the object and the open file. `json.load(f)` takes only the file.
:::

## Quiz: what JSON keeps
id: quiz-json
stage: files
needs: file-json
minutes: 5
goal: A save comes back from disk.
source: Python docs: json | https://docs.python.org/3/library/json.html

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
import json

state = {"hp": 10, "bag": ["rope", "gem"]}
text = json.dumps(state, sort_keys=True)
back = json.loads(text)
print(back["hp"] + 5, len(back["bag"]))
```
answer:
```
15 2
```
why: JSON keeps numbers and lists. json.loads rebuilds a dictionary, so back["hp"] is the number 10 again.
:::

## The Guild's front door
id: module-main
stage: modules
needs: quiz-json
minutes: 5
goal: A file that is both a program and a module needs a front door.
source: Python docs: __main__ | https://docs.python.org/3/library/__main__.html

### Assignment

When Python runs a file, it sets `__name__` to `"__main__"`. When another file imports it, `__name__` is the module's name instead. So `if __name__ == "__main__": main()` runs `main()` when the file is run, and stays quiet when the file is imported. That is how one file can be both a program and a library.

Add the guard so running the file prints exactly:

```text
The Guild opens its doors.
```

Importing it must print nothing.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def main():
    print("The Guild opens its doors.")
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

import contextlib, io, os
import solution

EXPECTED = "The Guild opens its doors."

def test_runs_as_script():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_import_does_not_run_it():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="guild")
    assert buf.getvalue() == "", "Importing the file ran main() too."

def test_main_is_defined():
    assert callable(solution.main)

def test_code_0():
    assert has_node('If'), 'Your code needs a `if statement`.'

def test_code_1():
    assert uses_name('__name__'), 'Use the name `__name__`.'

def test_code_2():
    assert calls('main'), 'Call `main()` in your code.'
```
solution:
```python
def main():
    print("The Guild opens its doors.")


if __name__ == "__main__":
    main()
```
wrong: calls main() at the bottom with no guard
```python
def main():
    print("The Guild opens its doors.")


main()
```
wrong: prints in the guard instead of calling main
```python
def main():
    print("The Guild opens its doors.")


if __name__ == "__main__":
    print("The Guild opens its doors.")
```
wrong: gets the comparison backwards
```python
def main():
    print("The Guild opens its doors.")


if __name__ != "__main__":
    main()
```
hint: Put `if __name__ == "__main__":` at the bottom and call `main()` under it.
:::

## The Guild's hero
id: guild-hero
stage: guild
needs: module-main
minutes: 5
goal: Sam needs a bag that belongs to Sam alone.
source: Python docs: dataclasses.field | https://docs.python.org/3/library/dataclasses.html#dataclasses.field

### Assignment

A **class attribute** such as `bag = []` belongs to the class, not to one hero: every instance reads the same list, and an append through one hero shows up for all of them. A **dataclass** field can build a fresh value for each instance with `field(default_factory=list)`; the factory runs once per hero.

Turn `Hero` into a dataclass with `name`, `hp` and `bag`, and add `take(item)` and `hurt(amount)`. The code below the marker makes two heroes and gives Sam two items; the console must show:

```text
Sam ['lamp', 'key'] 6
Ada []
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
class Hero:
    bag = []

    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def take(self, item):
        self.bag.append(item)

    def hurt(self, amount):
        self.hp = max(0, self.hp - amount)


# Don't touch below this line
sam = Hero("Sam", 10)
ada = Hero("Ada", 10)
sam.take("lamp")
sam.take("key")
sam.hurt(4)
print(sam.name, sam.bag, sam.hp)
print(ada.name, ada.bag)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "Sam ['lamp', 'key'] 6\nAda []"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

import dataclasses
from solution import Hero

def test_is_dataclass():
    assert dataclasses.is_dataclass(Hero), "Hero should be a dataclass."

def test_bags_are_separate():
    a, b = Hero("Sam", 10), Hero("Ada", 10)
    a.take("lamp")
    assert a.bag == ["lamp"]
    assert b.bag == []

def test_hurt_stops_at_zero():
    h = Hero("Sam", 10)
    h.hurt(4)
    assert h.hp == 6
    h.hurt(9)
    assert h.hp == 0

def test_take_changes_the_hero():
    h = Hero("Sam", 10)
    h.take("rope")
    assert h.bag == ["rope"]

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'sam = Hero("Sam", 10)\nada = Hero("Ada", 10)\nsam.take("lamp")\nsam.take("key")\nsam.hurt(4)\nprint(sam.name, sam.bag, sam.hp)\nprint(ada.name, ada.bag)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert has_node('ClassDef'), 'Your code needs a `class`.'

def test_code_1():
    assert calls('field'), 'Call `field()` in your code.'

def test_code_2():
    assert defines('take'), 'Define `take`.'

def test_code_3():
    assert defines('hurt'), 'Define `hurt`.'
```
solution:
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)

    def take(self, item):
        self.bag.append(item)

    def hurt(self, amount):
        self.hp = max(0, self.hp - amount)


# Don't touch below this line
sam = Hero("Sam", 10)
ada = Hero("Ada", 10)
sam.take("lamp")
sam.take("key")
sam.hurt(4)
print(sam.name, sam.bag, sam.hp)
print(ada.name, ada.bag)
```
wrong: keeps the shared class attribute
```python
class Hero:
    bag = []

    def __init__(self, name, hp):
        self.name = name
        self.hp = hp

    def take(self, item):
        self.bag.append(item)

    def hurt(self, amount):
        self.hp = max(0, self.hp - amount)


# Don't touch below this line
sam = Hero("Sam", 10)
ada = Hero("Ada", 10)
sam.take("lamp")
sam.take("key")
sam.hurt(4)
print(sam.name, sam.bag, sam.hp)
print(ada.name, ada.bag)
```
wrong: builds a new bag instead of changing this hero's
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)

    def take(self, item):
        return self.bag + [item]

    def hurt(self, amount):
        self.hp = max(0, self.hp - amount)


# Don't touch below this line
sam = Hero("Sam", 10)
ada = Hero("Ada", 10)
sam.take("lamp")
sam.take("key")
sam.hurt(4)
print(sam.name, sam.bag, sam.hp)
print(ada.name, ada.bag)
```
wrong: lets health go negative
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)

    def take(self, item):
        self.bag.append(item)

    def hurt(self, amount):
        self.hp -= amount


# Don't touch below this line
sam = Hero("Sam", 10)
ada = Hero("Ada", 10)
sam.take("lamp")
sam.take("key")
sam.hurt(4)
print(sam.name, sam.bag, sam.hp)
print(ada.name, ada.bag)
```
hint: `@dataclass` plus `field(default_factory=list)` builds a new bag for each hero. `take` appends to `self.bag`; `hurt` uses `max(0, ...)`.
:::

## The Guild's map
id: guild-world
stage: guild
needs: guild-hero
minutes: 5
goal: The map is rooms, exits and things you can pick up.
source: Python tutorial: Classes | https://docs.python.org/3/tutorial/classes.html

### Assignment

A `Room` holds a name, a dictionary of exits (`direction -> room name`) and the items lying in it. A `Game` holds the hero, all the rooms and the room the hero is in. `move(direction)` must look the direction up, change the room only when the exit exists, and return `True` or `False`. `take(item)` must remove the item from the room **and** put it in the hero's bag.

Fill in the three `Game` methods. The code below the marker walks and takes; the console must show:

```text
cellar ['lamp', 'key']
False
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        pass

    def move(self, direction):
        return False

    def take(self, item):
        return False


# Don't touch below this line
rooms = {
    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
    "cellar": Room("cellar", {"south": "hall"}, ["key"]),
}
game = Game(Hero("Sam", 20), rooms, "hall")
game.take("lamp")
game.move("north")
game.take("key")
print(game.room, game.hero.bag)
print(game.move("north"))
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = "cellar ['lamp', 'key']\nFalse"

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

from solution import Hero, Room, Game

def make_game():
    rooms = {
        "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
        "cellar": Room("cellar", {"south": "hall"}, ["key"]),
    }
    return Game(Hero("Sam", 20), rooms, "hall")

def test_move():
    g = make_game()
    assert g.move("north") is True
    assert g.room == "cellar"
    assert g.move("north") is False
    assert g.room == "cellar"

def test_take():
    g = make_game()
    assert g.take("lamp") is True
    assert g.hero.bag == ["lamp"]
    assert g.rooms["hall"].items == []
    assert g.take("key") is False

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'rooms = {\n    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),\n    "cellar": Room("cellar", {"south": "hall"}, ["key"]),\n}\ngame = Game(Hero("Sam", 20), rooms, "hall")\ngame.take("lamp")\ngame.move("north")\ngame.take("key")\nprint(game.room, game.hero.bag)\nprint(game.move("north"))', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert defines('move'), 'Define `move`.'

def test_code_1():
    assert defines('take'), 'Define `take`.'
```
solution:
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def move(self, direction):
        exits = self.rooms[self.room].exits
        if direction not in exits:
            return False
        self.room = exits[direction]
        return True

    def take(self, item):
        items = self.rooms[self.room].items
        if item not in items:
            return False
        items.remove(item)
        self.hero.bag.append(item)
        return True


# Don't touch below this line
rooms = {
    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
    "cellar": Room("cellar", {"south": "hall"}, ["key"]),
}
game = Game(Hero("Sam", 20), rooms, "hall")
game.take("lamp")
game.move("north")
game.take("key")
print(game.room, game.hero.bag)
print(game.move("north"))
```
wrong: moves without checking that the exit exists
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def move(self, direction):
        self.room = self.rooms[self.room].exits[direction]
        return True

    def take(self, item):
        items = self.rooms[self.room].items
        if item not in items:
            return False
        items.remove(item)
        self.hero.bag.append(item)
        return True


# Don't touch below this line
rooms = {
    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
    "cellar": Room("cellar", {"south": "hall"}, ["key"]),
}
game = Game(Hero("Sam", 20), rooms, "hall")
game.take("lamp")
game.move("north")
game.take("key")
print(game.room, game.hero.bag)
print(game.move("north"))
```
wrong: puts the item in the bag but leaves it in the room
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def move(self, direction):
        exits = self.rooms[self.room].exits
        if direction not in exits:
            return False
        self.room = exits[direction]
        return True

    def take(self, item):
        if item not in self.rooms[self.room].items:
            return False
        self.hero.bag.append(item)
        return True


# Don't touch below this line
rooms = {
    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
    "cellar": Room("cellar", {"south": "hall"}, ["key"]),
}
game = Game(Hero("Sam", 20), rooms, "hall")
game.take("lamp")
game.move("north")
game.take("key")
print(game.room, game.hero.bag)
print(game.move("north"))
```
hint: In `move`, check `direction in exits` before changing `self.room`. In `take`, use `items.remove(item)` and `self.hero.bag.append(item)`.
:::

## The Guild's ledger
id: guild-save
stage: guild
needs: guild-world
minutes: 5
goal: A game that forgets the bag is not a game.
source: Python docs: dataclasses | https://docs.python.org/3/library/dataclasses.html

### Assignment

`dataclasses.asdict(obj)` turns a dataclass into a plain dictionary, which JSON can store. To load it back, rebuild each object from its dictionary: `Hero(**data["hero"])`, and one `Room(**room)` for every entry in the rooms.

Add `to_dict()` and `from_dict(data)` to `Game`, plus `save(path)` and `load(path)`. The code below the marker saves and loads a game; the console must show:

```text
hall ['lamp'] key
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
import json
from dataclasses import asdict, dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def to_dict(self):
        return {}

    @classmethod
    def from_dict(cls, data):
        return None

    def save(self, path):
        pass

    @classmethod
    def load(cls, path):
        pass


# Don't touch below this line
rooms = {
    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
    "cellar": Room("cellar", {"south": "hall"}, ["key"]),
}
game = Game(Hero("Sam", 20), rooms, "hall")
game.save("save.json")
loaded = Game.load("save.json")
print(loaded.room, loaded.hero.bag, loaded.rooms["cellar"].items[0])
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

import json, os
from solution import Hero, Room, Game

def make_game():
    rooms = {
        "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
        "cellar": Room("cellar", {"south": "hall"}, ["key"]),
    }
    g = Game(Hero("Sam", 20), rooms, "hall")
    g.hero.bag.append("rope")
    return g

def test_round_trip():
    path = os.path.join(HERE, "game.json")
    g = make_game()
    g.save(path)
    back = Game.load(path)
    assert back.room == "hall"
    assert back.hero.name == "Sam"
    assert back.hero.bag == ["rope"]
    assert back.rooms["cellar"].items == ["key"]
    assert back.rooms["hall"].exits == {"north": "cellar"}

def test_file_is_json():
    path = os.path.join(HERE, "game2.json")
    make_game().save(path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    assert data["hero"]["name"] == "Sam"

def test_load_returns_a_game():
    path = os.path.join(HERE, "game3.json")
    make_game().save(path)
    assert isinstance(Game.load(path), Game)

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'rooms = {\n    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),\n    "cellar": Room("cellar", {"south": "hall"}, ["key"]),\n}\ngame = Game(Hero("Sam", 20), rooms, "hall")\ngame.save("save.json")\nloaded = Game.load("save.json")\nprint(loaded.room, loaded.hero.bag, loaded.rooms["cellar"].items[0])', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert calls('asdict'), 'Call `asdict()` in your code.'

def test_code_1():
    assert calls('dump'), 'Call `dump()` in your code.'

def test_code_2():
    assert calls('load'), 'Call `load()` in your code.'

def test_code_3():
    assert has_node('ClassDef'), 'Your code needs a `class`.'
```
solution:
```python
import json
from dataclasses import asdict, dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def to_dict(self):
        return {
            "hero": asdict(self.hero),
            "rooms": {name: asdict(room) for name, room in self.rooms.items()},
            "room": self.room,
        }

    @classmethod
    def from_dict(cls, data):
        hero = Hero(**data["hero"])
        rooms = {name: Room(**room) for name, room in data["rooms"].items()}
        return cls(hero, rooms, data["room"])

    def save(self, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f)

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))


# Don't touch below this line
rooms = {
    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
    "cellar": Room("cellar", {"south": "hall"}, ["key"]),
}
game = Game(Hero("Sam", 20), rooms, "hall")
game.save("save.json")
loaded = Game.load("save.json")
print(loaded.room, loaded.hero.bag, loaded.rooms["cellar"].items[0])
```
wrong: serialises the game with str(), which is not JSON
```python
import json
from dataclasses import asdict, dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def to_dict(self):
        return str(self)

    @classmethod
    def from_dict(cls, data):
        return None

    def save(self, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f)

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))


# Don't touch below this line
rooms = {
    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
    "cellar": Room("cellar", {"south": "hall"}, ["key"]),
}
game = Game(Hero("Sam", 20), rooms, "hall")
game.save("save.json")
loaded = Game.load("save.json")
print(loaded.room, loaded.hero.bag, loaded.rooms["cellar"].items[0])
```
wrong: builds the JSON text but never writes the file
```python
import json
from dataclasses import asdict, dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def to_dict(self):
        return {"hero": asdict(self.hero), "rooms": {n: asdict(r) for n, r in self.rooms.items()}, "room": self.room}

    @classmethod
    def from_dict(cls, data):
        hero = Hero(**data["hero"])
        rooms = {name: Room(**room) for name, room in data["rooms"].items()}
        return cls(hero, rooms, data["room"])

    def save(self, path):
        json.dumps(self.to_dict())

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))


# Don't touch below this line
rooms = {
    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
    "cellar": Room("cellar", {"south": "hall"}, ["key"]),
}
game = Game(Hero("Sam", 20), rooms, "hall")
game.save("save.json")
loaded = Game.load("save.json")
print(loaded.room, loaded.hero.bag, loaded.rooms["cellar"].items[0])
```
wrong: throws away the rooms when loading
```python
import json
from dataclasses import asdict, dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def to_dict(self):
        return {"hero": asdict(self.hero), "rooms": {name: asdict(room) for name, room in self.rooms.items()}, "room": self.room}

    @classmethod
    def from_dict(cls, data):
        return cls(Hero(**data["hero"]), {}, data["room"])

    def save(self, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f)

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))


# Don't touch below this line
rooms = {
    "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
    "cellar": Room("cellar", {"south": "hall"}, ["key"]),
}
game = Game(Hero("Sam", 20), rooms, "hall")
game.save("save.json")
loaded = Game.load("save.json")
print(loaded.room, loaded.hero.bag, loaded.rooms["cellar"].items[0])
```
hint: `to_dict` can be one `asdict` for the hero and a dict comprehension over `self.rooms`. `from_dict` reverses it with `Hero(**...)` and `Room(**...)`.
:::

## The Guild's game
id: guild-play
stage: guild
needs: guild-save
minutes: 15
goal: Time to play the game the Guild asked for.
source: Python tutorial: Classes | https://docs.python.org/3/tutorial/classes.html
project: true

### Assignment

The engine is written: `Hero`, `Room`, `Game`, `new_game()` and the two rooms are below. Your job is `play(commands)`, which takes a list of command lines and returns a list of transcript lines. For each command: `look` describes the room and its items; `go <direction>` moves; `take <item>` picks something up; anything else gets `You can't do that.`. Finish with one `Bag: ...` line.

The exact words matter; the tests compare the transcript line for line. Each call starts a fresh game.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)

    def take(self, item):
        self.bag.append(item)

    def hurt(self, amount):
        self.hp = max(0, self.hp - amount)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def move(self, direction):
        exits = self.rooms[self.room].exits
        if direction not in exits:
            return False
        self.room = exits[direction]
        return True

    def take(self, item):
        items = self.rooms[self.room].items
        if item not in items:
            return False
        items.remove(item)
        self.hero.bag.append(item)
        return True


def new_game():
    rooms = {
        "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
        "cellar": Room("cellar", {"south": "hall"}, ["key"]),
    }
    return Game(Hero("Sam", 20), rooms, "hall")


def play(commands):
    return []


# Don't touch below this line
if __name__ == "__main__":
    for line in play(["look", "take lamp", "go north", "take key"]):
        print(line)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import play

def test_walk_and_take():
    got = play(["look", "take lamp", "go north", "take key"])
    assert got == [
        "You are in the hall. Items: lamp.",
        "You take the lamp.",
        "You go north to the cellar.",
        "You take the key.",
        "Bag: key, lamp.",
    ]

def test_failures():
    got = play(["go south", "take key", "dance"])
    assert got == [
        "You can't go that way.",
        "There is no key here.",
        "You can't do that.",
        "Bag: empty.",
    ]

def test_each_call_is_fresh():
    play(["take lamp", "go north", "take key"])
    got = play(["look"])
    assert got == [
        "You are in the hall. Items: lamp.",
        "Bag: empty.",
    ]

def test_no_commands():
    assert play([]) == ["Bag: empty."]

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'if __name__ == "__main__":\n    for line in play(["look", "take lamp", "go north", "take key"]):\n        print(line)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert defines('play'), 'Define `play`.'

def test_code_1():
    assert has_node('For'), 'Your code needs a `for loop`.'

def test_code_2():
    assert calls('move'), 'Call `move()` in your code.'

def test_code_3():
    assert calls('take'), 'Call `take()` in your code.'
```
solution:
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)

    def take(self, item):
        self.bag.append(item)

    def hurt(self, amount):
        self.hp = max(0, self.hp - amount)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def move(self, direction):
        exits = self.rooms[self.room].exits
        if direction not in exits:
            return False
        self.room = exits[direction]
        return True

    def take(self, item):
        items = self.rooms[self.room].items
        if item not in items:
            return False
        items.remove(item)
        self.hero.bag.append(item)
        return True


def new_game():
    rooms = {
        "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
        "cellar": Room("cellar", {"south": "hall"}, ["key"]),
    }
    return Game(Hero("Sam", 20), rooms, "hall")


def play(commands):
    game = new_game()
    lines = []
    for command in commands:
        parts = command.strip().lower().split(maxsplit=1)
        if not parts:
            continue
        verb = parts[0]
        rest = parts[1] if len(parts) > 1 else ""
        if verb == "look":
            items = game.rooms[game.room].items
            shown_items = ", ".join(items) if items else "none"
            lines.append(f"You are in the {game.room}. Items: {shown_items}.")
        elif verb == "go" and rest:
            if game.move(rest):
                lines.append(f"You go {rest} to the {game.room}.")
            else:
                lines.append("You can't go that way.")
        elif verb == "take" and rest:
            if game.take(rest):
                lines.append(f"You take the {rest}.")
            else:
                lines.append(f"There is no {rest} here.")
        else:
            lines.append("You can't do that.")
    bag = ", ".join(sorted(game.hero.bag)) or "empty"
    lines.append(f"Bag: {bag}.")
    return lines


# Don't touch below this line
if __name__ == "__main__":
    for line in play(["look", "take lamp", "go north", "take key"]):
        print(line)
```
wrong: keeps one game between calls, so the second run is not fresh
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)

    def take(self, item):
        self.bag.append(item)

    def hurt(self, amount):
        self.hp = max(0, self.hp - amount)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def move(self, direction):
        exits = self.rooms[self.room].exits
        if direction not in exits:
            return False
        self.room = exits[direction]
        return True

    def take(self, item):
        items = self.rooms[self.room].items
        if item not in items:
            return False
        items.remove(item)
        self.hero.bag.append(item)
        return True


def new_game():
    rooms = {
        "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
        "cellar": Room("cellar", {"south": "hall"}, ["key"]),
    }
    return Game(Hero("Sam", 20), rooms, "hall")


GAME = new_game()


def play(commands):
    game = GAME
    lines = []
    for command in commands:
        parts = command.strip().lower().split(maxsplit=1)
        if not parts:
            continue
        verb = parts[0]
        rest = parts[1] if len(parts) > 1 else ""
        if verb == "look":
            items = game.rooms[game.room].items
            shown_items = ", ".join(items) if items else "none"
            lines.append(f"You are in the {game.room}. Items: {shown_items}.")
        elif verb == "go" and rest:
            if game.move(rest):
                lines.append(f"You go {rest} to the {game.room}.")
            else:
                lines.append("You can't go that way.")
        elif verb == "take" and rest:
            if game.take(rest):
                lines.append(f"You take the {rest}.")
            else:
                lines.append(f"There is no {rest} here.")
        else:
            lines.append("You can't do that.")
    bag = ", ".join(sorted(game.hero.bag)) or "empty"
    lines.append(f"Bag: {bag}.")
    return lines
```
wrong: forgets the closing bag line
```python
from dataclasses import dataclass, field


@dataclass
class Hero:
    name: str
    hp: int
    bag: list = field(default_factory=list)

    def take(self, item):
        self.bag.append(item)

    def hurt(self, amount):
        self.hp = max(0, self.hp - amount)


@dataclass
class Room:
    name: str
    exits: dict
    items: list


class Game:
    def __init__(self, hero, rooms, room):
        self.hero = hero
        self.rooms = rooms
        self.room = room

    def move(self, direction):
        exits = self.rooms[self.room].exits
        if direction not in exits:
            return False
        self.room = exits[direction]
        return True

    def take(self, item):
        items = self.rooms[self.room].items
        if item not in items:
            return False
        items.remove(item)
        self.hero.bag.append(item)
        return True


def new_game():
    rooms = {
        "hall": Room("hall", {"north": "cellar"}, ["lamp"]),
        "cellar": Room("cellar", {"south": "hall"}, ["key"]),
    }
    return Game(Hero("Sam", 20), rooms, "hall")


def play(commands):
    game = new_game()
    lines = []
    for command in commands:
        parts = command.strip().lower().split(maxsplit=1)
        if not parts:
            continue
        verb = parts[0]
        rest = parts[1] if len(parts) > 1 else ""
        if verb == "look":
            items = game.rooms[game.room].items
            shown_items = ", ".join(items) if items else "none"
            lines.append(f"You are in the {game.room}. Items: {shown_items}.")
        elif verb == "go" and rest:
            if game.move(rest):
                lines.append(f"You go {rest} to the {game.room}.")
            else:
                lines.append("You can't go that way.")
        elif verb == "take" and rest:
            if game.take(rest):
                lines.append(f"You take the {rest}.")
            else:
                lines.append(f"There is no {rest} here.")
        else:
            lines.append("You can't do that.")
    return lines
```
hint: Split each command with `split(maxsplit=1)`, then use `if`/`elif`. Call `game.move` and `game.take`; they return `True` or `False`. Build the bag line with `", ".join(sorted(...))`.
:::

## Quiz: the bag that isn't there
id: quiz-method
stage: guild
needs: guild-play
minutes: 5
goal: Two heroes, one lesson.
source: Python tutorial: Classes | https://docs.python.org/3/tutorial/classes.html

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
class Hero:
    bag = []

    def __init__(self, name):
        self.name = name

a = Hero("Sam")
b = Hero("Ada")
a.bag.append("lamp")
print(b.bag)
```
answer:
```
['lamp']
```
why: bag is a class attribute, so both heroes share one list. A dataclass field with default_factory=list gives each hero its own.
:::

## A fixed record
id: g1-tuple-record
stage: tuples
needs: quiz-method
minutes: 5
goal: The Guild's card for Sam is a fixed record: name, hp, level.
source: Python tutorial: Tuples and sequences | https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences

### Assignment

Write `sheet(hero)`. `hero` is a tuple `(name, hp, level)`. Index it and return a line like `sheet(("Sam", 40, 3))` equal to `"Sam (level 3) has 40 hp"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def sheet(hero):
    return ""
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import sheet

def test_values():
    assert sheet(("Sam", 40, 3)) == "Sam (level 3) has 40 hp"
    assert sheet(("Mira", 0, 1)) == "Mira (level 1) has 0 hp"
    assert sheet(("Bran", 12, 10)) == "Bran (level 10) has 12 hp"

def test_code_0():
    assert has_node('Subscript'), 'Index the tuple, like `hero[0]`.'

import copy, random
from solution import sheet as LEARNER
def ref(hero):
    return f"{hero[0]} (level {hero[2]}) has {hero[1]} hp"

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [(r.choice(names), r.randint(0, 40), r.randint(1, 12))]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "sheet%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def sheet(hero):
    return f"{hero[0]} (level {hero[2]}) has {hero[1]} hp"
```
wrong: unpacks the tuple instead of indexing it
```python
def sheet(hero):
    name, hp, level = hero
    return f"{name} (level {level}) has {hp} hp"
```
wrong: swaps hp and level
```python
def sheet(hero):
    return f"{hero[0]} (level {hero[1]}) has {hero[2]} hp"
```
hint: `hero[0]` is the name, `hero[1]` the hp, `hero[2]` the level.
:::

## Unpacking
id: g1-unpack
stage: tuples
needs: g1-tuple-record
minutes: 5
goal: Sam's card won't open: the clerk unpacked two names from a three-part record.
source: Python tutorial: Tuples and sequences | https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences

### Assignment

The starter crashes. `name, hp = hero` takes two names from a tuple of three values. Give every value a name so the console shows:

```text
Sam 40 3
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
hero = ("Sam", 40, 3)
name, hp = hero

# Don't touch below this line
print(name, hp, level)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = 'Sam 40 3'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(name, hp, level)', "The code under # Don't touch below this line must stay as it was"
```
solution:
```python
hero = ("Sam", 40, 3)
name, hp, level = hero

# Don't touch below this line
print(name, hp, level)
```
wrong: puts hp in the level name
```python
hero = ("Sam", 40, 3)
name, level, hp = hero

# Don't touch below this line
print(name, hp, level)
```
wrong: reads hp twice
```python
hero = ("Sam", 40, 3)
name, hp, level = hero[0], hero[1], hero[1]

# Don't touch below this line
print(name, hp, level)
```
hint: `name, hp, level = hero` needs one name per value.
:::

## Star unpacking
id: g1-star-unpack
stage: tuples
needs: g1-unpack
minutes: 5
goal: The queue at the gate has a first hero, a last hero, and everyone in between.
source: Python tutorial: Tuples and sequences | https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences

### Assignment

Write `split_queue(queue)`. `queue` is a list of at least one name. Use both `first, *rest = queue` and `*body, last = queue`. Return `(first, rest, body, last)`. `rest` and `body` are lists. `split_queue(["Sam", "Mira", "Bran"])` is `("Sam", ["Mira", "Bran"], ["Sam", "Mira"], "Bran")`. `split_queue(["Sam"])` is `("Sam", [], [], "Sam")`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def split_queue(queue):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import split_queue

def test_values():
    assert split_queue(["Sam", "Mira", "Bran"]) == ("Sam", ["Mira", "Bran"], ["Sam", "Mira"], "Bran")
    assert split_queue(["Sam"]) == ("Sam", [], [], "Sam")
    assert split_queue(["axe", "bow"]) == ("axe", ["bow"], ["axe"], "bow")

def test_star_makes_lists():
    _, rest, body, _ = split_queue(["Sam", "Mira"])
    assert type(rest) is list and type(body) is list

def test_code_0():
    assert has_token('*'), 'Use `*` to unpack, as in `first, *rest = queue`.'

import copy, random
from solution import split_queue as LEARNER
def ref(queue):
    first, *rest = queue
    *body, last = queue
    return first, rest, body, last

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [[r.choice(names) for _ in range(r.randint(1, 6))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "split_queue%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def split_queue(queue):
    first, *rest = queue
    *body, last = queue
    return first, rest, body, last
```
wrong: slices instead of star-unpacking
```python
def split_queue(queue):
    first, rest = queue[0], queue[1:]
    body, last = queue[:-1], queue[-1]
    return first, rest, body, last
```
wrong: drops the first hero from the body
```python
def split_queue(queue):
    first, *rest = queue
    *body, last = rest if rest else queue
    return first, rest, body, last
```
hint: `first, *rest = queue` keeps the first item and a list of the rest. `*body, last = queue` does it from the other end.
:::

## Tuples can't be changed
id: g1-tuple-immutable
stage: tuples
needs: g1-star-unpack
minutes: 5
goal: Sam's card is a tuple, so a heal has to be written on a new card.
source: Python tutorial: Tuples and sequences | https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences

### Assignment

The starter crashes: it tries to assign into the tuple. Write `heal(hero, amount)`. `hero` is `(name, hp, level)`. Return a new tuple with `amount` added to hp (amount may be negative). Leave the tuple you were given unchanged. `heal(("Sam", 40, 3), 5)` is `("Sam", 45, 3)`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def heal(hero, amount):
    hero[1] = hero[1] + amount
    return hero
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

import copy, random
from solution import heal as LEARNER
def ref(hero, amount):
    name, hp, level = hero
    return (name, hp + amount, level)

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [(r.choice(names), r.randint(0, 40), r.randint(1, 10)), r.randint(-5, 12)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "heal%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def heal(hero, amount):
    name, hp, level = hero
    return (name, hp + amount, level)
```
wrong: returns a list
```python
def heal(hero, amount):
    name, hp, level = hero
    return [name, hp + amount, level]
```
wrong: adds the amount to the level
```python
def heal(hero, amount):
    name, hp, level = hero
    return (name, hp, level + amount)
```
hint: Build a new tuple: `(name, hp + amount, level)`.
:::

## Unpacking in a loop
id: g1-enumerate-unpack
stage: tuples
needs: g1-tuple-immutable
minutes: 5
goal: The roll call reads each hero's name and hp together.
source: Python tutorial: Looping techniques | https://docs.python.org/3/tutorial/datastructures.html#looping-techniques

### Assignment

Write `still_fighting(party)`. `party` is a list of `(name, hp)` pairs. Return the names whose hp is above 0, in the same order. Unpack each pair: `for name, hp in party`. `still_fighting([("Sam", 10), ("Mira", 0), ("Bran", 3)])` is `["Sam", "Bran"]`. An empty party is `[]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def still_fighting(party):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import still_fighting

def test_values():
    assert still_fighting([("Sam", 10), ("Mira", 0), ("Bran", 3)]) == ["Sam", "Bran"]
    assert still_fighting([]) == []
    assert still_fighting([("Mira", 0), ("Bran", -1)]) == []
    assert still_fighting([("Sam", 1), ("Sam", 0), ("Sam", 2)]) == ["Sam", "Sam"]

def test_code_0():
    assert has_node('For'), 'Your code needs a `for loop`.'

import copy, random
from solution import still_fighting as LEARNER
def ref(party):
    return [name for name, hp in party if hp > 0]

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [[(r.choice(names), r.randint(-2, 8)) for _ in range(r.randint(0, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "still_fighting%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def still_fighting(party):
    names = []
    for name, hp in party:
        if hp > 0:
            names.append(name)
    return names
```
wrong: a comprehension instead of a loop
```python
def still_fighting(party):
    return [name for name, hp in party if hp > 0]
```
wrong: keeps heroes on 0 hp
```python
def still_fighting(party):
    names = []
    for name, hp in party:
        if hp >= 0:
            names.append(name)
    return names
```
hint: `for name, hp in party:` then keep the name when `hp > 0`.
:::

## Return several values
id: g1-namedtuple-lite
stage: tuples
needs: g1-enumerate-unpack
minutes: 5
goal: One swing of the fight deals damage and takes it, both at once.
source: Python tutorial: Tuples and sequences | https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences

### Assignment

Write `fight_round(hero_atk, foe_atk)` that returns the pair `(dealt, taken)`. `dealt` is `hero_atk`. `taken` is `foe_atk // 2`. Then unpack the call `fight_round(7, 5)` into the names `dealt` and `taken`. The console shows:

```text
7
2
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def fight_round(hero_atk, foe_atk):
    return None

dealt, taken = fight_round(7, 5)

# Don't touch below this line
print(dealt)
print(taken)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '7\n2'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

from solution import fight_round

def test_pair():
    assert fight_round(7, 5) == (7, 2)
    assert fight_round(0, 1) == (0, 0)
    assert fight_round(4, 8) == (4, 4)
    assert fight_round(3, 0) == (3, 0)
    assert type(fight_round(7, 5)) is tuple, "return a tuple so the caller can unpack it"

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'print(dealt)\nprint(taken)', "The code under # Don't touch below this line must stay as it was"

import copy, random
from solution import fight_round as LEARNER
def ref(hero_atk, foe_atk):
    return hero_atk, foe_atk // 2

def gen(r):
    return [r.randint(0, 30), r.randint(0, 30)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "fight_round%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def fight_round(hero_atk, foe_atk):
    return hero_atk, foe_atk // 2

dealt, taken = fight_round(7, 5)

# Don't touch below this line
print(dealt)
print(taken)
```
wrong: swaps dealt and taken
```python
def fight_round(hero_atk, foe_atk):
    return foe_atk // 2, hero_atk

dealt, taken = fight_round(7, 5)

# Don't touch below this line
print(dealt)
print(taken)
```
wrong: forgets to halve the blow
```python
def fight_round(hero_atk, foe_atk):
    return hero_atk, foe_atk

dealt, taken = fight_round(7, 5)

# Don't touch below this line
print(dealt)
print(taken)
```
hint: `return hero_atk, foe_atk // 2`, then `dealt, taken = fight_round(7, 5)`.
:::

## Quiz: the missing comma
id: g1-quiz-tuple
stage: tuples
needs: g1-namedtuple-lite
minutes: 5
goal: The armory labels a single sword, and the comma goes missing.
source: Python tutorial: Tuples and sequences | https://docs.python.org/3/tutorial/datastructures.html#tuples-and-sequences

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
print(type(("sword")).__name__)
print(("sword",))
print(len(("sword",)))
```
answer:
```
str
('sword',)
1
```
why: Parentheses without a comma only group an expression, so ("sword") is a string. A one-item tuple needs the trailing comma, and its length is 1.
:::

## Functions in a dictionary
id: g1-fn-as-value
stage: functional
needs: g1-quiz-tuple
minutes: 5
goal: Sam shouts a command, and the right action answers.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

Write `heal(hp)`, `hit(hp)` and `wait(hp)`. `heal` adds 4. `hit` subtracts 6 but never goes below 0. `wait` returns hp unchanged. Store the functions in a dict `COMMANDS = {"heal": heal, "hit": hit, "wait": wait}`. Write `act(command, hp)` that calls the function stored under that command. `act("heal", 10)` is 14, `act("hit", 10)` is 4, `act("hit", 3)` is 0, and `act("wait", 3)` is 3.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def heal(hp):
    return None

def hit(hp):
    return None

def wait(hp):
    return None

COMMANDS = {}

def act(command, hp):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert has_node('Dict'), 'Your code needs a `Dict`.'

def test_code_1():
    assert uses_name('COMMANDS'), 'Use the name `COMMANDS`.'

def test_code_2():
    assert defines('heal'), 'Define `heal`.'

def test_code_3():
    assert defines('hit'), 'Define `hit`.'

def test_code_4():
    assert defines('wait'), 'Define `wait`.'

def test_code_5():
    assert defines('act'), 'Define `act`.'

import copy, random
from solution import act as LEARNER
def ref(command, hp):
    if command == "heal":
        return hp + 4
    if command == "hit":
        return max(0, hp - 6)
    return hp

def gen(r):
    return [r.choice(["heal", "hit", "wait"]), r.randint(0, 30)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "act%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def heal(hp):
    return hp + 4

def hit(hp):
    return max(0, hp - 6)

def wait(hp):
    return hp

COMMANDS = {"heal": heal, "hit": hit, "wait": wait}

def act(command, hp):
    return COMMANDS[command](hp)
```
wrong: if/elif instead of a dictionary of functions
```python
def act(command, hp):
    if command == "heal":
        return hp + 4
    if command == "hit":
        return max(0, hp - 6)
    return hp
```
wrong: hit can drop hp below 0
```python
def heal(hp):
    return hp + 4

def hit(hp):
    return hp - 6

def wait(hp):
    return hp

COMMANDS = {"heal": heal, "hit": hit, "wait": wait}

def act(command, hp):
    return COMMANDS[command](hp)
```
hint: `COMMANDS = {"heal": heal, "hit": hit, "wait": wait}` and `return COMMANDS[command](hp)`.
:::

## Sorting with a key function
id: g1-sort-key
stage: functional
needs: g1-fn-as-value
minutes: 5
goal: The healer wants the party ordered by hp.
source: Python HOWTO: Sorting (key functions) | https://docs.python.org/3/howto/sorting.html#key-functions

### Assignment

Write a named function `by_hp(hero)` that returns the hp of a `(name, hp)` pair. Write `rank(heroes)` using `sorted`, `min` and `max`, each with `key=by_hp`. Return `(ordered, frailest, toughest)`. `ordered` is the pairs sorted by hp, lowest first. Ties keep their original order. `frailest` is the first pair with the lowest hp, and `toughest` is the first pair with the highest hp. `rank([])` is `([], None, None)`. `rank([("Sam", 5), ("Mira", 9), ("Bran", 5)])` is `([("Sam", 5), ("Bran", 5), ("Mira", 9)], ("Sam", 5), ("Mira", 9))`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def rank(heroes):
    return [], None, None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert defines('by_hp'), 'Define `by_hp`.'

def test_code_1():
    assert keyword_arg('key'), 'Pass `key=` as a keyword argument.'

def test_code_2():
    assert calls('sorted'), 'Call `sorted()` in your code.'

def test_code_3():
    assert calls('min'), 'Call `min()` in your code.'

def test_code_4():
    assert calls('max'), 'Call `max()` in your code.'

def test_code_5():
    assert not has_node('Lambda'), 'Use a named function for the key, not a lambda.'

import copy, random
from solution import rank as LEARNER
def ref(heroes):
    if not heroes:
        return [], None, None
    return sorted(heroes, key=lambda h: h[1]), min(heroes, key=lambda h: h[1]), max(heroes, key=lambda h: h[1])

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [[(r.choice(names), r.randint(1, 6)) for _ in range(r.randint(0, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "rank%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def by_hp(hero):
    return hero[1]

def rank(heroes):
    if not heroes:
        return [], None, None
    ordered = sorted(heroes, key=by_hp)
    return ordered, min(heroes, key=by_hp), max(heroes, key=by_hp)
```
wrong: sorts by name instead of hp
```python
def by_hp(hero):
    return hero[0]

def rank(heroes):
    if not heroes:
        return [], None, None
    ordered = sorted(heroes, key=by_hp)
    return ordered, min(heroes, key=by_hp), max(heroes, key=by_hp)
```
wrong: a lambda instead of a named function
```python
def rank(heroes):
    if not heroes:
        return [], None, None
    return sorted(heroes, key=lambda hero: hero[1]), min(heroes, key=lambda hero: hero[1]), max(heroes, key=lambda hero: hero[1])
```
hint: `def by_hp(hero): return hero[1]`, then pass `key=by_hp` to `sorted`, `min` and `max`. An empty list returns `[], None, None`.
:::

## Sorting with a lambda
id: g1-lambda
stage: functional
needs: g1-sort-key
minutes: 5
goal: The same order, with the key written in place.
source: Python reference: Lambdas | https://docs.python.org/3/reference/expressions.html#lambda

### Assignment

Write `rank(heroes)` again. `heroes` is a list of `(name, hp)` pairs. Return `(ordered, frailest, toughest)`: the pairs sorted by hp, lowest first; the first pair with the lowest hp; and the first pair with the highest hp. Ties keep their original order. Pass a `lambda` as `key` to `sorted`, `min` and `max`. Do not define `by_hp`. `rank([])` is `([], None, None)`. `rank([("Sam", 5), ("Mira", 9), ("Bran", 5)])` is `([("Sam", 5), ("Bran", 5), ("Mira", 9)], ("Sam", 5), ("Mira", 9))`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def rank(heroes):
    return [], None, None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert has_node('Lambda'), 'Your code needs a `lambda`.'

def test_code_1():
    assert keyword_arg('key'), 'Pass `key=` as a keyword argument.'

def test_code_2():
    assert calls('sorted'), 'Call `sorted()` in your code.'

def test_code_3():
    assert calls('min'), 'Call `min()` in your code.'

def test_code_4():
    assert calls('max'), 'Call `max()` in your code.'

def test_code_5():
    assert not defines('by_hp'), 'Use a lambda for the key, not a function named by_hp.'

import copy, random
from solution import rank as LEARNER
def ref(heroes):
    if not heroes:
        return [], None, None
    return sorted(heroes, key=lambda h: h[1]), min(heroes, key=lambda h: h[1]), max(heroes, key=lambda h: h[1])

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [[(r.choice(names), r.randint(1, 6)) for _ in range(r.randint(0, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "rank%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def rank(heroes):
    if not heroes:
        return [], None, None
    ordered = sorted(heroes, key=lambda hero: hero[1])
    return ordered, min(heroes, key=lambda hero: hero[1]), max(heroes, key=lambda hero: hero[1])
```
wrong: a named function instead of a lambda
```python
def by_hp(hero):
    return hero[1]

def rank(heroes):
    if not heroes:
        return [], None, None
    ordered = sorted(heroes, key=by_hp)
    return ordered, min(heroes, key=by_hp), max(heroes, key=by_hp)
```
wrong: the lambda returns the name
```python
def rank(heroes):
    if not heroes:
        return [], None, None
    ordered = sorted(heroes, key=lambda hero: hero[0])
    return ordered, min(heroes, key=lambda hero: hero[0]), max(heroes, key=lambda hero: hero[0])
```
hint: `key=lambda hero: hero[1]`
:::

## map and filter
id: g1-map-filter
stage: functional
needs: g1-lambda
minutes: 5
goal: The bard names only the heroes still standing.
source: Python docs: map() | https://docs.python.org/3/library/functions.html#map

### Assignment

Write `living_names(party)`. `party` is a list of `(name, hp)` pairs. Return a list of the names whose hp is above 0, in the same order. Use `map` and `filter`, not a list comprehension. `filter` keeps the heroes; `map` takes their names; `list` builds the list. `living_names([("Sam", 5), ("Mira", 0), ("Bran", 2)])` is `["Sam", "Bran"]`. An empty party is `[]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def living_names(party):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import living_names

def test_values():
    assert living_names([("Sam", 5), ("Mira", 0), ("Bran", 2)]) == ["Sam", "Bran"]
    assert living_names([]) == []
    assert living_names([("Mira", 0), ("Bran", -1)]) == []
    assert living_names([("Sam", 1)]) == ["Sam"]

def test_code_0():
    assert calls('map'), 'Call `map()` in your code.'

def test_code_1():
    assert calls('filter'), 'Call `filter()` in your code.'

def test_code_2():
    assert not has_node('ListComp'), "Don't use a `list comprehension` here."

import copy, random
from solution import living_names as LEARNER
def ref(party):
    return [name for name, hp in party if hp > 0]

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [[(r.choice(names), r.randint(-2, 8)) for _ in range(r.randint(0, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "living_names%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def living_names(party):
    return list(map(lambda hero: hero[0], filter(lambda hero: hero[1] > 0, party)))
```
wrong: a comprehension instead of map and filter
```python
def living_names(party):
    return [name for name, hp in party if hp > 0]
```
wrong: keeps heroes on 0 hp
```python
def living_names(party):
    return list(map(lambda hero: hero[0], filter(lambda hero: hero[1] >= 0, party)))
```
wrong: returns the map object without listing it
```python
def living_names(party):
    return map(lambda hero: hero[0], filter(lambda hero: hero[1] > 0, party))
```
hint: `list(map(lambda hero: hero[0], filter(lambda hero: hero[1] > 0, party)))`
:::

## any and all
id: g1-any-all
stage: functional
needs: g1-map-filter
minutes: 5
goal: Before the gate opens: is anyone poisoned, and is everyone ready?
source: Python docs: any() | https://docs.python.org/3/library/functions.html#any

### Assignment

Write `party_check(party)`. `party` is a list of `(name, poisoned, ready)`, and `poisoned` and `ready` are bools. Return `(anyone_poisoned, everyone_ready)`. Use `any` and `all` on generator expressions. An empty party has nobody poisoned, and `all` of no heroes is ready: `party_check([])` is `(False, True)`. `party_check([("Sam", False, True), ("Mira", True, True)])` is `(True, True)`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def party_check(party):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import party_check

def test_values():
    assert party_check([]) == (False, True)
    assert party_check([("Sam", False, True), ("Mira", True, True)]) == (True, True)
    assert party_check([("Sam", False, True)]) == (False, True)
    assert party_check([("Sam", True, False)]) == (True, False)
    assert party_check([("Sam", False, False), ("Mira", False, True)]) == (False, False)
    assert party_check([("Sam", True, True), ("Mira", False, True)]) == (True, True)

def test_code_0():
    assert calls('any'), 'Call `any()` in your code.'

def test_code_1():
    assert calls('all'), 'Call `all()` in your code.'

def test_code_2():
    assert has_node('GeneratorExp'), 'Use a generator expression, like `any(poisoned for _, poisoned, _ in party)`.'

import copy, random
from solution import party_check as LEARNER
def ref(party):
    return any(p for _, p, _ in party), all(r for _, _, r in party)

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [[(r.choice(names), r.choice([True, False]), r.choice([True, False])) for _ in range(r.randint(0, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "party_check%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def party_check(party):
    return any(poisoned for _, poisoned, _ in party), all(ready for _, _, ready in party)
```
wrong: list comprehensions instead of generators
```python
def party_check(party):
    return any([p for _, p, _ in party]), all([ready for _, _, ready in party])
```
wrong: an empty party is not ready
```python
def party_check(party):
    if not party:
        return False, False
    return any(poisoned for _, poisoned, _ in party), all(ready for _, _, ready in party)
```
wrong: swaps any and all
```python
def party_check(party):
    return any(ready for _, _, ready in party), all(poisoned for _, poisoned, _ in party)
```
hint: `any(poisoned for _, poisoned, _ in party)` and `all(ready for _, _, ready in party)`.
:::

## A function that takes a function
id: g1-higher-order
stage: functional
needs: g1-any-all
minutes: 5
goal: Mira practices a spell by casting it again and again.
source: Python FAQ: How do you make a higher order function? | https://docs.python.org/3/faq/programming.html#how-do-you-make-a-higher-order-function-in-python

### Assignment

Write `apply_n(f, x, n)`. Call `f` on `x`, then on that result, `n` times, and return the last result. `n == 0` returns `x` without calling `f`. `apply_n(lambda v: v + 1, 10, 4)` is 14. `apply_n(lambda v: v * 2, 3, 4)` is 48.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def apply_n(f, x, n):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import apply_n

def test_values():
    assert apply_n(lambda v: v + 1, 10, 0) == 10
    assert apply_n(lambda v: v + 1, 10, 1) == 11
    assert apply_n(lambda v: v + 1, 10, 4) == 14
    assert apply_n(lambda v: v * 2, 3, 4) == 48
    assert apply_n(lambda v: v - 3, 0, 2) == -6

import copy, random
from solution import apply_n as LEARNER
def ref(f, x, n):
    result = x
    for _ in range(n):
        result = f(result)
    return result

def gen(r):
    op = r.choice(["inc", "dbl"])
    def f(v):
        if op == "inc":
            return v + 1
        return v * 2
    return [f, r.randint(-3, 10), r.randint(0, 6)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "apply_n%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def apply_n(f, x, n):
    result = x
    for _ in range(n):
        result = f(result)
    return result
```
wrong: stops one call early
```python
def apply_n(f, x, n):
    result = x
    for _ in range(n - 1):
        result = f(result)
    return result
```
wrong: calls f once no matter what n is
```python
def apply_n(f, x, n):
    if n == 0:
        return x
    return f(x)
```
hint: `result = f(result)` inside `for _ in range(n)`.
:::

## A function that returns a function
id: g1-return-function
stage: functional
needs: g1-higher-order
minutes: 5
goal: The enchanter builds a spell that remembers its factor.
source: Python FAQ: How do you make a higher order function? | https://docs.python.org/3/faq/programming.html#how-do-you-make-a-higher-order-function-in-python

### Assignment

Write `make_multiplier(n)`. It returns a function. That function takes a number and returns it multiplied by `n`. Two multipliers keep their own `n`. `make_multiplier(2)(5)` is 10. `make_multiplier(3)(5)` is 15. `make_multiplier(0)(8)` is 0. `make_multiplier(-3)(4)` is -12.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def make_multiplier(n):
    return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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
```
solution:
```python
def make_multiplier(n):
    def multiply(x):
        return x * n
    return multiply
```
wrong: every multiplier shares one factor
```python
factor = 0

def make_multiplier(n):
    global factor
    factor = n
    def multiply(x):
        return x * factor
    return multiply
```
wrong: adds n instead of multiplying by it
```python
def make_multiplier(n):
    def multiply(x):
        return x + n
    return multiply
```
hint: Define `multiply(x)` inside `make_multiplier` so it returns `x * n`, then `return multiply`.
:::

## Quiz: a stable sort
id: g1-quiz-key
stage: functional
needs: g1-return-function
minutes: 5
goal: The scribe sorts the names by length and expects the ties to stay put.
source: Python docs: sorted() | https://docs.python.org/3/library/functions.html#sorted

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
names = ["Mira", "Sam", "Bran", "Ada"]
print(sorted(names, key=len))
```
answer:
```
['Sam', 'Ada', 'Mira', 'Bran']
```
why: key=len compares lengths. sorted is stable, so equal lengths stay in their original order: Sam before Ada, Mira before Bran.
:::

## Quest: the auction
id: g1-q-auction
stage: functional
needs: g1-quiz-key
minutes: 15
goal: The Guild auctions a relic, and the earliest bid wins a tie.
source: Python HOWTO: Sorting (key functions) | https://docs.python.org/3/howto/sorting.html#key-functions
project: true

### Assignment

Write `rank_bids(bids)`. Each bid is a tuple `(name, gold, arrival)`. `arrival` is a number; a smaller one was shouted earlier. Return a new list of the same tuples, highest gold first. When gold ties, the smaller arrival comes first. When gold and arrival both tie, keep the original order. Do not change the list you were given. `rank_bids([("Sam", 10, 1), ("Mira", 10, 0), ("Bran", 12, 2)])` is `[("Bran", 12, 2), ("Mira", 10, 0), ("Sam", 10, 1)]`. `rank_bids([])` is `[]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def rank_bids(bids):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert keyword_arg('key'), 'Pass `key=` as a keyword argument.'

def test_code_1():
    assert calls('sorted'), 'Call `sorted()` in your code.'

def test_code_2():
    assert not calls('sort'), "Don't call `sort()` here."

import copy, random
from solution import rank_bids as LEARNER
def ref(bids):
    return sorted(bids, key=lambda b: (-b[1], b[2]))

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"] + ["Lux"]
    return [[(r.choice(names), r.randint(0, 20), r.randint(0, 10)) for _ in range(r.randint(0, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "rank_bids%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def rank_bids(bids):
    return sorted(bids, key=lambda bid: (-bid[1], bid[2]))
```
wrong: ties keep list order and ignore arrival
```python
def rank_bids(bids):
    return sorted(bids, key=lambda bid: -bid[1])
```
wrong: a later bid wins a tie
```python
def rank_bids(bids):
    return sorted(bids, key=lambda bid: (-bid[1], -bid[2]))
```
wrong: sorts the caller's list
```python
def rank_bids(bids):
    bids.sort(key=lambda bid: (-bid[1], bid[2]))
    return bids
```
hint: Pass `key=` to `sorted`. Higher gold first is `-gold`. On a tie, the smaller arrival comes first.
:::

## Countdown
id: g1-countdown
stage: recursion
needs: g1-q-auction
minutes: 5
goal: The portal closes, counting down to zero.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

Write `countdown(n)` so it prints `n`, then `n - 1`, and so on down through `0`, one number per line. Call `countdown` again with `n - 1`. No `for` loop, no `while` loop, and no `range`. The lines below the marker call it. The console shows:

```text
3
2
1
0
---
1
0
```

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def countdown(n):
    print(n)

# Don't touch below this line
countdown(3)
print("---")
countdown(1)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

EXPECTED = '3\n2\n1\n0\n---\n1\n0'

def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\n" + got + "\n\nExpected:\n" + EXPECTED

from solution import countdown

def test_other_counts():
    assert printed(countdown, 0) == "0"
    assert printed(countdown, 2) == "2\n1\n0"
    assert printed(countdown, 6) == "6\n5\n4\n3\n2\n1\n0"

def test_protected_lines_unchanged():
    assert "# Don't touch below this line" in SRC, "Keep the line # Don't touch below this line"
    assert SRC.split("# Don't touch below this line", 1)[1].strip() == 'countdown(3)\nprint("---")\ncountdown(1)', "The code under # Don't touch below this line must stay as it was"

def test_code_0():
    assert not has_node('For'), "Don't use a `for loop` here."

def test_code_1():
    assert not has_node('While'), "Don't use a `while loop` here."

def test_code_2():
    assert not calls('range'), "Don't call `range()` here."
```
solution:
```python
def countdown(n):
    print(n)
    if n == 0:
        return
    countdown(n - 1)

# Don't touch below this line
countdown(3)
print("---")
countdown(1)
```
wrong: range instead of a recursive call
```python
def countdown(n):
    print(*range(n, -1, -1), sep="\n")

# Don't touch below this line
countdown(3)
print("---")
countdown(1)
```
wrong: a while loop
```python
def countdown(n):
    while n >= 0:
        print(n)
        n -= 1

# Don't touch below this line
countdown(3)
print("---")
countdown(1)
```
wrong: stops before 0
```python
def countdown(n):
    if n == 0:
        return
    print(n)
    countdown(n - 1)

# Don't touch below this line
countdown(3)
print("---")
countdown(1)
```
hint: Print `n`, and if `n` is not 0, call `countdown(n - 1)`.
:::

## Nested gold
id: g1-sum-nested
stage: recursion
needs: g1-countdown
minutes: 5
goal: Chests of gold sit inside other chests.
source: Python docs: sys.setrecursionlimit() | https://docs.python.org/3/library/sys.html#sys.setrecursionlimit

### Assignment

Write `total_gold(chests)`. `chests` is a list whose items are integers or lists of the same kind, nested any number of times. Return the sum of every integer. Call `total_gold` on each nested list. `total_gold([3, [4, [5]], 1])` is 13. `total_gold([])` is 0.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def total_gold(chests):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import total_gold

def test_values():
    assert total_gold([3, [4, [5]], 1]) == 13
    assert total_gold([]) == 0
    assert total_gold([1, 2, 3]) == 6
    assert total_gold([[], [[]]]) == 0
    assert total_gold([[1, 2], 3]) == 6
    assert total_gold([[[[4]]]]) == 4

def test_code_0():
    assert calls('total_gold'), 'Call `total_gold()` in your code.'

import copy, random
from solution import total_gold as LEARNER
def ref(chests):
    total = 0
    for chest in chests:
        total += ref(chest) if isinstance(chest, list) else chest
    return total

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

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "total_gold%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def total_gold(chests):
    total = 0
    for chest in chests:
        if isinstance(chest, list):
            total += total_gold(chest)
        else:
            total += chest
    return total
```
wrong: adds only the numbers on the top level
```python
def total_gold(chests):
    return sum(chest for chest in chests if not isinstance(chest, list))
```
wrong: opens one level of chests and stops
```python
def total_gold(chests):
    total = 0
    for chest in chests:
        if isinstance(chest, list):
            for item in chest:
                if not isinstance(item, list):
                    total += item
        else:
            total += chest
    return total
```
hint: If an item is a list, add `total_gold(item)`. Otherwise add the number.
:::

## How deep the dungeon goes
id: g1-depth
stage: recursion
needs: g1-sum-nested
minutes: 5
goal: The dungeon is a nest of rooms, and Sam asks how deep it goes.
source: Python docs: sys.setrecursionlimit() | https://docs.python.org/3/library/sys.html#sys.setrecursionlimit

### Assignment

Write `depth(rooms)`. `rooms` is a dictionary whose values are more dictionaries like it. An empty dictionary is depth 0. Any other dictionary is 1 plus the deepest child. Call `depth` on each child. `depth({})` is 0. `depth({"hall": {}})` is 1. `depth({"hall": {"cellar": {}}})` is 2. `depth({"hall": {}, "pit": {"den": {}}})` is 2.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def depth(rooms):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import depth

def test_values():
    assert depth({}) == 0
    assert depth({"hall": {}}) == 1
    assert depth({"hall": {"cellar": {}}}) == 2
    assert depth({"hall": {}, "pit": {"den": {}}}) == 2
    assert depth({"a": {}, "b": {}, "c": {"d": {}}}) == 2
    assert depth({"gate": {"hall": {"cellar": {}}}}) == 3

def test_code_0():
    assert calls('depth'), 'Call `depth()` in your code.'

import copy, random
from solution import depth as LEARNER
def ref(rooms):
    if not rooms:
        return 0
    return 1 + max(ref(child) for child in rooms.values())

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

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "depth%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def depth(rooms):
    if not rooms:
        return 0
    return 1 + max(depth(child) for child in rooms.values())
```
wrong: the shallowest branch, not the deepest
```python
def depth(rooms):
    if not rooms:
        return 0
    return 1 + min(depth(child) for child in rooms.values())
```
wrong: counts rooms instead of levels
```python
def depth(rooms):
    if not isinstance(rooms, dict) or not rooms:
        return 0
    return len(rooms) + sum(depth(child) for child in rooms.values())
```
hint: `1 + max(depth(child) for child in rooms.values())`, and `0` for an empty dictionary.
:::

## Rooms you can reach
id: g1-flood
stage: recursion
needs: g1-depth
minutes: 5
goal: From the entrance, Sam counts every room he can walk to.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

Write `reachable(rooms, start)`. `rooms` maps a room name to a list of names it leads to. Return how many rooms can be walked to from `start`, counting `start` when it is a key. A name that is not a key is not a room. Do not count a room twice: keep the rooms already seen in a `set`. Walk by calling a function on each next room. No `while` loop. From `hall` in this map the answer is 4, because `tower` only leads back toward `hall`:

`{"hall": ["pit", "den"], "pit": ["hall"], "den": ["cellar"], "cellar": [], "tower": ["hall"]}`

`reachable(rooms, "attic")` is 0 when `attic` is not a key. `reachable({"hall": ["void"]}, "hall")` is 1.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def reachable(rooms, start):
    return 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert calls('set'), 'Call `set()` in your code.'

def test_code_1():
    assert not has_node('While'), "Don't use a `while loop` here."

import copy, random
from solution import reachable as LEARNER
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

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "reachable%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def reachable(rooms, start):
    seen = set()
    def walk(room):
        if room in seen or room not in rooms:
            return
        seen.add(room)
        for nxt in rooms[room]:
            walk(nxt)
    walk(start)
    return len(seen)
```
wrong: counts every room in the map
```python
def reachable(rooms, start):
    if start not in rooms:
        return 0
    return len(rooms)
```
wrong: counts names that are not rooms
```python
def reachable(rooms, start):
    seen = set()
    def walk(room):
        if room in seen:
            return
        seen.add(room)
        for nxt in rooms.get(room, []):
            walk(nxt)
    walk(start)
    return len(seen)
```
hint: Recurse from `start`, and keep `seen = set()` so a cycle does not visit a room twice. Skip names that are not keys of `rooms`.
:::

## Quiz: the way back up
id: g1-quiz-recursion
stage: recursion
needs: g1-flood
minutes: 5
goal: Mira's cheer echoes on the way down and on the way back up.
source: Python tutorial: Defining functions | https://docs.python.org/3/tutorial/controlflow.html#defining-functions

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
def cheer(n):
    if n == 0:
        print("go")
        return
    print(n)
    cheer(n - 1)
    print(n)

cheer(2)
```
answer:
```
2
1
go
1
2
```
why: Each call prints n before the recursive call and again after it returns, so the way back up prints 1 then 2, with go in the middle.
:::

## Walking the rooms by hand
id: g2-iter-next
stage: iterators
needs: g1-quiz-recursion
minutes: 5
goal: The dungeon map is a list, and Sam walks it one room at a time.
source: Python tutorial: Iterators | https://docs.python.org/3/tutorial/classes.html#iterators

### Assignment

Write `walk(rooms)`. Start with `it = iter(rooms)`. Pull one room at a time with `next(it)` and append it to a list. If the room is `"collapsed"`, stop before adding it. If the iterator runs out, stop. Return the rooms you walked through. Use no `for` loop. `walk(["hall", "pit"])` is `["hall", "pit"]`. `walk(["hall", "collapsed", "den"])` is `["hall"]`. `walk([])` is `[]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def walk(rooms):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import walk

def test_values():
    assert walk(["hall", "pit"]) == ["hall", "pit"]
    assert walk(["hall", "collapsed", "den"]) == ["hall"]
    assert walk([]) == []
    assert walk(["collapsed"]) == []
    assert walk(["hall", "pit", "collapsed"]) == ["hall", "pit"]
    assert walk(["gate", "tower", "cellar"]) == ["gate", "tower", "cellar"]

def test_code_0():
    assert calls('iter'), 'Start with `iter(rooms)`.'

def test_code_1():
    assert calls('next'), 'Pull each room with `next(it)`.'

def test_code_2():
    assert not has_node('For'), 'Walk with `iter` and `next`, not a `for` loop.'

import copy, random
from solution import walk as LEARNER
def ref(rooms):
    seen = []
    for room in rooms:
        if room == "collapsed":
            break
        seen.append(room)
    return seen

def gen(r):
    rooms = ["hall", "pit", "den", "gate", "tower", "cellar"] + ["collapsed"]
    return [[r.choice(rooms) for _ in range(r.randint(0, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "walk%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def walk(rooms):
    it = iter(rooms)
    seen = []
    while True:
        try:
            room = next(it)
        except StopIteration:
            break
        if room == "collapsed":
            break
        seen.append(room)
    return seen
```
wrong: a for loop instead of iter and next
```python
def walk(rooms):
    seen = []
    for room in rooms:
        if room == "collapsed":
            break
        seen.append(room)
    return seen
```
wrong: walks into the collapsed room
```python
def walk(rooms):
    it = iter(rooms)
    seen = []
    while True:
        try:
            room = next(it)
        except StopIteration:
            break
        seen.append(room)
        if room == "collapsed":
            break
    return seen
```
wrong: skips the first room
```python
def walk(rooms):
    it = iter(rooms)
    seen = []
    try:
        next(it)
    except StopIteration:
        return seen
    while True:
        try:
            room = next(it)
        except StopIteration:
            break
        seen.append(room)
    return seen
```
hint: `it = iter(rooms)`, then `next(it)` inside a `try`. `StopIteration` means the map is finished.
:::

## A patrol generator
id: g2-yield
stage: iterators
needs: g2-iter-next
minutes: 5
goal: Mira sends a scout through every room, but only when the scout is needed.
source: Python tutorial: Generators | https://docs.python.org/3/tutorial/classes.html#generators

### Assignment

Write `patrol(rooms)`. It is a generator that yields `"scout " + room` for each room, in order. Calling `patrol(["hall", "pit"])` must not build a list; it returns a generator. `list(patrol(["hall", "pit"]))` is `["scout hall", "scout pit"]`. `patrol([])` gives nothing. The first `next` of `patrol(["den"])` is `"scout den"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def patrol(rooms):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert has_node('Yield'), 'Use `yield` inside patrol.'

def test_code_1():
    assert not calls('list'), "Don't build a list; yield the rooms."
```
solution:
```python
def patrol(rooms):
    for room in rooms:
        yield "scout " + room
```
wrong: returns a list
```python
def patrol(rooms):
    return ["scout " + room for room in rooms]
```
wrong: forgets the scout prefix
```python
def patrol(rooms):
    for room in rooms:
        yield room
```
wrong: yields only the first room
```python
def patrol(rooms):
    for room in rooms:
        yield "scout " + room
        return
```
hint: Inside the function, `for room in rooms:` and `yield "scout " + room`.
:::

## Damage on demand
id: g2-genexpr
stage: iterators
needs: g2-yield
minutes: 5
goal: The bard totals a battle without keeping every blow in memory.
source: Python reference: Generator expressions | https://docs.python.org/3/reference/expressions.html#generator-expressions

### Assignment

Write `battle_totals(hits)`. `hits` is a list of `(attacker, damage)` pairs. Return `(total, heaviest)`: the sum of all damage, and the largest damage. Use generator expressions straight inside `sum` and `max`, not a list comprehension. An empty battle is `(0, 0)`. `battle_totals([("Sam", 5), ("Mira", 12), ("Bran", 2)])` is `(19, 12)`. Negative damage counts in the sum but never makes a new heaviest.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def battle_totals(hits):
    return 0, 0
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import battle_totals

def test_values():
    assert battle_totals([]) == (0, 0)
    assert battle_totals([("Sam", 5)]) == (5, 5)
    assert battle_totals([("Sam", 5), ("Mira", 12), ("Bran", 2)]) == (19, 12)
    assert battle_totals([("Sam", -3), ("Mira", -1)]) == (-4, 0)
    assert battle_totals([("Sam", -3), ("Mira", 4)]) == (1, 4)
    assert battle_totals([("Sam", 7), ("Mira", 7)]) == (14, 7)

def test_code_0():
    assert has_node('GeneratorExp'), 'Use a generator expression, like `damage for _, damage in hits`.'

def test_code_1():
    assert not has_node('ListComp'), "Pass the generator straight to sum and max; don't build a list."

import copy, random
from solution import battle_totals as LEARNER
def ref(hits):
    return sum(d for _, d in hits), max((d for _, d in hits if d > 0), default=0)

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [[(r.choice(names), r.randint(-5, 20)) for _ in range(r.randint(0, 8))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "battle_totals%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def battle_totals(hits):
    return sum(damage for _, damage in hits), max((damage for _, damage in hits if damage > 0), default=0)
```
wrong: a list comprehension for both totals
```python
def battle_totals(hits):
    return sum([d for _, d in hits]), max([d for _, d in hits])
```
wrong: max crashes on an empty battle
```python
def battle_totals(hits):
    return sum(d for _, d in hits), max(d for _, d in hits)
```
wrong: negative damage is dropped from the sum
```python
def battle_totals(hits):
    return sum(d for _, d in hits if d > 0), max((d for _, d in hits), default=0)
```
hint: `sum(damage for _, damage in hits)` and `max((damage for _, damage in hits if damage > 0), default=0)`.
:::

## An endless turn order
id: g2-infinite
stage: iterators
needs: g2-genexpr
minutes: 5
goal: The heroes take turns forever, and the scribe writes down only the first few.
source: Python docs: itertools.islice() | https://docs.python.org/3/library/itertools.html#itertools.islice

### Assignment

Write `turn_order(heroes)`, an endless generator that yields the heroes in a circle, forever. An empty party yields nothing. Write `first_turns(heroes, n)` that returns the first `n` turns as a list, using `itertools.islice`. `first_turns(["Sam", "Mira"], 5)` is `["Sam", "Mira", "Sam", "Mira", "Sam"]`. `first_turns(["Sam"], 3)` is `["Sam", "Sam", "Sam"]`. `first_turns(["Sam"], 0)` and `first_turns([], 4)` are `[]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
import itertools

def turn_order(heroes):
    return []

def first_turns(heroes, n):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert calls('islice'), 'Take the first n with `itertools.islice`.'

def test_code_1():
    assert has_node('Yield'), 'Yield each hero.'

import copy, random
from solution import first_turns as LEARNER
def ref(heroes, n):
    if n <= 0 or not heroes:
        return []
    return [heroes[i % len(heroes)] for i in range(n)]

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    n = r.randint(0, 8)
    size = r.randint(0, 4)
    if n > 0 and size == 0:
        size = 1
    return [[r.choice(names) for _ in range(size)], n]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "first_turns%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
import itertools

def turn_order(heroes):
    if not heroes:
        return
    while True:
        for hero in heroes:
            yield hero

def first_turns(heroes, n):
    return list(itertools.islice(turn_order(heroes), n))
```
wrong: repeats the party once instead of circling
```python
import itertools

def turn_order(heroes):
    for hero in heroes:
        yield hero

def first_turns(heroes, n):
    return list(itertools.islice(turn_order(heroes), n))
```
wrong: takes from the list, not the endless turn order
```python
import itertools

def turn_order(heroes):
    while True:
        for hero in heroes:
            yield hero

def first_turns(heroes, n):
    return list(itertools.islice(heroes, n))
```
wrong: off by one: n - 1 turns
```python
import itertools

def turn_order(heroes):
    while True:
        for hero in heroes:
            yield hero

def first_turns(heroes, n):
    return list(itertools.islice(turn_order(heroes), n - 1))
```
hint: `yield` inside an endless `while True`, and take `n` with `itertools.islice(turn_order(heroes), n)`.
:::

## Stop at the boss
id: g2-lazy
stage: iterators
needs: g2-infinite
minutes: 5
goal: The scout should stop reading the map the moment the boss room appears.
source: Python tutorial: Generators | https://docs.python.org/3/tutorial/classes.html#generators

### Assignment

Write `take_until_boss(rooms)`, a generator that yields each room and stops after yielding `"boss"`. It must not read a room after the boss. The tests pass an iterator that raises if it is read too far, so read lazily: one room at a time, only while the caller asks. `list(take_until_boss(["hall", "boss", "treasure"]))` is `["hall", "boss"]`. `list(take_until_boss(["boss", "treasure"]))` is `["boss"]`. `list(take_until_boss(["hall"]))` is `["hall"]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def take_until_boss(rooms):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert has_node('Yield'), 'Yield each room as it is read.'

def test_code_1():
    assert not calls('list'), "Don't collect all the rooms in a list."
```
solution:
```python
def take_until_boss(rooms):
    for room in rooms:
        yield room
        if room == "boss":
            return
```
wrong: reads the whole map first
```python
def take_until_boss(rooms):
    return [room for room in rooms]
```
wrong: yields the rooms after the boss too
```python
def take_until_boss(rooms):
    for room in rooms:
        yield room
```
wrong: stops before the boss
```python
def take_until_boss(rooms):
    for room in rooms:
        if room == "boss":
            return
        yield room
```
hint: `yield room` first, then `if room == "boss": return` so the boss is included and nothing after it is read.
:::

## Flatten the levels
id: g2-yield-from
stage: iterators
needs: g2-lazy
minutes: 5
goal: The dungeon map arrives level by level, and Sam wants one long list of rooms.
source: Python reference: Yield expressions | https://docs.python.org/3/reference/expressions.html#yield-expressions

### Assignment

Write `rooms_by_level(levels)`, a generator. `levels` is a list of room lists. Yield every room from every level, in order, with `yield from`. `list(rooms_by_level([["hall", "pit"], ["den"], []]))` is `["hall", "pit", "den"]`. `list(rooms_by_level([]))` is `[]`. Do not build the whole list before yielding.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def rooms_by_level(levels):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

import types
from solution import rooms_by_level

def test_values():
    assert list(rooms_by_level([["hall", "pit"], ["den"], []])) == ["hall", "pit", "den"]
    assert list(rooms_by_level([])) == []
    assert list(rooms_by_level([[], []])) == []
    assert list(rooms_by_level([["gate"], ["tower", "cellar"]])) == ["gate", "tower", "cellar"]

def test_is_a_generator():
    assert isinstance(rooms_by_level([["hall"]]), types.GeneratorType), "yield rooms, don't return a list"

def test_code_0():
    assert has_node('YieldFrom'), 'Flatten each level with `yield from level`.'

def test_code_1():
    assert not calls('list'), "Don't build one big list."
```
solution:
```python
def rooms_by_level(levels):
    for level in levels:
        yield from level
```
wrong: nested for loops with yield
```python
def rooms_by_level(levels):
    for level in levels:
        for room in level:
            yield room
```
wrong: returns a list
```python
def rooms_by_level(levels):
    return [room for level in levels for room in level]
```
wrong: yields the levels themselves
```python
def rooms_by_level(levels):
    for level in levels:
        yield from [level]
```
hint: Inside `for level in levels:`, write `yield from level`.
:::

## The damage pipeline
id: g2-pipeline
stage: iterators
needs: g2-yield-from
minutes: 5
goal: Each line of the battle log is read, parsed, filtered, and written out in one pass.
source: Python reference: Generator expressions | https://docs.python.org/3/reference/expressions.html#generator-expressions

### Assignment

Write `report(lines, minimum)`. Each line looks like `"Sam 12"`: a name, a space, and a whole number. Read the log as a pipeline of generator expressions: parse each line into `(name, damage)`, keep the hits with `damage >= minimum`, then build the list `"name hit for damage"`. `report(["Sam 12", "Mira 3", "Bran 10"], 10)` is `["Sam hit for 12", "Bran hit for 10"]`. `report([], 10)` is `[]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def report(lines, minimum):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import report

def test_values():
    assert report(["Sam 12", "Mira 3", "Bran 10"], 10) == ["Sam hit for 12", "Bran hit for 10"]
    assert report(["Sam 12"], 10) == ["Sam hit for 12"]
    assert report(["Sam 9"], 10) == []
    assert report([], 10) == []
    assert report(["Ada 1", "Ned 30", "Lux 7"], 0) == ["Ada hit for 1", "Ned hit for 30", "Lux hit for 7"]

def test_code_0():
    assert has_node('GeneratorExp'), 'Use a generator expression in the pipeline.'

import copy, random
from solution import report as LEARNER
def ref(lines, minimum):
    out = []
    for line in lines:
        name, damage = line.split()
        if int(damage) >= minimum:
            out.append("%s hit for %s" % (name, damage))
    return out

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [[("%s %d" % (r.choice(names), r.randint(-5, 25))) for _ in range(r.randint(0, 8))], r.randint(-5, 20)]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "report%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def report(lines, minimum):
    parsed = ((line.split()[0], int(line.split()[1])) for line in lines)
    kept = ((name, damage) for name, damage in parsed if damage >= minimum)
    return [f"{name} hit for {damage}" for name, damage in kept]
```
wrong: drops hits equal to the minimum
```python
def report(lines, minimum):
    parsed = ((line.split()[0], int(line.split()[1])) for line in lines)
    kept = ((name, damage) for name, damage in parsed if damage > minimum)
    return [f"{name} hit for {damage}" for name, damage in kept]
```
wrong: reads the damage as the name
```python
def report(lines, minimum):
    parsed = ((line.split()[1], int(line.split()[0])) for line in lines)
    kept = ((name, damage) for name, damage in parsed if damage >= minimum)
    return [f"{name} hit for {damage}" for name, damage in kept]
```
wrong: keeps every hit
```python
def report(lines, minimum):
    parsed = ((line.split()[0], int(line.split()[1])) for line in lines)
    return [f"{name} hit for {damage}" for name, damage in parsed]
```
hint: Build one generator expression for parsed hits, a second that filters them, then a list of the label strings.
:::

## Roll call
id: g2-enumerate-zip-lazy
stage: iterators
needs: g2-pipeline
minutes: 5
goal: The quartermaster reads a name and a score together, and stops at the shorter list.
source: Python docs: zip() | https://docs.python.org/3/library/functions.html#zip

### Assignment

Write `roll_call(names, scores)`. Pair the two with `zip`, number the pairs from 1 with `enumerate(..., start=1)`, and return `"1. Sam: 12"` style lines. `zip` stops at the shorter input. `roll_call(["Sam", "Mira"], [12, 7])` is `["1. Sam: 12", "2. Mira: 7"]`. `roll_call(["Sam", "Mira"], [12])` is `["1. Sam: 12"]`. `roll_call([], [1, 2])` is `[]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def roll_call(names, scores):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import roll_call

def test_values():
    assert roll_call(["Sam", "Mira"], [12, 7]) == ["1. Sam: 12", "2. Mira: 7"]
    assert roll_call(["Sam", "Mira"], [12]) == ["1. Sam: 12"]
    assert roll_call([], [1, 2]) == []
    assert roll_call(["Sam"], []) == []
    assert roll_call(["Sam", "Mira", "Bran"], [1, 2, 3]) == ["1. Sam: 1", "2. Mira: 2", "3. Bran: 3"]

def test_works_with_generators():
    assert roll_call(iter(["Sam", "Mira"]), iter([4, 5])) == ["1. Sam: 4", "2. Mira: 5"]

def test_code_0():
    assert calls('zip'), 'Pair names and scores with `zip`.'

def test_code_1():
    assert calls('enumerate'), 'Number the pairs with `enumerate`.'

import copy, random
from solution import roll_call as LEARNER
def ref(names, scores):
    return ["%d. %s: %s" % (i, name, score) for i, (name, score) in enumerate(zip(names, scores), start=1)]

def gen(r):
    names = ["Sam", "Mira", "Bran", "Ada", "Ned"]
    return [[r.choice(names) for _ in range(r.randint(0, 5))], [r.randint(0, 20) for _ in range(r.randint(0, 5))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "roll_call%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
def roll_call(names, scores):
    return [f"{i}. {name}: {score}" for i, (name, score) in enumerate(zip(names, scores), start=1)]
```
wrong: numbers from 0
```python
def roll_call(names, scores):
    return [f"{i}. {name}: {score}" for i, (name, score) in enumerate(zip(names, scores))]
```
wrong: keeps going past the shorter list
```python
import itertools

def roll_call(names, scores):
    return [f"{i}. {name}: {score}" for i, (name, score) in enumerate(itertools.zip_longest(names, scores), start=1)]
```
wrong: indexes names by position
```python
def roll_call(names, scores):
    return [f"{i}. {names[i - 1]}: {score}" for i, score in enumerate(scores, start=1)]
```
hint: `enumerate(zip(names, scores), start=1)` gives the number and the pair.
:::

## The guild ledger
id: g2-itertools
stage: iterators
needs: g2-enumerate-zip-lazy
minutes: 5
goal: Loot arrives in chests, and the treasurer wants a running total by day.
source: Python docs: itertools | https://docs.python.org/3/library/itertools.html

### Assignment

Write `flatten(groups)` that returns one list from a list of lists, using `itertools.chain.from_iterable`. Write `daily_totals(entries)` where each entry is `(day, gold)`. Sort by day, group the days with `itertools.groupby`, total each day, then use `itertools.accumulate` for the running total. Return `(day, day_total, running_total)` tuples in day order. `daily_totals([("Mon", 5), ("Tue", 3), ("Mon", 2)])` is `[("Mon", 7, 7), ("Tue", 3, 10)]`. `flatten([["gem"], ["gold", "gem"]])` is `["gem", "gold", "gem"]`. `daily_totals([])` is `[]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
import itertools

def flatten(groups):
    return []

def daily_totals(entries):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert calls('from_iterable'), 'Flatten with `itertools.chain.from_iterable`.'

def test_code_1():
    assert calls('groupby'), 'Group the sorted days with `itertools.groupby`.'

def test_code_2():
    assert calls('accumulate'), 'Build the running total with `itertools.accumulate`.'

def test_code_3():
    assert calls('sorted'), 'Sort the entries by day before grouping.'

import copy, random
from solution import daily_totals as LEARNER
def ref(entries):
    ordered = sorted(entries, key=lambda e: e[0])
    totals = []
    for day, group in __import__("itertools").groupby(ordered, key=lambda e: e[0]):
        totals.append((day, sum(gold for _, gold in group)))
    out = []
    run = 0
    for day, total in totals:
        run += total
        out.append((day, total, run))
    return out

def gen(r):
    days = ["Mon", "Tue", "Wed", "Thu"]
    return [[(r.choice(days), r.randint(-5, 20)) for _ in range(r.randint(0, 10))]]

def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "daily_totals%r returned %r, expected %r" % (tuple(args), got, want)
```
solution:
```python
import itertools

def flatten(groups):
    return list(itertools.chain.from_iterable(groups))

def daily_totals(entries):
    ordered = sorted(entries, key=lambda entry: entry[0])
    totals = [(day, sum(gold for _, gold in group)) for day, group in itertools.groupby(ordered, key=lambda entry: entry[0])]
    running = itertools.accumulate(total for _, total in totals)
    return [(day, total, run) for (day, total), run in zip(totals, running)]
```
wrong: groups without sorting first
```python
import itertools

def flatten(groups):
    return list(itertools.chain.from_iterable(groups))

def daily_totals(entries):
    totals = [(day, sum(gold for _, gold in group)) for day, group in itertools.groupby(entries, key=lambda entry: entry[0])]
    running = itertools.accumulate(total for _, total in totals)
    return [(day, total, run) for (day, total), run in zip(totals, running)]
```
wrong: every day restarts the running total
```python
import itertools

def flatten(groups):
    return list(itertools.chain.from_iterable(groups))

def daily_totals(entries):
    ordered = sorted(entries, key=lambda entry: entry[0])
    totals = [(day, sum(gold for _, gold in group)) for day, group in itertools.groupby(ordered, key=lambda entry: entry[0])]
    return [(day, total, total) for day, total in totals]
```
wrong: flattens one level with a loop
```python
import itertools

def flatten(groups):
    out = []
    for group in groups:
        out.extend(group)
    return out

def daily_totals(entries):
    ordered = sorted(entries, key=lambda entry: entry[0])
    totals = [(day, sum(gold for _, gold in group)) for day, group in itertools.groupby(ordered, key=lambda entry: entry[0])]
    running = itertools.accumulate(total for _, total in totals)
    return [(day, total, run) for (day, total), run in zip(totals, running)]
```
hint: Sort before `groupby` (it only groups neighbours). `accumulate` turns day totals into a running total.
:::

## A dungeon that knows how to walk
id: g2-iter-class
stage: iterators
needs: g2-itertools
minutes: 5
goal: A dungeon is not a list of rooms; it is an object with a position in it.
source: Python docs: Iterator types | https://docs.python.org/3/library/stdtypes.html#iterator-types

### Assignment

Write a class `Dungeon`. `Dungeon(rooms)` keeps the list. `iter(dungeon)` returns the dungeon itself. `next(dungeon)` returns the next room, one at a time, and raises `StopIteration` when the rooms run out. `list(Dungeon(["hall", "pit"]))` is `["hall", "pit"]`, and `iter(dungeon) is dungeon`. The dungeon is one-shot: after it runs out, `next(dungeon, "done")` is `"done"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
class Dungeon:
    def __init__(self, rooms):
        self.rooms = rooms

    def __iter__(self):
        return iter(self.rooms)

    def __next__(self):
        return None
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert defines('__iter__'), 'Define `__iter__`.'

def test_code_1():
    assert defines('__next__'), 'Define `__next__`.'

def test_code_2():
    assert has_node('Raise'), 'Raise `StopIteration` when the rooms run out.'
```
solution:
```python
class Dungeon:
    def __init__(self, rooms):
        self.rooms = rooms
        self.index = 0

    def __iter__(self):
        return self

    def __next__(self):
        if self.index >= len(self.rooms):
            raise StopIteration
        room = self.rooms[self.index]
        self.index += 1
        return room
```
wrong: iter returns the list's iterator
```python
class Dungeon:
    def __init__(self, rooms):
        self.rooms = rooms
        self.index = 0

    def __iter__(self):
        return iter(self.rooms)

    def __next__(self):
        if self.index >= len(self.rooms):
            raise StopIteration
        room = self.rooms[self.index]
        self.index += 1
        return room
```
wrong: raises the wrong error at the end
```python
class Dungeon:
    def __init__(self, rooms):
        self.rooms = rooms
        self.index = 0

    def __iter__(self):
        return self

    def __next__(self):
        if self.index >= len(self.rooms):
            raise ValueError("the end")
        room = self.rooms[self.index]
        self.index += 1
        return room
```
wrong: skips the first room
```python
class Dungeon:
    def __init__(self, rooms):
        self.rooms = rooms
        self.index = 1

    def __iter__(self):
        return self

    def __next__(self):
        if self.index >= len(self.rooms):
            raise StopIteration
        room = self.rooms[self.index]
        self.index += 1
        return room
```
hint: `__iter__` returns `self`. `__next__` returns `self.rooms[self.index]` and moves the index; at the end it raises `StopIteration`.
:::

## Quiz: a generator runs once
id: g2-quiz-exhausted
stage: iterators
needs: g2-iter-class
minutes: 5
goal: Mira keeps the same lantern for two trips, and the second trip is dark.
source: Python tutorial: Generators | https://docs.python.org/3/tutorial/classes.html#generators

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
def rooms():
    yield "hall"
    yield "pit"

r = rooms()
print(list(r))
print(list(r))
print(next(rooms()))
```
answer:
```
['hall', 'pit']
[]
hall
```
why: A generator is its own iterator: the first list uses it up, the second finds nothing. A new call to rooms() starts a fresh generator.
:::

## Quest: the monster spawner
id: g2-q-spawner
stage: iterators
needs: g2-quiz-exhausted
minutes: 15
goal: The dungeon needs waves of monsters that grow, but the dungeon master sets a cap.
source: Python reference: Yield expressions | https://docs.python.org/3/reference/expressions.html#yield-expressions
project: true

### Assignment

Write `spawn_wave(monster, start, step, cap)`, a generator. The first wave is a list with `start` copies of `monster`. Each next wave has `step` more, up to `cap`: never yield a wave larger than `cap`. `list(spawn_wave("goblin", 1, 2, 7))` is `[["goblin"], ["goblin", "goblin", "goblin"], ["goblin"] * 5, ["goblin"] * 7]`. If `start > cap`, nothing is yielded. Each wave is a new list, so changing one does not change the next.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def spawn_wave(monster, start, step, cap):
    return []
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert has_node('Yield'), 'Yield each wave instead of returning one list.'

def test_code_1():
    assert has_node('While'), 'Use a loop until the cap.'
```
solution:
```python
def spawn_wave(monster, start, step, cap):
    count = start
    while count <= cap:
        yield [monster] * count
        count += step
```
wrong: starts one step too high
```python
def spawn_wave(monster, start, step, cap):
    count = start + step
    while count <= cap:
        yield [monster] * count
        count += step
```
wrong: never yields the wave on the cap
```python
def spawn_wave(monster, start, step, cap):
    count = start
    while count < cap:
        yield [monster] * count
        count += step
```
wrong: returns one list instead of a generator
```python
def spawn_wave(monster, start, step, cap):
    return [[monster] * count for count in range(start, cap + 1, step)]
```
wrong: reuses one list for every wave
```python
def spawn_wave(monster, start, step, cap):
    wave = []
    count = start
    while count <= cap:
        wave.extend([monster] * step)
        yield wave
        count += step
```
hint: Keep `count = start`, `yield [monster] * count`, then `count += step` while `count <= cap`.
:::

## A counter that remembers
id: g2-closure
stage: decorators
needs: g2-q-spawner
minutes: 5
goal: Every time Sam opens the chest, the tally on the lid goes up.
source: Python reference: The nonlocal statement | https://docs.python.org/3/reference/simple_stmts.html#the-nonlocal-statement

### Assignment

Write `make_counter()`. It returns a function. Each call of that function increases its own count and returns the new value: 1, then 2, then 3. Two counters made by two calls keep separate counts. Use `nonlocal`. `make_counter` itself takes no arguments.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def make_counter():
    return lambda: 1
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert defines('make_counter'), 'Define `make_counter`.'

def test_code_1():
    assert has_node('Nonlocal'), 'Use `nonlocal count` inside the inner function.'
```
solution:
```python
def make_counter():
    count = 0
    def tick():
        nonlocal count
        count += 1
        return count
    return tick
```
wrong: one count shared by every counter
```python
count = 0

def make_counter():
    def tick():
        global count
        count += 1
        return count
    return tick
```
wrong: always returns 1
```python
def make_counter():
    count = 0
    def tick():
        nonlocal count
        count = 1
        return count
    return tick
```
wrong: rebinds count as a local each call
```python
def make_counter():
    count = 0
    def tick():
        count = 0
        count += 1
        return count
    return tick
```
hint: `count = 0`, then inside `tick` use `nonlocal count` before `count += 1`.
:::

## The late-binding trap
id: g2-closure-late-binding
stage: decorators
needs: g2-closure
minutes: 5
goal: The Guild made a greeting for every hero, and every greeting said the last hero's name.
source: Python FAQ: Why do lambdas in a loop all return the same value? | https://docs.python.org/3/faq/programming.html#why-do-lambdas-defined-in-a-loop-with-different-values-all-return-the-same-result

### Assignment

Write `make_greeters(names)`. Return a list of functions, one per name. Each function takes no arguments and returns `"Hello, NAME!"` for its own name. The starter's lambdas all close over the same loop variable, so they all say the last name. Fix it by binding the current name as a default argument: `lambda name=name: ...`. `[g() for g in make_greeters(["Sam", "Mira"])]` is `["Hello, Sam!", "Hello, Mira!"]`. `make_greeters([])` is `[]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def make_greeters(names):
    return [lambda: f"Hello, {name}!" for name in names]
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

from solution import make_greeters

def test_each_greeter_has_its_own_name():
    greeters = make_greeters(["Sam", "Mira", "Bran"])
    assert [g() for g in greeters] == ["Hello, Sam!", "Hello, Mira!", "Hello, Bran!"]

def test_edges():
    assert make_greeters([]) == []
    assert [g() for g in make_greeters(["Ada"])] == ["Hello, Ada!"]
    assert [g() for g in make_greeters(["Sam", "Sam"])] == ["Hello, Sam!", "Hello, Sam!"]
    assert all(callable(g) for g in make_greeters(["Ned"]))

def test_code_0():
    assert has_node('Lambda'), 'Return lambdas, one per name.'

def test_code_1():
    assert defines('make_greeters'), 'Keep the function called `make_greeters`.'
```
solution:
```python
def make_greeters(names):
    return [lambda name=name: f"Hello, {name}!" for name in names]
```
wrong: the classic late-binding bug
```python
def make_greeters(names):
    return [lambda: f"Hello, {name}!" for name in names]
```
wrong: every greeter uses the last name
```python
def make_greeters(names):
    return [lambda: f"Hello, {names[-1]}!" for _ in names]
```
wrong: returns strings instead of functions
```python
def make_greeters(names):
    return [f"Hello, {name}!" for name in names]
```
hint: Give the lambda a default: `lambda name=name: f"Hello, {name}!"`. The default is evaluated now, not when called.
:::

## The shouting decorator
id: g2-decorator-basic
stage: decorators
needs: g2-closure-late-binding
minutes: 5
goal: The herald shouts every message, whatever the message was.
source: Python glossary: decorator | https://docs.python.org/3/glossary.html#term-decorator

### Assignment

Write `shout(fn)`. It returns a wrapper that calls `fn` with the same arguments and uppercases the result. Then decorate `greet(name)`, which returns `"hello " + name`, with `@shout`. `greet("sam")` is `"HELLO SAM"`. `greet("")` is `"HELLO "`. `shout` must also work on another function: `shout(lambda s: s + "!") ("hi")` is `"HI!"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def shout(fn):
    return fn

@shout
def greet(name):
    return "hello " + name
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert defines('shout'), 'Define `shout`.'

def test_code_1():
    assert has_token('*'), 'Pass arguments through with `*args` (and `**kwargs`).'
```
solution:
```python
def shout(fn):
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs).upper()
    return wrapper

@shout
def greet(name):
    return "hello " + name
```
wrong: uppercases the argument instead of the result
```python
def shout(fn):
    def wrapper(*args, **kwargs):
        return fn(*[a.upper() for a in args])
    return wrapper

@shout
def greet(name):
    return "hello " + name
```
wrong: returns None
```python
def shout(fn):
    def wrapper(*args, **kwargs):
        fn(*args, **kwargs).upper()
    return wrapper

@shout
def greet(name):
    return "hello " + name
```
wrong: calls the function twice
```python
def shout(fn):
    def wrapper(*args, **kwargs):
        fn(*args, **kwargs)
        return fn(*args, **kwargs).upper()
    return wrapper

@shout
def greet(name):
    return "hello " + name
```
hint: The wrapper calls `fn(*args, **kwargs)` and returns `.upper()` of the result.
:::

## A decorator that logs
id: g2-decorator-args
stage: decorators
needs: g2-decorator-basic
minutes: 5
goal: The quartermaster writes down every command, with every argument.
source: Python reference: Function definitions | https://docs.python.org/3/reference/compound_stmts.html#function-definitions

### Assignment

Write `CALLS = []` and a decorator `logged(fn)`. Its wrapper appends `(fn.__name__, args, kwargs)` to `CALLS`, then calls `fn(*args, **kwargs)` and returns the result. Decorate `attack(hero, damage, *, crit=False)`, which returns `damage * 2` when `crit` is true and `damage` otherwise. `attack("Sam", 5)` is 5 and logs `("attack", ("Sam", 5), {})`. `attack("Mira", 4, crit=True)` is 8 and logs the keyword. Pass every argument through; do not change them.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
CALLS = []

def logged(fn):
    return fn

@logged
def attack(hero, damage, *, crit=False):
    return damage * 2 if crit else damage
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert defines('logged'), 'Define `logged`.'

def test_code_1():
    assert defines('attack'), 'Define and decorate `attack`.'

def test_code_2():
    assert has_token('**'), 'Accept `**kwargs` and pass them through.'
```
solution:
```python
CALLS = []

def logged(fn):
    def wrapper(*args, **kwargs):
        CALLS.append((fn.__name__, args, kwargs))
        return fn(*args, **kwargs)
    return wrapper

@logged
def attack(hero, damage, *, crit=False):
    return damage * 2 if crit else damage
```
wrong: drops the keyword arguments from the call
```python
CALLS = []

def logged(fn):
    def wrapper(*args, **kwargs):
        CALLS.append((fn.__name__, args, kwargs))
        return fn(*args)
    return wrapper

@logged
def attack(hero, damage, *, crit=False):
    return damage * 2 if crit else damage
```
wrong: logs only the arguments, not the keywords
```python
CALLS = []

def logged(fn):
    def wrapper(*args, **kwargs):
        CALLS.append((fn.__name__, args, {}))
        return fn(*args, **kwargs)
    return wrapper

@logged
def attack(hero, damage, *, crit=False):
    return damage * 2 if crit else damage
```
wrong: the wrapper returns None
```python
CALLS = []

def logged(fn):
    def wrapper(*args, **kwargs):
        CALLS.append((fn.__name__, args, kwargs))
        fn(*args, **kwargs)
    return wrapper

@logged
def attack(hero, damage, *, crit=False):
    return damage * 2 if crit else damage
```
hint: In the wrapper, append `(fn.__name__, args, kwargs)` first, then `return fn(*args, **kwargs)`.
:::

## Keep the function's name
id: g2-wraps
stage: decorators
needs: g2-decorator-args
minutes: 5
goal: The scribe wraps every spell, and the spellbook still needs the spell's real name.
source: Python docs: functools.wraps() | https://docs.python.org/3/library/functools.html#functools.wraps

### Assignment

Write a decorator `logged(fn)` that returns a wrapper, but uses `functools.wraps(fn)` so the wrapper keeps the function's `__name__` and `__doc__`. Decorate `heal(hero, amount)` with a docstring `Heal a hero by amount.` that returns `hero + " +" + str(amount)`. `heal.__name__` must be `"heal"`, `heal.__doc__` must be the docstring, and `heal("Sam", 2)` is `"Sam +2"`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
import functools

def logged(fn):
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)
    return wrapper

@logged
def heal(hero, amount):
    """Heal a hero by amount."""
    return f"{hero} +{amount}"
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert calls('wraps'), 'Use `functools.wraps(fn)`.'

def test_code_1():
    assert defines('logged'), 'Define `logged`.'
```
solution:
```python
import functools

def logged(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)
    return wrapper

@logged
def heal(hero, amount):
    """Heal a hero by amount."""
    return f"{hero} +{amount}"
```
wrong: no wraps at all
```python
import functools

def logged(fn):
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)
    return wrapper

@logged
def heal(hero, amount):
    """Heal a hero by amount."""
    return f"{hero} +{amount}"
```
wrong: copies the name but not the docstring
```python
import functools

def logged(fn):
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)
    wrapper.__name__ = fn.__name__
    return wrapper

@logged
def heal(hero, amount):
    """Heal a hero by amount."""
    return f"{hero} +{amount}"
```
wrong: returns the function itself
```python
import functools

def logged(fn):
    return fn

@logged
def heal(hero, amount):
    """Heal a hero by amount."""
    return f"{hero} +{amount}"
```
hint: Put `@functools.wraps(fn)` on the inner `wrapper` function.
:::

## A decorator with arguments
id: g2-decorator-factory
stage: decorators
needs: g2-wraps
minutes: 5
goal: The rogue keeps trying the locked chest, but only so many times.
source: Python glossary: decorator | https://docs.python.org/3/glossary.html#term-decorator

### Assignment

Write `retry(times)`, a decorator factory. It returns a decorator; that decorator wraps a function so it is called up to `times` times while it raises `ValueError`. The first success returns its value. If every try fails, raise the last `ValueError`. Do not retry other exceptions. `@retry(times=3)` around a function that succeeds on its third call returns that value after exactly 3 calls.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def retry(times):
    def decorate(fn):
        return fn
    return decorate
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert defines('retry'), 'Define `retry`.'

def test_code_1():
    assert has_node('Try'), 'Catch `ValueError` inside the wrapper.'
```
solution:
```python
def retry(times):
    def decorate(fn):
        def wrapper(*args, **kwargs):
            last = None
            for _ in range(times):
                try:
                    return fn(*args, **kwargs)
                except ValueError as error:
                    last = error
            raise last
        return wrapper
    return decorate
```
wrong: retries every exception
```python
def retry(times):
    def decorate(fn):
        def wrapper(*args, **kwargs):
            last = None
            for _ in range(times):
                try:
                    return fn(*args, **kwargs)
                except Exception as error:
                    last = error
            raise last
        return wrapper
    return decorate
```
wrong: tries one time too few
```python
def retry(times):
    def decorate(fn):
        def wrapper(*args, **kwargs):
            last = None
            for _ in range(times - 1):
                try:
                    return fn(*args, **kwargs)
                except ValueError as error:
                    last = error
            raise last
        return wrapper
    return decorate
```
wrong: never retries
```python
def retry(times):
    def decorate(fn):
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except ValueError as error:
                raise error
        return wrapper
    return decorate
```
hint: The inner wrapper loops `range(times)`, returns on success, keeps the last `ValueError`, and raises it after the loop.
:::

## Remember the paths
id: g2-cache
stage: decorators
needs: g2-decorator-factory
minutes: 5
goal: Mira counts the paths up the cliff, and the same short climbs keep coming back.
source: Python docs: functools.cache() | https://docs.python.org/3/library/functools.html#functools.cache

### Assignment

Write `paths(n)`: the number of ways to climb `n` steps when each move is 1 or 2 steps. `paths(0)` is 1 (standing still), `paths(1)` is 1, and `paths(n)` is `paths(n - 1) + paths(n - 2)`. Decorate it with `functools.cache` (or `functools.lru_cache`) so repeated subproblems are computed once. The tests call `paths.cache_clear()` and `paths.cache_info()`, so keep the real decorator. `[paths(n) for n in range(8)]` is `[1, 1, 2, 3, 5, 8, 13, 21]`.

::: write lang=python
task: Press **Run** to see the console, and **Submit** to check your code.
starter:
```python
def paths(n):
    if n <= 1:
        return 1
    return paths(n - 1) + paths(n - 2)
```
tests:
```python
import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()

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

def test_code_0():
    assert defines('paths'), 'Define `paths`.'
```
solution:
```python
import functools

@functools.cache
def paths(n):
    if n <= 1:
        return 1
    return paths(n - 1) + paths(n - 2)
```
wrong: no cache at all
```python
def paths(n):
    if n <= 1:
        return 1
    return paths(n - 1) + paths(n - 2)
```
wrong: the wrong base case
```python
import functools

@functools.cache
def paths(n):
    if n == 0:
        return 0
    if n == 1:
        return 1
    return paths(n - 1) + paths(n - 2)
```
wrong: a cache that keeps nothing
```python
import functools

@functools.lru_cache(maxsize=0)
def paths(n):
    if n <= 1:
        return 1
    return paths(n - 1) + paths(n - 2)
```
hint: Add `@functools.cache` above `paths`. The recursive calls then reuse the answers.
:::

## Quiz: the order of wrappers
id: g2-quiz-decorator-order
stage: decorators
needs: g2-cache
minutes: 5
goal: Two enchanters wrap the same sword, and Sam wants to know which spell speaks first.
source: Python glossary: decorator | https://docs.python.org/3/glossary.html#term-decorator

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
def first(fn):
    def wrapper(*args, **kwargs):
        print("first before")
        out = fn(*args, **kwargs)
        print("first after")
        return out
    return wrapper

def second(fn):
    def wrapper(*args, **kwargs):
        print("second before")
        out = fn(*args, **kwargs)
        print("second after")
        return out
    return wrapper

@first
@second
def hit():
    print("hit")

hit()
```
answer:
```
first before
second before
hit
second after
first after
```
why: The decorator nearest the function applies first, so hit is first(second(hit)). The outermost wrapper speaks first and returns last.
:::

## Quiz: the missing nonlocal
id: g2-quiz-nonlocal
stage: decorators
needs: g2-quiz-decorator-order
minutes: 5
goal: Mira's tally refuses to move, and the interpreter names the reason.
source: Python reference: The nonlocal statement | https://docs.python.org/3/reference/simple_stmts.html#the-nonlocal-statement

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
def make_counter():
    count = 0
    def tick():
        print("start")
        count += 1
        return count
    return tick

try:
    make_counter()()
except UnboundLocalError as error:
    print(type(error).__name__)
```
answer:
```
start
UnboundLocalError
```
why: Because tick assigns to count, count is local to tick for the whole function. Reading it before that assignment raises UnboundLocalError. `nonlocal count` would make it the outer counter.
:::

## Quiz: two names, one list
id: quiz-names
stage: quiz
needs: g2-quiz-nonlocal
minutes: 5
goal: The quartermaster tests your memory.
source: Python reference: Assignment statements | https://docs.python.org/3/reference/simple_stmts.html#assignment-statements

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
bag = ["rope"]
spare = bag
spare.append("torch")
print(len(bag))
```
answer:
```
2
```
why: `spare = bag` doesn't copy the list. Both names point at one list, so the append through `spare` shows up in `bag` too.
:::

## Quiz: range
id: quiz-range
stage: quiz
needs: quiz-names
minutes: 5
goal: The arena master counts the rounds.
source: Python tutorial: The range() function | https://docs.python.org/3/tutorial/controlflow.html#the-range-function

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
total = 0
for n in range(1, 4):
    total += n
print(total)
```
answer:
```
6
```
why: `range(1, 4)` is 1, 2, 3; the stop value isn't included. 1 + 2 + 3 is 6.
:::

## Quiz: local or global
id: quiz-scope
stage: quiz
needs: quiz-range
minutes: 5
goal: A riddle from the sphinx.
source: Python tutorial: Scopes and namespaces | https://docs.python.org/3/tutorial/classes.html#python-scopes-and-namespaces

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
gold = 10

def spend():
    gold = 3
    return gold

print(spend(), gold)
```
answer:
```
3 10
```
why: The `gold = 3` inside the function makes a new local name. The global `gold` is still 10.
:::

## Quiz: the mutable default
id: quiz-default
stage: quiz
needs: quiz-scope
minutes: 5
goal: An old trap that has caught many heroes.
source: Python tutorial: Default argument values | https://docs.python.org/3/tutorial/controlflow.html#default-argument-values

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
def add_loot(item, bag=[]):
    bag.append(item)
    return bag

add_loot("gem")
print(add_loot("gold"))
```
answer:
```
['gem', 'gold']
```
why: The default list is made once, when `def` runs, and every call without a `bag` shares it. Use `bag=None` and make a new list inside instead.
:::

## Quiz: truthiness
id: quiz-truthy
stage: quiz
needs: quiz-default
minutes: 5
goal: The gatekeeper checks your pockets.
source: Python docs: Truth value testing | https://docs.python.org/3/library/stdtypes.html#truth-value-testing

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
for thing in [0, "", [], "0", [0]]:
    print(bool(thing))
```
answer:
```
False
False
False
True
True
```
why: Zero, the empty string and the empty list are false. `"0"` is a non-empty string and `[0]` is a non-empty list, so both are true.
:::

## Quiz: dictionary keys
id: quiz-dict
stage: quiz
needs: quiz-truthy
minutes: 5
goal: The scribe keeps updating the same page.
source: Python tutorial: Dictionaries | https://docs.python.org/3/tutorial/datastructures.html#dictionaries

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
scores = {"Sam": 1}
scores["Sam"] = 5
scores["sam"] = 2
print(len(scores), scores["Sam"])
```
answer:
```
2 5
```
why: Keys are case-sensitive, so `"sam"` is a second key. Assigning to `"Sam"` again replaces its value.
:::

## Quiz: try, except, finally
id: quiz-except
stage: quiz
needs: quiz-dict
minutes: 5
goal: Follow the trap through the dungeon.
source: Python tutorial: Defining clean-up actions | https://docs.python.org/3/tutorial/errors.html#defining-clean-up-actions

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
def open_chest():
    try:
        print("open")
        return 1 / 0
    except ZeroDivisionError:
        print("trap!")
        return -1
    finally:
        print("close")

print(open_chest())
```
answer:
```
open
trap!
close
-1
```
why: The division fails, so the `except` block prints and returns -1. `finally` still runs before the function really returns, so `close` prints before the -1.
:::

## Quiz: slicing
id: quiz-slices
stage: quiz
needs: quiz-except
minutes: 5
goal: The scout reads the road backwards.
source: Python tutorial: Lists | https://docs.python.org/3/tutorial/introduction.html#lists

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
road = "dragon"
print(road[1:4], road[-1], road[::-1])
```
answer:
```
rag n nogard
```
why: `[1:4]` is indexes 1, 2, 3: `rag`. `[-1]` is the last letter. `[::-1]` steps backwards through the whole string.
:::

## Quiz: sets
id: quiz-sets
stage: quiz
needs: quiz-slices
minutes: 5
goal: Counting the kinds of loot.
source: Python tutorial: Sets | https://docs.python.org/3/tutorial/datastructures.html#sets

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
loot = ["gem", "gold", "gem", "Gem"]
print(len(set(loot)))
```
answer:
```
3
```
why: A set keeps each value once, but `"gem"` and `"Gem"` are different strings: gem, gold and Gem.
:::

## Quiz: division
id: quiz-int-div
stage: quiz
needs: quiz-sets
minutes: 5
goal: The treasurer splits the gold.
source: Python tutorial: Numbers | https://docs.python.org/3/tutorial/introduction.html#numbers

### Assignment

What does this code print? Trace it line by line, then type the console output exactly.

::: predict lang=python
q: What does this print?
code:
```python
print(7 / 2, 7 // 2, -7 // 2, 7 % 3)
```
answer:
```
3.5 3 -4 1
```
why: `/` always gives a float. `//` rounds down, toward minus infinity, so `-7 // 2` is -4, not -3. `7 % 3` is the remainder, 1.
:::
