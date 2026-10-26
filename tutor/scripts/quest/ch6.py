"""Book II: the Guild. Classes, files, JSON, modules and a game you can play.

These lessons pick up where the adventure engine leaves off: Sam reaches the Guild, which wants a
real game, saved to disk. The order is deliberate: a class, a method, a repr, a dataclass,
inheritance, then writing and reading files, JSON, a program's front door, and finally the game.
"""
from lib import L, Q, out, dedent

T = "# Don't touch below this line"


# ============================================================ Classes
L("classes", "class-hero", "A blueprint for a hero", "class",
  "The Guild keeps a card for every hero.",
  "A **class** is a blueprint; an **instance** is one thing made from it. `Hero(\"Sam\", 40)` builds a "
  "new instance and calls `__init__` with that instance as `self`, plus the arguments you passed. "
  "Store the arguments on `self` so each hero keeps its own name and health.\n\n"
  "Define `class Hero` with an `__init__(self, name, hp)` that sets `self.name` and `self.hp`. The "
  "lines below the marker make one hero and print its name and health; they must show:\n\n"
  "```text\nSam 40\n```",
  dedent("""\
  class Hero:
      def __init__(self, name, hp):
          pass


  # Don't touch below this line
  sam = Hero("Sam", 40)
  print(sam.name, sam.hp)
  """),
  dedent("""\
  class Hero:
      def __init__(self, name, hp):
          self.name = name
          self.hp = hp


  # Don't touch below this line
  sam = Hero("Sam", 40)
  print(sam.name, sam.hp)
  """),
  "Inside `__init__`, `self` is the new hero. `self.name = name` copies the argument onto that hero.",
  tests=dedent('''
  EXPECTED = "Sam 40"

  def test_console():
      got = shown()
      assert got == EXPECTED, "The console shows:\\n" + got + "\\n\\nExpected:\\n" + EXPECTED

  from solution import Hero

  def test_two_heroes():
      a, b = Hero("Sam", 40), Hero("Ada", 7)
      assert (a.name, a.hp) == ("Sam", 40)
      assert (b.name, b.hp) == ("Ada", 7)
  '''),
  checks=["node:ClassDef", "def:__init__"],
  wrong=[("stores the same values for every hero instead of the arguments",
          dedent("""\
          class Hero:
              def __init__(self, name, hp):
                  self.name = "Sam"
                  self.hp = 40


          # Don't touch below this line
          sam = Hero("Sam", 40)
          print(sam.name, sam.hp)
          """)),
         ("uses class attributes, so the arguments are refused",
          dedent("""\
          class Hero:
              name = "Sam"
              hp = 40


          # Don't touch below this line
          sam = Hero("Sam", 40)
          print(sam.name, sam.hp)
          """))])

L("classes", "class-method", "A method that changes the hero", "methods",
  "A hero who cannot be hurt is no hero.",
  "A **method** is a function that belongs to the class. Its first parameter is `self`, the instance "
  "it was called on, so it can read and change that instance's attributes.\n\n"
  "Add `take_damage(self, amount)` to `Hero`. It must lower `self.hp` by `amount`, and never let "
  "health go below 0. The code below the marker hits a 10-health hero for 4 and then for 9; the "
  "console must show:\n\n```text\n0\n```",
  dedent("""\
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
  """),
  dedent("""\
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
  """),
  "`self.hp -= amount` changes the hero. Wrap the result in `max(0, ...)` so a big hit stops at 0.",
  tests=dedent('''
  EXPECTED = "0"

  def test_console():
      got = shown()
      assert got == EXPECTED, "The console shows:\\n" + got + "\\n\\nExpected:\\n" + EXPECTED

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
  '''),
  checks=["def:take_damage"],
  wrong=[("lets health go negative",
          dedent("""\
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
          """)),
         ("returns the new health but never stores it",
          dedent("""\
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
          """))])

L("classes", "class-repr", "Say what a hero looks like", "repr",
  "The Guild's ledger prints a list of heroes and gets a wall of numbers.",
  "`print` and the REPL ask an object for its **repr**: the text that stands for the object. The "
  "default is an address like `<Hero object at 0x…>`, which tells a reader nothing. Define "
  "`__repr__(self)` to return `Hero(name, hp)` with the real name and health, so a list of heroes "
  "reads like a roster.\n\n"
  "The code below the marker prints a list with one hero in it; it must show:\n\n"
  "```text\n[Hero(Sam, 40)]\n```",
  dedent("""\
  class Hero:
      def __init__(self, name, hp):
          self.name = name
          self.hp = hp

      def __repr__(self):
          return "Hero"


  # Don't touch below this line
  sam = Hero("Sam", 40)
  print([sam])
  """),
  dedent("""\
  class Hero:
      def __init__(self, name, hp):
          self.name = name
          self.hp = hp

      def __repr__(self):
          return f"Hero({self.name}, {self.hp})"


  # Don't touch below this line
  sam = Hero("Sam", 40)
  print([sam])
  """),
  "`__repr__` must return a string, not print one. Build it with an f-string: `f\"Hero({self.name}, {self.hp})\"`.",
  tests=dedent('''
  EXPECTED = "[Hero(Sam, 40)]"

  def test_console():
      got = shown()
      assert got == EXPECTED, "The console shows:\\n" + got + "\\n\\nExpected:\\n" + EXPECTED

  from solution import Hero

  def test_repr():
      assert repr(Hero("Ada", 7)) == "Hero(Ada, 7)"
  '''),
  checks=["def:__repr__"],
  wrong=[("uses angle brackets and leaves out the health",
          dedent("""\
          class Hero:
              def __init__(self, name, hp):
                  self.name = name
                  self.hp = hp

              def __repr__(self):
                  return f"<Hero {self.name}>"


          # Don't touch below this line
          sam = Hero("Sam", 40)
          print([sam])
          """)),
         ("prints instead of returning, so repr gets None",
          dedent("""\
          class Hero:
              def __init__(self, name, hp):
                  self.name = name
                  self.hp = hp

              def __repr__(self):
                  print(f"Hero({self.name}, {self.hp})")


          # Don't touch below this line
          sam = Hero("Sam", 40)
          print([sam])
          """))])

L("classes", "class-dataclass", "Items as dataclasses", "dataclass",
  "Every rope, gem and key needs a name and a value.",
  "A **dataclass** writes the boring parts of a class for you: `__init__`, `__repr__` and `__eq__` "
  "come from the fields you declare. The decorator is `@dataclass`, and the fields are annotated "
  "names: `name: str` and `value: int = 1`.\n\n"
  "Turn `Item` into a dataclass with a `name: str` and a `value: int` that defaults to 1. The code "
  "below the marker prints a rope and a gem's value; it must show:\n\n"
  "```text\nItem(name='rope', value=1)\n5\n```",
  dedent("""\
  from dataclasses import dataclass


  class Item:
      def __init__(self, name, value=1):
          self.name = name
          self.value = value


  # Don't touch below this line
  print(Item("rope"))
  print(Item("gem", 5).value)
  """),
  dedent("""\
  from dataclasses import dataclass


  @dataclass
  class Item:
      name: str
      value: int = 1


  # Don't touch below this line
  print(Item("rope"))
  print(Item("gem", 5).value)
  """),
  "Put `@dataclass` on the line above `class Item`, then replace `__init__` with two annotated fields.",
  tests=dedent('''
  EXPECTED = "Item(name='rope', value=1)\\n5"

  def test_console():
      got = shown()
      assert got == EXPECTED, "The console shows:\\n" + got + "\\n\\nExpected:\\n" + EXPECTED

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
  '''),
  checks=["node:ClassDef"],
  wrong=[("keeps a hand-written __init__, so it is not a dataclass",
          dedent("""\
          from dataclasses import dataclass


          class Item:
              def __init__(self, name, value=1):
                  self.name = name
                  self.value = value


          # Don't touch below this line
          print(Item("rope"))
          print(Item("gem", 5).value)
          """)),
         ("forgets the default value",
          dedent("""\
          from dataclasses import dataclass


          @dataclass
          class Item:
              name: str
              value: int


          # Don't touch below this line
          print(Item("rope"))
          print(Item("gem", 5).value)
          """)),
         ("defaults the value to 0",
          dedent("""\
          from dataclasses import dataclass


          @dataclass
          class Item:
              name: str
              value: int = 0


          # Don't touch below this line
          print(Item("rope"))
          print(Item("gem", 5).value)
          """))])

L("classes", "class-inherit", "Monsters, and a dragon", "inheritance",
  "The dragon is a monster with one more idea: fire.",
  "**Inheritance** lets one class build on another. `class Dragon(Monster)` gets every method "
  "`Monster` has. Its own `__init__` calls `super().__init__(name, hp)` to let the parent set the "
  "shared fields, then adds `self.fire`. A method with the same name in the child **overrides** the "
  "parent's.\n\n"
  "Finish `Dragon`: call the parent's `__init__`, store `fire`, and override `describe()` to return "
  "`Smaug the dragon has 300 hp and breathes 40 fire`. The console must show:\n\n"
  "```text\nGoblin has 12 hp\nSmaug the dragon has 300 hp and breathes 40 fire\n```",
  dedent("""\
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
  """),
  dedent("""\
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
  """),
  "`super().__init__(name, hp)` runs `Monster.__init__` for this dragon. Then add `self.fire = fire` and write a new `describe`.",
  tests=dedent('''
  EXPECTED = "Goblin has 12 hp\\nSmaug the dragon has 300 hp and breathes 40 fire"

  def test_console():
      got = shown()
      assert got == EXPECTED, "The console shows:\\n" + got + "\\n\\nExpected:\\n" + EXPECTED

  from solution import Monster, Dragon

  def test_is_a_monster():
      assert issubclass(Dragon, Monster)

  def test_fields():
      d = Dragon("Smaug", 300, 40)
      assert (d.name, d.hp, d.fire) == ("Smaug", 300, 40)

  def test_override():
      assert Dragon("Smaug", 300, 40).describe() == "Smaug the dragon has 300 hp and breathes 40 fire"
      assert Monster("Goblin", 12).describe() == "Goblin has 12 hp"
  '''),
  checks=["node:ClassDef", "call:super", "def:describe"],
  wrong=[("never runs the parent's __init__",
          dedent("""\
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
          """)),
         ("forgets to override describe",
          dedent("""\
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
          """))])


# ============================================================ Files
L("files", "file-write", "Write the banner to a file", "files",
  "The Guild wants the notice on disk, not just on screen.",
  "`open(path, \"w\")` opens a file for writing and creates it if needed. Use it inside a `with` "
  "block: the block closes the file for you, even if something fails. `f.write(text)` writes exactly "
  "the characters you give it, with no newline added.\n\n"
  "Write `save_text(path, text)` that writes `text` to `path`. The code below the marker saves a "
  "notice, reads the file back and prints it; the console must show:\n\n"
  "```text\nThe Guild is open\n```",
  dedent("""\
  def save_text(path, text):
      pass


  # Don't touch below this line
  save_text("notice.txt", "The Guild is open")
  with open("notice.txt", encoding="utf-8") as f:
      print(f.read())
  """),
  dedent("""\
  def save_text(path, text):
      with open(path, "w", encoding="utf-8") as f:
          f.write(text)


  # Don't touch below this line
  save_text("notice.txt", "The Guild is open")
  with open("notice.txt", encoding="utf-8") as f:
      print(f.read())
  """),
  "Open with `\"w\"`, then call `f.write(text)` inside the `with` block.",
  tests=dedent('''
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
  '''),
  checks=[],
  wrong=[("adds a newline that was not asked for",
          dedent("""\
          def save_text(path, text):
              with open(path, "w", encoding="utf-8") as f:
                  f.write(text + "\\n")


          # Don't touch below this line
          save_text("notice.txt", "The Guild is open")
          with open("notice.txt", encoding="utf-8") as f:
              print(f.read())
          """)),
         ("writes the repr with quotes",
          dedent("""\
          def save_text(path, text):
              with open(path, "w", encoding="utf-8") as f:
                  f.write(repr(text))


          # Don't touch below this line
          save_text("notice.txt", "The Guild is open")
          with open("notice.txt", encoding="utf-8") as f:
              print(f.read())
          """)),
         ("opens without a with block",
          dedent("""\
          def save_text(path, text):
              f = open(path, "w", encoding="utf-8")
              f.write(text)


          # Don't touch below this line
          save_text("notice.txt", "The Guild is open")
          with open("notice.txt", encoding="utf-8") as f:
              print(f.read())
          """))])

L("files", "file-read", "Read the save, survive a missing one", "with",
  "A save file that isn't there is not a crash.",
  "Reading works the same way: `open(path)` then `f.read()`. But the file may be missing, and then "
  "`open` raises `FileNotFoundError`. Catch **that** error and return `\"empty\"`; let every other "
  "error through, because a bug in the path should not look like an empty save.\n\n"
  "Write `load_text(path)`. The code below the marker writes a file, reads it, then reads a file "
  "that does not exist; the console must show:\n\n```text\nThe Guild is open\nempty\n```",
  dedent("""\
  def load_text(path):
      with open(path, encoding="utf-8") as f:
          return f.read()


  # Don't touch below this line
  with open("notice.txt", "w", encoding="utf-8") as f:
      f.write("The Guild is open")
  print(load_text("notice.txt"))
  print(load_text("missing.txt"))
  """),
  dedent("""\
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
  """),
  "Put the `with open(...)` inside `try:` and catch `FileNotFoundError` only.",
  tests=dedent('''
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
  '''),
  checks=["node:Try"],
  wrong=[("does not catch the missing file",
          dedent("""\
          def load_text(path):
              with open(path, encoding="utf-8") as f:
                  return f.read()


          # Don't touch below this line
          with open("notice.txt", "w", encoding="utf-8") as f:
              f.write("The Guild is open")
          print(load_text("notice.txt"))
          print(load_text("missing.txt"))
          """)),
         ("catches every error, so real bugs look like empty saves",
          dedent("""\
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
          """)),
         ("returns an empty string instead of the word empty",
          dedent("""\
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
          """))])

L("files", "file-json", "Save the game as JSON", "json",
  "A bag and a quest log are not plain text.",
  "**JSON** is a text format for lists, dictionaries, strings, numbers, booleans and null. "
  "`json.dump(state, f)` writes a dictionary to an open file; `json.load(f)` reads it back as a "
  "dictionary. That keeps the shape of the save: lists stay lists, nested dictionaries stay nested.\n\n"
  "Write `save_game(path, state)` and `load_game(path)`. The code below the marker saves a hero and "
  "a bag, loads them, and prints the hero with the bag sorted; the console must show:\n\n"
  "```text\nSam gem rope\n```",
  dedent("""\
  import json


  def save_game(path, state):
      pass


  def load_game(path):
      pass


  # Don't touch below this line
  save_game("save.json", {"hero": "Sam", "bag": ["gem", "rope"]})
  state = load_game("save.json")
  print(state["hero"], " ".join(sorted(state["bag"])))
  """),
  dedent("""\
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
  """),
  "`json.dump(state, f)` needs both the object and the open file. `json.load(f)` takes only the file.",
  tests=dedent('''
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
  '''),
  checks=["call:dump", "call:load", "node:With"],
  wrong=[("writes Python's repr, which is not JSON",
          dedent("""\
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
          """)),
         ("builds the JSON text but never writes it",
          dedent("""\
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
          """)),
         ("returns the raw text instead of a dictionary",
          dedent("""\
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
          """))])


# ============================================================ Modules
L("modules", "module-main", "The Guild's front door", "main",
  "A file that is both a program and a module needs a front door.",
  "When Python runs a file, it sets `__name__` to `\"__main__\"`. When another file imports it, "
  "`__name__` is the module's name instead. So `if __name__ == \"__main__\": main()` runs `main()` "
  "when the file is run, and stays quiet when the file is imported. That is how one file can be both "
  "a program and a library.\n\n"
  "Add the guard so running the file prints exactly:\n\n```text\nThe Guild opens its doors.\n```\n\n"
  "Importing it must print nothing.",
  dedent("""\
  def main():
      print("The Guild opens its doors.")
  """),
  dedent("""\
  def main():
      print("The Guild opens its doors.")


  if __name__ == "__main__":
      main()
  """),
  "Put `if __name__ == \"__main__\":` at the bottom and call `main()` under it.",
  tests=dedent('''
  import contextlib, io, os
  import solution

  EXPECTED = "The Guild opens its doors."

  def test_runs_as_script():
      got = shown()
      assert got == EXPECTED, "The console shows:\\n" + got + "\\n\\nExpected:\\n" + EXPECTED

  def test_import_does_not_run_it():
      buf = io.StringIO()
      with contextlib.redirect_stdout(buf):
          runpy.run_path(os.path.join(HERE, "solution.py"), run_name="guild")
      assert buf.getvalue() == "", "Importing the file ran main() too."

  def test_main_is_defined():
      assert callable(solution.main)
  '''),
  checks=["node:If", "name:__name__", "call:main"],
  wrong=[("calls main() at the bottom with no guard",
          dedent("""\
          def main():
              print("The Guild opens its doors.")


          main()
          """)),
         ("prints in the guard instead of calling main",
          dedent("""\
          def main():
              print("The Guild opens its doors.")


          if __name__ == "__main__":
              print("The Guild opens its doors.")
          """)),
         ("gets the comparison backwards",
          dedent("""\
          def main():
              print("The Guild opens its doors.")


          if __name__ != "__main__":
              main()
          """))])


# ============================================================ The Guild
L("guild", "guild-hero", "The Guild's hero", "field",
  "Sam needs a bag that belongs to Sam alone.",
  "A **class attribute** such as `bag = []` belongs to the class, not to one hero: every instance "
  "reads the same list, and an append through one hero shows up for all of them. A **dataclass** "
  "field can build a fresh value for each instance with `field(default_factory=list)`; the factory "
  "runs once per hero.\n\n"
  "Turn `Hero` into a dataclass with `name`, `hp` and `bag`, and add `take(item)` and "
  "`hurt(amount)`. The code below the marker makes two heroes and gives Sam two items; the console "
  "must show:\n\n```text\nSam ['lamp', 'key'] 6\nAda []\n```",
  dedent("""\
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
  """),
  dedent("""\
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
  """),
  "`@dataclass` plus `field(default_factory=list)` builds a new bag for each hero. `take` appends to `self.bag`; `hurt` uses `max(0, ...)`.",
  tests=dedent('''
  EXPECTED = "Sam ['lamp', 'key'] 6\\nAda []"

  def test_console():
      got = shown()
      assert got == EXPECTED, "The console shows:\\n" + got + "\\n\\nExpected:\\n" + EXPECTED

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
  '''),
  checks=["node:ClassDef", "call:field", "def:take", "def:hurt"],
  wrong=[("keeps the shared class attribute",
          dedent("""\
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
          """)),
         ("builds a new bag instead of changing this hero's",
          dedent("""\
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
          """)),
         ("lets health go negative",
          dedent("""\
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
          """))])

L("guild", "guild-world", "The Guild's map", "class",
  "The map is rooms, exits and things you can pick up.",
  "A `Room` holds a name, a dictionary of exits (`direction -> room name`) and the items lying in "
  "it. A `Game` holds the hero, all the rooms and the room the hero is in. `move(direction)` must "
  "look the direction up, change the room only when the exit exists, and return `True` or `False`. "
  "`take(item)` must remove the item from the room **and** put it in the hero's bag.\n\n"
  "Fill in the three `Game` methods. The code below the marker walks and takes; the console must "
  "show:\n\n```text\ncellar ['lamp', 'key']\nFalse\n```",
  dedent("""\
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
  """),
  dedent("""\
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
  """),
  "In `move`, check `direction in exits` before changing `self.room`. In `take`, use `items.remove(item)` and `self.hero.bag.append(item)`.",
  tests=dedent('''
  EXPECTED = "cellar ['lamp', 'key']\\nFalse"

  def test_console():
      got = shown()
      assert got == EXPECTED, "The console shows:\\n" + got + "\\n\\nExpected:\\n" + EXPECTED

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
  '''),
  checks=["def:move", "def:take"],
  wrong=[("moves without checking that the exit exists",
          dedent("""\
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
          """)),
         ("puts the item in the bag but leaves it in the room",
          dedent("""\
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
          """))])

L("guild", "guild-save", "The Guild's ledger", "dataclass",
  "A game that forgets the bag is not a game.",
  "`dataclasses.asdict(obj)` turns a dataclass into a plain dictionary, which JSON can store. To load "
  "it back, rebuild each object from its dictionary: `Hero(**data[\"hero\"])`, and one `Room(**room)` "
  "for every entry in the rooms.\n\n"
  "Add `to_dict()` and `from_dict(data)` to `Game`, plus `save(path)` and `load(path)`. The code "
  "below the marker saves and loads a game; the console must show:\n\n"
  "```text\nhall ['lamp'] key\n```",
  dedent("""\
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
  """),
  dedent("""\
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
  """),
  "`to_dict` can be one `asdict` for the hero and a dict comprehension over `self.rooms`. `from_dict` reverses it with `Hero(**...)` and `Room(**...)`.",
  tests=dedent('''
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
  '''),
  checks=["call:asdict", "call:dump", "call:load", "node:ClassDef"],
  wrong=[("serialises the game with str(), which is not JSON",
          dedent("""\
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
          """)),
         ("builds the JSON text but never writes the file",
          dedent("""\
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
          """)),
         ("throws away the rooms when loading",
          dedent("""\
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
          """))])

L("guild", "guild-play", "The Guild's game", "class",
  "Time to play the game the Guild asked for.",
  "The engine is written: `Hero`, `Room`, `Game`, `new_game()` and the two rooms are below. Your job "
  "is `play(commands)`, which takes a list of command lines and returns a list of transcript lines. "
  "For each command: `look` describes the room and its items; `go <direction>` moves; `take <item>` "
  "picks something up; anything else gets `You can't do that.`. Finish with one `Bag: ...` line.\n\n"
  "The exact words matter; the tests compare the transcript line for line. Each call starts a fresh "
  "game.",
  dedent("""\
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
  """),
  dedent("""\
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
  """),
  "Split each command with `split(maxsplit=1)`, then use `if`/`elif`. Call `game.move` and `game.take`; they return `True` or `False`. Build the bag line with `\", \".join(sorted(...))`.",
  tests=dedent('''
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
  '''),
  checks=["def:play", "node:For", "call:move", "call:take"],
  project=True,
  wrong=[("keeps one game between calls, so the second run is not fresh",
          dedent("""\
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
          """)),
         ("forgets the closing bag line",
          dedent("""\
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
          """))])


# ============================================================ Checks on the new ground
Q("classes", "quiz-dataclass", "Quiz: the dataclass's card", "dataclass",
  "The Guild's clerk reads an item aloud.",
  """from dataclasses import dataclass

@dataclass
class Item:
    name: str
    value: int = 1

print(Item("rope"))""",
  "Item(name='rope', value=1)",
  "@dataclass writes __repr__ from the fields, so it shows the field names and the default value.")

Q("files", "quiz-json", "Quiz: what JSON keeps", "json",
  "A save comes back from disk.",
  """import json

state = {"hp": 10, "bag": ["rope", "gem"]}
text = json.dumps(state, sort_keys=True)
back = json.loads(text)
print(back["hp"] + 5, len(back["bag"]))""",
  "15 2",
  "JSON keeps numbers and lists. json.loads rebuilds a dictionary, so back[\"hp\"] is the number 10 again.")

Q("guild", "quiz-method", "Quiz: the bag that isn't there", "class",
  "Two heroes, one lesson.",
  """class Hero:
    bag = []

    def __init__(self, name):
        self.name = name

a = Hero("Sam")
b = Hero("Ada")
a.bag.append("lamp")
print(b.bag)""",
  "['lamp']",
  "bag is a class attribute, so both heroes share one list. A dataclass field with default_factory=list gives each hero its own.")
