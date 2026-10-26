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
