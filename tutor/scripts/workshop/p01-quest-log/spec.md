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
