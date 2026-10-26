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
