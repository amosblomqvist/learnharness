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
