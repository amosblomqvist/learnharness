# Shell wargame
id: wargame
blurb: A capture-the-password game in the style of OverTheWire's Bandit: every level hides a password in a prepared folder, and you dig it out with the shell.
why: Reading about commands is not the same as using them under pressure. Each level gives you a folder and a goal, and nothing else: you explore, combine tools, and get stuck until you understand. It comes after Linux and Git because it uses both, and it goes further than Bandit (git forensics, logs, JSON, signals, permissions, decryption).
stage: entry | Getting in | Find files the shell makes awkward: odd names, hidden files, binary noise, sizes and dates.
stage: dig | Digging through data | Pull one line out of thousands, decode it, peel archives, compare files.
stage: beyond | Beyond Bandit | Git history, logs, JSON, permissions, PATH, signals, exit codes, streams, checksums, cron, and decryption.

## Level 0: the readme
id: l00
stage: entry
needs: linux/paths
minutes: 5
goal: Solve your first level: find the password and print only it.
source: OverTheWire Bandit (the original game, played over SSH) | https://overthewire.org/wargames/bandit/

Every level of this game works the same way. Tutor builds a folder for the level, runs your commands in it, and checks the output. The level is solved when your command prints **only the password**: one line, nothing else.

You can't see the folder until you look. Your first command in any level should be some form of `ls`, and `ls -la` is better, because it also shows hidden files, sizes and permissions. Each time you press Enter, the folder is rebuilt from scratch, so you can't break anything. You can also run several commands at once, one per line (⇧Enter), or chain them with `&&`.

A good way to work is in two phases:

1. **Explore.** `ls -la`, `cat` small files, `file` to see what kind of file something is, `head` and `wc -l` on big ones. The output appears even when it isn't the password, so use it.
2. **Extract.** Once you know where the password is, write the command that prints just it.

That two-phase habit is how you approach any unknown server: look before you touch, then do the smallest thing that answers the question.

This game follows the idea of [OverTheWire's Bandit](https://overthewire.org/wargames/bandit/), which is worth playing too: there you SSH into a real Linux server and each level is a different user account. The levels here are original, and the later ones go well beyond what Bandit covers. Bandit asks players not to publish solutions; in the same spirit, try hard before you open a solution here, because the struggle is the lesson. The solution link only appears after three tries.

### Level goal

The password for the next level is in a file called `readme` in the level's folder.

::: shell secret
task: Print the password from `readme`.
setup:
```bash
printf '%s\n' ldWtzrHm0VTQiEj8zMxnngp9lrzqmjPp > readme
```
expect: ldWtzrHm0VTQiEj8zMxnngp9lrzqmjPp
solution:
```bash
cat readme
```
hint: `ls` shows what's there. `cat` prints a file.
:::

::: card
q: In a wargame level (or on a server you've never seen), what should your first command be, and why?
answer: `ls -la`: it lists every entry, including hidden ones (names starting with a dot), with type, permissions, size and date. You learn what's there before you touch anything.
:::

## Level 1: a file called -
id: l01
stage: entry
needs: l00
minutes: 10
goal: Open a file whose name looks like an option.
source: GNU coreutils: Common options (the -- convention) | https://www.gnu.org/software/coreutils/manual/html_node/Common-options.html

The password is in a file named `-`. Try `cat -` and see what happens: nothing comes back, or the command waits. Why?

Programs read their arguments and decide which ones are options by the leading dash. For many tools a lone `-` is a special name meaning **standard input**: `cat -` reads from the keyboard (or from a pipe), not from a file called `-`. The shell isn't involved in this decision; it hands `-` to `cat` as a string, and `cat` interprets it.

There are two classic ways to tell a program "this is a filename, not an option":

- **Give it a path**, so it no longer starts with a dash: `./-` is the same file, but no program will mistake it for an option.
- **End the options with `--`**: most programs treat everything after `--` as an operand, even if it starts with a dash. (That works for names like `-rf`, but not for a lone `-`, which many programs still read as standard input.)

You'll meet this for real when someone creates a file called `-rf` or `--help` by accident, and `rm -- -rf` or `rm ./-rf` is how you remove it safely.

::: shell secret
task: Print the password from the file named `-`.
setup:
```bash
printf '%s\n' 1ejABox7dor2Uy9Sx2q0r5MuR5b5bNvL > ./-
printf 'nothing here\n' > notes
```
expect: 1ejABox7dor2Uy9Sx2q0r5MuR5b5bNvL
solution:
```bash
cat ./-
```
hint: Name the file with a path that doesn't start with a dash.
:::

::: quiz
q: You need to delete a file literally named `-rf` in the current directory. Which command is safe?
- `rm -rf`
- `rm "-rf"`
+ `rm ./-rf` (or `rm -- -rf`)
- `rm '-rf' -i`
why: Quotes don't help: the shell removes them, and `rm` still sees `-rf` as options. A path (`./-rf`) or `--` before the name makes `rm` treat it as a file. `rm -rf` with no file does nothing harmful here, but it also deletes nothing, and typed one slip later it is the most dangerous command there is.
:::

## Level 2: spaces in the name
id: l02
stage: entry
needs: l01
minutes: 10
goal: Handle a filename with spaces and leading dashes.
source: GNU Bash manual: Quoting | https://www.gnu.org/software/bash/manual/bash.html#Quoting

This time the file's name has spaces in it, and it also starts with dashes. You have to solve two problems at once:

1. **Spaces.** The shell splits a command line on spaces. Unquoted, `cat my file` passes two arguments, `my` and `file`. Quote the name (`"my file"`) or escape each space (`my\ file`) so it arrives as one argument. Tab completion in a real terminal does the escaping for you.
2. **The leading dashes.** Even once it's one argument, a name starting with `-` looks like an option, as in the last level.

Quotes are for the shell; the path prefix or `--` is for the program. Each solves a different layer of the problem, and you need both.

When a name is unpleasant to type, you can also let a glob match it: `cat ./*spaces*` expands to the real name, quoting included, because the shell inserts the matched name as one word.

::: shell secret
task: Print the password from the file whose name contains `spaces`.
setup:
```bash
printf '%s\n' lisIZM3Bhniw9P8sCSJT8xZXTbndNSY7 > './--spaces in this filename--'
printf 'not it\n' > './spaces.txt.bak'
```
expect: lisIZM3Bhniw9P8sCSJT8xZXTbndNSY7
solution:
```bash
cat -- "--spaces in this filename--"
```
hint: `ls -la` shows the exact name. Quote it so it's one argument, and stop option parsing with `--` (or put `./` in front).
:::

::: card
q: A filename is `-- my report --`. Why do you need both quotes and `./` (or `--`) to `cat` it?
answer: Quotes keep the shell from splitting the name at the spaces, so `cat` gets one argument. `./` (or `--` before it) keeps `cat` from reading the leading dashes as options. The quotes work at the shell's level; the path works at the program's level.
:::

## Level 3: hidden in plain sight
id: l03
stage: entry
needs: l02
minutes: 10
goal: Find hidden files, including ones whose names are made to look like nothing.
source: GNU coreutils: ls invocation | https://www.gnu.org/software/coreutils/manual/html_node/ls-invocation.html

The password is in a directory called `inhere`, and `ls inhere` shows something that isn't it.

On Unix a file is **hidden** if its name starts with a dot, and that's the whole mechanism: there is no hidden attribute. `ls` skips dot-files unless you pass `-a` (everything, including `.` and `..`) or `-A` (everything except `.` and `..`). Configuration lives in dot-files for that reason: `~/.bashrc`, `~/.ssh/`, `.git/`, `.env`.

Two tricks make hidden files harder to spot:

- Names that are **mostly dots**, like `...` or `...hidden`, which look like `.` and `..` at a glance.
- Names with **trailing spaces**, which `ls` prints without showing the space. `ls -lab` (BSD) or `ls -la --quoting-style=c` (GNU) reveals them.

Globs skip dot-files too: `cat inhere/*` doesn't match `inhere/.secret`. `inhere/.*` does, but on older shells it also matches `.` and `..`.

::: shell secret
task: Print the password hidden in `inhere`.
setup:
```bash
mkdir inhere
printf 'Nothing to see here.\n' > inhere/readme
printf '%s\n' LLu0HStG3vK5zCEIHsVzTnKu47BdGdQP > 'inhere/...Hiding-From-You'
```
expect: LLu0HStG3vK5zCEIHsVzTnKu47BdGdQP
solution:
```bash
cat "inhere/...Hiding-From-You"
```
hint: `ls -A inhere`.
:::

::: quiz
q: What makes a file "hidden" on Linux?
- A hidden attribute set with `chattr`
+ Its name starts with a dot; `ls` and globs skip such names unless asked
- Permissions of 000
- Being owned by root
why: There is no separate attribute: it's purely a naming convention honoured by `ls` and the shell's globs. A file with mode 000 is still listed, just unreadable.
:::

## Level 4: the only readable one
id: l04
stage: entry
needs: l03
minutes: 15
goal: Tell text files from binary ones with `file`, and pick the one that matters.
source: file(1) manual page | https://man7.org/linux/man-pages/man1/file.1.html

`inhere` holds ten files named `-file00` to `-file09`. Only one of them is human-readable. `cat`-ing the others prints binary garbage, which can mess up your terminal (in a real one, `reset` fixes it).

The tool for "what is this file?" is `file`. It ignores the name and extension and looks at the content: magic numbers at the start (`%PDF`, gzip's `1f 8b`, ELF executables), character encodings, line endings. Typical answers are `ASCII text`, `UTF-8 Unicode text`, `gzip compressed data`, `ELF 64-bit LSB executable` and `data`, which means "bytes I can't classify".

`file` takes many arguments, so one call can survey a whole folder: `file inhere/*`. Remember the leading dashes: `inhere/-file00` is a path, so it's safe, but `cd inhere && file *` would pass `-file00` as an option. `file ./*` avoids that.

In real life `file` answers questions like "is this upload really a PDF?", "why does this config fail to parse?" (it's UTF-16 or has CRLF line endings, and `file` says so), and "what is this binary someone left in /tmp?".

::: shell secret
task: Print the password from the only human-readable file in `inhere`.
setup:
```bash
mkdir inhere
for i in 0 1 2 3 4 5 6 7 8 9; do
  printf '\0\377\0\376%.0s' $(seq 1 $((20 + i))) > "inhere/-file0$i"
done
printf '%s\n' BG9sDZtUJakjKNSvOMGYGtuwBPQrVn1n > inhere/-file07
```
expect: BG9sDZtUJakjKNSvOMGYGtuwBPQrVn1n
solution:
```bash
cat "$(file inhere/* | grep 'ASCII text' | cut -d: -f1)"
```
hint: `file inhere/*` classifies every file. Pick the one that says text, then `cat` it by its path.
:::

::: card
q: How does `file` decide what a file is, and what does an answer of `data` mean?
answer: It reads the content (magic numbers, encodings, structure), not the name or extension. `data` means it found no recognisable format, which usually means binary or encrypted bytes.
:::

## Level 5: a file with these properties
id: l05
stage: entry
needs: l04, linux/grep
minutes: 20
goal: Search by size, permissions and type with `find`, and combine tests.
source: GNU findutils: Finding files | https://www.gnu.org/software/findutils/manual/html_node/find_html/index.html

`inhere` now has twenty directories with files scattered through them. The password file has all three of these properties:

- human-readable
- exactly **1033 bytes**
- **not** executable

`find` filters by properties, and every test you add must hold (they're ANDed):

| Test | Matches |
|---|---|
| `-type f` / `-type d` | regular files / directories |
| `-size 1033c` | exactly 1033 bytes (`c` = bytes; plain `-size 2` means 2 blocks of 512) |
| `-size +100M` | bigger than 100 MiB |
| `-perm -100` | the owner's execute bit is set (the `-` means "at least these bits") |
| `! -perm -100` | the owner's execute bit is **not** set |
| `-name '*.log'` | the name matches (quote it, so the shell doesn't expand it first) |

`!` negates the next test. Watch out for the `c`: `-size 1033` without it means 1033 *blocks*, and matches nothing you expect. That's a classic source of "find finds nothing".

`find` can't test "human-readable" itself, but it can hand its results to `file` with `-exec file {} +`, which you used in the last level. Narrow with `find` first, then classify only the survivors.

::: shell secret
task: Print the password from the human-readable, 1033-byte, non-executable file somewhere under `inhere`.
setup:
```bash
mkdir inhere
for d in $(seq -w 0 19); do
  mkdir "inhere/maybehere$d"
  printf 'decoy %s\n' "$d" > "inhere/maybehere$d/-file1"
  printf 'x%.0s' $(seq 1 $((900 + 10#$d * 6))) > "inhere/maybehere$d/.file2"
  printf '%s\n' "$(printf 'p%s' "$d" | shasum | cut -c1-32)" > "inhere/maybehere$d/spaces file3"
done
{ printf 'y%.0s' $(seq 1 1032); printf '\n'; } > inhere/maybehere04/-file1
chmod +x inhere/maybehere04/-file1
{ printf '\0\377\0\376%.0s' $(seq 1 258); printf '\0'; } > inhere/maybehere11/.file2
{ printf '%s\n' QtQEBFNXjmhO13AnZgi5VbJRo0UOrd8o; printf ' %.0s' $(seq 1 1000); } > inhere/maybehere07/.file2
```
expect: QtQEBFNXjmhO13AnZgi5VbJRo0UOrd8o
solution:
```bash
find inhere -type f -size 1033c ! -perm -100 -exec file {} + | grep 'ASCII text' | cut -d: -f1 | while read -r f; do cat "$f"; done
```
hint: `find inhere -type f -size 1033c` first: there are three such files. Then drop the executable one with `! -perm -100`, and use `file` to drop the binary one.
:::

::: quiz
q: `find . -size 1033` finds nothing, but you know a 1033-byte file is there. Why?
- `find` can't search by size
+ Without a unit, `-size` counts 512-byte blocks; you need `-size 1033c` for bytes
- The file is hidden, and `find` skips dot-files
- `-size` needs a `+` or `-`
why: The default unit is a 512-byte block, a leftover from old Unix. `c` means bytes; `k`, `M` and `G` are also available. And unlike `ls` and globs, `find` does not skip dot-files.
:::

## Level 6: the leap day
id: l06
stage: entry
needs: l05
minutes: 15
goal: Find files by modification time, and pull one field from the result.
source: GNU findutils: Age ranges | https://www.gnu.org/software/findutils/manual/html_node/find_html/Age-Ranges.html

`logs` has hundreds of files, and every one contains a line like `session <token>`. The password is the token in the only file **last modified on 29 February 2024**.

Every file has timestamps, and `ls -l` shows the modification time (mtime). For a handful of files you can eyeball them; for hundreds you ask `find`:

- `-mtime -7`: modified within the last 7 days (counted back from *now*)
- `-newer ref`: modified more recently than the file `ref`
- `-newermt 2024-02-29`: modified after that date and time (both GNU and BSD `find` support it)

To get a window, combine one test with the negation of another: newer than the start, and **not** newer than the end. That's the same AND-plus-`!` logic as the last level.

Once you've found the file, you want the token, not the whole line: `awk '{print $2}'` prints the second whitespace-separated field. `find … -exec awk '{print $2}' {} +` does it in one step.

At work, "which config changed between Tuesday and Wednesday?" and "which logs are older than 30 days?" (the cleanup cron job) are this exact search.

::: shell secret
task: Print the session token from the only file in `logs` last modified on 29 February 2024.
setup:
```bash
mkdir logs
i=0
for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
  for d in 03 07 11 15 19 23 27; do
    i=$((i + 1))
    f="logs/app-$i.log"
    printf 'session %s\n' "$(printf 'decoy%s' "$i" | shasum | cut -c1-32)" > "$f"
    touch -t "2024$m${d}1200" "$f"
  done
done
printf 'session %s\n' Qdxidq7OyFjVisrM1h8vbvTXfQNNTGnN > logs/app-31.log.1
touch -t 202402291530 logs/app-31.log.1
```
expect: Qdxidq7OyFjVisrM1h8vbvTXfQNNTGnN
solution:
```bash
find logs -type f -newermt 2024-02-29 ! -newermt 2024-03-01 -exec awk '{print $2}' {} +
```
hint: `-newermt 2024-02-29` keeps files changed after the start of that day. Add `! -newermt 2024-03-01` to cut off the end. Then print the second field.
:::

::: card
q: How do you find files modified on one particular day with `find`?
answer: Combine a start and a negated end: `find . -newermt 2024-02-29 ! -newermt 2024-03-01`. Both conditions must hold, so only files changed during that day match.
:::

## Level 7: the millionth word
id: l07
stage: dig
needs: l06, linux/textproc
minutes: 15
goal: Match a whole field exactly, and see why grep -w can lie.
source: GNU awk: Comparison expressions | https://www.gnu.org/software/gawk/manual/html_node/Comparison-Operators.html

`data.txt` has twenty thousand lines of `word<TAB>token`. The password is the token on the line whose word is exactly `millionth`.

`grep millionth` matches too much: any line containing those letters, including `millionths`. `grep -w millionth` looks better, because it requires the match to be a whole *word*. But `grep`'s idea of a word is "letters, digits and underscore", so in `millionth-ish` the `-` counts as a boundary, and `-w` matches it anyway. Run it and look.

When the data has columns, compare the column instead of searching the line:

```bash
awk '$1 == "millionth" { print $2 }' data.txt
```

`awk` splits each line into fields (`$1`, `$2`, …) on whitespace by default, tabs included, and `==` compares the whole field. There's no partial match and no word-boundary rule to trip over. That's more precise than any regex for structured data.

The general lesson: text search answers "does this appear somewhere?", and field comparison answers "is this column exactly X?". Logs and CSVs usually need the second.

::: shell secret
task: Print the token next to the word `millionth` in `data.txt`.
setup:
```bash
awk 'BEGIN {
  srand(7); split("apple river stone millionths cloud millionth-ish candle orbit", w, " ")
  c = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  for (i = 0; i < 20000; i++) {
    if (i == 12345) { printf "millionth\t%s\n", "Zlhyg74gTFSsWSr4GUqN4XtpwWyIDXQ5"; continue }
    printf "%s\t%s\n", w[int(rand() * 8) + 1], substr(c, int(rand() * 30) + 1, 32)
  }
}' > data.txt
```
expect: Zlhyg74gTFSsWSr4GUqN4XtpwWyIDXQ5
solution:
```bash
awk '$1 == "millionth" { print $2 }' data.txt
```
hint: Try `grep -w millionth data.txt | head` and look at what it matches. Then compare the first field exactly with `awk`.
:::

::: quiz
q: Why does `grep -w millionth` match the line `millionth-ish	abc`?
- `-w` is case-insensitive
+ For grep a "word" is letters, digits and underscore, so `-` is a word boundary and `millionth` counts as a whole word there
- `-w` matches the start of the line
- It doesn't; grep -w would skip that line
why: `-w` only checks that the characters around the match aren't word characters. A hyphen isn't one, so `millionth-ish` contains the whole word `millionth`. To match a column exactly, compare the field: `awk '$1 == "millionth"'`.
:::

## Level 8: the one that's alone
id: l08
stage: dig
needs: l07
minutes: 10
goal: Find the only line that occurs exactly once.
source: GNU coreutils: uniq invocation | https://www.gnu.org/software/coreutils/manual/html_node/uniq-invocation.html

`data.txt` holds hundreds of tokens, shuffled, and each appears between two and six times, except the password, which appears exactly once.

`uniq` works on **adjacent** lines only, which is why it almost always follows `sort`. Its options answer different questions:

| Command | Prints |
|---|---|
| `sort f \| uniq` | each distinct line once |
| `sort f \| uniq -c` | each distinct line with its count |
| `sort f \| uniq -d` | only lines that appear more than once |
| `sort f \| uniq -u` | only lines that appear exactly once |

Without `sort` first, `uniq -u` on shuffled data reports almost everything as unique, because duplicates aren't next to each other. That's the bug to remember.

At work: "which IP made exactly one request?", "which config keys appear in only one environment?" (concatenate the key lists, then `sort | uniq -u`), "which hosts are missing from the inventory?"

::: shell secret
task: Print the only line in `data.txt` that occurs exactly once.
setup:
```bash
awk -v pw=QD22y93vAh7FdEbnO5O4wmk1nKiqVzGe 'BEGIN {
  srand(8); c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (i = 1; i <= 300; i++) {
    s = ""; for (j = 0; j < 32; j++) s = s substr(c, int(rand() * 62) + 1, 1)
    n = int(rand() * 5) + 2; for (k = 0; k < n; k++) print s
  }
  print pw
}' | awk 'BEGIN { srand(9) } { print rand() "\t" $0 }' | sort -k1,1 | cut -f2- > data.txt
```
expect: QD22y93vAh7FdEbnO5O4wmk1nKiqVzGe
solution:
```bash
sort data.txt | uniq -u
```
hint: `uniq` only compares neighbouring lines, so sort first.
:::

::: card
q: Why does `uniq -u data.txt` give wrong results on unsorted data?
answer: `uniq` only compares each line with the one right before it. Duplicates that aren't adjacent look unique. Sort first: `sort data.txt | uniq -u`.
:::

## Level 9: strings in the noise
id: l09
stage: dig
needs: l08, l04
minutes: 15
goal: Extract readable text from a binary file.
source: strings(1) manual page | https://man7.org/linux/man-pages/man1/strings.1.html

`data.bin` is binary. Somewhere inside it, among the noise, are a few human-readable strings, and the ones that matter start with several `=` signs. The password is one of them.

`strings` prints every run of printable characters at least 4 long (`-n 8` raises the minimum). It's the first thing to run on an unknown binary: it shows embedded messages, URLs, file paths, version strings and, far too often, credentials that someone compiled into a program.

```bash
strings data.bin | head
strings -n 10 /usr/bin/ssh | grep -i openssl
```

Pipe the result through `grep` to keep the lines you care about, then cut down to the field you need. On macOS `strings` comes with the Command Line Tools; on Linux it's in binutils. If it's missing, `grep -a` (treat binary as text) plus a pattern does a rougher job.

::: shell secret
task: Print the password from the readable strings in `data.bin`.
setup:
```bash
noise() { printf '\001\002\003\004\005\006\007\010%.0s' $(seq 1 40); }
{
  noise; printf 'Zx7fake=PASSWORD0not\0'
  noise; printf '==== the\0'
  noise; printf 'xQ\0'
  noise; printf '==== password\0'
  noise; printf '==== is\0'
  noise; printf '==== %s\0' X7vZZT1bzz9rzk4cW3jeUfWwv0cJG5Nt
  noise; printf 'end-of-file\0'
  noise
} > data.bin
```
expect: X7vZZT1bzz9rzk4cW3jeUfWwv0cJG5Nt
solution:
```bash
strings data.bin | grep '^==' | tail -n 1 | awk '{print $2}'
```
hint: `strings data.bin` shows every readable run. Keep the ones that start with `==`, and look at what they spell.
:::

::: quiz
q: You suspect a vendor's binary has an API key compiled into it. What's the quickest first look?
- `cat binary | less`
+ `strings binary | grep -i -E 'key|token|secret'`
- `file binary`
- `chmod +x binary && ./binary --help`
why: `strings` pulls out every printable run, and grep filters for likely names. `file` only tells you the format, `cat` floods you with binary, and running an unknown binary is the one thing not to do first.
:::

## Level 10: base64
id: l10
stage: dig
needs: l09
minutes: 10
goal: Recognise and decode base64.
source: RFC 4648: The Base64 encoding | https://www.rfc-editor.org/rfc/rfc4648

`data.txt` holds a line of letters, digits, `+`, `/` and maybe `=` at the end. That shape is **base64**: a way to write any bytes using only 64 safe characters, so binary data survives email, JSON, URLs and YAML.

Base64 is an **encoding, not encryption**. Anyone can reverse it, without a key:

```bash
printf 'hi' | base64        # aGk=
printf 'aGk=' | base64 -d   # hi
```

You'll see it everywhere in infrastructure: Kubernetes Secrets store values base64-encoded, HTTP Basic auth sends `user:password` base64-encoded, JWTs are three base64url pieces, and certificates (PEM) are base64 between `-----BEGIN` lines. Every one of those is readable by anyone who gets the text. Recognising base64 on sight, and knowing it hides nothing, is a basic security reflex.

Mind one portability trap: GNU `base64 -d file` takes a filename, but macOS's `base64` only reads standard input (or `-i file`). `base64 -d < file` works on both, and it's what scripts that must run anywhere use. Older macOS versions spelled `-d` as `-D`.

::: shell secret
task: Decode `data.txt` and print only the password.
setup:
```bash
printf 'The password is %s\n' ST0uFgMu5G24IoWCsSE7qmi6ZhfCBp2x | base64 > data.txt
```
expect: ST0uFgMu5G24IoWCsSE7qmi6ZhfCBp2x
solution:
```bash
base64 -d < data.txt | awk '{print $4}'
```
hint: Decode it first and read the sentence; then print the right word.
:::

::: quiz
q: A Kubernetes Secret has `password: aHVudGVyMg==`. How protected is that password?
- Encrypted with the cluster's key
+ Not at all: it's base64, so `echo aHVudGVyMg== | base64 -d` prints it
- Hashed, so it can't be recovered
- Protected unless someone has the base64 key
why: Base64 is a reversible encoding with no key. Kubernetes Secrets are protected by access control (RBAC) and optional encryption at rest, not by the base64.
:::

## Level 11: rotated letters
id: l11
stage: dig
needs: l10
minutes: 10
goal: Reverse a letter substitution with `tr`.
source: GNU coreutils: tr invocation | https://www.gnu.org/software/coreutils/manual/html_node/tr-invocation.html

`data.txt` is English, but every letter has been rotated 13 places: a becomes n, b becomes o, …, n becomes a. This is **ROT13**, the Caesar cipher with a shift of 13. Applying it twice gives back the original, which is why it was used on old forums to hide spoilers.

`tr` translates characters from one set to the matching position in another:

```bash
echo hello | tr 'a-z' 'A-Z'                       # HELLO
echo 'Uryyb' | tr 'A-Za-z' 'N-ZA-Mn-za-m'         # Hello
```

Read the second set carefully: `A-Z` maps onto `N-Z` followed by `A-M`, so A→N, …, M→Z, N→A, …. The same goes for the lower case. Digits are untouched.

ROT13 isn't security; it's a puzzle. But `tr` itself is a workhorse: `tr -d '\r'` strips Windows line endings that break shell scripts, `tr -s ' '` squeezes repeated spaces before `cut`, and `tr '\n' ' '` joins lines.

::: shell secret
task: Undo the rotation in `data.txt` and print only the password.
setup:
```bash
printf 'The password is %s\n' FoSaGEYtT2bOqPALJ4sfPwlpe3N5E2jU | tr 'A-Za-z' 'N-ZA-Mn-za-m' > data.txt
```
expect: FoSaGEYtT2bOqPALJ4sfPwlpe3N5E2jU
solution:
```bash
tr 'A-Za-z' 'N-ZA-Mn-za-m' < data.txt | awk '{print $4}'
```
hint: ROT13 is its own inverse: the same `tr` that encoded it decodes it.
:::

::: card
q: A shell script fails with `$'\r': command not found`. What happened, and which one-liner fixes the file?
answer: The file has Windows line endings (CRLF), so every line ends with an invisible carriage return. `tr -d '\r' < script.sh > fixed.sh` removes them (or `dos2unix`).
:::

## Level 12: the onion
id: l12
stage: dig
needs: l11, linux/archives
minutes: 30
goal: Peel a file that was compressed and archived several times, identifying each layer with `file`.
source: xxd(1) manual page | https://man7.org/linux/man-pages/man1/xxd.1.html
source: GNU tar manual | https://www.gnu.org/software/tar/manual/tar.html

`data.txt` is a **hexdump**: the bytes of a file written as hexadecimal, the way `xxd` prints them. Under it is a file that was compressed and archived over and over, in a mixed order. Somewhere in the middle there's the password.

The method is the same at every layer:

1. Turn the current thing into a real file.
2. Ask `file` what it is.
3. Use the matching tool to unwrap it.
4. Repeat until `file` says text.

| `file` says | Unwrap with |
|---|---|
| hexdump text | `xxd -r data.txt > out` |
| gzip compressed data | `gzip -dc out > next` |
| bzip2 compressed data | `bzip2 -dc out > next` |
| POSIX tar archive | `tar xf out` (and see what files appear) |

Don't trust names or extensions; trust `file`. Work in a scratch directory (`mkdir t && cd t`), because unpacking creates files. Since every run starts fresh here, build up your command line by line: run what you have, look at the `file` output, add the next step.

Tools that read from standard input can be chained with pipes (`xxd -r data.txt | gzip -dc | bzip2 -dc | …`), and `tar xf -` reads an archive from the pipe. That's how you would unpack it in one line once you know the layers.

::: shell secret
task: Unwrap `data.txt` layer by layer and print only the password.
setup:
```bash
mkdir w && cd w
printf 'The password is %s\n' iO67TMbh1jaCeM6jMGQuAsGXum9iw1qj > data9.txt
gzip -c data9.txt > data8.gz
bzip2 -c data8.gz > data7.bz2
tar cf data6.tar data7.bz2
gzip -c data6.tar > data5.gz
tar cf data4.tar data5.gz
bzip2 -c data4.tar > data3.bz2
gzip -c data3.bz2 > data2.gz
xxd data2.gz > ../data.txt
cd .. && rm -r w
```
expect: iO67TMbh1jaCeM6jMGQuAsGXum9iw1qj
solution:
```bash
mkdir t && cd t
xxd -r ../data.txt | gzip -dc | bzip2 -dc | tar xf -
gzip -dc data5.gz | tar xf -
bzip2 -dc data7.bz2 | gzip -dc | awk '{print $4}'
```
hint: Start with `mkdir t && cd t && xxd -r ../data.txt > a && file a`. Unwrap, run `file` on the result, and repeat. When a tar appears, `tar xf` it and `ls` to see what came out.
:::

::: quiz
q: You download `backup.tar.gz` and `tar xzf` fails with "not in gzip format". What's the most useful next command?
- Rename it to `backup.tar` and try again
+ `file backup.tar.gz`, to see what the bytes really are
- `gzip -f backup.tar.gz`
- Download it again until it works
why: Extensions are just names. `file` reads the content, and it might say plain tar, bzip2, an HTML error page saved by the downloader, or zero-length. Each needs a different next step.
:::

## Level 13: what changed
id: l13
stage: dig
needs: l12
minutes: 10
goal: Compare two files and extract the line that differs.
source: GNU diffutils manual | https://www.gnu.org/software/diffutils/manual/diffutils.html

`passwords.old` and `passwords.new` have a hundred lines each. One line was changed, and the new value is the password.

`diff a b` prints what you'd have to do to `a` to get `b`:

```text
57c57
< old line
---
> new line
```

`57c57` means "line 57 changed into line 57". Lines from the first file start with `<`, lines from the second with `>`. `a` means added and `d` means deleted. `diff -u` gives the unified format you know from `git diff`: `-` and `+` with context around them.

The exit code tells you whether the files differ: 0 for the same, 1 for different, 2 for trouble. Scripts use `diff -q a b > /dev/null || echo changed` without printing anything.

At work: comparing two environments' configs, two `pip freeze` outputs, the package lists of two servers, or a rendered manifest against what's deployed. (`kubectl diff` and `terraform plan` are this same idea, applied to infrastructure.)

::: shell secret
task: Print the line that is in `passwords.new` but was different in `passwords.old`.
setup:
```bash
awk 'BEGIN {
  srand(13); c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (i = 1; i <= 100; i++) { s = ""; for (j = 0; j < 32; j++) s = s substr(c, int(rand() * 62) + 1, 1); print s }
}' > passwords.old
awk 'NR == 57 { print "55mUuQ2qW1GvL1OCRkXAh9H5vHHWqhXM"; next } { print }' passwords.old > passwords.new
```
expect: 55mUuQ2qW1GvL1OCRkXAh9H5vHHWqhXM
solution:
```bash
diff passwords.old passwords.new | grep '^>' | cut -c3-
```
hint: Look at the raw `diff` output first. The new line starts with `> `.
:::

::: card
q: What does `diff` exit with when the files are identical, different, or unreadable, and why does that matter?
answer: 0 when identical, 1 when they differ, 2 on error. Scripts and CI use the exit code (`diff -q a b || …`) instead of parsing the output.
:::

## Level 14: deleted, not gone
id: l14
stage: beyond
needs: l13, git/history
minutes: 20
goal: Recover a secret that was removed from a file but lives on in git history.
source: Pro Git: Viewing the commit history | https://git-scm.com/book/en/v2/Git-Basics-Viewing-the-Commit-History
source: GitHub: Removing sensitive data from a repository | https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository

This folder is a git repository. Someone committed a database password to `config.yml`, noticed, and replaced it with a placeholder in a later commit. The current file is clean. The history isn't.

Every commit is a full snapshot, so a value that was ever committed is still in the repository, in the old commit. "We removed it in the next commit" doesn't remove it. That's why a leaked secret has to be **rotated** (changed at the source), not just deleted from the code: anyone who cloned the repo, or can read it now, can find it.

The tools:

```bash
git log --oneline                 # the commits
git log -p -- config.yml          # each commit that touched the file, with its diff
git log -S 'password' -p          # commits that added or removed the string "password"
git show <commit>:config.yml      # the whole file as it was in that commit
```

In a diff, lines starting with `-` were removed by that commit and `+` were added. The secret was added in one commit (`+password: …`) and removed in another (`-password: …`), so it appears twice.

Secret scanners (gitleaks, trufflehog, GitHub's secret scanning) do exactly this search across all history, and attackers do too.

::: shell secret git
task: Find the password that used to be in `config.yml` and print only it.
setup:
```bash
git init -q
printf 'host: db\nport: 5432\n' > config.yml
git add . && git commit -qm "Add config"
printf 'host: db\nport: 5432\npassword: %s\n' hAoLzEgbADMr5dstSIw1YbJxYubZ8P9q > config.yml
git commit -qam "Connect to the database"
printf 'host: db\nport: 5432\npassword: ${DB_PASSWORD}\n' > config.yml
git commit -qam "Read the password from the environment"
printf 'host: db\nport: 5432\npassword: ${DB_PASSWORD}\npool: 10\n' > config.yml
git commit -qam "Raise the pool size"
```
expect: hAoLzEgbADMr5dstSIw1YbJxYubZ8P9q
solution:
```bash
git log -p -- config.yml | grep '^-password:' | awk '{print $2}'
```
hint: `git log -p -- config.yml` shows every change to the file. The password was added once and removed once.
:::

::: quiz
q: A teammate pushed an AWS key to GitHub, then pushed a commit deleting it five minutes later. What must happen now?
- Nothing, it's deleted
- Squash the two commits so the key disappears from history
+ Deactivate and rotate the key at AWS right away; cleaning history is optional and secondary
- Make the repository private
why: The key is in the history and in every clone made in those minutes, and automated scanners find pushed keys within seconds. Only rotating it makes the leaked copy useless.
:::

## Level 15: off the main branch
id: l15
stage: beyond
needs: l14, git/stash
minutes: 15
goal: Look in the places git keeps work that isn't on the current branch.
source: Pro Git: Stashing and cleaning | https://git-scm.com/book/en/v2/Git-Tools-Stashing-and-Cleaning

The repository's working tree and `main` look clean. But git keeps work in more places than the current branch:

| Where | How to see it |
|---|---|
| other branches | `git branch -a`, `git log --all --oneline` |
| tags | `git tag`, `git show <tag>` |
| the stash | `git stash list`, `git stash show -p stash@{0}` |
| unreachable commits | `git reflog`, `git fsck --lost-found` |

Someone was editing `notes.txt`, added a token, and **stashed** the change instead of committing it. There's also a branch with a token that isn't the right one. The password is the one in the stash.

A stash is a commit (really two or three) stored under `refs/stash`, not on any branch. `git stash show -p` prints it as a diff, with `+` lines for what was added. `git log --all` doesn't list stashes by default, which is exactly why work gets "lost" in them, and why you check `git stash list` before deleting a repo.

::: shell secret git
task: Print the token that was stashed (not the one on any branch).
setup:
```bash
git init -q
printf 'todo\n' > notes.txt
git add . && git commit -qm "Start notes"
git switch -qc dev
printf 'todo\ntoken: notThisOneEitherItIsOnABranch00\n' > notes.txt
git commit -qam "WIP on dev"
git switch -q main
printf 'todo\ntoken: %s\n' Kk3oAD3xCi3PVufGf3lp8XaFwbT8fw8l > notes.txt
git stash -q
```
expect: Kk3oAD3xCi3PVufGf3lp8XaFwbT8fw8l
solution:
```bash
git stash show -p | grep '^+token:' | awk '{print $2}'
```
hint: `git stash list` shows there is a stash. `git stash show -p` shows its diff.
:::

::: card
q: Name four places in a git repository where work can hide that `git log` (on the current branch) won't show.
answer: Other branches (`git log --all`), tags (`git tag`), the stash (`git stash list`), and unreachable commits found through `git reflog`.
:::

## Level 16: who broke admin
id: l16
stage: beyond
needs: l13, linux/textproc
minutes: 25
goal: Answer a real forensics question from an access log with a two-step pipeline.
source: GNU awk: Getting started | https://www.gnu.org/software/gawk/manual/html_node/Getting-Started.html

`access.log` has a few thousand requests, one per line:

```text
<ip> <method> <path> <status> <user-agent>
```

The question: **which client caused the most server errors (status 500 and up) on `/admin` paths?** The password is that client's user-agent string.

This is two questions chained together, the shape of most real log investigations:

1. **Filter and rank**: keep lines where the path starts with `/admin` and the status is at least 500, take the IP, then count and rank (`sort | uniq -c | sort -rn | head`).
2. **Look up**: with the top IP in hand, find its user agent.

Capture step 1 in a variable, `ip=$(…)`, and use it in step 2 with `awk -v ip="$ip" '$1 == ip …'`. `-v` passes a shell value into awk safely, without quoting games.

Watch the traps. One client produced lots of 5xx errors, but not on `/admin`. A regex like `/admin` also matches `/api/admin-tools`, so anchor it: `$3 ~ /^\/admin/`. And compare status as a number (`$4 >= 500`), not as text.

::: shell secret
task: Print the user agent of the client with the most 5xx responses on `/admin` paths.
setup:
```bash
awk -v pw=8PrqOjy8ANK9oKEoZ2GSyubJ3Ks065pP 'BEGIN {
  srand(16)
  split("Mozilla/5.0 curl/8.7.1 python-requests/2.32.3 Go-http-client/1.1 kube-probe/1.31", ua, " ")
  split("/ /login /api/orders /admin /admin/users /health /api/admin-tools", p, " ")
  for (i = 0; i < 3000; i++) {
    ip = "10.0." int(rand() * 4) "." int(rand() * 40 + 1)
    st = (rand() < 0.05) ? 500 : 200
    printf "%s GET %s %d %s\n", ip, p[int(rand() * 7) + 1], st, ua[int(rand() * 5) + 1]
  }
  for (i = 0; i < 60; i++) printf "10.9.9.9 GET /api/orders 502 LoadTester/0.9\n"
  for (i = 0; i < 40; i++) printf "10.9.9.10 GET /api/admin-tools 500 Scanner/1.0\n"
  for (i = 0; i < 25; i++) printf "10.66.6.6 GET /admin/users %d %s\n", (i % 2 ? 500 : 503), pw
}' | awk 'BEGIN { srand(17) } { print rand() "\t" $0 }' | sort -k1,1 | cut -f2- > access.log
```
expect: 8PrqOjy8ANK9oKEoZ2GSyubJ3Ks065pP
solution:
```bash
ip=$(awk '$3 ~ /^\/admin/ && $4 >= 500 {print $1}' access.log | sort | uniq -c | sort -rn | head -n 1 | awk '{print $2}')
awk -v ip="$ip" '$1 == ip {print $5}' access.log | sort -u
```
hint: Build step 1 alone and look at the top few counts. Is the winner really hitting `/admin`?
:::

::: quiz
q: In `awk '$3 ~ /admin/'`, why is `/admin/` risky as a filter for admin pages?
- awk regexes can't contain slashes
+ It matches `admin` anywhere in the path, like `/api/admin-tools`; anchor it with `/^\/admin/`
- `~` compares numbers, not text
- It's case-insensitive
why: An unanchored regex finds the text anywhere. `^` pins it to the start of the field, and `\/` escapes the slash inside awk's `/…/`.
:::

## Level 17: the right vault
id: l17
stage: beyond
needs: l16
minutes: 20
goal: Query JSON precisely with jq, selecting on more than one condition.
source: jq manual | https://jqlang.org/manual/

`inventory.json` describes the services of a platform. The password is the `token` in the `config` of the service named exactly `vault` that is **enabled**. There are near-misses: a disabled `vault`, and an enabled `vault-staging`.

APIs, `kubectl get -o json`, `aws … --output json` and `terraform show -json` all speak JSON, and `jq` is the shell's tool for it:

```bash
jq '.services | length' inventory.json             # how many
jq -r '.services[].name' inventory.json            # every name, raw (no quotes)
jq '.services[] | select(.enabled)' inventory.json # objects where enabled is true
jq -r '.services[] | select(.name == "x" and .enabled) | .config.token' f.json
```

- `.services[]` iterates over the array; `|` passes each element on.
- `select(cond)` keeps elements where the condition is true. `and`/`or` combine conditions.
- `-r` prints strings without JSON quotes, which is what you want for shell use.

`grep token inventory.json` finds all four tokens and can't tell which belongs to which service. Structured data deserves a structured query. (`jq` ships with macOS 15 and later. On servers, `apt install jq`.)

::: shell secret
task: Print the token of the enabled service named exactly `vault`.
setup:
```bash
cat > inventory.json <<'EOF'
{
  "region": "eu-central-1",
  "services": [
    { "name": "web", "enabled": true, "config": { "replicas": 3, "token": "webTokenNotThePassword000000000" } },
    { "name": "vault", "enabled": false, "config": { "token": "oldVaultTokenDisabledLongAgo0000" } },
    { "name": "vault-staging", "enabled": true, "config": { "token": "stagingVaultTokenNotThisOne00000" } },
    { "name": "vault", "enabled": true, "config": { "token": "N2lpqNxYRk3bup9n2AdiO8GT8WqQQ6D7", "rotated": "2026-01-05" } },
    { "name": "worker", "enabled": true, "config": { "concurrency": 8 } }
  ]
}
EOF
```
expect: N2lpqNxYRk3bup9n2AdiO8GT8WqQQ6D7
solution:
```bash
jq -r '.services[] | select(.name == "vault" and .enabled) | .config.token' inventory.json
```
hint: Start with `jq '.services[]' inventory.json`, then add `select(...)` with both conditions, then `.config.token`, and `-r` for raw output.
:::

::: quiz
q: `kubectl get pods -o json` returns a list. Which jq expression prints the names of pods whose phase isn't Running?
+ `jq -r '.items[] | select(.status.phase != "Running") | .metadata.name'`
- `jq '.items.metadata.name | select(!= "Running")'`
- `grep -v Running | jq .name`
- `jq -r '.items[].status.phase != "Running"'`
why: Iterate the array (`.items[]`), filter each object with `select`, then take its name. The last option prints true/false per pod, not names.
:::

## Level 18: locked out by permissions
id: l18
stage: beyond
needs: l17, linux/perms
minutes: 15
goal: Fix file permissions so a script will run and can read its key.
source: GNU coreutils: chmod invocation | https://www.gnu.org/software/coreutils/manual/html_node/chmod-invocation.html

`reveal.sh` prints the password, but it's picky. Run it and read what it says: error messages are the level's instructions. Each one names a permission problem, and you have to fix them all.

Reminders from the permissions lesson:

- `ls -l` shows the mode: `-rw-r--r--` means owner read/write, group read, others read.
- `chmod u+x file` adds execute for the owner. `chmod 600 file` sets exactly owner read/write and nothing else.
- Running `./script.sh` needs the execute bit. `bash script.sh` doesn't, because bash reads the file as data, which is why some scripts check how they were started.
- A file with mode `000` can't be read even by its owner until the owner changes the mode. Owners can always `chmod` their own files.

Note the order: fix things, then run the script in the same command (`chmod … && chmod … && ./reveal.sh`), because every run starts fresh.

This is a common situation at work: SSH refuses keys that others can read, systemd and cron refuse scripts with the wrong mode, and a container fails because its entrypoint lost its execute bit in a copy step.

::: shell secret
task: Make `reveal.sh` happy and print only the password it reveals.
setup:
```bash
printf '%s' zLD3qHJW77e5a2xvfEehEzFL9XRIUMEO | base64 > key
cat > reveal.sh <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
if [ ! -x reveal.sh ]; then echo "reveal.sh: I only run when I'm executable" >&2; exit 1; fi
if [ "$(ls -l key | cut -c1-10)" != "-rw-------" ]; then echo "reveal.sh: key must be readable and writable by its owner only, and nothing else" >&2; exit 1; fi
base64 -d < key; echo
EOF
chmod 644 reveal.sh
chmod 000 key
```
expect: zLD3qHJW77e5a2xvfEehEzFL9XRIUMEO
solution:
```bash
chmod 600 key && chmod u+x reveal.sh && ./reveal.sh
```
hint: Run `./reveal.sh` and `bash reveal.sh` and `ls -l`, and read the messages. Owner-only read/write is 600.
:::

::: card
q: Why does `./script.sh` fail with "Permission denied" while `bash script.sh` works?
answer: `./script.sh` asks the kernel to execute the file, which needs the execute bit. `bash script.sh` runs bash, which only reads the file, so read permission is enough. Fix with `chmod u+x script.sh`.
:::

## Level 19: the vault has rules
id: l19
stage: beyond
needs: l18, linux/env
minutes: 20
goal: Run a program with the right PATH, working directory, environment variable and arguments.
source: GNU Bash manual: Command search and execution | https://www.gnu.org/software/bash/manual/bash.html#Command-Search-and-Execution

`bin/vault` opens only when four things are true at once. It tells you which one is wrong each time you run it, so read its messages:

1. It must be **called by name** (`vault`), found through `PATH`, not as `bin/vault`.
2. It must run **inside the `vault-room` directory**.
3. The environment variable `VAULT_MODE` must be `unlock`.
4. It must get the arguments `--user ops`.

Each one is a separate idea from the Linux module:

- `PATH` is the list of directories the shell searches for a command name. `PATH="$PWD/bin:$PATH"` puts `bin` first, for that shell. (Use an absolute path: `PATH` entries are looked up relative to wherever you are later.)
- The working directory is per process. `cd vault-room && …` changes it for what follows on that line.
- `NAME=value command` sets an environment variable for that one command.
- Arguments are just words after the command name.

You could read the script and work around it, and reading the source is a fine instinct. But here, practise doing it properly. That's exactly how you'll run real tools with the right `KUBECONFIG`, `AWS_PROFILE` or virtualenv `PATH`.

::: shell secret
task: Get `vault` to print the password, and print only that.
setup:
```bash
mkdir -p bin vault-room
blob=$(printf '%s\n' yCGs2yk1LLYYu3KQhTVXiehblvR8FjPp | openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:unlock:ops:vault-room -base64 -A)
cat > bin/vault <<EOF
#!/bin/bash
here="\$(cd "\$(dirname "\$0")" && pwd)"
[ "\$(command -v vault)" = "\$here/vault" ] || { echo "vault: call me by name, found through PATH" >&2; exit 1; }
[ "\$(basename "\$PWD")" = "vault-room" ] || { echo "vault: I only open inside vault-room" >&2; exit 1; }
[ "\${VAULT_MODE:-}" = "unlock" ] || { echo "vault: VAULT_MODE is not unlock" >&2; exit 1; }
[ "\${1:-}" = "--user" ] && [ -n "\${2:-}" ] || { echo "usage: vault --user NAME" >&2; exit 1; }
printf '%s\n' '$blob' | openssl enc -d -aes-256-cbc -pbkdf2 -base64 -A -pass "pass:\$VAULT_MODE:\$2:\$(basename "\$PWD")" 2>/dev/null || { echo "vault: wrong user" >&2; exit 1; }
EOF
chmod +x bin/vault
```
expect: yCGs2yk1LLYYu3KQhTVXiehblvR8FjPp
solution:
```bash
cd vault-room && PATH="$(cd ../bin && pwd):$PATH" VAULT_MODE=unlock vault --user ops
```
hint: Start with `bin/vault` and fix one complaint at a time. For PATH, use the absolute path of `bin`: `"$PWD/bin"` before you `cd`, or `"$(cd ../bin && pwd)"` after.
:::

::: card
q: What does `FOO=1 ./tool` do, compared with `FOO=1; ./tool`?
answer: `FOO=1 ./tool` sets FOO in the environment of that one command. `FOO=1; ./tool` sets a shell variable that isn't exported, so `./tool` doesn't see it (unless FOO was exported earlier).
:::

## Level 20: knock with a signal
id: l20
stage: beyond
needs: l19, linux/processes
minutes: 20
goal: Run a process in the background and send it a specific signal.
source: GNU Bash manual: Signals | https://www.gnu.org/software/bash/manual/bash.html#Signals
source: signal(7) manual page | https://man7.org/linux/man-pages/man7/signal.7.html

`guard.sh` waits about five seconds and then gives up. It reveals the password only if it receives the signal **SIGUSR1** while it's waiting. If you send it SIGTERM, it just quits.

You need three moves from the processes lesson:

```bash
./guard.sh &        # run it in the background; the shell carries on
pid=$!              # $! is the PID of the last background job
kill -USR1 "$pid"   # send it SIGUSR1 (kill sends any signal, not just "kill")
wait "$pid"         # wait for it to finish, so its output arrives before your command ends
```

Give it a moment to start before you signal it (`sleep 0.5`). A signal sent before the program has set up its handler hits the default action instead, and the default for SIGUSR1 is to terminate the process.

SIGUSR1 and SIGUSR2 are "user-defined": programs choose what they mean. nginx reopens its log files on SIGUSR1, and many daemons reload config on SIGHUP. That's how log rotation tells a running server to start a new file without restarting it.

::: shell secret
task: Make `guard.sh` reveal the password, and print only that.
setup:
```bash
blob=$(printf '%s\n' uzmFTDwjSQt9ZBfZF9OPwqkcjkIF42D0 | openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:usr1 -base64 -A)
cat > guard.sh <<EOF
#!/bin/bash
reveal() { printf '%s\n' '$blob' | openssl enc -d -aes-256-cbc -pbkdf2 -base64 -A -pass pass:usr1; exit 0; }
trap reveal USR1
trap 'echo "guard: TERM received, nothing to see" >&2; exit 1' TERM
for i in \$(seq 1 50); do sleep 0.1; done
echo "guard: nobody knocked" >&2
exit 2
EOF
chmod +x guard.sh
```
expect: uzmFTDwjSQt9ZBfZF9OPwqkcjkIF42D0
solution:
```bash
./guard.sh &
pid=$!
sleep 0.5
kill -USR1 "$pid"
wait "$pid"
```
hint: Background it with `&`, keep `$!`, wait a moment, `kill -USR1`, then `wait`.
:::

::: quiz
q: A log-rotation job renames `access.log` and wants nginx to start a fresh file without dropping connections. What does it send?
- SIGKILL
- SIGTERM
+ SIGUSR1 to the nginx master process (nginx's "reopen log files" signal)
- SIGSTOP
why: SIGTERM and SIGKILL stop the server. nginx defines SIGUSR1 as "reopen logs", so it keeps serving and writes to the new file.
:::

## Level 21: the one that succeeds
id: l21
stage: beyond
needs: l20, linux/scripts
minutes: 15
goal: Use exit codes to find the one command that succeeds.
source: GNU Bash manual: Exit status | https://www.gnu.org/software/bash/manual/bash.html#Exit-Status

`probe/` has forty scripts. Each prints a candidate password, and each exits with a status. Only one exits **0** (success), and its candidate is the password.

The exit status is how every program says "did it work?", and the shell makes it easy to act on:

```bash
if ./check.sh; then echo ok; fi           # if tests the exit status, not the output
./check.sh && echo ok                     # && runs the right side only on success
out=$(./check.sh) && echo "$out"          # capture output, keep the status
```

`out=$(cmd)` sets `$?` to `cmd`'s status, so `out=$(cmd) && echo "$out"` prints the output only when `cmd` succeeded. Put that in a `for` loop over `probe/*`, and only the winner prints.

This is the logic of health checks (`curl -f` exits non-zero on HTTP errors), CI steps (any non-zero status fails the job) and Kubernetes exec probes (exit 0 means healthy).

::: shell secret
task: Print the output of the only probe that exits successfully.
setup:
```bash
mkdir probe
printf '27\n' > ok.txt
for i in $(seq -w 1 40); do
  cand=$(printf 'probe%s' "$i" | shasum | cut -c1-32)
  [ "$i" = 27 ] && cand=A74MpIIis4xFIbDyq6oC7LcLme17cOli
  printf '#!/bin/sh\necho %s\ntest "$(cat "$(dirname "$0")/../ok.txt")" = "%s"\n' "$cand" "$i" > "probe/check-$i.sh"
done
```
expect: A74MpIIis4xFIbDyq6oC7LcLme17cOli
solution:
```bash
for f in probe/*.sh; do out=$(sh "$f") && echo "$out"; done
```
hint: Loop over the scripts. `out=$(sh "$f") && echo "$out"` prints only when the script succeeds.
:::

::: card
q: What does `out=$(cmd) && echo "$out"` print when `cmd` prints "x" and exits 1?
answer: Nothing. The assignment's exit status is `cmd`'s status (1), so `&&` skips the echo. The output was captured, but it's only printed on success.
:::

## Level 22: the quiet stream
id: l22
stage: beyond
needs: l21, linux/pipes
minutes: 15
goal: Separate standard error from standard output and search only one of them.
source: GNU Bash manual: Redirections | https://www.gnu.org/software/bash/manual/bash.html#Redirections

`noisy` prints hundreds of lines that look like `PASSWORD: …` on standard output. They're all decoys. The real one is printed on **standard error**, among some warnings.

In a terminal both streams appear mixed together, but they're separate, and a pipe only carries stdout. To search stderr alone you have to move it:

```bash
cmd 2>&1 >/dev/null | grep …    # stderr goes into the pipe, stdout goes to /dev/null
```

Read the redirections left to right. `2>&1` points stderr at where stdout points *right now*, which is the pipe. Then `>/dev/null` moves stdout away. stderr stays on the pipe. Swap the order (`>/dev/null 2>&1`) and both streams end up in /dev/null.

This matters whenever a tool prints progress on stderr and data on stdout (curl, git, docker, most well-behaved CLIs). It's also how you grep a program's warnings, or capture errors into a file while data flows on.

::: shell secret
task: Print the password from the `PASSWORD:` line that `noisy` writes to standard error.
setup:
```bash
awk 'BEGIN {
  srand(22); c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (i = 0; i < 300; i++) { s = ""; for (j = 0; j < 32; j++) s = s substr(c, int(rand() * 62) + 1, 1); print "PASSWORD: " s }
}' > .decoys
printf '%s' 5JgXJUL4zLjZNQBVstxVqKqvYpirVLxh | base64 > .e
cat > noisy <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
head -n 150 .decoys
echo "warning: cache is cold" >&2
printf 'PASSWORD: %s\n' "$(base64 -d < .e)" >&2
tail -n 150 .decoys
echo "warning: done" >&2
EOF
chmod +x noisy
```
expect: 5JgXJUL4zLjZNQBVstxVqKqvYpirVLxh
solution:
```bash
./noisy 2>&1 >/dev/null | awk '/^PASSWORD:/ {print $2}'
```
hint: First silence stdout entirely (`./noisy >/dev/null`) and look at what's left. Then get that into a pipe.
:::

::: quiz
q: Which line sends only a program's errors into `grep`?
- `prog | grep err`
- `prog >/dev/null 2>&1 | grep err`
+ `prog 2>&1 >/dev/null | grep err`
- `prog 2>/dev/null | grep err`
why: Redirections apply left to right: `2>&1` first copies stdout's current target (the pipe) to stderr, then `>/dev/null` sends stdout away. The second option sends both to /dev/null, and the last discards exactly the errors you wanted.
:::

## Level 23: in pieces
id: l23
stage: beyond
needs: l22, linux/xargs
minutes: 20
goal: Reassemble a password from fragments, in numeric order, with awkward filenames.
source: GNU coreutils: sort invocation | https://www.gnu.org/software/coreutils/manual/html_node/sort-invocation.html

The password was split into sixteen two-character pieces, stored in `fragments/part 1.txt` through `fragments/part 16.txt`. Joined in order, they form the password. `fragments/old/` holds pieces of a previous password; ignore them.

Two traps:

1. **Order.** A glob sorts names as text: `part 1, part 10, part 11, …, part 16, part 2, …`. Text order isn't numeric order. Either generate the numbers yourself (`for i in $(seq 1 16)`), or sort numerically on the number (`sort -t ' ' -k2 -n`).
2. **Spaces.** `part 1.txt` has a space, so every use must be quoted: `cat "fragments/part $i.txt"`. Unquoted, it becomes two arguments.

Each piece ends with a newline, and the password is one line. `tr -d '\n'` deletes newlines; finish with `echo` to end the line.

The same problems show up when you rotate `backup-1.tar … backup-12.tar`, apply database migrations `1_init.sql … 10_add_index.sql`, or process files a user uploaded with spaces in the names. Zero-padding names (`01`, `02`, …) is the fix when you control the naming.

::: shell secret
task: Join the sixteen fragments in numeric order and print the password.
setup:
```bash
mkdir -p fragments/old
pw=BHmL5HzfDBmLQLzR2wsov91XNOHE54ei
for i in $(seq 1 16); do
  printf '%s\n' "$(printf '%s' "$pw" | cut -c$((2 * i - 1))-$((2 * i)))" > "fragments/part $i.txt"
  printf 'zz\n' > "fragments/old/part $i.txt"
done
```
expect: BHmL5HzfDBmLQLzR2wsov91XNOHE54ei
solution:
```bash
for i in $(seq 1 16); do cat "fragments/part $i.txt"; done | tr -d '\n'; echo
```
hint: `cat fragments/*.txt` gets the order wrong. Loop over `seq 1 16`, and quote the path.
:::

::: card
q: Why does `ls` list `part 10.txt` before `part 2.txt`, and what are two ways to fix it?
answer: Names are sorted as text, character by character, and "1" comes before "2". Sort numerically on the number (`sort -t ' ' -k2 -n`, or `ls -v` on GNU), or zero-pad names when you create them (`part 02.txt`).
:::

## Level 24: the checksum
id: l24
stage: beyond
needs: l23
minutes: 15
goal: Find a file by its SHA-256 checksum.
source: shasum(1) (Perl) manual | https://perldoc.perl.org/shasum
source: GNU coreutils: sha2 utilities | https://www.gnu.org/software/coreutils/manual/html_node/sha2-utilities.html

`candidates/` has a hundred files, each with one candidate password. `README` gives the SHA-256 checksum of the right file.

A **cryptographic hash** turns any input into a fixed-size fingerprint: the same bytes always give the same hash, and a single changed byte gives a completely different one. That's how you check that a download wasn't corrupted or tampered with, how git names every object, and how container images are pinned by digest (`@sha256:…`).

```bash
shasum -a 256 file         # macOS (also on Linux, from Perl)
sha256sum file             # Linux (GNU coreutils)
```

Both print `<hash>  <filename>`, with two spaces between. Hash every candidate in one call, then keep the line whose first field equals the target, and print the second field (the filename). Then `cat` it. Remember the hash covers the file's exact bytes, including its final newline.

::: shell secret
task: Print the contents of the candidate file whose SHA-256 matches the one in `README`.
setup:
```bash
mkdir candidates
for i in $(seq -w 1 100); do
  printf '%s\n' "$(printf 'cand%s' "$i" | shasum | cut -c1-32)" > "candidates/c$i"
done
printf '%s\n' M1xtPr8htJrDRMOh2Z7TnIqL1zDrKPec > candidates/c063
printf 'The right file has this SHA-256: %s\n' "$(shasum -a 256 candidates/c063 | cut -d' ' -f1)" > README
```
expect: M1xtPr8htJrDRMOh2Z7TnIqL1zDrKPec
solution:
```bash
h=$(awk '{print $NF}' README)
shasum -a 256 candidates/* | awk -v h="$h" '$1 == h {print $2}' | xargs cat
```
hint: Get the target hash from `README` into a variable. Hash all candidates, compare the first field, and `cat` the file that matches.
:::

::: quiz
q: A release page lists a SHA-256 for `tool.tar.gz`. Your download's hash is different. What does that tell you?
- The release page is outdated; use the file anyway
+ The file's bytes differ from what was published: a corrupt or tampered download. Don't use it
- Hashes differ between macOS and Linux
- Only the file name changed
why: The same bytes always give the same SHA-256, on every OS. A mismatch means different content. (If the page and the file come from the same compromised server, a hash alone doesn't help, which is why signed releases exist.)
:::

## Level 25: what runs at 03:15
id: l25
stage: beyond
needs: l24, linux/cron
minutes: 20
goal: Read a crontab exactly, and run the job that fires at a given moment.
source: crontab(5) manual page | https://man7.org/linux/man-pages/man5/crontab.5.html

`crontab` lists six jobs, and each script in `jobs/` prints a different token. The password is printed by the job that runs at **03:15 on Monday 5 January 2026**. Read the schedule, find the one job, run it.

Cron's five time fields are **minute, hour, day of month, month, day of week**. Several of these jobs are deliberate traps:

- `15 3` is 03:15, and `3 15` would be 15:03. One job uses `15 15`: 15:15, the classic minute/hour swap.
- `*/20` in the minute field means 0, 20 and 40, so it never fires at :15. (`*/15` would.)
- `1-5` in day of week is Monday to Friday. 0 and 7 are Sunday.
- 5 January isn't the 1st, so a job scheduled for day of month `1` doesn't run.
- `2 3` is 03:02, not 03:15.

Once you know which script it is, run just that script.

At work you read crontabs (and Kubernetes CronJob `schedule:` fields, which use the same syntax) to answer "why did this run at 3 am?" and "why didn't the backup run last night?".

::: shell secret
task: Print the token from the job that runs at 03:15 on Monday 5 January 2026.
setup:
```bash
mkdir jobs
cat > crontab <<'EOF'
# m   h   dom mon dow  command
*/20  *   *   *   *    jobs/heartbeat.sh
2     3   *   *   *    jobs/rotate-logs.sh
15    3   *   *   1    jobs/backup.sh
15    3   1   *   *    jobs/monthly-report.sh
30    2   *   *   1-5  jobs/sync.sh
15    15  *   *   1    jobs/cleanup.sh
EOF
for j in heartbeat rotate-logs monthly-report sync cleanup; do
  printf '#!/bin/sh\necho %s\n' "$(printf 'job%s' "$j" | shasum | cut -c1-32)" > "jobs/$j.sh"
done
printf '#!/bin/sh\necho %s | tr A-Za-z N-ZA-Mn-za-m\n' "$(printf '%s' 86ATYeGC8KlVBp9ARe9IVoCL3xdF80ZV | tr 'A-Za-z' 'N-ZA-Mn-za-m')" > jobs/backup.sh
chmod +x jobs/*.sh
```
expect: 86ATYeGC8KlVBp9ARe9IVoCL3xdF80ZV
solution:
```bash
sh jobs/backup.sh
```
hint: Read each line field by field: minute, hour, day of month, month, day of week. Only one job matches minute 15, hour 3, a Monday, and a day that isn't the 1st.
:::

::: quiz
q: In a crontab, when does `*/15 9-17 * * 1-5 ./check.sh` run?
+ Every 15 minutes (:00, :15, :30, :45) from 09:00 to 17:45, Monday to Friday
- Every 15 hours on weekdays
- At 09:15 and 17:15 on weekdays
- Every 15 minutes, only on the 1st to the 5th of the month
why: The fields are minute, hour, day of month, month, day of week. `*/15` in minutes gives 0, 15, 30 and 45; `9-17` is the hours 9 to 17 inclusive; `1-5` in the fifth field is Monday to Friday.
:::

## Level 26: the vault, final level
id: l26
stage: beyond
needs: l25, l14
minutes: 30
goal: Combine git forensics and decryption: find a key in history, then decrypt the vault.
source: OpenSSL: enc command | https://docs.openssl.org/master/man1/openssl-enc/

The last level uses everything at once. `vault.enc` is encrypted. `NOTE` says how it was made. The key that decrypts it was once committed to the `ops` repository, in a `.env` file that is no longer tracked.

You'll need:

- **git forensics** (level 14): the key was in `.env` in an early commit. `git -C ops log -p` runs git inside `ops` without `cd`. Look for the `VAULT_KEY=` line that was added.
- **decryption**: `openssl enc -d` with the same cipher and options as in `NOTE`, the key given as `-pass "pass:$key"`, and `-in vault.enc`.

This is **real encryption**, unlike base64 and ROT13: without the key, the content is unreadable. With it, decryption is one command. That's the point of the level. Encryption moves the secret from the file into the key, and the key leaked through git, exactly as happens in real breaches. A `.gitignore` added *after* a commit doesn't remove what was already committed.

`-pbkdf2` derives the actual cipher key from the passphrase slowly (many iterations), which makes guessing expensive. Options must match on both sides: decrypt with different options and you get `bad decrypt`.

::: shell secret git
task: Find the key in the `ops` history, decrypt `vault.enc`, and print only the password.
setup:
```bash
mkdir ops && cd ops && git init -q
printf 'APP=shop\nVAULT_KEY=%s\n' 'k3y-7f2b-shop-ops-2026' > .env
git add .env && git commit -qm "Local settings"
git rm -q --cached .env && printf '.env\n' > .gitignore
git add .gitignore && git commit -qm "Stop tracking .env"
rm .env && printf 'APP=shop\n' > .env.example
git add .env.example && git commit -qm "Add an example env file"
cd ..
printf '%s\n' OcuQ7b60IWe5Af4U3j6eJhiMByyqXEY4 | openssl enc -aes-256-cbc -pbkdf2 -salt -pass 'pass:k3y-7f2b-shop-ops-2026' -base64 -out vault.enc
printf 'vault.enc was made with: openssl enc -aes-256-cbc -pbkdf2 -salt -base64 (passphrase: VAULT_KEY)\n' > NOTE
```
expect: OcuQ7b60IWe5Af4U3j6eJhiMByyqXEY4
solution:
```bash
key=$(git -C ops log -p | grep '^+VAULT_KEY=' | cut -d= -f2)
openssl enc -d -aes-256-cbc -pbkdf2 -base64 -pass "pass:$key" -in vault.enc
```
hint: Get the key with `git -C ops log -p`, then decrypt with `openssl enc -d` and the options from `NOTE`.
:::

::: card
q: Base64, ROT13, a SHA-256 hash, and AES encryption: which can be reversed, and what does reversing each need?
answer: Base64 and ROT13 are reversible by anyone, with no key. A hash can't be reversed at all (you can only compare it against hashes of guesses). AES encryption is reversible only with the key. That's why a leaked key, not the ciphertext, is the breach.
:::
