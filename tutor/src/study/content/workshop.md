# Fantasy Quest: The Workshop
id: workshop
blurb: Real projects, built from a blank folder in your own editor and checked by hidden acceptance tests: command-line tools, an interactive game, data tools, a tested package, a web API, and a tool for your own machine.
why: You learn to program by writing a lot of code from nothing. Each project unlocks when Fantasy Quest has taught what it needs; then it's your design, your files, your git history.
stage: tools | Command-line tools | Programs with a front door: arguments in, files on disk, a clear exit code.
stage: games | Interactive programs | A loop that reads what you type and keeps state between turns.

## Project: the quest log
id: p01-quest-log
stage: tools
needs: quest/guild-save
minutes: 180
goal: The guild wants its quest board on the command line: add quests, mark them done, count the gold.
source: Python docs: argparse tutorial | https://docs.python.org/3/howto/argparse.html
source: Python docs: json | https://docs.python.org/3/library/json.html
source: Python docs: sys.exit() | https://docs.python.org/3/library/sys.html#sys.exit
project: true

### The job

Build it from a blank folder, in your own editor. The spec is on the right; it's also the folder's README. **Check** runs the hidden acceptance tests against your folder. Commit your work with git as you go.

::: project folder=quest-log
task: |
  # The quest log

  Build `questlog.py`, a command-line tool that keeps the guild's quests in a JSON file.

  ```text
  python questlog.py [--file PATH] <command> [arguments]
  ```

  `--file` is where the quests are kept; it defaults to `quests.json` in the current folder. A file that doesn't exist yet means there are no quests.

  ## Commands

  | Command | Prints (to stdout) | Exit code |
  |---|---|---|
  | `add NAME GOLD` | `Added: NAME (GOLD gold)` | 0 |
  | `list` | one line per quest, in the order they were added: `[ ] NAME - GOLD gold`, or `[x] ...` when done. With no quests: `No quests yet.` | 0 |
  | `done NAME` | `Completed: NAME. +GOLD gold` | 0 |
  | `stats` | `Q quests, D done, E gold earned, W gold waiting` (earned is the gold of done quests, waiting the gold of the rest) | 0 |

  ## Errors

  Errors go to **stderr**, start with `error: `, and change nothing on disk.

  | Problem | Message | Exit code |
  |---|---|---|
  | GOLD isn't a whole number of 0 or more | `error: gold must be a whole number` | 2 |
  | `add` with a name that's already there | `error: quest already exists: NAME` | 1 |
  | `done` with a name that isn't there | `error: no such quest: NAME` | 1 |
  | `done` on a quest that's already done | `error: already done: NAME` | 1 |
  | no command, or an unknown one | a usage message | 2 |

  ## The file

  ```json
  {"quests": [{"name": "Slay rats", "gold": 20, "done": false}]}
  ```

  Keep this shape: the tests read and write it too.

  ## Example

  ```text
  $ python questlog.py add "Slay rats" 20
  Added: Slay rats (20 gold)
  $ python questlog.py add "Find the key" 500
  Added: Find the key (500 gold)
  $ python questlog.py done "Slay rats"
  Completed: Slay rats. +20 gold
  $ python questlog.py list
  [x] Slay rats - 20 gold
  [ ] Find the key - 500 gold
  $ python questlog.py stats
  2 quests, 1 done, 20 gold earned, 500 gold waiting
  ```

  Use only the standard library. Put the code in functions, with the command-line handling under `if __name__ == "__main__":`.
file: README.md
~~~
# The quest log

Build `questlog.py`, a command-line tool that keeps the guild's quests in a JSON file.

```text
python questlog.py [--file PATH] <command> [arguments]
```

`--file` is where the quests are kept; it defaults to `quests.json` in the current folder. A file that doesn't exist yet means there are no quests.

## Commands

| Command | Prints (to stdout) | Exit code |
|---|---|---|
| `add NAME GOLD` | `Added: NAME (GOLD gold)` | 0 |
| `list` | one line per quest, in the order they were added: `[ ] NAME - GOLD gold`, or `[x] ...` when done. With no quests: `No quests yet.` | 0 |
| `done NAME` | `Completed: NAME. +GOLD gold` | 0 |
| `stats` | `Q quests, D done, E gold earned, W gold waiting` (earned is the gold of done quests, waiting the gold of the rest) | 0 |

## Errors

Errors go to **stderr**, start with `error: `, and change nothing on disk.

| Problem | Message | Exit code |
|---|---|---|
| GOLD isn't a whole number of 0 or more | `error: gold must be a whole number` | 2 |
| `add` with a name that's already there | `error: quest already exists: NAME` | 1 |
| `done` with a name that isn't there | `error: no such quest: NAME` | 1 |
| `done` on a quest that's already done | `error: already done: NAME` | 1 |
| no command, or an unknown one | a usage message | 2 |

## The file

```json
{"quests": [{"name": "Slay rats", "gold": 20, "done": false}]}
```

Keep this shape: the tests read and write it too.

## Example

```text
$ python questlog.py add "Slay rats" 20
Added: Slay rats (20 gold)
$ python questlog.py add "Find the key" 500
Added: Find the key (500 gold)
$ python questlog.py done "Slay rats"
Completed: Slay rats. +20 gold
$ python questlog.py list
[x] Slay rats - 20 gold
[ ] Find the key - 500 gold
$ python questlog.py stats
2 quests, 1 done, 20 gold earned, 500 gold waiting
```

Use only the standard library. Put the code in functions, with the command-line handling under `if __name__ == "__main__":`.
~~~
test: test_questlog.py
```
import json
import os
import subprocess
import sys
import uuid

ROOT = os.environ["PROJECT_ROOT"]
TMP = os.environ["TEST_TMP"]
SCRIPT = os.path.join(ROOT, "questlog.py")


def fresh():
    return os.path.join(TMP, "quests-%s.json" % uuid.uuid4().hex)


def run(path, *args, cwd=None):
    argv = [sys.executable, SCRIPT] + (["--file", path] if path else []) + list(args)
    r = subprocess.run(argv, capture_output=True, text=True, cwd=cwd or TMP, timeout=10)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def test_the_script_exists():
    assert os.path.exists(SCRIPT), "Make a file called questlog.py in the project folder"


def test_add_and_list():
    f = fresh()
    assert run(f, "add", "Slay rats", "20") == (0, "Added: Slay rats (20 gold)", "")
    run(f, "add", "Find the key", "500")
    code, out, _ = run(f, "list")
    assert code == 0
    assert out == "[ ] Slay rats - 20 gold\n[ ] Find the key - 500 gold"


def test_empty_list_and_missing_file():
    code, out, _ = run(fresh(), "list")
    assert (code, out) == (0, "No quests yet.")


def test_done_and_stats():
    f = fresh()
    run(f, "add", "Slay rats", "20")
    run(f, "add", "Find the key", "500")
    assert run(f, "done", "Slay rats")[:2] == (0, "Completed: Slay rats. +20 gold")
    assert run(f, "list")[1] == "[x] Slay rats - 20 gold\n[ ] Find the key - 500 gold"
    assert run(f, "stats")[1] == "2 quests, 1 done, 20 gold earned, 500 gold waiting"


def test_stats_when_empty():
    assert run(fresh(), "stats")[1] == "0 quests, 0 done, 0 gold earned, 0 gold waiting"


def test_file_format():
    f = fresh()
    run(f, "add", "Slay rats", "20")
    run(f, "done", "Slay rats")
    assert json.load(open(f)) == {"quests": [{"name": "Slay rats", "gold": 20, "done": True}]}


def test_reads_a_file_it_did_not_write():
    f = fresh()
    json.dump({"quests": [{"name": "Old quest", "gold": 7, "done": True}]}, open(f, "w"))
    assert run(f, "list")[1] == "[x] Old quest - 7 gold"


def test_default_file_is_in_the_current_folder():
    here = os.path.join(TMP, "cwd-%s" % uuid.uuid4().hex)
    os.makedirs(here)
    run(None, "add", "Herbs", "5", cwd=here)
    assert os.path.exists(os.path.join(here, "quests.json")), "Without --file, use quests.json in the current folder"


def test_bad_gold():
    f = fresh()
    for bad in ("lots", "-5", "2.5"):
        code, out, err = run(f, "add", "Greedy", bad)
        assert code == 2, "add with gold %r should exit 2, not %r" % (bad, code)
        assert err.splitlines()[-1] == "error: gold must be a whole number"
        assert out == ""
    assert not os.path.exists(f), "A failed add must not create or change the file"


def test_duplicate():
    f = fresh()
    run(f, "add", "Slay rats", "20")
    assert run(f, "add", "Slay rats", "99") == (1, "", "error: quest already exists: Slay rats")
    assert run(f, "list")[1] == "[ ] Slay rats - 20 gold"


def test_done_errors():
    f = fresh()
    run(f, "add", "Slay rats", "20")
    assert run(f, "done", "Ghost") == (1, "", "error: no such quest: Ghost")
    run(f, "done", "Slay rats")
    assert run(f, "done", "Slay rats") == (1, "", "error: already done: Slay rats")


def test_usage():
    code, out, err = run(fresh())
    assert code == 2 and err, "With no command, print a usage message to stderr and exit 2"
    code, out, err = run(fresh(), "dance")
    assert code == 2 and err


def test_importable_without_running():
    r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, %r); import questlog" % ROOT], capture_output=True, text=True, cwd=TMP, timeout=10)
    assert r.returncode == 0 and r.stdout == "", "Importing questlog should not run the program: use if __name__ == '__main__'"
```
solution: questlog.py
```
"""The guild's quest board on the command line."""
import argparse
import json
import os
import sys


def load(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)["quests"]


def save(path, quests):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"quests": quests}, f, indent=2)


def find(quests, name):
    for quest in quests:
        if quest["name"] == name:
            return quest
    return None


def fail(message, code=1):
    print("error: " + message, file=sys.stderr)
    return code


def gold_amount(text):
    if not text.isdigit():
        raise ValueError(text)
    return int(text)


def add(path, name, gold_text):
    try:
        gold = gold_amount(gold_text)
    except ValueError:
        return fail("gold must be a whole number", 2)
    quests = load(path)
    if find(quests, name):
        return fail("quest already exists: " + name)
    quests.append({"name": name, "gold": gold, "done": False})
    save(path, quests)
    print(f"Added: {name} ({gold} gold)")
    return 0


def show(path):
    quests = load(path)
    if not quests:
        print("No quests yet.")
    for quest in quests:
        mark = "x" if quest["done"] else " "
        print(f"[{mark}] {quest['name']} - {quest['gold']} gold")
    return 0


def done(path, name):
    quests = load(path)
    quest = find(quests, name)
    if quest is None:
        return fail("no such quest: " + name)
    if quest["done"]:
        return fail("already done: " + name)
    quest["done"] = True
    save(path, quests)
    print(f"Completed: {name}. +{quest['gold']} gold")
    return 0


def stats(path):
    quests = load(path)
    finished = [q for q in quests if q["done"]]
    earned = sum(q["gold"] for q in finished)
    waiting = sum(q["gold"] for q in quests if not q["done"])
    print(f"{len(quests)} quests, {len(finished)} done, {earned} gold earned, {waiting} gold waiting")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="questlog", description="The guild's quest board.")
    parser.add_argument("--file", default="quests.json", help="where the quests are kept")
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("add")
    p.add_argument("name")
    p.add_argument("gold")
    commands.add_parser("list")
    p = commands.add_parser("done")
    p.add_argument("name")
    commands.add_parser("stats")
    args = parser.parse_args(argv)
    if args.command == "add":
        return add(args.file, args.name, args.gold)
    if args.command == "list":
        return show(args.file)
    if args.command == "done":
        return done(args.file, args.name)
    return stats(args.file)


if __name__ == "__main__":
    sys.exit(main())
```
hint: Start with load() and save() for the JSON file, then one function per command. argparse with subparsers gives you the usage message and exit code 2 for free.
:::

## Project: the dungeon
id: p02-dungeon
stage: games
needs: quest/guild-play, quest/file-json, quest/class-dataclass
minutes: 240
goal: The Guild found a dungeon with a locked vault. Build the text adventure Sam explores it in.
source: Python tutorial: Input and output | https://docs.python.org/3/tutorial/inputoutput.html
source: Python docs: json | https://docs.python.org/3/library/json.html
source: Python docs: argparse | https://docs.python.org/3/howto/argparse.html
source: Python docs: sys.exit() | https://docs.python.org/3/library/sys.html#sys.exit
project: true

### The job

Build it from a blank folder, in your own editor. The spec is on the right; it's also the folder's README. **Check** runs the hidden acceptance tests against your folder. Commit your work with git as you go.

::: project folder=dungeon
task: |
  # The dungeon

  Build `dungeon.py`, a text adventure played in the terminal. The world comes from a JSON file, so the same program can run any dungeon.

  ```text
  python dungeon.py [--world PATH]
  ```

  `--world` is the world file; it defaults to `world.json` in the current folder. A world the program can't read prints `error: could not read world: PATH` to stderr and exits 2.

  ## The world file

  ```json
  {
    "start": "gate",
    "torch": 8,
    "win": "vault",
    "rooms": {
      "gate": {
        "name": "The Gate",
        "desc": "A cold wind follows you in. A hall lies north.",
        "exits": {"north": "hall"},
        "items": []
      },
      "hall": {
        "name": "The Hall",
        "desc": "Dust covers the floor. A vault door is east, and a tower stair is north.",
        "exits": {"south": "gate", "north": "tower", "east": "vault"},
        "items": ["key"],
        "locked": {"east": "vault"}
      }
    }
  }
  ```

  - `start` is the room the player begins in. `win` is the treasure room: entering it wins.
  - `torch` is how many moves the player can make. Each successful `go` uses one. When it reaches 0 after a move, the player loses, unless that room is the win room.
  - `rooms` maps a room id to `name`, `desc`, `exits` and `items`. `items` is optional; missing means empty.
  - A room may have `locked`, mapping a direction to the room behind it. That door opens only after the player uses a key in that room.

  ## The screen

  On start, and after a successful `go` or a `load`, print the room exactly as four lines:

  ```text
  The Hall
  Dust covers the floor. A vault door is east, and a tower stair is north.
  Exits: east, north, south
  Items: key
  ```

  Directions are sorted; items keep the order they have in the room's list. With no exits write `Exits: none`; with no items write `Items: none`.

  The prompt is `> `, with no newline, before every command.

  ## Commands

  | Command | Prints |
  |---|---|
  | `look` | the room, as above |
  | `go DIR` | the new room. Bad direction: `You can't go that way.` Locked door: `The door is locked. You need a key.` |
  | `take ITEM` | `Taken: ITEM.` Already carrying it: `You already have ITEM.` Not here: `There is no ITEM here.` |
  | `drop ITEM` | `Dropped: ITEM.` Not carrying it: `You don't have ITEM.` |
  | `inventory` | `You carry: key, torch.` or `You carry nothing.` |
  | `use ITEM` | `The door unlocks.` (in a room with a locked door, holding a key). Already open: `The door is already open.` No locked door here: `There is no locked door here.` Not carrying it: `You don't have ITEM.` A carried item that isn't a key: `You can't use ITEM here.` |
  | `save NAME` | `Saved: NAME.json` |
  | `load NAME` | `Loaded: NAME.json`, then the room. Missing save: `No save named NAME.` |
  | `quit` | `Goodbye.` and exit 0 |

  Anything else, including a command with the wrong number of words, prints `I don't understand that.` End of input is the same as `quit`. The key is not used up.

  Saving writes `NAME.json` beside the world file. The name may contain letters, digits, `-` and `_` only; anything else is `I don't understand that.` The file is JSON in this shape, and `load` must restore every part of it:

  ```json
  {
    "room": "hall",
    "inventory": ["key"],
    "torch": 7,
    "unlocked": ["hall:east"],
    "items": {"gate": [], "hall": [], "tower": [], "vault": ["treasure"]}
  }
  ```

  `items` holds the current contents of every room, so an item dropped before saving is still there after loading.

  ## Winning, losing, and exit codes

  Reaching the win room prints `You found the treasure! You win.` after the room and exits 0. Running out of torch prints `Your torch gutters out. The dark takes you.` after the room and exits 1. `quit` and end of input exit 0. A bad world or bad arguments exit 2.

  ## Example

  ```text
  $ python dungeon.py
  The Gate
  A cold wind follows you in. A hall lies north.
  Exits: north
  Items: none
  > go north
  The Hall
  Dust covers the floor. A vault door is east, and a tower stair is north.
  Exits: east, north, south
  Items: key
  > take key
  Taken: key.
  > use key
  The door unlocks.
  > go east
  The Vault
  Gold heaps around a stone chest.
  Exits: west
  Items: treasure
  You found the treasure! You win.
  ```

  Use only the standard library. Put the code in functions or a small class, with the command-line handling under `if __name__ == "__main__":`.
file: world.json
```
{
  "start": "gate",
  "torch": 8,
  "win": "vault",
  "rooms": {
    "gate": {
      "name": "The Gate",
      "desc": "A cold wind follows you in. A hall lies north.",
      "exits": {"north": "hall"},
      "items": []
    },
    "hall": {
      "name": "The Hall",
      "desc": "Dust covers the floor. A vault door is east, and a tower stair is north.",
      "exits": {"south": "gate", "north": "tower", "east": "vault"},
      "items": ["key"],
      "locked": {"east": "vault"}
    },
    "tower": {
      "name": "The Tower",
      "desc": "A narrow stair climbs into the dark. Nothing else is here.",
      "exits": {"south": "hall"},
      "items": []
    },
    "vault": {
      "name": "The Vault",
      "desc": "Gold heaps around a stone chest.",
      "exits": {"west": "hall"},
      "items": ["treasure"]
    }
  }
}
```
file: README.md
~~~
# The dungeon

Build `dungeon.py`, a text adventure played in the terminal. The world comes from a JSON file, so the same program can run any dungeon.

```text
python dungeon.py [--world PATH]
```

`--world` is the world file; it defaults to `world.json` in the current folder. A world the program can't read prints `error: could not read world: PATH` to stderr and exits 2.

## The world file

```json
{
  "start": "gate",
  "torch": 8,
  "win": "vault",
  "rooms": {
    "gate": {
      "name": "The Gate",
      "desc": "A cold wind follows you in. A hall lies north.",
      "exits": {"north": "hall"},
      "items": []
    },
    "hall": {
      "name": "The Hall",
      "desc": "Dust covers the floor. A vault door is east, and a tower stair is north.",
      "exits": {"south": "gate", "north": "tower", "east": "vault"},
      "items": ["key"],
      "locked": {"east": "vault"}
    }
  }
}
```

- `start` is the room the player begins in. `win` is the treasure room: entering it wins.
- `torch` is how many moves the player can make. Each successful `go` uses one. When it reaches 0 after a move, the player loses, unless that room is the win room.
- `rooms` maps a room id to `name`, `desc`, `exits` and `items`. `items` is optional; missing means empty.
- A room may have `locked`, mapping a direction to the room behind it. That door opens only after the player uses a key in that room.

## The screen

On start, and after a successful `go` or a `load`, print the room exactly as four lines:

```text
The Hall
Dust covers the floor. A vault door is east, and a tower stair is north.
Exits: east, north, south
Items: key
```

Directions are sorted; items keep the order they have in the room's list. With no exits write `Exits: none`; with no items write `Items: none`.

The prompt is `> `, with no newline, before every command.

## Commands

| Command | Prints |
|---|---|
| `look` | the room, as above |
| `go DIR` | the new room. Bad direction: `You can't go that way.` Locked door: `The door is locked. You need a key.` |
| `take ITEM` | `Taken: ITEM.` Already carrying it: `You already have ITEM.` Not here: `There is no ITEM here.` |
| `drop ITEM` | `Dropped: ITEM.` Not carrying it: `You don't have ITEM.` |
| `inventory` | `You carry: key, torch.` or `You carry nothing.` |
| `use ITEM` | `The door unlocks.` (in a room with a locked door, holding a key). Already open: `The door is already open.` No locked door here: `There is no locked door here.` Not carrying it: `You don't have ITEM.` A carried item that isn't a key: `You can't use ITEM here.` |
| `save NAME` | `Saved: NAME.json` |
| `load NAME` | `Loaded: NAME.json`, then the room. Missing save: `No save named NAME.` |
| `quit` | `Goodbye.` and exit 0 |

Anything else, including a command with the wrong number of words, prints `I don't understand that.` End of input is the same as `quit`. The key is not used up.

Saving writes `NAME.json` beside the world file. The name may contain letters, digits, `-` and `_` only; anything else is `I don't understand that.` The file is JSON in this shape, and `load` must restore every part of it:

```json
{
  "room": "hall",
  "inventory": ["key"],
  "torch": 7,
  "unlocked": ["hall:east"],
  "items": {"gate": [], "hall": [], "tower": [], "vault": ["treasure"]}
}
```

`items` holds the current contents of every room, so an item dropped before saving is still there after loading.

## Winning, losing, and exit codes

Reaching the win room prints `You found the treasure! You win.` after the room and exits 0. Running out of torch prints `Your torch gutters out. The dark takes you.` after the room and exits 1. `quit` and end of input exit 0. A bad world or bad arguments exit 2.

## Example

```text
$ python dungeon.py
The Gate
A cold wind follows you in. A hall lies north.
Exits: north
Items: none
> go north
The Hall
Dust covers the floor. A vault door is east, and a tower stair is north.
Exits: east, north, south
Items: key
> take key
Taken: key.
> use key
The door unlocks.
> go east
The Vault
Gold heaps around a stone chest.
Exits: west
Items: treasure
You found the treasure! You win.
```

Use only the standard library. Put the code in functions or a small class, with the command-line handling under `if __name__ == "__main__":`.
~~~
test: test_dungeon.py
```
import json
import os
import shutil
import subprocess
import sys
import uuid

ROOT = os.environ["PROJECT_ROOT"]
TMP = os.environ["TEST_TMP"]
SCRIPT = os.path.join(ROOT, "dungeon.py")

GATE = """The Gate
A cold wind follows you in. A hall lies north.
Exits: north
Items: none"""
HALL = """The Hall
Dust covers the floor. A vault door is east, and a tower stair is north.
Exits: east, north, south
Items: key"""
HALL_EMPTY = """The Hall
Dust covers the floor. A vault door is east, and a tower stair is north.
Exits: east, north, south
Items: none"""
TOWER = """The Tower
A narrow stair climbs into the dark. Nothing else is here.
Exits: south
Items: none"""
VAULT = """The Vault
Gold heaps around a stone chest.
Exits: west
Items: treasure"""


def run(text, world=None, cwd=None):
    # Most tests use their own copy of the world, so a save can't touch the project folder.
    if world is None and cwd is None:
        world = world_copy()
    argv = [sys.executable, SCRIPT]
    if world:
        argv += ["--world", world]
    return subprocess.run(argv, input=text, capture_output=True, text=True, cwd=cwd or TMP, timeout=10)


def transcript(*parts):
    return "\n".join([parts[0]] + ["> " + part for part in parts[1:]]).strip()


def save_path(world, name):
    return os.path.join(os.path.dirname(world), name + ".json")


def world_copy(torch=None):
    path = os.path.join(TMP, "world-%s.json" % uuid.uuid4().hex)
    shutil.copy(os.path.join(ROOT, "world.json"), path)
    if torch is not None:
        data = json.load(open(path, encoding="utf-8"))
        data["torch"] = torch
        json.dump(data, open(path, "w", encoding="utf-8"))
    return path


def custom_world(data):
    path = os.path.join(TMP, "world-%s.json" % uuid.uuid4().hex)
    json.dump(data, open(path, "w", encoding="utf-8"))
    return path


def test_the_script_exists():
    assert os.path.exists(SCRIPT), "Make a file called dungeon.py in the project folder"


def test_starts_in_the_start_room_and_quits():
    r = run("quit\n", cwd=ROOT)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == transcript(GATE, "Goodbye.")


def test_look_unknown_and_blank_lines():
    r = run("look\ndance\n\nquit\n")
    assert r.returncode == 0
    assert r.stdout.strip() == transcript(
        GATE, GATE, "I don't understand that.", "I don't understand that.", "Goodbye."
    )


def test_bad_direction():
    r = run("go south\nquit\n")
    assert r.stdout.strip() == transcript(GATE, "You can't go that way.", "Goodbye.")


def test_take_drop_and_inventory():
    r = run(
        "go north\ntake key\ninventory\ndrop key\ninventory\ntake key\ntake key\ndrop gold\nquit\n"
    )
    assert r.returncode == 0
    assert r.stdout.strip() == transcript(
        GATE,
        HALL,
        "Taken: key.",
        "You carry: key.",
        "Dropped: key.",
        "You carry nothing.",
        "Taken: key.",
        "You already have key.",
        "You don't have gold.",
        "Goodbye.",
    )


def test_locked_door_and_win():
    r = run("go north\ngo east\nuse key\ntake key\nuse key\nuse key\ngo east\n")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == transcript(
        GATE,
        HALL,
        "The door is locked. You need a key.",
        "You don't have key.",
        "Taken: key.",
        "The door unlocks.",
        "The door is already open.",
        VAULT + "\nYou found the treasure! You win.",
    )


def test_torch_runs_out():
    world = world_copy(torch=2)
    r = run("go north\ngo south\n", world=world)
    assert r.returncode == 1
    assert r.stdout.strip() == transcript(
        GATE, HALL, GATE + "\nYour torch gutters out. The dark takes you."
    )


def test_win_beats_the_last_torch():
    world = custom_world(
        {
            "start": "a",
            "torch": 1,
            "win": "b",
            "rooms": {
                "a": {"name": "A", "desc": "First.", "exits": {"right": "b"}, "items": []},
                "b": {"name": "B", "desc": "Last.", "exits": {"left": "a"}, "items": ["gem"]},
            },
        }
    )
    r = run("go right\n", world=world)
    assert r.returncode == 0, "reaching the treasure wins even when the torch reaches 0"
    assert r.stdout.strip() == transcript(
        "A\nFirst.\nExits: right\nItems: none",
        "B\nLast.\nExits: left\nItems: gem\nYou found the treasure! You win.",
    )


def test_custom_world_is_not_hard_coded():
    world = custom_world(
        {
            "start": "cell",
            "torch": 5,
            "win": "vault",
            "rooms": {
                "cell": {"name": "The Cell", "desc": "A damp cell.", "exits": {"out": "corridor"}, "items": ["coin"]},
                "corridor": {
                    "name": "The Corridor",
                    "desc": "A long corridor.",
                    "exits": {"in": "cell", "on": "vault"},
                    "items": [],
                    "locked": {"on": "vault"},
                },
                "vault": {"name": "The Other Vault", "desc": "A different treasure.", "exits": {"back": "corridor"}, "items": ["gem"]},
            },
        }
    )
    r = run("look\ntake coin\ngo out\ninventory\ngo on\nuse coin\nquit\n", world=world)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == transcript(
        "The Cell\nA damp cell.\nExits: out\nItems: coin",
        "The Cell\nA damp cell.\nExits: out\nItems: coin",
        "Taken: coin.",
        "The Corridor\nA long corridor.\nExits: in, on\nItems: none",
        "You carry: coin.",
        "The door is locked. You need a key.",
        "You can't use coin here.",
        "Goodbye.",
    )


def test_another_world_with_a_key_and_a_win():
    world = custom_world(
        {
            "start": "cell",
            "torch": 5,
            "win": "vault",
            "rooms": {
                "cell": {"name": "Cell", "desc": "Damp.", "exits": {"out": "hall"}, "items": ["key"]},
                "hall": {
                    "name": "Hall",
                    "desc": "Long.",
                    "exits": {"in": "cell", "on": "vault"},
                    "items": [],
                    "locked": {"on": "vault"},
                },
                "vault": {"name": "Vault", "desc": "Gold.", "exits": {"back": "hall"}, "items": []},
            },
        }
    )
    r = run("take key\ngo out\nuse key\ngo on\n", world=world)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == transcript(
        "Cell\nDamp.\nExits: out\nItems: key",
        "Taken: key.",
        "Hall\nLong.\nExits: in, on\nItems: none",
        "The door unlocks.",
        "Vault\nGold.\nExits: back\nItems: none\nYou found the treasure! You win.",
    )


def test_use_key_where_there_is_no_locked_door():
    r = run("go north\ntake key\ngo north\nuse key\nquit\n")
    assert r.returncode == 0
    assert r.stdout.strip() == transcript(
        GATE, HALL, "Taken: key.", TOWER, "There is no locked door here.", "Goodbye."
    )


def test_save_then_load_restores_the_state():
    world = world_copy()
    r = run("go north\ntake key\nuse key\nsave mid\nquit\n", world=world)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == transcript(
        GATE, HALL, "Taken: key.", "The door unlocks.", "Saved: mid.json", "Goodbye."
    )
    saved = json.load(open(save_path(world, "mid"), encoding="utf-8"))
    assert saved == {
        "room": "hall",
        "inventory": ["key"],
        "torch": 7,
        "unlocked": ["hall:east"],
        "items": {"gate": [], "hall": [], "tower": [], "vault": ["treasure"]},
    }

    r2 = run("load mid\ninventory\ngo east\n", world=world)
    assert r2.returncode == 0, r2.stderr
    assert r2.stdout.strip() == transcript(
        GATE,
        "Loaded: mid.json\n" + HALL_EMPTY,
        "You carry: key.",
        VAULT + "\nYou found the treasure! You win.",
    )


def test_save_keeps_a_dropped_item_in_the_room():
    world = world_copy()
    run("go north\ntake key\ndrop key\nsave drop\nquit\n", world=world)
    r = run("load drop\nlook\ntake key\n", world=world)
    assert r.returncode == 0
    assert r.stdout.strip() == transcript(
        GATE, "Loaded: drop.json\n" + HALL, HALL, "Taken: key.", "Goodbye."
    )


def test_missing_save():
    r = run("load nope\nquit\n")
    assert r.returncode == 0
    assert r.stdout.strip() == transcript(GATE, "No save named nope.", "Goodbye.")


def test_bad_save_name():
    r = run("save ../escape\nquit\n")
    assert r.returncode == 0
    assert r.stdout.strip() == transcript(GATE, "I don't understand that.", "Goodbye.")


def test_default_world_is_in_the_current_folder():
    shutil.copy(os.path.join(ROOT, "world.json"), os.path.join(TMP, "world.json"))
    r = run("quit\n")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == transcript(GATE, "Goodbye.")


def test_missing_world_is_an_error():
    path = os.path.join(TMP, "missing-world.json")
    r = run("quit\n", world=path)
    assert r.returncode == 2
    assert r.stdout == ""
    assert r.stderr.strip() == "error: could not read world: " + path


def test_end_of_input_quits():
    r = run("")
    assert r.returncode == 0
    assert r.stdout.strip() == transcript(GATE, "Goodbye.")


def test_import_does_not_run_the_game():
    r = subprocess.run(
        [sys.executable, "-c", "import sys; sys.path.insert(0, %r); import dungeon" % ROOT],
        capture_output=True,
        text=True,
        cwd=TMP,
        timeout=10,
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout == "", "Importing dungeon should not print or read input"
```
solution: dungeon.py
```
"""A text adventure that reads its world from JSON."""
import argparse
import json
import os
import re
import sys

NAME = re.compile(r"^[A-Za-z0-9_-]+$")


def load_world(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def describe(world, room_id):
    room = world["rooms"][room_id]
    exits = ", ".join(sorted(room.get("exits", {}))) or "none"
    items = ", ".join(room.get("items", [])) or "none"
    return f"{room['name']}\n{room['desc']}\nExits: {exits}\nItems: {items}"


class Game:
    def __init__(self, world, world_path):
        self.world = world
        self.world_path = os.path.abspath(world_path)
        self.room = world["start"]
        self.inventory = []
        self.torch = int(world["torch"])
        self.unlocked = set()
        self.over = False
        self.lost = False

    # ---------- output ----------
    def say(self, text):
        print(text)

    def look(self):
        self.say(describe(self.world, self.room))

    # ---------- movement ----------
    def door(self, direction):
        return f"{self.room}:{direction}"

    def go(self, direction):
        room = self.world["rooms"][self.room]
        exits = room.get("exits", {})
        if direction not in exits:
            self.say("You can't go that way.")
            return
        if direction in room.get("locked", {}) and self.door(direction) not in self.unlocked:
            self.say("The door is locked. You need a key.")
            return
        self.room = exits[direction]
        self.torch -= 1
        self.look()
        if self.room == self.world.get("win"):
            self.say("You found the treasure! You win.")
            self.over = True
        elif self.torch <= 0:
            self.say("Your torch gutters out. The dark takes you.")
            self.over = True
            self.lost = True

    # ---------- items ----------
    def take(self, item):
        room = self.world["rooms"][self.room]
        items = room.setdefault("items", [])
        if item in items:
            items.remove(item)
            self.inventory.append(item)
            self.say(f"Taken: {item}.")
        elif item in self.inventory:
            self.say(f"You already have {item}.")
        else:
            self.say(f"There is no {item} here.")

    def drop(self, item):
        if item not in self.inventory:
            self.say(f"You don't have {item}.")
            return
        self.inventory.remove(item)
        self.world["rooms"][self.room].setdefault("items", []).append(item)
        self.say(f"Dropped: {item}.")

    def show_inventory(self):
        if self.inventory:
            self.say("You carry: " + ", ".join(self.inventory) + ".")
        else:
            self.say("You carry nothing.")

    def use(self, item):
        if item not in self.inventory:
            self.say(f"You don't have {item}.")
            return
        if item != "key":
            self.say(f"You can't use {item} here.")
            return
        locked = self.world["rooms"][self.room].get("locked", {})
        if not locked:
            self.say("There is no locked door here.")
            return
        opened = False
        for direction in locked:
            if self.door(direction) not in self.unlocked:
                self.unlocked.add(self.door(direction))
                opened = True
        if opened:
            self.say("The door unlocks.")
        else:
            self.say("The door is already open.")

    # ---------- saves ----------
    def save_path(self, name):
        return os.path.join(os.path.dirname(self.world_path), name + ".json")

    def save(self, name):
        data = {
            "room": self.room,
            "inventory": self.inventory,
            "torch": self.torch,
            "unlocked": sorted(self.unlocked),
            "items": {room_id: list(room.get("items", [])) for room_id, room in self.world["rooms"].items()},
        }
        with open(self.save_path(name), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        self.say("Saved: " + name + ".json")

    def load(self, name):
        path = self.save_path(name)
        if not os.path.exists(path):
            self.say("No save named " + name + ".")
            return
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.room = data["room"]
        self.inventory = list(data["inventory"])
        self.torch = data["torch"]
        self.unlocked = set(data["unlocked"])
        for room_id, items in data.get("items", {}).items():
            if room_id in self.world["rooms"]:
                self.world["rooms"][room_id]["items"] = list(items)
        self.say("Loaded: " + name + ".json")
        self.look()

    # ---------- one turn ----------
    def command(self, line):
        parts = line.split()
        if not parts:
            self.say("I don't understand that.")
            return
        command, args = parts[0], parts[1:]
        if command == "look" and not args:
            self.look()
        elif command == "go" and len(args) == 1:
            self.go(args[0])
        elif command == "take" and len(args) == 1:
            self.take(args[0])
        elif command == "drop" and len(args) == 1:
            self.drop(args[0])
        elif command == "inventory" and not args:
            self.show_inventory()
        elif command == "use" and len(args) == 1:
            self.use(args[0])
        elif command in ("save", "load") and len(args) == 1 and NAME.match(args[0]):
            getattr(self, command)(args[0])
        elif command == "quit" and not args:
            self.say("Goodbye.")
            self.over = True
        else:
            self.say("I don't understand that.")


def play(world, world_path):
    game = Game(world, world_path)
    game.look()
    while not game.over:
        try:
            line = input("> ")
        except EOFError:
            game.say("Goodbye.")
            break
        game.command(line)
    return 1 if game.lost else 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="dungeon", description="Explore a small dungeon.")
    parser.add_argument("--world", default="world.json", help="the world file")
    args = parser.parse_args(argv)
    try:
        world = load_world(args.world)
    except (OSError, ValueError, KeyError):
        print("error: could not read world: " + args.world, file=sys.stderr)
        return 2
    return play(world, args.world)


if __name__ == "__main__":
    sys.exit(main())
```
hint: Keep the world in a dict, the player's state in a small class, and one method per command. Read commands with input("> ") until quit, a win or the torch dies.
:::
