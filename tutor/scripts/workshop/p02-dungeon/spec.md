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
