# Git
id: git
blurb: Version control the way teams use it: commits, branches, merges and conflicts, undoing safely, remotes and pull requests.
why: Every change you make from here on (code, Dockerfiles, Terraform, Kubernetes manifests) lives in Git, reaches production through a pull request, and is undone through Git when it goes wrong.
stage: basics | Snapshots | Record work as small commits and read the history.
stage: team | Working with others | Branch, merge or rebase, resolve conflicts, undo safely, and share through a remote.

## Snapshots and the three areas
id: commits
stage: basics
needs: linux/files
minutes: 45
goal: Turn changes into commits on purpose, and keep files that don't belong out of the repository.
source: Pro Git, chapter 2: Git basics | https://git-scm.com/book/en/v2/Git-Basics-Getting-a-Git-Repository
source: GitHub's .gitignore templates | https://github.com/github/gitignore

A deploy went out and the payment webhook started failing. The question is not "what does the file look like now". The question is "what did the tree look like at the commit we shipped, and which commit changed it". If you only keep the latest files, you cannot answer that, because the previous bytes are gone. Git keeps each commit as a snapshot of the whole tree, plus the name of the commit that came before it, so you can walk backwards.

A **commit** is that snapshot: the contents of every tracked file at one moment, a message, an author, a timestamp, and a pointer to the parent commit. It is not a list of edits. `git show` prints a diff because Git can compare two snapshots and describe how they differ. The object that was stored is the tree. That is why changing one line still records the whole project, and why a commit you can check out is a directory you can reconstruct, not a patch you have to apply in order.

### Three places, and why the middle one exists

Your files sit in one of three places:

| Area | What it is | Commands |
|---|---|---|
| **Working tree** | the files on disk, as you edit them | edit, `git restore file` |
| **Staging area** (index) | what will go into the next commit | `git add file`, `git restore --staged file` |
| **Repository** | the commits | `git commit -m "message"` |

The working tree is whatever is on disk right now, including edits you have not decided to keep. The repository is the commits that already exist. The staging area, also called the index, is the snapshot you are assembling for the next commit. It exists so that "I edited three files" and "I want to record one of them" are different decisions. Without it, every commit would have to be "whatever happens to be dirty", and a half-finished refactor would ride along with the bug fix you actually meant to ship.

`git status` is how you see the three places at once. A short status uses two columns. The left column is the staging area compared with the last commit. The right column is the working tree compared with the staging area. `A` means added, `M` means modified, `?` means untracked. A file can be both: you staged one version, then kept editing, so the left column and the right column disagree. That is not a bug. It is the reason the middle area exists. `git diff` compares the working tree with the index. `git diff --staged` compares the index with the last commit, which is the diff the next commit will record.

```bash
git init
git status
git add billing.py
git commit -m "Retry the payment webhook on timeout"
git log --oneline
```

`git init` creates the repository in `.git`. You do it once per project. `git add billing.py` copies the current bytes of that file into the index. `git commit` writes a commit from the index, not from whatever is on disk at that moment, so an edit you make after `git add` and before `git commit` is not in the commit unless you add again. `git log --oneline` prints one line per commit, newest first, because the parent pointer makes a chain and the log walks it.

`git add .` stages everything that is not ignored, which is convenient and also how a secret file gets into a commit when you were only thinking about the code. Add the paths you mean when the change is mixed.

### What not to commit

Secrets (`.env`, private keys), build output (`dist/`, `__pycache__/`), dependencies (`node_modules/`, `.venv`) and machine junk (`.DS_Store`) stay out. They do not belong in the snapshot, because a secret in history is a secret everyone with the repo can read, and a `node_modules` tree makes every clone huge for bytes that `npm install` can recreate. List the names in a `.gitignore` at the root of the repository:

```text
.env
node_modules/
__pycache__/
*.log
```

Git reads those patterns when it decides what is untracked. A matching untracked file does not show up as something to add, and `git add .` skips it. The pattern does nothing for a file that is already tracked. The index already has a copy, so later edits to that file still show up as modifications, and a new commit will still contain it. To stop tracking a file you already committed, you remove it from the index and leave the disk copy alone (`git rm --cached token.txt`), then commit that removal. The old commit still has the bytes. History is not rewritten by a new commit that deletes a path. If the secret was ever pushed, you rotate it, because anyone who cloned the old commit still has it. Deleting the file in a later commit does not reach into their clone.

### Where this breaks

**Committing the working tree by habit.** `git add .` then `git commit` records every unignored change, including the debug print you were about to delete. Look at `git diff --staged` before you commit. If the diff contains a file you did not mean, unstage it with `git restore --staged` and commit the rest.

**Thinking a commit is a diff.** Reverting, rebasing, and cherry-picking feel magical if you imagine Git stores patches. They are operations on snapshots and parent pointers. The diff is a view.

**A gitignore added after the fact.** The file is still in `HEAD`. The ignore line only affects the next untracked name. `git status` will keep showing the tracked file until you remove it from the index.

**A message that says "fix".** `git log` is the only documentation many changes ever get. Six months later "fix" does not tell you whether the commit is safe to revert. Write one line, imperative, about the effect: "Retry the payment webhook on timeout".

**Amending to hide a secret that was pushed.** `git commit --amend` replaces the latest commit on your branch. It does not erase the commit anyone else already fetched. Rotation is the fix for a published secret. Amend is for a commit that has not left your machine.

### How this is used at work

A pull request is a stack of these snapshots. Reviewers read the diffs, but the merge records a new snapshot on the branch you deploy. CI checks out a commit, not a set of unsaved files, which is why "it worked in my working tree" is not the same claim as "this commit builds". A release is a commit you can name later. When production breaks, you check out the previous snapshot or you revert, and you can do that only because the snapshot is still there.

The same habit shows up in every later tool that stores desired state in a repository. A Terraform plan is reviewed as a diff against a commit. A Kubernetes manifest is applied from a commit. If the commit contains a `.env` or a built `dist/`, the review is looking at the wrong bytes and the secret is in the history of the deploy repo.

### Which command

| You want | Command | Why |
|---|---|---|
| See what is staged and what is not | `git status` | The two columns are the index and the working tree |
| Copy a file into the next commit | `git add path` | The commit reads the index, not the disk at commit time |
| See the diff you are about to record | `git diff --staged` | That is the index compared with `HEAD` |
| See edits you have not staged | `git diff` | That is the working tree compared with the index |
| Record the index | `git commit -m "why"` | A new snapshot whose parent is the current commit |
| Keep a file out of future adds | a line in `.gitignore`, before the file is tracked | Ignore rules do not untrack a path that is already in the index |
| Stop tracking a file, keep the disk copy | `git rm --cached path`, then commit | The next snapshot omits it. Older snapshots still have it |

### You can now

- Explain a commit as a snapshot plus a parent, and say why `git show` can still print a diff.
- Point at the working tree, the index, and `HEAD`, and say which comparison `git diff` and `git diff --staged` make.
- Stage one file and leave another change for a later commit.
- Write a `.gitignore` that keeps a secret out of `git add .`, and explain why that does nothing for a file that is already tracked.
- Write a commit message that says the effect, so a later revert is a decision rather than a guess.

::: quiz
q: You edited `app.py` and `README.md`, then ran `git add app.py` and `git commit -m "..."`. Where is the README change now?
- In the commit too
+ Still in the working tree, uncommitted
- Lost
- Staged for the next commit
why: Only what's staged goes into a commit. The README change is untouched on disk; `git status` lists it as modified.
:::

::: shell git
task: Make this folder a Git repository. Add a `.gitignore` that keeps `.env` out, then commit **everything else** in one commit with the message `Initial commit`.
file: app.py
```
print("hello")
```
file: README.md
```
# demo
```
file: .env
```
API_KEY=secret
```
verify:
```bash
git rev-parse --git-dir >/dev/null 2>&1 || { echo "this isn't a git repository yet (git init)"; exit 1; }
git check-ignore -q .env || { echo ".env isn't ignored"; exit 1; }
[ "$(git rev-list --count HEAD 2>/dev/null)" = "1" ] || { echo "there should be exactly one commit"; exit 1; }
[ "$(git log -1 --format=%s)" = "Initial commit" ] || { echo "the commit message should be 'Initial commit'"; exit 1; }
[ "$(git ls-files | LC_ALL=C sort | tr '\n' ' ')" = ".gitignore README.md app.py " ] || { echo "the commit should hold .gitignore, README.md and app.py (it has: $(git ls-files | tr '\n' ' '))"; exit 1; }
```
solution:
```bash
git init
echo ".env" > .gitignore
git add .
git commit -m "Initial commit"
```
hint: Write `.gitignore` before `git add .`, so `.env` is never staged.
:::

::: quiz
q: You change one line of `billing.py` and commit. What does that commit store?
- Only the one line that changed, because a commit is a patch
+ A snapshot of the whole tracked tree, plus a pointer to the parent commit. The diff is computed later, when you compare two snapshots
- A copy of the working tree, including ignored files and untracked files
- The index as it was before `git add`, so the new line is left out on purpose
why: Git stores the tree. `git show` prints a diff by comparing this snapshot with its parent, which is why a one-line edit still produces a commit you can check out as a full directory. Ignored and untracked files are not in the index, so they are not in the snapshot. The index after `git add` is what gets recorded, not the index from before the add.
:::

::: quiz
q: `token.txt` is already in the latest commit. You add `token.txt` to `.gitignore` and run `git status`. What happens, and why?
- The file disappears from the repository, because ignore rules apply to every commit
+ The file is still tracked. Ignore rules only hide untracked names, so Git still reports later edits and the next commit will still contain the file unless you remove it from the index
- `git status` fails, because a tracked file cannot be named in `.gitignore`
- The file is deleted from disk, so the secret is gone
why: `.gitignore` is consulted for names that are not in the index. A path that is already tracked stays tracked, which is why adding the line does not remove the secret from `HEAD`. `git rm --cached token.txt` takes it out of the index and leaves the disk copy. A new commit then omits it. The old commit still has the bytes, so a pushed secret still has to be rotated. Git does not delete the working file just because you ignored it, and it does not error on an ignore line that names a tracked path.
:::

::: predict lang=shell
q: What does `git status --short` print? The left column is the index compared with `HEAD`. The right column is the working tree compared with the index. Spacing in the short status is normalised here.
code:
```bash
git init -q
echo one > a.txt
echo two > b.txt
git add a.txt
git status --short
```
answer:
```
A a.txt
?? b.txt
```
why: `a.txt` is in the index and not in a commit yet, so the staged column is `A` and there is no unstaged change. `b.txt` was never added, so both columns are `?`. `git add .` would have staged both. The commit does not exist yet, which is why the added file is not described as a modification of `HEAD`.
:::

::: shell git
task: The repository already has a commit. `app.py` and `notes.md` have both been edited since then. Commit only the `notes.md` change, with the message `Document the retry`. Leave the `app.py` edit in the working tree, unstaged.
setup:
```bash
git init -q
echo 'print("v1")' > app.py
echo '# notes' > notes.md
git add . && git commit -qm "Start"
echo 'print("v2")' > app.py
printf '%s\n' '# notes' 'retry on timeout' > notes.md
```
verify:
```bash
# wrong answer tested: git add . && git commit -m "Document the retry"
# which also records print("v2") in HEAD. The app.py edit must stay unstaged.
set -euo pipefail
[ "$(git log -1 --format=%s)" = "Document the retry" ]
git show HEAD:notes.md | grep -qx 'retry on timeout'
if git show HEAD:app.py | grep -qx 'print("v2")'; then
  echo "app.py change was committed" >&2
  exit 1
fi
git show HEAD:app.py | grep -qx 'print("v1")'
grep -qx 'print("v2")' app.py
```
solution:
```bash
git add notes.md
git commit -m "Document the retry"
```
hint: `git add notes.md` copies only that file into the index. `git diff --staged` should not mention `app.py`. Then commit. `git add .` would take the Python change too.
:::

::: shell git
task: `token.txt` is already in the latest commit. Stop tracking it, keep the file on disk, and ignore that name from now on. Make a new commit with the message `Stop tracking the token`. The history should have two commits. Do not use `--amend`.
setup:
```bash
git init -q
echo 'print("ok")' > app.py
echo 'sekret' > token.txt
git add . && git commit -qm "Start"
```
verify:
```bash
# wrong answer tested: echo token.txt >> .gitignore && git add .gitignore && git commit
# without git rm --cached. HEAD still contains token.txt.
set -euo pipefail
[ "$(git rev-list --count HEAD)" = "2" ]
[ "$(git log -1 --format=%s)" = "Stop tracking the token" ]
if git cat-file -e HEAD:token.txt 2>/dev/null; then
  echo "token.txt is still in HEAD" >&2
  exit 1
fi
[ -f token.txt ]
git check-ignore -q token.txt
git show HEAD:app.py | grep -qx 'print("ok")'
```
solution:
```bash
git rm --cached token.txt
echo token.txt > .gitignore
git add .gitignore
git commit -m "Stop tracking the token"
```
hint: `git rm --cached` removes the path from the index and leaves the file on disk. A line in `.gitignore` then keeps `git add .` from putting it back. Commit both the removal and the ignore file. An ignore line alone does not take a tracked path out of `HEAD`.
:::

## Reading history
id: history
stage: basics
needs: commits
minutes: 40
goal: Find out what changed, when, and why, from the history and the diffs.
source: Pro Git: Viewing the commit history | https://git-scm.com/book/en/v2/Git-Basics-Viewing-the-Commit-History
source: OverTheWire Bandit, levels 27 to 31: git repositories with secrets in them | https://overthewire.org/wargames/bandit/bandit28.html

A reviewer asks which commit turned a fee on. The file on disk only has the current text, so staring at it cannot answer the question. The commits can, because each one stored a full snapshot and the name of its parent. `git log` walks that parent pointer, newest first, and prints the message that was written at the time. The message is the only sentence many changes ever get, which is why "fix" becomes useless the week after you wrote it and a sentence about the effect is still readable in six months.

The walk is not a search of your working tree. It is a walk of objects in `.git`. A commit object points at a tree, the tree points at the file contents, and the commit also points at its parent. `git log --oneline` prints one short line per commit so you can see the shape. Adding `--format=%s` prints only the subject, which is what you want when you are collecting messages rather than reading hashes. `-n 2` stops after two commits, because the walk would otherwise continue until the root.

### A path is a filter, not a search box

`git log -- rates.txt` still walks the same chain, but it keeps a commit only when the snapshot of `rates.txt` differs from the parent's snapshot of that same path. A commit that added a README and left the rates alone is omitted, because the blob for that path is identical to the parent's blob. That is why the log for one file is shorter than the log for the repository. It is also why the filter can surprise you on a merge: history simplification can hide a merge whose result matches one parent. When you need the merge itself, `--full-history` keeps it. For a straight line of ordinary commits, the path filter is the right tool and it is enough.

`git show` is the same comparison for one commit. You name a commit and Git diffs that snapshot against its parent, then prints the message above the diff. The stored object is still the tree. The diff is computed when you ask.

`git blame rates.txt` answers a narrower question. For each current line it finds the most recent commit that set that line to the text you see. A line can be months older than the commit that last touched a different line in the same file. Blame is how you find who last set a value. It is not a list of everyone who ever edited the file.

### Names for a commit

A commit's real name is the hash of its contents: the tree, the parents, the message, the author, and the timestamps. The first seven characters are usually enough to type, because a collision in a single repository is rare. `HEAD` is not a hash. It is a pointer to where you are now, usually "the tip of the branch you have checked out". `HEAD~1` means the first parent of `HEAD`. `HEAD~3` follows that first-parent link three times.

The first-parent rule is the part people skip. A merge commit has two parents. The first is the branch you were on when you merged. The second is the branch you merged in. `HEAD~1` from that merge is the first parent, so it is not "whatever commit happened to be earlier in time on the other branch". If you wanted the second parent you would write `HEAD^2`. Using `~` and expecting a time-ordered walk across both sides will land on the wrong snapshot, and the diff will look like the bug came back when really you followed the wrong pointer.

### Reading a diff

A hunk starts with `@@`. The numbers say where the change sits in the old file and the new file. Lines that begin with `-` were in the parent and are not in this snapshot. Lines that begin with `+` are in this snapshot and were not in the parent. A changed line is printed as a removal plus an addition, because Git is describing two snapshots, not editing the file in front of you.

```text
@@ -4,3 +4,3 @@
 standard: 0.20
-reduced: 0.05
+reduced: 0.00
 local: 0.01
```

Here the reduced rate changed and the lines around it are context so you can see which rate. The `@@` header is the map. The `+` and `-` lines are the only bytes that differ.

`git diff` and `git diff --staged` are the same kind of comparison, aimed at the two places that are not yet a commit. `git diff` compares the working tree with the index, so it shows edits you have not staged. `git diff --staged` compares the index with `HEAD`, so it shows what the next commit will record. A file can appear in both, because you can stage one version and then keep typing. The left column of `git status --short` is that staged comparison. The right column is the unstaged one.

### Where this breaks

**`HEAD~n` across a merge.** You follow the first parent only. The other side of the merge is still in the graph, at `HEAD^2`, and a log that does not say `--first-parent` will show both. A log that does say `--first-parent` hides the second side on purpose, which is what you want when you are reading "what landed on main" and not every commit that was on the branch.

**A path filter that looks empty.** The file might have been renamed. `git log --follow -- rates.txt` follows a rename. Without `--follow`, the log stops at the commit that created the new name, and the older history looks missing.

**Blame on a line you just moved.** Blame reports the commit that last set the line's text. A commit that only moved the line may or may not show up, depending on whether the text itself changed. If you need the commit that introduced a blank line or a formatting-only edit, blame is the wrong tool and `git log -p` is the right one.

**Author dates.** `git log` prints the author date by default. A rebased commit can have an author date from when you first wrote it and a committer date from when it was replayed. If two events disagree, look at the committer date before you decide which one "happened" later.

### How this is used at work

An incident starts with a commit, not with a hunch. You get the deploy's hash from the release, then `git log` and `git show` on that range until you see the message and the hunk that match the failure. Code review is the same comparison before the commit is even on main: the diff under a pull request is `git diff` between the branch tip and the base. Release notes are the subjects from `git log` since the previous tag, which is why a subject that says the effect can be pasted into the notes and a subject that says "wip" cannot.

### Which command

| You want | Command | Why |
|---|---|---|
| The shape of recent history | `git log --oneline` | One line per commit, newest first, walking parents |
| Only the commits that changed a file | `git log -- path` | Skips commits whose blob for that path matches the parent |
| The message and diff of one commit | `git show <commit>` | Compares that snapshot with its parent |
| What the next commit will record | `git diff --staged` | Index versus `HEAD` |
| Edits you have not staged | `git diff` | Working tree versus the index |
| Who last set each current line | `git blame path` | The last commit that produced the line you see |
| The first parent, n steps back | `HEAD~n` | Follows the first parent only, including through merges |

### You can now

- Walk history as parent pointers and say why the newest commit is printed first.
- Limit that walk to one path, and explain why a commit that did not change the path is missing.
- Read a hunk: context, removals, additions, and the `@@` line.
- Choose `git diff` or `git diff --staged` from which two trees you are comparing.
- Name `HEAD~1` as the first parent, and say why that is not "the other side" of a merge.

::: card
q: What's the difference between `git diff` and `git diff --staged`?
answer: `git diff` shows changes you haven't staged yet. `git diff --staged` shows what's staged, which is exactly what `git commit` would record.
:::

::: shell git
task: This repository has some history. Print the **messages** of the commits that changed `config.yml`, newest first, one per line. (`--format=%s` prints just the message.)
setup:
```bash
git init -q
echo "port: 80" > config.yml; echo "print(1)" > app.py
git add . && git commit -qm "Start the service"
echo "print(2)" > app.py && git commit -qam "Print two"
echo "port: 8080" > config.yml && git commit -qam "Move to port 8080"
echo "# docs" > README.md && git add README.md && git commit -qm "Add a README"
printf "port: 8080\ndebug: false\n" > config.yml && git commit -qam "Turn debug off"
```
expect:
```
Turn debug off
Move to port 8080
Start the service
```
solution:
```bash
git log --format=%s -- config.yml
```
hint: `git log` takes a path after `--` and lists only the commits that touched it.
:::

::: predict lang=shell
q: What does the last line print?
code:
```bash
git init -q
echo a > f.txt && git add f.txt && git commit -qm one
echo b > f.txt
git add f.txt
echo c > f.txt
git diff --staged --stat | tail -n 1
git diff --name-only
```
answer:
```
1 file changed, 1 insertion(+), 1 deletion(-)
f.txt
```
why: The staged version (b) differs from the commit (a), and the working tree (c) differs from the staged version too. A file can have staged and unstaged changes at once.
:::

::: quiz
q: You are on a merge commit. What does `HEAD~1` point at?
- The most recent commit on the branch that was merged in
+ The first parent, which is the tip of the branch you were on when you merged
- Whichever parent has the earlier author date
- The second parent, because `~` counts every parent
why: `~` follows the first parent. On a merge, the first parent is the branch you had checked out. The branch you merged in is the second parent, `HEAD^2`. Picking the older author date is a time sort, and Git's pointer is not a time sort.
:::

::: quiz
q: `git log --oneline -- billing.py` omits a commit whose message is `Add a README`. The commit is in `git log --oneline` without a path. Why?
- Path arguments only search commit messages, and this message does not mention billing
+ That commit's snapshot of `billing.py` is identical to its parent's snapshot of `billing.py`, so the path filter drops it
- README commits are stored on a different branch, so the main log cannot see them
- `git log` hides the newest commit whenever you pass a path
why: The path filter compares the file's contents with the parent. A commit that only added a README did not change `billing.py`, so it is not a commit that explains the billing file. The commit is still in the full log. Message text is not what the path filter searches.
:::

::: predict lang=shell
q: What does this print? `git log` walks newest first, and `-n 2` stops after two commits.
code:
```bash
git init -q
echo a > n.txt && git add n.txt && git commit -qm start
echo b > n.txt && git commit -qam "set b"
echo c > n.txt && git commit -qam "set c"
git log --format=%s -n 2
```
answer:
```
set c
set b
```
why: The newest commit is `set c`, then its parent `set b`. `-n 2` does not print `start`. `--format=%s` prints the subject only, so there is no hash on the line.
:::

::: shell git
task: Write `last.sh` so that running it prints only the subject of the commit that last changed `price.txt`. One line, the message, nothing else. The script has to ask Git. A script that echoes the message will not pass.
setup:
```bash
git init -q
printf '%s\n' 'port: 80' > price.txt
git add . && git commit -qm "Start prices"
printf '%s\n' 'port: 80' 'fee: 5' > price.txt
git commit -qam "Add the fee"
echo readme > README.md && git add README.md && git commit -qm "Add a readme"
```
verify:
```bash
# wrong answer tested: echo "Add the fee" > last.sh
# and: git log -1 --format=%s   (prints "Add a readme")
set -euo pipefail
[ -f last.sh ]
if grep -q 'Add the fee' last.sh; then
  echo "the message is hardcoded in last.sh" >&2
  exit 1
fi
[ "$(bash last.sh)" = "Add the fee" ]
```
solution:
```bash
printf '%s\n' 'git log -1 --format=%s -- price.txt' > last.sh
```
hint: A path after `--` keeps only commits that changed that file. `-1` stops after the newest of those. Without the path, you get the tip of the branch, which is the README commit.
:::

## Finding the first bad commit
id: bisect
stage: basics
needs: history
minutes: 40
goal: Binary-search history for the first commit that fails a check you can run.
source: Pro Git: git bisect | https://git-scm.com/docs/git-bisect

A test that passed at the start of the quarter fails on today's main. There are a few hundred commits in between. Reading each diff until you spot the bug is linear in the length of the history, and most of those diffs are innocent. The failure, if it started once and stayed, has a single first commit. Everything before that commit is good. Everything from that commit on is bad. That shape is what binary search is for. Each test throws away half of the remaining range, so a few hundred commits take on the order of eight tests, not a few hundred.

`git bisect` is that search. You mark one commit bad and one commit good. Git checks out a commit in the middle. You test it and mark it good or bad. Git repeats until only one commit could be the first bad one. `git bisect start <bad> <good>` records the two ends. `HEAD` is usually the bad end, because that is the commit you are looking at when you notice the failure. The good end has to be old enough that the bug is not already there. If your good mark is actually bad, the search is answering a different question than the one you asked, and it will hand you a commit that is not the regression.

### A script can mark the commits

`git bisect run ./check.sh` checks out each candidate and runs the script. Exit 0 means good. Exit 1 through 127 means bad. Exit 125 means "I cannot tell", and Git skips that commit. You use 125 when the project does not build at that revision, because a compile failure is not the bug you are hunting and marking it bad would pin the search on the wrong change.

The script has to be true at the good end and false from the first bad commit through the tip. Bisect assumes the failure does not come and go. If someone introduced the bug and a later commit fixed it, a bad mark at the tip is wrong, because the tip is good again. The search only works for a range where the answer flips once from good to bad and stays bad.

On the Git this course runs (Apple Git 2.54), `git bisect run` prints the first bad commit and records it as `refs/bisect/bad`, and the same line is written at the end of `.git/BISECT_LOG`. The worktree is left on the last revision the script tested, which is often the last good commit, not the bad one. Read the "first bad commit" line, or `git log -1 --format=%s refs/bisect/bad`. Do not trust `git log -1` with no revision while the bisect is still open. When you are finished, `git bisect reset` checks out the branch you started from and deletes the bisect state.

### Walking a range by hand

Suppose the good commit is number 0 and the bad tip is number 7, and the bug arrived in commit 5. You do not know that. You know 0 passes and 7 fails. The middle is 3 or 4. You test 3, it passes, and the first bad commit is now somewhere in 4, 5, 6, or 7. The good fence moves up to 3. The middle of what remains is 5 or 6. You test 5, it fails, and the bad fence moves down to 5. The only commit still in between the new fences is 4. You test 4, it passes, and 5 is the only commit that is bad while its parent is good. That is eight commits decided in three tests. The same arithmetic is why a few hundred commits are about eight tests: each test halves what is left, and halving is what `git bisect` is doing when it checks out the next candidate.

The script is the test you just did by hand. It has to implement the same yes-or-no you would have typed. On commit 3 it exits 0. On commit 5 it exits 1. If commit 2 does not compile, the script exits 125, and Git chooses a neighbour instead of treating a missing compiler as the regression. After `git bisect run` finishes, read `refs/bisect/bad`. On the Git used here the worktree is often still sitting on the last commit the script ran, which in this story might be commit 4, the last good one. The announcement already named commit 5. Trust that name.

### Where this breaks

**A flaky test.** If the script fails for a reason other than the bug, a good commit gets marked bad and the search narrows onto noise. Run the script once on the known-good commit and once on the tip before you start, so you know the exit codes mean what you think.

**A dirty worktree.** Bisect checks out old trees. Uncommitted edits block the checkout, or they ride along and make the script fail for a reason that is not in the commit. Commit or stash before you start.

**Too short a history.** `HEAD~3` only exists when there are at least four commits. Starting a bisect with a revision that is not in the graph errors immediately. Count with `git rev-list --count HEAD` if you are not sure the good mark is real.

**Marking the newest commit as the answer by hand.** The tip is bad, and so is every commit after the first bad one. The tip is the answer only when the bug was introduced in the latest commit. The point of the search is to refuse that guess.

### How this is used at work

A CI history that went from green to red is the usual input. The check is the same command CI runs, or a smaller script that detects the symptom (a wrong value in a file, a test name that fails). You bisect locally when the script is fast. You let a build system bisect when the check needs a full compile. Either way the output you paste into the incident is the first bad commit's subject and hash, not the newest red build.

### Which command

| You want | Command | Why |
|---|---|---|
| Start the range | `git bisect start <bad> <good>` | Bad is where it fails, good is where it still passed |
| Let a script walk | `git bisect run ./check.sh` | 0 is good, 1–127 is bad, 125 skips |
| Read the result | `git log -1 --format=%s refs/bisect/bad` | The worktree may still be on the last tested commit |
| Leave the search | `git bisect reset` | Returns you to the branch and drops bisect state |

### You can now

- Explain why one test in the middle of the range deletes half of the commits.
- Write a check whose exit code is 0 on a good commit and non-zero on a bad one.
- Read the first bad commit from `refs/bisect/bad` rather than from a bare `git log -1`.
- Say when bisect cannot work: a flaky script, a bug that was already fixed, or a good mark that is not actually good.

::: quiz
q: `git bisect run` executes your script on a commit. The script exits 0. What does Git record?
- The commit is bad, because a passing script means the bug is here
+ The commit is good, so the first bad commit is later in the range
- The search stops and this commit is the answer
- Exit 0 means "skip", and Git will try a neighbour
why: Exit 0 is good and exit 1 through 127 is bad. The search stops only when one commit is the first bad one. Exit 125 is the skip code, not 0.
:::

::: quiz
q: The newest commit fails your check, and so do the two commits before it. The commit before those passes. Which commit is the one bisect should report?
- The newest commit, because that is the one you have checked out
+ The oldest of the failing commits, because that is where the check flipped from good to bad
- The oldest commit in the repository, because the bug has to start at the root
- Whichever commit has the longest diff
why: Later failing commits inherited the bug. The first bad commit is the earliest one that fails, given that its parent still passes. The newest commit is only that commit when nothing before it fails.
:::

::: card
q: Your check script cannot build a very old commit, so it cannot tell whether the bug is there. What exit code should it use, and why?
answer: Exit 125. Git skips that commit instead of marking it good or bad. Marking a compile failure as bad would aim the search at the build break rather than at the bug you are looking for.
:::

::: predict lang=shell
q: What does this print? The walk is newest first.
code:
```bash
git init -q
echo ok > app.txt && git add . && git commit -qm start
echo bad > app.txt && git commit -qam "introduce bug"
echo docs > README.md && git add . && git commit -qm "unrelated docs"
git log --format=%s
```
answer:
```
unrelated docs
introduce bug
start
```
why: The tip is the docs commit, which did not introduce the bad contents. The bug is its parent. A bisect of this range should report `introduce bug`, not the tip, because the tip fails only by inheritance.
:::

::: shell git
task: `check.sh` exits 0 when `app.txt` contains exactly `ok`. The bug appeared somewhere after `start` and is still present at the tip. Run bisect from `HEAD` (bad) back to `HEAD~3` (good). When it finishes, `refs/bisect/bad` should be the commit whose subject is `introduce bug`.
setup:
```bash
git init -q
echo ok > app.txt && git add . && git commit -qm start
echo ok > app.txt && echo keep > notes.txt && git add . && git commit -qm "keep ok"
echo bad > app.txt && git add . && git commit -qm "introduce bug"
echo docs > README.md && git add . && git commit -qm "unrelated docs"
printf '%s\n' '#!/bin/bash' 'grep -qx ok app.txt' > check.sh
chmod +x check.sh
```
verify:
```bash
# wrong answer tested: git log -1 --format=%s
# On this Git, bisect run leaves HEAD on the last tested revision ("keep ok"),
# not on the first bad commit. Reading HEAD reports the wrong subject.
# An inverted check (grep for "bad") also lands refs/bisect/bad on a different commit.
set -euo pipefail
[ "$(git log -1 --format=%s refs/bisect/bad)" = "introduce bug" ]
grep -q 'first bad commit:.*introduce bug' .git/BISECT_LOG
```
solution:
```bash
git bisect start HEAD HEAD~3
git bisect run ./check.sh
```
hint: `git bisect start HEAD HEAD~3` marks the tip bad and the commit three first-parents back good. `git bisect run ./check.sh` walks the range. Read `refs/bisect/bad` afterwards. A bare `git log -1` shows whichever commit was tested last.
:::

::: shell git
task: History has four commits and the fee is wrong at the tip. Write `check.sh` so it exits 0 when `rates.txt` is exactly the line `fee: 5`, and exits non-zero otherwise. Run bisect from `HEAD` back to `HEAD~3`. `refs/bisect/bad` should be the commit `raise the fee`.
setup:
```bash
git init -q
echo 'fee: 5' > rates.txt && git add . && git commit -qm start
echo 'note' > plan.txt && git add . && git commit -qm "note the plan"
echo 'fee: 9' > rates.txt && git add . && git commit -qm "raise the fee"
echo docs > README.md && git add . && git commit -qm "update the readme"
```
verify:
```bash
# wrong answer tested: check.sh runs `grep -qx 'fee: 9' rates.txt`
# which treats the bug as the good state, so refs/bisect/bad is not "raise the fee".
set -euo pipefail
[ -f check.sh ]
[ "$(git log -1 --format=%s refs/bisect/bad)" = "raise the fee" ]
```
solution:
```bash
printf '%s\n' '#!/bin/bash' 'grep -qx "fee: 5" rates.txt' > check.sh
chmod +x check.sh
git bisect start HEAD HEAD~3
git bisect run ./check.sh
```
hint: The good state is `fee: 5`. Exit 0 when that line is present. Then `git bisect start HEAD HEAD~3` and `git bisect run ./check.sh`. A check that looks for `fee: 9` has the sense of the test backwards.
:::

## Branches and merging
id: branches
stage: team
needs: history
minutes: 45
goal: Work on a branch, and merge it back knowing whether Git will fast-forward or make a merge commit.
source: Pro Git: Branches in a nutshell | https://git-scm.com/book/en/v2/Git-Branching-Branches-in-a-Nutshell

Two people editing one directory will overwrite each other. A branch is how Git lets both sets of commits exist before anyone decides how they join. The branch is not a copy of the files and it is not a folder. It is a movable name for one commit. `main` points at a commit. When you commit while that name is checked out, Git makes a new commit whose parent is the old tip, then moves the name forward to the new commit. The old commit is still there. The name moved.

`HEAD` says which name is checked out. If `HEAD` is "the branch `feature/invoices`", the next commit advances `feature/invoices`. The files in your working tree are the snapshot that name points at, plus any edits you have not committed. `git switch feature/invoices` moves `HEAD` to that name and checks out that snapshot, which is why the files on disk change when you switch. `git switch -c feature/invoices` creates the name at the current commit and switches to it in one step. Creating the name with `git branch` does not switch, so a commit after `git branch` still advances the branch you were already on.

```text
before the new commit          after committing on the feature

  main                          main
   |                             |
   v                             v
  C2                            C2
   ^                             ^
   |                             |
 feature                    feature -> C3
```

Both names can point at the same commit. That is the moment just after you create the branch and before you commit. The new commit is what makes them differ. Deleting the name with `git branch -d` deletes the label. The commits stay reachable as long as some other name, including the reflog, can still see them. Deleting a merged branch is safe because `main` still points at a history that contains those commits. Deleting an unmerged branch with `-d` is refused. `-D` deletes it anyway, and then the only way back is the reflog.

### Fast-forward or a merge commit

`git merge feature/invoices` while you are on `main` means "make `main` contain the work that is on `feature/invoices`". Git looks at whether `main`'s tip is an ancestor of the feature tip.

If it is, nothing on `main` happened after the branch point. Git can move the `main` label forward to the feature tip. That is a fast-forward. No new commit is written. The history stays a straight line, and `git rev-list --parents -n 1 HEAD` shows the commit and one parent.

If both names have commits the other does not have, neither tip is an ancestor of the other. Moving a label would drop one side. Git writes a new commit whose tree is the combined snapshot and whose parents are the two tips. That merge commit is the join. `git rev-list --parents -n 1 HEAD` then shows the new commit and two parents, three words on the line. `git rev-list --merges --count HEAD` counts those joins.

```text
fast-forward                 both sides moved

  C1 <- C2 <- C3               C1 <- C2 <- C4   <- M
              ^                      ^    ^      ^
            main, feature          main  feature main
```

A pull request is a merge that a second person agrees to. The hosting site may fast-forward, create a merge commit, or squash the branch into one commit. The graph you get is the graph that choice writes. The review is about the diff. The history is about which of these shapes you asked for.

### What "ahead" means before anyone pushes

Create `feature/invoices` at the current tip and the two names point at one commit, so `git log main..feature/invoices` is empty. The `..` notation is "reachable from the right name and not from the left". One commit on the feature makes that range one commit long, and `git log feature/invoices..main` is still empty if `main` has not moved. That second empty range is the fast-forward condition: `main` has nothing the feature lacks, so moving the `main` label forward loses nothing. The moment someone commits on `main`, both ranges are non-empty. A fast-forward would have to drop one of them, so Git refuses to pretend the histories are nested and writes a merge commit instead.

`git merge --ff-only` is the form a deploy script uses when the only acceptable update is sliding the label. If the ranges are both non-empty, the command fails and the script stops, which is what you want on a release branch that must not grow a merge commit in the middle of the night. You then decide, awake, whether to rebase the feature or to merge on purpose. The failure is the script doing the job you gave it.

### Where this breaks

**Committing on `main` by accident.** `git branch feature/invoices` made the name and left you on `main`. The commit advanced `main`. `git switch -c` exists so the name and the checkout happen together. `git status` prints the branch at the top for this reason.

**Expecting a fast-forward after `main` moved.** If someone else committed on `main`, a fast-forward is impossible and Git will create a merge commit, or refuse if you passed `--ff-only`. `--ff-only` is how a deploy script says "only move the label, never invent a merge".

**Thinking the branch contains a private copy of the files.** Both branches share every commit up to the branch point. Changing a file on the feature does not hide the old blob. The old blob remains the parent's version, which is why merging can still see both edits.

### How this is used at work

A change that is not ready to deploy lives on a branch so `main` stays at the commit you are willing to release. CI builds the branch tip. Reviewers read the diff between that tip and `main`. When the change is accepted, the merge moves `main`. Short branches, a day or two, merge before `main` has moved far, which is why they fast-forward or conflict in a handful of lines instead of in a week's worth of edits.

### Which command

| You want | Command | Why |
|---|---|---|
| New name, and start committing on it | `git switch -c name` | Creates the pointer and moves `HEAD` |
| See the name you are on | `git branch --show-current` | Prints the branch `HEAD` is attached to |
| Bring a branch in when `main` has not moved | `git merge name` | Fast-forward: the label moves, no new commit |
| Join two branches that both moved | `git merge name` | A commit with two parents |
| Refuse a surprise merge commit | `git merge --ff-only name` | Fails if fast-forward is impossible |
| Delete a label you already merged | `git branch -d name` | The commits remain reachable from `main` |

### You can now

- Describe a branch as a movable name for a commit, and `HEAD` as the name that will advance when you commit.
- Predict a fast-forward when one tip is an ancestor of the other.
- Predict a merge commit with two parents when both sides have new commits.
- Say why deleting a merged branch does not delete the commits.

::: quiz
q: You branched `fix/typo` from `main`, made one commit, and nobody touched `main` since. What does `git switch main && git merge fix/typo` do?
+ Fast-forward: `main` moves to your commit, and no merge commit is made
- It makes a merge commit with two parents
- It fails, because the branch must be pushed first
- It copies the commit and deletes the branch
why: `main` is an ancestor of your branch, so there's nothing to join; Git just moves the name forward.
:::

::: shell git
task: On a new branch `feature/health`, add a file `health.py` containing `print("ok")` and commit it. Then switch back to `main` and merge the branch in.
setup:
```bash
git init -q
echo 'print("app")' > app.py
git add . && git commit -qm "Start"
```
verify:
```bash
[ "$(git branch --show-current)" = "main" ] || { echo "you should end on main"; exit 1; }
git rev-parse -q --verify feature/health >/dev/null || { echo "there's no branch called feature/health"; exit 1; }
git cat-file -e main:health.py 2>/dev/null || { echo "main doesn't have health.py committed"; exit 1; }
[ "$(git show main:health.py)" = 'print("ok")' ] || { echo "health.py should contain print(\"ok\")"; exit 1; }
git merge-base --is-ancestor feature/health main || { echo "feature/health isn't merged into main"; exit 1; }
```
solution:
```bash
git switch -c feature/health
echo 'print("ok")' > health.py
git add health.py
git commit -m "Add a health check"
git switch main
git merge feature/health
```
hint: `git switch -c NAME` makes the branch and moves onto it. Commit there, `git switch main`, then `git merge feature/health`.
:::

::: quiz
q: You run `git branch feature/invoices` and then commit. Which name moves forward?
- `feature/invoices`, because creating a branch switches you onto it
+ The branch you were already on. `git branch` makes a name and leaves `HEAD` where it was
- Both names, because they pointed at the same commit
- Neither, until you push
why: A branch is a label. `git branch` writes the label and does not move `HEAD`. The next commit advances whichever label `HEAD` is attached to. `git switch -c` is the command that writes the label and attaches `HEAD` to it.
:::

::: predict lang=shell
q: What does this print?
code:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm base
git switch -c feature/invoices
echo b > inv.txt && git add . && git commit -qm "Add the invoice export"
git branch --show-current
git log --format=%s -n 1
```
answer:
```
feature/invoices
Add the invoice export
```
why: `git switch -c` attaches `HEAD` to the new name before the commit, so the commit advances `feature/invoices` and not `main`. The switch message goes to stderr. The two lines here are the current name and the new subject.
:::

::: quiz
q: `feature/invoices` is merged into `main`. You delete the branch name. What happens to its commits?
- They are deleted, because nothing points at them
+ They stay. `main` still reaches them, and the name was only a label
- They become a merge commit
- Git refuses, because a merged branch cannot be deleted
why: `git branch -d` removes a label. After a merge, `main`'s history still reaches those commits, so they are not dangling. `-d` refuses when the branch is not merged, which is the opposite of this case.
:::

::: shell git
task: `main` and `feature/tax` have each gained a commit since they split. Merge `feature/tax` into `main` so the result is a merge commit with two parents. Stay on `main`. Both `tax.txt` and `main.txt` should be in `HEAD`.
setup:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm base
git switch -q -c feature/tax
echo t > tax.txt && git add . && git commit -qm "Add the tax table"
git switch -q main
echo m > main.txt && git add . && git commit -qm "Note the warehouse"
```
verify:
```bash
# wrong answer tested: git rebase feature/tax
# which replays main onto the feature and leaves a single parent (two words, not three).
set -euo pipefail
[ "$(git branch --show-current)" = "main" ]
[ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" = "3" ]
git cat-file -e HEAD:tax.txt
git cat-file -e HEAD:main.txt
```
solution:
```bash
git merge --no-edit feature/tax
```
hint: You are already on `main`, and `main` is not an ancestor of the feature, so a merge writes a commit with two parents. `git rebase` would replay one side and leave a straight line.
:::

## Stashing a half-finished edit
id: stash
stage: team
needs: branches
minutes: 35
goal: Set aside uncommitted work, commit something else, and bring the work back.
source: Pro Git: git stash | https://git-scm.com/docs/git-stash

You are halfway through a paragraph in `styles.css` when a one-line fix in `app.py` has to go out. The CSS edit is not ready to commit, and the fix should not wait for it. The working tree is one set of files, so you cannot check out a clean tree while those edits are sitting there. A commit of both files would publish the unfinished paragraph. A commit of neither leaves the fix unshipped.

`git stash push` takes the uncommitted changes and stores them as commits that are not on your branch. The branch tip does not move. The working tree and the index go back to matching `HEAD`, so the files look like the last commit again. You can then make the small fix as a normal commit. `git stash pop` applies the stored changes onto the new tip and drops that stash entry. The CSS paragraph comes back as an unstaged edit on top of the fix you just committed. `git stash apply` does the same apply and leaves the entry on the stack, which is what you want when you may need to apply it again. `git stash drop` throws an entry away.

The stack is a stack. `git stash list` prints the entries, newest first. `stash@{0}` is the one `pop` will use. A path after `--` limits what is stored: `git stash push -- styles.css` sets aside that file and leaves every other dirty file in the worktree. Without a path, a plain `git stash push` takes tracked modifications. Untracked files stay untracked unless you pass `--include-untracked` (`-u`). An ignored file stays ignored unless you ask for it. That default is why a new file you never `git add`ed is still sitting there after a stash, and the checkout you hoped would be clean is not.

### The CSS paragraph, set down and picked up

`styles.css` has a half-written rule and `app.py` has the one-line fix. Both files are tracked, and both are dirty. `git stash push -- styles.css` writes the CSS edit onto the stash stack and checks `styles.css` back out at `HEAD`. `app.py` is still dirty, because the path limited what was stored. `git diff -- styles.css` is empty. `git diff -- app.py` is the fix. You stage `app.py` and commit it. The branch tip moves. The CSS rule is not in that commit, which you can see because `git show HEAD -- styles.css` has nothing to say about the paragraph.

`git stash pop` applies the stored diff onto the new tip. The paragraph is back in the worktree as an unstaged edit, and `git stash list` no longer shows that entry. If the fix commit had edited the same lines of `styles.css`, the pop would stop with conflict markers and the stash entry would stay. You would edit the file until the paragraph and the fix both make sense, add the file, and drop the entry once `git diff` shows the edit you meant to keep. The branch tip still would not move until you commit. A stash never was a commit on the branch, and popping it does not create one either.

The entries are real commits, which is why the edit survives a switch to another branch. They are just commits no branch name points at. `git stash show -p` prints the diff of the newest entry without applying it, so you can read the paragraph before you decide to pop. Dropping an entry you have not read is the way the paragraph actually disappears.

### Where this breaks

**Popping onto a commit that edited the same lines.** Stash applies a change. If the commit you made in between touched those lines, the pop stops with a conflict, the same markers a merge uses. The stash entry is kept when the apply conflicts, so you do not lose it. Fix the file, `git add` it, and drop the stash yourself once you are sure the edit is back.

**Stashing and forgetting the pop.** The small commit goes out and the paragraph is only on the stash stack. It is not on the branch, so a clone does not have it. `git stash list` is the place to look before you decide the work is gone.

**`git stash push` with no path when two files are dirty.** Both tracked edits leave the worktree. You then have nothing left to put in the fix commit. Name the path you want to set aside, and leave the file you intend to commit.

### How this is used at work

The usual moment is a review comment that should be a tiny commit on top of a branch that already has unrelated local edits. Stash the local edits, commit the review fix, pop, and keep going. It is also how you move uncommitted work onto a new branch: stash, `git switch -c`, pop. The commits people pull are still ordinary commits. A stash is local. It is not a way to hand work to someone else.

### Which command

| You want | Command | Why |
|---|---|---|
| Set aside tracked edits | `git stash push` | Stores them off to the side and matches the worktree to `HEAD` |
| Set aside one file | `git stash push -- path` | Leaves other dirty files where they are |
| Include a new untracked file | `git stash push -u` | The default stash ignores untracked names |
| Bring it back and drop the entry | `git stash pop` | Applies onto the current commit |
| Bring it back and keep the entry | `git stash apply` | The stack still has it |
| See what you set aside | `git stash list` | Newest entry first |

A stash also records whether the change was staged. If you had `git add`ed `styles.css` and then stashed, the pop puts those bytes back in the index, staged, not only in the worktree. That is useful when you were in the middle of assembling a commit and had to step away. It is surprising when you expected a pop to be a quiet unstaged edit. `git stash pop` will tell you the index was restored. If you did not want it staged, `git restore --staged` on the path leaves the bytes in the worktree and takes them out of the next commit. The stack can hold several entries. A second stash while the first is still there does not overwrite it. `stash@{0}` is the new one and `stash@{1}` is the older one. Pop takes the newest. Name `stash@{1}` when you want the older entry, and read `git stash list` so the number is the entry you think it is.

### You can now

- Say why a stash does not move the branch tip.
- Stash one dirty file, commit a different file, and pop the first edit back.
- Explain why an untracked file is still in the worktree after a stash that did not use `-u`.
- Recover from a pop you have not done yet by reading `git stash list`.

::: quiz
q: You stash a tracked edit and then look at `git log`. Where is that edit?
- It is the newest commit on the branch, with a message Git invented
+ It is not on the branch. The tip did not move, and the edit is on the stash stack
- It was discarded, because a stash deletes the working tree change
- It was pushed to `origin`, because stash means "set aside on the remote"
why: Stash writes commits that no branch points at, then checks out `HEAD` again. `git log` walks the branch, so the edit is not in that walk. `git stash list` shows it. Nothing was pushed.
:::

::: quiz
q: `git stash pop` succeeds. What is true of `stash@{0}` afterwards?
- It still holds the same edit, so you can pop it again
+ That entry is gone. Pop applies the edit and then drops it
- The branch tip moves back to the commit from before the stash
- The applied edit is staged, because pop implies `git add`
why: Pop is apply plus drop. A second pop would apply the next entry, if there is one. The edit comes back as working-tree changes, not as a new commit and not as a staged snapshot, unless it had been staged when you stashed it.
:::

::: card
q: You created `notes.md` and never added it. You run `git stash push` with no flags and no path. Why is `notes.md` still in the worktree?
answer: A stash without `-u` or `--include-untracked` only takes tracked modifications. An untracked file was never in the index, so it is left on disk. Pass `-u` when the new file has to leave the worktree too.
:::

::: predict lang=shell
q: What does `git status --short` print after the stash? Spacing is normalised.
code:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm base
echo b > a.txt
echo c > b.txt
git stash push -q -- a.txt
git status --short
```
answer:
```
?? b.txt
```
why: `a.txt` was tracked and dirty, so the stash restored it to the committed contents and there is nothing to report for it. `b.txt` was never added. A path-limited stash does not take it, and a stash without `-u` would not take an untracked file anyway. It stays untracked.
:::

::: shell git
task: `notes.md` and `app.py` are both dirty. Stash only the `notes.md` edit, commit the `app.py` edit with the message `Ship the handler`, then bring the notes edit back. The notes draft must be in the worktree and must not be in `HEAD`. The stash stack should be empty when you finish.
setup:
```bash
git init -q
printf '%s\n' '# n' > notes.md
echo 'print(1)' > app.py
git add . && git commit -qm base
printf '%s\n' '# n' 'draft' > notes.md
echo 'print(2)' > app.py
```
verify:
```bash
# wrong answer tested: git add . && git commit -m "Ship the handler"
# which records "draft" in HEAD. Also fails: stash without pop (draft is not
# in the worktree, and git stash list is not empty).
set -euo pipefail
[ "$(git log -1 --format=%s)" = "Ship the handler" ]
git show HEAD:app.py | grep -qx 'print(2)'
if git show HEAD:notes.md | grep -qx draft; then
  echo "the notes draft was committed" >&2
  exit 1
fi
grep -qx draft notes.md
[ "$(git stash list | wc -l | tr -d ' ')" = "0" ]
```
solution:
```bash
git stash push -m "hold the notes" -- notes.md
git add app.py
git commit -m "Ship the handler"
git stash pop
```
hint: `git stash push -- notes.md` sets aside one path. Commit `app.py` on the clean notes file, then `git stash pop`. `git add .` would put the draft in the same commit as the handler.
:::

## Merge conflicts
id: conflicts
stage: team
needs: branches
minutes: 45
goal: Resolve a conflict calmly: read the markers, decide, finish the merge.
source: GitHub: Resolving a merge conflict using the command line | https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/addressing-merge-conflicts/resolving-a-merge-conflict-using-the-command-line

A merge can combine two snapshots on its own when the two sides edited different lines, or different files. Git applies both edits and writes the merge commit. A conflict is the case it will not guess: both sides changed the same lines since the common ancestor, or one side deleted a file the other side edited. Git stops in the middle of the merge and leaves the decision in the file, because the correct result is a product decision, not a text decision. Shipping either side unchanged can drop a line that existed only on the other side.

The file is marked like this when `feature/dark` is merged into `main` and both sides edited `theme.css`:

```text
<<<<<<< HEAD
color: blue
size: 14
font: serif
=======
color: black
size: 12
>>>>>>> feature/dark
```

The text between `<<<<<<< HEAD` and `=======` is the branch you have checked out, called ours. The text between `=======` and `>>>>>>> feature/dark` is the branch you are merging in, called theirs. The labels are about the direction of the merge, not about who is right. If you had switched to `feature/dark` and merged `main` in, the two sides would swap, because `HEAD` would be the feature.

The ancestor is not printed in the markers. Ours has a font line and a larger size because `main` added them. Theirs changed the color and still has the old size because the feature never saw the font commit. A correct result can take the color from theirs and the size and font from ours:

```text
color: black
size: 14
font: serif
```

None of the marker lines may remain. A file that still contains `<<<<<<<` is not a resolved file, and a later checkout will show those markers to a user. `git status` lists the path as both modified until you `git add` it. The add means "the index now holds the resolution", not "I accept one side". `git commit` then finishes the merge. Git already has a message ready, so `--no-edit` keeps it. The commit has two parents, because a conflict does not change what a merge is. It only pauses it.

`git checkout --ours path` and `git checkout --theirs path` replace the whole file with one side. That is the right move when one side really is the whole answer. It is the wrong move when the other side added a line you still need, because the whole-file checkout throws that line away with the rest of the side you rejected. In the theme file, `--theirs` keeps `color: black` and loses `font: serif`. `--ours` keeps the font and loses the black.

`git merge --abort` returns the branch to the commit you were on before the merge and throws away the in-progress index. Use it when the resolution is a mess and you want to start the merge again. It does not undo commits that were already there.

### Finishing the theme file

After `git merge feature/dark` stops, `git status` lists `theme.css` as both modified, and `.git/MERGE_HEAD` exists, which is how Git remembers that a merge is in progress. The index holds more than one stage for that path: stage 1 is the common ancestor, stage 2 is ours, stage 3 is theirs. `git show :2:theme.css` is the `HEAD` version, with the font line. `git show :3:theme.css` is the feature version, with the black color and the old size. The worktree file is the marked-up mix.

You replace that file with the three lines you actually want, and you search it for `<<<<<<<` before you go on. `git add theme.css` copies your bytes into the index as a normal stage-0 blob and clears the unmerged stages. `git status` no longer lists the path as unmerged. `git commit --no-edit` writes the merge commit. Its first parent is the `main` tip you were on. Its second parent is `feature/dark`. `MERGE_HEAD` is gone, because the merge is no longer in progress. If you had run `git checkout --theirs theme.css` instead of editing, the add would have succeeded and the font line would already be gone. The absence of markers is not evidence that both sides survived. The evidence is the file.

### Where this breaks

**Leaving a marker in the file and committing.** Git will let you commit a file full of markers once it is staged. The markers are ordinary text after you decide the index is right. Search the file for `<<<<<<<` before you add it.

**Resolving the wrong branch's idea of ours.** Ours is `HEAD`, the branch you are sitting on. People remember "ours means my feature" and then take the wrong half because they merged in the other direction.

**A whole-file checkout that looks successful.** The conflict markers disappear, `git add` works, and the merge commits. The unique line from the other side is gone. Read the result against both parents, not only against the markers.

### How this is used at work

Conflicts cluster on files several people edit: generated lockfiles, a shared config, a changelog. The way to have fewer of them is to merge `main` into the branch often, so each conflict is the last day's edits. When one does happen, the person who understands the change resolves it. A mechanical "take theirs" on a lockfile is sometimes correct, because the file is generated and you will regenerate it. The same command on a config file drops a setting. The file type decides, not the habit.

### Which command

| You want | Command | Why |
|---|---|---|
| See conflicted paths | `git status` | Lists them as both modified |
| Take one whole file | `git checkout --ours path` or `--theirs` | Replaces the file, including lines that did not conflict |
| Keep a mix | edit the file, delete the markers | The index is updated only when you `git add` |
| Mark one file resolved | `git add path` | Clears the unmerged state for that path |
| Finish | `git commit --no-edit` | Writes the merge commit with two parents |
| Give up and go back | `git merge --abort` | Restores the pre-merge `HEAD` |

Renames collide in a way the markers make easy to miss. One side edits a file and the other side deletes it, or both sides rename it to different paths. Git stops and asks which name should survive. `git status` shows the delete/modify or the rename instead of a tidy "both modified". Taking theirs or ours is still a whole-file decision. For a delete/modify, keeping the file means the edit mattered more than the deletion, and removing it means the deletion was the decision. Write that down in the merge message if the default message only says "Merge branch", because six months later the log will not show which idea you kept.

### You can now

- Point at ours and theirs in a conflict marker, and say which one is `HEAD`.
- Build a result that keeps a line from each side, with no marker lines left.
- Explain why `--theirs` on the whole file drops additions that were only on ours.
- Abort a merge you do not want to finish.

::: quiz
q: In a conflict block, which part is the branch you're merging **in**?
- Between `<<<<<<< HEAD` and `=======`
+ Between `=======` and `>>>>>>> branch-name`
- Both parts are the same branch
- Neither; the incoming change is in a separate file
why: `HEAD` is where you are. The incoming branch's version comes after the `=======`, labelled with its name.
:::

::: shell git
task: Merge `feature/retry` into `main`. It conflicts. The right result keeps **both** ideas: `retries: 5` from the feature, and `backoff: exponential` from main. Make `config.yml` exactly the three lines below, then finish the merge.

```text
timeout: 30
retries: 5
backoff: exponential
```
setup:
```bash
git init -q
printf "timeout: 30\nretries: 3\n" > config.yml
git add . && git commit -qm "Base config"
git switch -qc feature/retry
printf "timeout: 30\nretries: 5\n" > config.yml && git commit -qam "More retries"
git switch -q main
printf "timeout: 30\nretries: 3\nbackoff: exponential\n" > config.yml && git commit -qam "Exponential backoff"
```
verify:
```bash
[ -z "$(git diff --name-only --diff-filter=U)" ] || { echo "there are still unresolved files"; exit 1; }
[ ! -f .git/MERGE_HEAD ] || { echo "the merge isn't finished: add the file and commit"; exit 1; }
[ "$(git show HEAD:config.yml)" = "$(printf 'timeout: 30\nretries: 5\nbackoff: exponential')" ] || { echo "the committed config.yml isn't the three lines asked for"; exit 1; }
[ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" = "3" ] || { echo "the last commit should be the merge commit (two parents)"; exit 1; }
```
solution:
```bash
git merge feature/retry
printf "timeout: 30\nretries: 5\nbackoff: exponential\n" > config.yml
git add config.yml
git commit --no-edit
```
hint: Run `git merge feature/retry`, then write the file's final content (an editor isn't available here; `printf` with `\n` or a heredoc works), `git add config.yml`, and `git commit --no-edit`.
:::

::: quiz
q: During a merge, `git checkout --theirs path` replaces the whole file. When is that the wrong resolution?
- When you want the incoming branch's version of every line
+ When the other side added a line that the incoming file does not have, because the checkout throws that line away
- When the file has conflict markers, because `--theirs` refuses to run until the markers are gone
- When the merge has two parents, because `--theirs` only works on a fast-forward
why: `--theirs` is the branch being merged in, and it replaces the path. Lines that exist only on `HEAD` are not in that blob, so they disappear. That is correct only when you really want the incoming file unchanged.
:::

::: card
q: You started a merge, the markers are a mess, and you want the branch back to the commit from before `git merge`. What do you run?
answer: `git merge --abort`. It drops the in-progress merge and checks out the commit you were on. It does not delete commits that were already on the branch.
:::

::: shell git
task: Merge `feature/season` into `main`. Keep `title: Summer` from the feature and `region: east` from main. `plan.txt` in the merge commit must be exactly the two lines below, markers included nowhere. Finish the merge.

```text
title: Summer
region: east
```
setup:
```bash
git init -q
printf '%s\n' 'title: Spring' > plan.txt
git add . && git commit -qm Base
git switch -qc feature/season
printf '%s\n' 'title: Summer' > plan.txt && git commit -qam "Summer title"
git switch -q main
printf '%s\n' 'title: Spring' 'region: east' > plan.txt && git commit -qam "Eastern region"
```
verify:
```bash
# wrong answer tested: git checkout --theirs plan.txt
# which keeps "title: Summer" and drops "region: east".
# git checkout --ours keeps "region: east" and leaves "title: Spring".
set -euo pipefail
[ -z "$(git diff --name-only --diff-filter=U)" ]
[ ! -f .git/MERGE_HEAD ]
[ "$(git show HEAD:plan.txt)" = "$(printf '%s\n' 'title: Summer' 'region: east')" ]
[ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" = "3" ]
```
solution:
```bash
git merge feature/season
printf '%s\n' 'title: Summer' 'region: east' > plan.txt
git add plan.txt
git commit --no-edit
```
hint: Merge, then write the two lines you want. `--theirs` is only the title. `--ours` is the old title plus the region. Add the file and commit so the merge has two parents.
:::

## Rebase and squash
id: rebase
stage: team
needs: conflicts
minutes: 45
goal: Replay commits onto a new base, and fold commits with an interactive rebase, without rewriting shared history.
source: Pro Git: Rebasing | https://git-scm.com/book/en/v2/Git-Branching-Rebasing
source: git-rebase | https://git-scm.com/docs/git-rebase

A feature branch started from yesterday's `main`. `main` has since gained a commit. A merge would join the two tips with a merge commit, which is honest and is also noisy when the branch only has two commits of its own. Rebase is the other join. `git rebase main`, while you are on the feature, takes the commits that are on the feature and not on `main`, and makes new commits with the same changes and messages whose parent is the new tip of `main`. The feature name moves to the last of those new commits. The old commits are still in the object store until nothing can reach them. The hashes are new, because a commit's hash includes its parent, and the parent changed.

```text
before                              after git rebase main

  base <- warehouse     main          base <- warehouse <- note <- extend
       ^                                              ^
       note <- extend   feature                              feature
```

The files from both sides are in the new tip. `git rev-list --merges --count` stays 0, because no commit has two parents. A later fast-forward can move `main` up to the feature, and the published history is a straight line.

Rebase stops if one of the replayed commits edits a line `main` also edited. The markers are the same ones a merge uses. You fix the file, `git add` it, and `git rebase --continue`. `git rebase --abort` goes back to the branch tip from before the rebase. The conflict is not a reason to switch to a merge in the middle. Abort, or finish the replay.

### Interactive rebase

`git rebase -i HEAD~2` opens a todo list of the last two commits, oldest first. Each line starts with a verb. `pick` keeps the commit. `reword` keeps the changes and lets you edit the message. `squash` folds the commit into the previous one and keeps both messages for you to edit. `fixup` folds the commit into the previous one and throws away this commit's message. `drop` deletes the commit from the replay. `edit` stops after applying the commit so you can change the tree.

There is no terminal editor in this course. `GIT_SEQUENCE_EDITOR` is the program that rewrites the todo file, and `GIT_EDITOR` is the program that rewrites the message file. `sed -i '' '2s/^pick/fixup/'` changes the second line from `pick` to `fixup`. `GIT_EDITOR=true` saves the message file without changing it. A fixup done that way leaves a single commit whose subject is the first commit's subject, and the second message is gone. A squash done the same way also keeps the first subject, because the subject is the first line of the message file, and the second commit's message stays in the body under that subject. The combined message file looks like this before the editor runs:

```text
# This is a combination of 2 commits.
# This is the 1st commit message:

Write the summary

# This is the commit message #2:

Mention the tax
```

Lines that begin with `#` are comments and are stripped. What remains is the first subject, a blank line, and the second message. `--format=%s` prints only the subject, so it prints `Write the summary` even though the body still has `Mention the tax`. If you wanted one sentence, you would delete the second message in the editor. `true` does not delete it.

### Why the hash has to change

A commit object hashes its parent id together with the tree and the message. The feature commit whose parent was yesterday's `main` cannot keep that id once its parent is today's `main`, even if you copied the message and the tree ended up identical. `git range-diff` can show you that the old and new patches correspond. The ids will not. Anyone who wrote down the old id, a CI link, a comment, a tag, is holding a name for a commit your branch no longer points at. That is harmless when the old id was never pushed. It is a break when it was.

The todo list for an interactive rebase is applied from top to bottom, and the top is the older commit. Squash and fixup say "I am not a commit of my own; fold me into the commit above me in this list." The first line has nothing above it, so it stays `pick`. Changing the second line is the whole edit. Leaving the message file untouched on a squash keeps every non-comment line, which is why the second subject survives in the body. Fixup never puts that second subject into the file.

### Where this breaks

**Rebasing commits other people have.** The replay writes new hashes. Anyone who built on the old hashes now has a history your branch does not contain. The next push is rejected, and a force-push replaces their work with yours. Rebase the commits that are still only on your machine. Once a commit is on `main`, or on a branch a teammate has pulled, undo it with `git revert` instead.

**Squashing the wrong line.** The todo list is oldest first. Line 1 is the first of the two commits. Changing line 1 to `squash` is an error, because squash folds into the previous commit and there is no previous commit in the list. Change the later line.

**A rebase of `main` onto a feature.** You replay shared history. The same force-push problem follows. Check out the feature and rebase it onto `main`, so `main`'s hashes stay put.

### How this is used at work

Many teams rebase a feature onto `main` just before opening or updating a pull request, so the diff is only the feature's changes against current `main`. They squash the "fix typo" and "really fix typo" commits so the review is one change. The hosting site can do the squash at merge time instead, which leaves the branch's small commits intact until the merge and writes one commit on `main`. Either policy is coherent. Mixing them, rebasing a branch someone else is also committing to, is how you lose an afternoon.

### Which command

| You want | Command | Why |
|---|---|---|
| Replay this branch onto `main` | `git rebase main` | New commits, new hashes, no merge commit |
| Stop and go back | `git rebase --abort` | Restores the pre-rebase tip |
| Fold the last two commits, keep both messages | `squash` on the later todo line | Subject stays the earlier subject unless you edit it |
| Fold and drop the later message | `fixup` on the later todo line | The earlier message is the whole message |
| Rewrite a shared commit | do not | Use `git revert` so other clones still apply |

### You can now

- Explain why rebased commits have new hashes even when the diff looks the same.
- Replay a feature onto `main` and recognise a straight history by the absence of a merge commit.
- Say what `pick`, `squash`, `fixup`, `reword`, and `drop` do in the todo list.
- Refuse to rebase a commit that other people already have.

::: quiz
q: Your feature branch has two commits, and you have already pushed it. A teammate has pulled it and committed on top. How do you take in the latest `main`?
- `git rebase main`, then `git push --force`, so their history matches yours
+ Merge `main` into the feature, or ask them before any rebase. Rebase would rewrite commits they already have
- `git reset --hard main`, because the feature commits can be recreated from the diff
- Delete the remote branch. Their commits will follow `main` automatically
why: Rebase writes new hashes for the commits you replay. Their new commit's parent is one of the old hashes, so a force-push leaves them with work your branch no longer contains. A merge adds a join and leaves their parent pointers valid.
:::

::: card
q: In an interactive rebase todo list, what is the difference between `squash` and `fixup` on the second commit?
answer: Both fold the second commit's changes into the first. `squash` keeps the second message so you can combine the two messages. `fixup` drops the second message and keeps the first.
:::

::: predict lang=shell
q: What does `git log --format=%s` print after the rebase?
code:
```bash
git init -q
echo base > app.txt && git add . && git commit -qm base
git switch -c feature/fee
echo fee > fee.txt && git add . && git commit -qm "add fee"
echo more >> fee.txt && git commit -qam "extend fee"
git switch main
echo moved > extra.txt && git add . && git commit -qm "main moves"
git switch feature/fee
git rebase -q main
git log --format=%s
```
answer:
```
extend fee
add fee
main moves
base
```
why: The feature's two commits are replayed on top of `main moves`. Newest is `extend fee`. There is no merge subject, because rebase does not write a commit with two parents. The old feature commits, whose parent was `base`, are no longer on this branch.
:::

::: shell git
task: You are on `feature/shipping`. `main` has moved. Replay your branch onto `main` so the history is a straight line: `Extend the shipping note`, then `Add the shipping note`, then `Record the warehouse`, then `base`. Stay on `feature/shipping`. No merge commit. `ship.txt` and `extra.txt` should both be in `HEAD`.
setup:
```bash
git init -q
echo base > app.txt && git add . && git commit -qm base
git switch -q -c feature/shipping
echo note > ship.txt && git add . && git commit -qm "Add the shipping note"
echo more >> ship.txt && git commit -qam "Extend the shipping note"
git switch -q main
echo moved > extra.txt && git add . && git commit -qm "Record the warehouse"
git switch -q feature/shipping
```
verify:
```bash
# wrong answer tested: git merge main
# which writes a merge commit, so rev-list --merges is 1 and the first subject is a merge message.
set -euo pipefail
[ "$(git branch --show-current)" = "feature/shipping" ]
[ "$(git log --format=%s | tr '\n' '|')" = "Extend the shipping note|Add the shipping note|Record the warehouse|base|" ]
[ "$(git rev-list --merges --count HEAD)" = "0" ]
git cat-file -e HEAD:ship.txt
git cat-file -e HEAD:extra.txt
```
solution:
```bash
git rebase main
```
hint: While you are on the feature, `git rebase main` replays the feature commits onto `main`. `git merge main` joins with a merge commit instead.
:::

::: shell git
task: Squash the last two commits into one. Leave the message file untouched. The subject of `HEAD` should stay `Draft the notice`, and the body should still contain the line `Add the date`. `notice.txt` and `date.txt` should both be in that commit. The history should have two commits, not three.
setup:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm base
echo b > notice.txt && git add . && git commit -qm "Draft the notice"
echo c > date.txt && git add . && git commit -qm "Add the date"
```
verify:
```bash
# wrong answer tested: leaving both commits (count is 3, subject is "Add the date").
# fixup instead of squash drops "Add the date" from the body.
set -euo pipefail
[ "$(git rev-list --count HEAD)" = "2" ]
[ "$(git log -1 --format=%s)" = "Draft the notice" ]
git log -1 --format=%B | grep -qx "Add the date"
git cat-file -e HEAD:notice.txt
git cat-file -e HEAD:date.txt
```
solution:
```bash
GIT_SEQUENCE_EDITOR="sed -i '' '2s/^pick/squash/'" GIT_EDITOR=true git rebase -i HEAD~2
```
hint: The todo list is oldest first, so the second line is `Add the date`. Change that `pick` to `squash`. `GIT_EDITOR=true` saves the combined message unchanged, which keeps the first subject and the second message in the body. `fixup` would drop the second message.
:::

## Cherry-pick
id: cherry-pick
stage: team
needs: rebase
minutes: 30
goal: Copy one commit onto the branch you are on, and leave the rest of the other branch behind.
source: git-cherry-pick | https://git-scm.com/docs/git-cherry-pick

A spike branch has two commits. The second one fixes a header that production needs today. The first one is an experiment that should not land. Merging the branch would bring both, because a merge joins whole histories. Rebasing the branch onto `main` would also replay both. You want the second snapshot's change, on `main`, and you do not want the first commit's files.

`git cherry-pick <commit>` while you are on `main` does that. Git looks at the diff between that commit and its parent, applies that diff to your current tip, and writes a new commit. The message defaults to the original message. The hash is new, because the parent is your tip, not the original parent. The branch you copied from does not move. Naming a branch, as in `git cherry-pick feature/extra`, picks that branch's tip commit and no other. It does not mean "take the branch". The earlier commits stay where they are, which is why their files are absent from `main` unless the tip's own diff created them.

If the tip only adds `footer.txt`, `main` gains `footer.txt` and does not gain a file that was added in the parent commit and left untouched by the tip. That is the usual reason to cherry-pick rather than merge. If the tip also modifies a file the parent introduced, the apply has to find the same context on `main`. When the context is not there, cherry-pick stops with the same conflict markers as a merge. You edit the file, `git add` it, and `git cherry-pick --continue`. `git cherry-pick --abort` returns you to the tip from before the pick.

### A header fix that cannot wait for the spike

`fix/header` has two commits. The first replaces the layout with an experiment. The second changes one string in `header.py` and does not touch the layout file. Production needs the string today. It does not need the experiment. You check out the release branch, which does not contain either commit, and you cherry-pick the second hash. Git diffs that commit against its parent, sees the string change, applies it to the release tip, and writes a new commit with the same message and a new hash. `header.py` on the release branch has the new string. The layout file is absent, because the commit you picked did not add it. `fix/header` still points at the experiment. Nothing on that branch moved.

You push the release branch. The deploy builds that commit. Next week the spike merges into `main` and the original string-change commit comes with it. The release branch already has a different commit with the same diff. The person merging should expect Git to notice the overlapping lines. Sometimes the merge is clean because the result matches. Sometimes it conflicts because the surrounding lines drifted. Either way the string was not lost on the day you needed it, and the experiment did not ship on that day. Merging `fix/header` into the release branch would have done the opposite: both commits, the same afternoon.

If the string change had called a function that only exists in the experiment commit, the picked diff would still apply and the release branch would not build. Cherry-pick does not walk the parents looking for dependencies. You read the diff before you pick, and you build after.

### Where this breaks

**Picking a commit whose parent is not in your history, when the diff needs that parent's lines.** The change may not apply, or it may apply and be wrong because a helper the change calls was introduced in a commit you did not pick. Cherry-pick copies a diff. It does not copy the commits that diff assumes. Read the resulting tree, not only the message.

**Using cherry-pick as a way to land a whole branch.** You will miss a commit, or you will copy them one by one and create a second history of the same work. A branch that should land as a unit should be merged or rebased.

**Duplicating a commit that will also be merged later.** The same change arrives twice. A later merge can conflict on lines that are already identical in intent, or it can look like the change was reverted and reapplied. Cherry-pick a commit that will not also arrive through a merge, or expect to skip the duplicate when it does.

### How this is used at work

A hotfix is the normal use. `main` has moved on, the fix is sitting in the middle of a feature branch, and releasing the feature is not acceptable. You cherry-pick the fix commit onto a release branch and ship that. The feature branch keeps the original commit, so the fix is not lost when the feature later merges. The release branch has a new hash with the same message, which is what you quote in the incident notes.

### Which command

| You want | Command | Why |
|---|---|---|
| Copy one commit onto `HEAD` | `git cherry-pick <commit>` | Applies that commit's diff and writes a new hash |
| Copy only the tip of a branch | `git cherry-pick branch-name` | A branch name means its tip, not every commit on it |
| Bring a whole branch | `git merge` or `git rebase` | Cherry-pick is one commit at a time |
| Give up in the middle | `git cherry-pick --abort` | Restores the pre-pick tip |

You can pass several commits, oldest first, and Git picks them in that order onto `HEAD`. The order matters because the second diff is applied to the result of the first, not to the original branch. Skipping the middle commit of a three-commit series is how you discover the third commit's diff assumed the middle one. The apply fails, or it succeeds and the function it calls is missing. `-x` appends a line naming the source hash, which is worth having on a release branch so the log says where the copy came from. The new commit's own hash is still new. The line is only a comment in the message. It does not make the two commits the same object. If you need the source commit itself on this branch, you wanted a merge or a rebase, not a copy.

Cherry-pick stops on an empty result when the diff is already in your tree, unless you pass a flag that allows an empty commit. That stop is useful. It means the release branch already contains the change, often because someone picked it last week, and a second copy would be the duplicate you were trying to avoid. Read the message and skip that commit rather than forcing an empty one onto the release.

### You can now

- Explain why the cherry-picked commit has a new hash and the same message.
- Pick the tip of a branch without taking the earlier commits on that branch.
- Say when a merge is the wrong tool because it would bring those earlier commits too.

::: quiz
q: `feature/extra` has two commits. The first adds `banner.txt`. The second adds `footer.txt` and does not touch `banner.txt`. You are on `main` and run `git cherry-pick feature/extra`. What lands on `main`?
- Both files, because a branch name means the whole branch
+ `footer.txt` only. A branch name picks that branch's tip commit, and the tip did not add `banner.txt`
- Nothing, until you push `feature/extra`
- A merge commit with two parents
why: Cherry-pick applies one commit's diff against its parent. The tip's diff is the footer file. The banner was added by the parent commit, which this command does not pick. `git merge feature/extra` is what would bring both.
:::

::: card
q: Why does a cherry-picked commit not keep the original hash?
answer: The hash covers the parent, the tree, the message, and the author. The parent is the tip you picked onto, which is a different parent, so the hash is different even when the message and the diff match the original.
:::

::: shell git
task: `feature/extra` has two commits. Copy only the tip onto `main`, so `HEAD`'s subject is `add footer`, `c.txt` is in `HEAD`, and `b.txt` is not. Stay on `main`. `main` should have two commits.
setup:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm start
git switch -q -c feature/extra
echo b > b.txt && git add . && git commit -qm "add banner"
echo c > c.txt && git add . && git commit -qm "add footer"
git switch -q main
```
verify:
```bash
# wrong answer tested: git merge feature/extra
# which brings b.txt as well as c.txt and writes a fast-forward or a merge of both commits.
set -euo pipefail
[ "$(git branch --show-current)" = "main" ]
[ "$(git log -1 --format=%s)" = "add footer" ]
[ "$(git rev-list --count HEAD)" = "2" ]
git cat-file -e HEAD:c.txt
if git cat-file -e HEAD:b.txt 2>/dev/null; then
  echo "b.txt came along; that is a merge of the branch, not a pick of the tip" >&2
  exit 1
fi
```
solution:
```bash
git cherry-pick feature/extra
```
hint: On `main`, `git cherry-pick feature/extra` applies the tip commit only. `git merge feature/extra` takes the banner commit too, because the banner is in the feature's history.
:::

::: predict lang=shell
q: What does `git log --format=%s` print? The cherry-pick's own progress is discarded.
code:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm start
git switch -c feature/extra
echo b > b.txt && git add . && git commit -qm "add banner"
echo c > c.txt && git add . && git commit -qm "add footer"
git switch main
git cherry-pick feature/extra >/dev/null
git log --format=%s
```
answer:
```
add footer
start
```
why: The tip of `feature/extra` is `add footer`. Cherry-pick copies that commit onto `main` and does not copy `add banner`, so the banner subject is not on `main`. `start` is the parent of the new commit.
:::

::: quiz
q: You cherry-picked a hotfix onto the release branch. The same commit is still on the feature branch, and the feature will be merged next week. What should you expect?
- The merge will delete the hotfix, because cherry-pick moves the commit off the feature
+ The feature still has the original commit. The merge may see the same change twice and conflict, or it may already be applied
- The release hash changes again when the feature merges
- Cherry-pick removed the commit from the feature, so the merge cannot see it
why: Cherry-pick copies. The source branch does not move, so the original commit is still there to be merged. The release branch has a different hash with the same change. A later merge is combining those two histories.
:::

## Undoing things
id: undo
stage: team
needs: branches
minutes: 45
goal: Pick the right undo for the situation, and never rewrite history other people already have.
source: Pro Git: Undoing things | https://git-scm.com/book/en/v2/Git-Basics-Undoing-Things
source: Atlassian: Resetting, checking out and reverting | https://www.atlassian.com/git/tutorials/resetting-checking-out-and-reverting
source: git reflog | https://git-scm.com/docs/git-reflog

Undoing is three different operations, and they are easy to mix up because all three can make a file look the way it did before. They differ in what they do to commits other people might already have.

If the edit is not committed, `git restore path` replaces the worktree file with the index version, which throws the edit away. `git restore --staged path` copies `HEAD`'s version back into the index and leaves the worktree edit alone, so the next commit will not include it. Nothing in the history changes, because there was no commit yet.

If the last commit is still only on your machine, `git commit --amend` replaces that commit. You stage the correction first. Amend writes a new commit with the same parent and, if you pass `--no-edit`, the same message, then moves the branch to the new commit. The previous tip is no longer on the branch. That is safe when you have not pushed it. It is not safe when someone has pulled it, because their history still points at the commit you just abandoned, and your next push will be rejected unless you force it.

`trace.log` got into that unpushed tip next to a real code change. Amend is the right fix. `git rm --cached trace.log` takes the log out of the index and leaves the file on disk. A `*.log` line in `.gitignore`, staged as well, keeps the next `git add` from putting it back. `git commit --amend --no-edit` rewrites the tip. The history still has the same number of commits. The message is unchanged. The log is not in the new tip. It is still in the abandoned commit, which is why a secret that was pushed is not fixed by amend. You rotate the secret. The old object is still reachable from anyone who fetched it.

`git reset` moves the branch pointer. `git reset HEAD~1` (mixed, the default) moves the branch back one commit and leaves the undone commit's changes in the worktree, unstaged. `--soft` moves the pointer and leaves the changes staged. `--hard` moves the pointer and makes the worktree match, which deletes the uncommitted work and the commit's files from disk. `--hard` is the one that destroys work you have not stashed and have not pushed. On a shared branch it is the one that requires a force-push if you want the remote to follow you. Do not do that to `main`.

`git revert <commit>` is the undo for a commit that is already public. It writes a new commit whose diff is the opposite of the named commit. The bad commit stays in the log. The branch moves forward. Everyone who already pulled can pull the revert as an ordinary fast-forward. `git revert --no-edit HEAD` uses the default message, `Revert "<subject>"`. The original subject is still in `git log`, one line down. Reset would have removed it from the branch. Revert does not.

### The reflog

Amend, reset, and rebase move labels. They do not immediately delete objects. `git reflog` lists where `HEAD` has been, including commits no branch points at now. After `git reset --hard HEAD~1`, the commit you just left is the previous reflog entry. You point the branch back at that entry, or at the hash printed next to it, with another `git reset --hard`. The default retention is on the order of 90 days. A commit that fell off the reflog and is unreachable can be garbage-collected, so the reflog is a recovery tool with a clock on it, not an archive.

```text
HEAD@{0}  reset: moving to HEAD~1      <- you are here
HEAD@{1}  commit: Rename the queue     <- the commit the reset left
HEAD@{2}  commit (initial): Start
```

In that picture the dropped commit is `HEAD@{2}` only if you have made another move since the reset. Right after the reset, it is the previous entry. Read the reflog before you type the number. The message on the entry tells you which one you dropped.

### Two undoes that look the same in the file

The tip sets a timeout to 1 so you can reproduce a bug, and you have not pushed. `git reset HEAD~1` moves the branch back and leaves the timeout edit in the worktree, so you can throw the line away or commit it differently. `git revert HEAD` would also put the timeout back to the old value, and it would add a second commit to do it. On an unpushed tip that extra commit is noise, so reset or amend is the better tool. The same timeout, already on `main` and already deployed, is the opposite case. Reset would require a force-push to update the remote, and every clone that pulled the bad tip would diverge. Revert adds the undo as a commit they can pull.

The reflog is what you read when the reset was the wrong one. The entry above the reset line is where `HEAD` was. Resetting back there returns the same object, not a reconstruction. If the afternoon has included other checkouts since, count the entries instead of assuming the number is 1.

### Where this breaks

**Amend or reset of a published commit, then force-push.** Other clones still have the old tip. Their next push is rejected, or your force-push discards commits they had added. Revert instead.

**`git reset --hard` to undo a revert.** You drop the revert and the bug is back, and you have rewritten again. If the revert was wrong, revert the revert. That is a new commit that puts the change back and leaves both attempts in the log.

**Believing amend erases a secret.** The old commit remains in the reflog locally and in every clone that fetched it. Rotation is what stops the key from working. History editing is a separate, deliberate project, done with the team, not with a quiet amend.

### How this is used at work

A broken deploy that is already on `main` gets a revert commit and a normal pull request. The incident notes name both hashes: the one that broke, and the one that reverted it. A commit you have not pushed, with a typo in the message or a log file in the tree, gets an amend before anyone else sees it. A reset `--hard` you did not mean gets a reflog recovery the same afternoon, while the entry is still there.

### Which command

| You want | Command | Why |
|---|---|---|
| Throw away an uncommitted edit | `git restore path` | The worktree file goes back to the index |
| Unstage, keep the edit | `git restore --staged path` | The index goes back to `HEAD` |
| Rewrite the unpushed tip | `git commit --amend` | New hash, same parent, branch moves |
| Move the branch back, keep the edits unstaged | `git reset HEAD~1` | Mixed reset |
| Move back and discard the edits | `git reset --hard HEAD~1` | Destroys uncommitted work |
| Undo a public commit | `git revert <commit>` | New commit, old commit stays in the log |
| Find a commit you reset away | `git reflog` | Recent positions of `HEAD`, including abandoned tips |

### You can now

- Choose amend, reset, or revert from whether the commit has been shared.
- Take a file out of the latest unpushed commit without adding a third commit.
- Revert `HEAD` and show that the bad subject is still in the log.
- Recover a commit you dropped with `git reset --hard` while it is still in the reflog.

::: quiz
q: A commit on `main` that the whole team has already pulled introduced a bug. How do you undo it?
- `git reset --hard HEAD~1` and `git push --force`
+ `git revert <hash>` and push the new commit
- `git commit --amend`
- Delete the branch and recreate it
why: `revert` adds a commit that undoes the change, so nobody's history is rewritten. Reset and force-push would break everyone who already has the commit.
:::

::: shell git
task: Your last commit accidentally included `debug.log`. It's not pushed. Take `debug.log` out of that commit (keep the file on disk), add `*.log` to `.gitignore`, and keep the commit message `Add payment retry`. The history should still have **two** commits.
setup:
```bash
git init -q
echo "x" > app.py && git add . && git commit -qm "Start"
echo "retry()" >> app.py
echo "lots of noise" > debug.log
git add . && git commit -qm "Add payment retry"
```
verify:
```bash
[ "$(git rev-list --count HEAD)" = "2" ] || { echo "there should still be exactly two commits (amend, don't add a third)"; exit 1; }
! git cat-file -e HEAD:debug.log 2>/dev/null || { echo "debug.log is still in the last commit"; exit 1; }
[ -f debug.log ] || { echo "debug.log should still be on disk"; exit 1; }
git cat-file -e HEAD:.gitignore 2>/dev/null && git show HEAD:.gitignore | grep -qx '\*.log' || { echo "the last commit should include a .gitignore with *.log"; exit 1; }
[ "$(git log -1 --format=%s)" = "Add payment retry" ] || { echo "the message should stay 'Add payment retry'"; exit 1; }
git show HEAD:app.py | grep -q "retry()" || { echo "the app.py change should still be in the commit"; exit 1; }
```
solution:
```bash
git rm --cached debug.log
echo "*.log" > .gitignore
git add .gitignore
git commit --amend --no-edit
```
hint: `git rm --cached FILE` unstages a file's removal while leaving it on disk. Stage `.gitignore`, then `git commit --amend --no-edit` rewrites the last commit with the same message.
:::

::: shell git
task: The latest commit, subject `Charge the fee`, set `rates.txt` to `fee: 9`. It is already on the branch everyone has. Add a revert of `HEAD`. Do not remove `Charge the fee` from the log. Afterwards `rates.txt` in `HEAD` should be `fee: 5`, the newest subject should be `Revert "Charge the fee"`, and the history should have three commits.
setup:
```bash
git init -q
echo 'fee: 5' > rates.txt && git add . && git commit -qm Start
echo 'fee: 9' > rates.txt && git add . && git commit -qm "Charge the fee"
```
verify:
```bash
# wrong answer tested: git reset --hard HEAD~1
# which restores fee: 5 but drops "Charge the fee" from the branch (count is 1).
set -euo pipefail
[ "$(git rev-list --count HEAD)" = "3" ]
[ "$(git log -1 --format=%s)" = 'Revert "Charge the fee"' ]
git log --format=%s | grep -qx "Charge the fee"
git show HEAD:rates.txt | grep -qx 'fee: 5'
```
solution:
```bash
git revert --no-edit HEAD
```
hint: `git revert --no-edit HEAD` writes a new commit that undoes the tip and leaves the bad commit in `git log`. `git reset --hard HEAD~1` moves the branch back so the bad commit is no longer on it.
:::

::: quiz
q: You ran `git reset --hard` and the commit is no longer on the branch. `git reflog` still lists it. What is true?
- The commit is deleted, and the reflog is only a text log of messages
+ The commit object is still in the repository. Pointing the branch at that reflog entry puts it back
- `git revert` is the only way to see the files again
- The remote was updated by the reset, so you must force-push before you can recover
why: Reset moves a label. The object remains until it is unreachable and garbage-collected. The reflog is a label for recent `HEAD` positions, so a reset to that entry moves the branch back onto the commit. A local reset does not update the remote.
:::

::: shell git
task: A hard reset dropped the commit `Add receipt` off the branch. The file that commit added is gone from the worktree, and the task does not tell you its contents. Put that exact commit back as `HEAD`. There should be two commits, and the subject of `HEAD` should be `Add receipt`.
setup:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm Start
echo receipt > b.txt && git add . && git commit -qm "Add receipt"
git rev-parse HEAD > ../lost-hash
git reset --hard HEAD~1
```
verify:
```bash
# wrong answer tested: git commit --allow-empty -m "Add receipt"
# which invents a new commit. The hash will not match the one the reset dropped,
# because the tree is not the old tree. Also fails: staying on Start.
set -euo pipefail
[ "$(git rev-parse HEAD)" = "$(cat ../lost-hash)" ]
[ "$(git log -1 --format=%s)" = "Add receipt" ]
[ "$(git rev-list --count HEAD)" = "2" ]
```
solution:
```bash
git reset --hard 'HEAD@{1}'
```
hint: `git reflog` shows the reset as the newest entry and the dropped commit as the one before it. `git reset --hard` to that entry moves the branch back onto the same object. Quoting `HEAD@{1}` stops the shell from treating the braces as a brace expansion.
:::

## Tags and releases
id: tags
stage: team
needs: undo
minutes: 30
goal: Name a commit with an annotated tag so a release points at one snapshot.
source: Pro Git: Tagging | https://git-scm.com/book/en/v2/Git-Basics-Tagging

A branch moves. The commit you shipped on Tuesday is not the commit `main` points at on Friday, so "we deployed main" is not a name you can check out later. A tag is a name that stays on the commit you gave it, unless someone deliberately moves it. Releases, the thing a deploy system checks out, are tags.

There are two kinds. A lightweight tag is a name that points straight at a commit, the same kind of pointer as a branch except that it does not move when you commit. `git cat-file -t` on a lightweight tag prints `commit`, because the name resolves to the commit object. An annotated tag is its own object. It stores the tagger, a date, a message, and the commit it points at. `git cat-file -t` prints `tag`. `git tag -a v1.2.0 -m "release" <commit>` creates one. The message is the release note's first line, and the object is what a signed tag would sign. This course does not create a signing key. The distinction that matters here is that the annotated tag is an object with a message, and the lightweight tag is not.

`git describe --tags --exact-match <commit>` prints the tag name when that commit is the one the tag points at, and fails when it is not. Tagging `HEAD~1` and then asking about `HEAD` fails the exact match on `HEAD`, which is how you notice you tagged the changelog commit instead of the commit you meant to ship. Tags do not move when you add a commit on top. The new commit is untagged until you make a new tag.

`git push origin v1.2.0` pushes one tag. `git push origin --tags` pushes every tag in your repository, including ones you did not mean to publish. Push the tag you mean.

### From one release to the next

`v1.1.0` is an annotated tag on the commit you shipped last month. `v1.2.0` is an annotated tag on the commit you are shipping today. `git log v1.1.0..v1.2.0 --format=%s` lists the subjects reachable from the new tag and not from the old one. That is the changelog if the subjects were written as effects. It is a pile of "wip" if they were not. `git describe --tags` on a commit a few steps after `v1.2.0` prints a name that starts with `v1.2.0` and then a count of additional commits, which is how a build names itself when you have not cut the next tag yet. `--exact-match` refuses that loose name and succeeds only when the commit you named is the tagged one.

A lightweight `v1.2.0` would still make `git describe` print something. It would not give you a message, a tagger, or an object a signature can cover. The release checklist asks for `git cat-file -t v1.2.0` to print `tag` before anyone deploys it. Pushing is `git push origin v1.2.0`. The branch push that happened earlier did not move the tag, and the tag push does not move the branch. They are different refs. A deploy that checks out the tag is unaffected by a later commit on `main` until you cut `v1.2.1` and deploy that.

### Where this breaks

**Tagging the wrong commit.** `HEAD` is whatever you have checked out, which may be a docs commit you made after the release snapshot. Name the commit, or tag before you add the follow-up.

**A lightweight tag where the process asked for an annotated one.** The name exists, and `git describe` may still print it, but there is no message object and nothing for a signature to cover. `git cat-file -t` is the check. `commit` means lightweight. `tag` means annotated.

**Moving a tag that a deploy already used.** `git tag -f` and a force-push of the tag make the name point at a different snapshot. Anyone who fetched the old tag and does not update still has the old one. A release tag should be treated as immutable. If the release is wrong, make `v1.2.1`. Do not slide `v1.2.0`.

### How this is used at work

CI builds a commit. When the build is the one you will ship, you put an annotated tag on that commit and the deploy checks out the tag, not a branch. Roll back by checking out the previous tag. The changelog is `git log v1.1.0..v1.2.0 --format=%s`, the subjects of the commits reachable from the new tag and not from the old one. That range is only as good as the subjects, and it is only stable because the tags do not move.

### Which command

| You want | Command | Why |
|---|---|---|
| Annotated tag with a message | `git tag -a name -m "message" <commit>` | Creates a tag object |
| See whether it is annotated | `git cat-file -t name` | `tag` is annotated, `commit` is lightweight |
| Confirm which commit it names | `git describe --tags --exact-match <commit>` | Prints the tag only when it points at that commit |
| Publish one tag | `git push origin name` | Does not push every local tag |

Annotated tags can point at the commit you will ship even when you are not checked out on it. Passing the hash, or `HEAD~1`, is how you avoid tagging the docs commit you made afterwards. `git show v1.2.0` prints the tag message and then the commit, because the tag object points at the commit and show follows it. `git show` on a lightweight tag prints only the commit, because there is no tag object to print. That difference is the same fact as `git cat-file -t`. A release process that requires a message is asking for the annotated object, and the show output is the quick way to read the message back without remembering the for-each-ref format. If `git show` jumps straight to the diff, you created a lightweight tag and the message was never stored.

The name is just a ref under `refs/tags/`. Branches live under `refs/heads/`. Because they are different namespaces, you can have a branch and a tag with the same short name, and Git will ask which one you meant. Do not do that. A release name that is also a branch name is how a deploy script checks out the moving branch and thinks it checked out the tag. `git rev-parse v1.2.0^{}` peels the tag down to the commit it points at, which is the id you compare with the deploy.

### You can now

- Say why a release is a tag and not a branch tip.
- Create an annotated tag and prove it with `git cat-file -t`.
- Put the tag on a parent commit rather than on whatever `HEAD` happens to be.
- Explain why retagging a published version is a different snapshot under an old name.

::: quiz
q: `git cat-file -t v1.2.0` prints `commit`. What kind of tag is it?
- Annotated, because every tag has a message object
+ Lightweight. The name points directly at a commit, so the type is `commit`
- A branch, because only branches resolve to commits
- Broken, because a tag's type is always `tag`
why: An annotated tag is a tag object, so its type is `tag`. A lightweight tag is another name for the commit, so the type you get is `commit`. The type is the check that a message object exists.
:::

::: quiz
q: Production deployed the commit tagged `v1.2.0`. The release is bad. What keeps the old name honest?
- `git tag -f v1.2.0` on the fixed commit, then force-push the tag
+ Leave `v1.2.0` where it is and tag the fix `v1.2.1`
- Delete the tag. Deploys will follow `main`
- Revert the tag object. Tags cannot point at a revert
why: People and pipelines already resolved `v1.2.0` to the bad snapshot. Moving the name makes the same word mean two commits. A new tag names the fix. A revert commit can be what `v1.2.1` points at.
:::

::: card
q: What does an annotated tag store that a lightweight tag does not?
answer: Its own object: a message, a tagger, and a date, pointing at the commit. A lightweight tag is only a name for the commit. `git cat-file -t` prints `tag` for the annotated one and `commit` for the lightweight one.
:::

::: predict lang=shell
q: What does this print?
code:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm start
git tag -a v0.1.0 -m "release" HEAD
git tag v0.1.0-light HEAD
git cat-file -t v0.1.0
git cat-file -t v0.1.0-light
```
answer:
```
tag
commit
```
why: `-a -m` writes a tag object, so the type is `tag`. A tag created with only a name points at the commit, so the type is `commit`. Both names can refer to the same snapshot.
:::

::: shell git
task: The commit you are shipping is the parent of `HEAD` (subject `add notes`), not the tip. Create an annotated tag `v1.4.0` with the message `release` on that parent. The tip must not be the commit `v1.4.0` points at.
setup:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm start
echo b > b.txt && git add . && git commit -qm "add notes"
echo c > c.txt && git add . && git commit -qm "add changelog"
```
verify:
```bash
# wrong answer tested: git tag v1.4.0 HEAD~1
# which is lightweight, so git cat-file -t prints commit, not tag.
# Tagging HEAD instead of HEAD~1 fails the exact-match on the parent.
set -euo pipefail
[ "$(git cat-file -t v1.4.0)" = "tag" ]
[ "$(git describe --tags --exact-match HEAD~1)" = "v1.4.0" ]
if git describe --tags --exact-match HEAD >/dev/null 2>&1; then
  echo "v1.4.0 points at HEAD; the release commit is HEAD~1" >&2
  exit 1
fi
git for-each-ref --format='%(contents)' refs/tags/v1.4.0 | grep -qx release
```
solution:
```bash
git tag -a v1.4.0 -m "release" HEAD~1
```
hint: `-a` and `-m` make an annotated tag. Pass `HEAD~1` so the name lands on `add notes` rather than on the changelog tip. `git cat-file -t v1.4.0` should print `tag`.
:::

## Remotes
id: remotes
stage: team
needs: conflicts, undo
minutes: 40
goal: Share work through a remote, take in teammates' changes, and keep a rejected push from turning into a force-push.
source: Pro Git: Working with remotes | https://git-scm.com/book/en/v2/Git-Basics-Working-with-Remotes
source: Pro Git: Remote branches | https://git-scm.com/book/en/v2/Git-Branching-Remote-Branches

A remote is another repository, usually the one the team treats as the place a commit has to be before anyone else can see it. The conventional name for the one you cloned from is `origin`. `git clone` copies the commits and writes that name into your config, along with a remote-tracking branch. `origin/main` is not `main`, and it is not "what the server says right now". It is your local copy of where `origin`'s `main` was the last time you fetched. It moves when you fetch or push. It does not move when someone else pushes, not until you ask.

`git fetch` downloads new objects and updates those remote-tracking names. It does not change your branches and it does not change your working tree. After a fetch, `git log origin/main` shows the teammate's commits and `git log main` still shows only yours. That split is the point. You can read what arrived before you let it into the branch you are committing on.

`git pull` is a fetch followed by an integration into the current branch. The integration is a merge unless you ask for a rebase. `git pull --rebase` fetches and then replays your unpushed commits on top of the remote-tracking branch, the same replay as `git rebase`. The result has no merge commit. `git config pull.rebase true` makes that the default for pull, which is what teams choose when they want a straight history on `main`.

`git push` sends your commits and asks the remote to move its branch to your tip. The remote accepts the update when your tip contains the remote's tip, a fast-forward. It rejects the update when the remote has a commit you do not have. The message is that the remote contains work you do not have locally. Someone pushed first. The safe response is to fetch, replay or merge, and push again. `git push --force` on `main` makes the remote drop their commit. Their work is no longer on the branch. Force-push is for a branch that is yours alone, and only when you mean to replace it.

A new branch is not on the remote until you push it. `git push -u origin feature/refund` creates the branch on the remote and records the upstream, so a later `git push` on that branch knows the destination. Until that push, the remote's `main` is unchanged. Publishing a feature branch is not merging it.

### A push that is rejected, walked through

You committed `Add the coupon` on `main` and you have not pushed. A teammate pushed `Fix the title` a minute earlier. Your `origin/main` still points at yesterday, because you have not fetched. `git push` sends your commit and asks the remote to move `main` from yesterday to your tip. The remote refuses. Your tip does not contain `Fix the title`, so the move would drop it. The refusal is the remote protecting their commit.

`git fetch` moves your `origin/main` to `Fix the title` and leaves your `main` at `Add the coupon`. You can now `git log origin/main` and read their change before you touch yours. `git pull --rebase` is that fetch plus a rebase of your unpushed commit onto `origin/main`. Your `main` becomes `Add the coupon` on top of `Fix the title`. The hashes of your commit changed, because its parent changed, and theirs did not. `git push` now fast-forwards the remote. Both commits are on it. A force-push at the refusal would have moved the remote to your old tip and `Fix the title` would not be on `main` anymore. Their objects might still exist on the server for a while. The branch would not point at them, and the next deploy would not contain the title fix.

### Where this breaks

**Reading `origin/main` as if it were live.** It is as fresh as your last fetch. A decision made from a stale remote-tracking branch will miss a push that happened after that fetch.

**Pulling when you only wanted to look.** Pull merges or rebases into the branch you have checked out. If you wanted to see a teammate's commit and keep your own `main` unmoved, fetch, and read `origin/main`.

**Resetting to `origin/main` to "get unstuck".** `git reset --hard origin/main` throws away your unpushed commits. They may still be in the reflog. They will not be in the push. Take them with you by rebasing onto the fetched tip instead.

### How this is used at work

The remote is the input to CI. A push of a feature branch starts the checks. A push of `main` starts a deploy. The rejection you see when you are a few minutes behind is normal, and the habit is `git pull --rebase` then `git push`, after you have looked at what you rebased onto. A bare repository on disk, the kind the exercises use, behaves like that remote without a network. `origin` is a path. Fetch, pull, and push mean the same things they mean against a hosted repository.

### Which command

| You want | Command | Why |
|---|---|---|
| Update remote-tracking names, change nothing else | `git fetch` | `main` stays where it is |
| Fetch and replay your commits on top | `git pull --rebase` | Straight history, their commits included |
| Send commits that fast-forward the remote | `git push` | Refused when the remote has something you lack |
| Publish a new branch | `git push -u origin name` | Sets the upstream for the next push |
| Make the remote drop commits | `git push --force` | Only on a branch you alone are allowed to rewrite |

`git push -u` writes the upstream into `.git/config` as `branch.<name>.remote` and `branch.<name>.merge`. The next plain `git push` and `git pull` on that branch use those values. Without an upstream, Git does not know which remote branch you meant, and a bare `git push` on a new local branch fails until you name the destination or set the upstream. `git status` uses the same values to say "ahead by 1" or "behind by 2". Those counts compare your branch with the remote-tracking ref, so they are only as current as the last fetch. "Ahead by 1, behind by 1" means you have a commit they lack and they have a commit you lack. A push will be rejected. A pull or a rebase is the way through, not a force-push of `main`.

`git remote -v` prints the URL for fetch and the URL for push. They are usually the same. A bare path such as `../origin.git` is a URL in that list. `git remote show origin` talks to the remote and lists which branches are tracked. It is the command that tells you the remote has a branch you have never checked out. Fetch brings the objects. It still does not create a local branch until you switch to one, with the remote-tracking ref as the start point.

### You can now

- Explain `origin/main` as a local bookmark updated by fetch, not as a live view of the server.
- Fetch a teammate's commit without bringing it into your `main`.
- Take a rejected push, rebase your unpushed commits on top of theirs, and push a fast-forward.
- Say what a force-push of `main` does to the commit you do not have.

::: quiz
q: `git push` is rejected: the remote has commits you don't have. Your commits aren't pushed yet. What do you do?
- `git push --force`
+ `git pull --rebase`, fix any conflicts, then `git push`
- Delete your local repository and clone again
- `git reset --hard origin/main`
why: Rebasing your unpushed commits onto the remote's keeps both. Force-pushing would delete your teammate's work, and reset would delete yours.
:::

::: shell git
task: You cloned `origin` and committed `Add search` locally. Meanwhile a teammate pushed `Fix header` to origin. Get your commit onto origin's `main` **without** a merge commit (rebase), keeping both changes.
setup:
```bash
git init -q --bare ../origin.git
git clone -q ../origin.git ../mate 2>/dev/null
( cd ../mate && echo "v1" > app.txt && git add . && git commit -qm "Start" && git push -q origin HEAD:main )
git clone -q ../origin.git . 2>/dev/null
git switch -q main 2>/dev/null || git checkout -q main
echo "search()" > search.txt && git add . && git commit -qm "Add search"
( cd ../mate && echo "header" > header.txt && git add . && git commit -qm "Fix header" && git push -q origin HEAD:main )
```
verify:
```bash
cd ../origin.git
[ "$(git log --format=%s main | tr '\n' '|')" = "Add search|Fix header|Start|" ] || { echo "origin's main should read: Add search, Fix header, Start (it reads: $(git log --format=%s main | tr '\n' ', '))"; exit 1; }
[ "$(git rev-list --merges --count main)" = "0" ] || { echo "there's a merge commit; use git pull --rebase"; exit 1; }
```
solution:
```bash
git pull --rebase
git push
```
hint: First try `git push` and read the error. Then `git pull --rebase` and push again.
:::

::: shell git
task: You have a local commit `Add the filter` that is not on `origin`. A teammate has pushed `Fix the nav` to `origin`'s `main`. Download their commit so `origin/main` contains it. Do not merge or rebase it into your `main`, and do not check out their file. Your `main` should still be `Add the filter` then `Start`. `nav.txt` should not appear in the worktree.
setup:
```bash
git init -q --bare ../origin.git
git clone -q ../origin.git ../mate 2>/dev/null
( cd ../mate && echo v1 > app.txt && git add . && git commit -qm Start && git push -q origin HEAD:main )
git clone -q ../origin.git . 2>/dev/null
git switch -q main 2>/dev/null || git checkout -q main
echo 'filter()' > filter.txt && git add . && git commit -qm "Add the filter"
( cd ../mate && echo nav > nav.txt && git add . && git commit -qm "Fix the nav" && git push -q origin HEAD:main )
```
verify:
```bash
# wrong answer tested: git pull --rebase
# which puts "Fix the nav" under "Add the filter" on local main and checks out nav.txt.
set -euo pipefail
[ "$(git log --format=%s main | tr '\n' '|')" = "Add the filter|Start|" ]
[ "$(git log --format=%s origin/main | tr '\n' '|')" = "Fix the nav|Start|" ]
[ ! -f nav.txt ]
```
solution:
```bash
git fetch origin
```
hint: `git fetch origin` updates `origin/main` and leaves your branch and your worktree alone. `git pull` would integrate their commit into `main`.
:::

::: quiz
q: A teammate pushed an hour ago. You have not fetched since yesterday. What does your `origin/main` name?
- Their new commit, because `origin/main` is a live view of the server
+ The tip from your last fetch. Their push is not in your repository until you fetch
- Your unpushed commits, because `origin/main` follows your `main`
- Nothing. A remote-tracking name disappears when it is behind
why: `origin/main` is a local ref. Fetch, pull, and your own successful push are what move it. Another person's push does not. Reading it without fetching is reading yesterday's bookmark.
:::

::: card
q: What does `git pull` do that `git fetch` does not?
answer: Pull fetches and then integrates the remote-tracking branch into the branch you have checked out. The integration is a merge unless you use `git pull --rebase` or set `pull.rebase` to true. Fetch updates `origin/main` and leaves your branch and worktree as they were.
:::

## GitHub flow
id: github-flow
stage: team
needs: remotes
minutes: 40
goal: Ship a change as a branch pushed for review, and only then move main.
source: GitHub flow | https://docs.github.com/en/get-started/using-github/github-flow
source: GitHub: About pull requests | https://docs.github.com/en/pull-requests

`main` is the branch you are willing to deploy. A change that is still being discussed does not go straight onto it, because a push of `main` is what starts the deploy. GitHub flow is the smallest loop that keeps that true. You start from a fresh `main`, you put the change on a new branch, you push that branch, someone reviews the diff, and `main` moves only when the review is done.

The steps are the same on a hosted repository and on a bare repository you use as `origin`:

1. Update `main` so you are branching from the commit the team is actually on.
2. `git switch -c feature/refund` and commit there. The name says the change. One branch per change, because the review diff should be one idea.
3. `git push -u origin feature/refund` publishes the branch. `origin/main` does not move. The feature commit is on the remote, and it is not on `main`, which is what "open for review" means. A pull request is that branch plus a request to merge it. Opening one needs the hosting site. The exercises stop at the git part: the branch is on the remote, and `main` is not.
4. Review comments become more commits on the same branch, pushed the same way. The pull request updates because it tracks the branch, not a single commit.
5. When the review is done, merge `feature/refund` into `main` and push `main`. If `main` has not moved, the merge is a fast-forward and there is no merge commit. If the team wants a merge commit even then, they pass `--no-ff`. If they want one commit, they squash. The choice is a history choice. The safety choice is that `main` did not move before the review.

A pull request that is merged through the website does this last step for you. Locally, with a bare remote, you do it yourself: check out `main`, merge the feature, push `main`. CI in a real project is the thing that refuses the merge when the tests fail. Here the check is the graph. `main` on the remote contains the feature commit, and it does not contain a surprise merge unless you asked for one.

### One change, from a fresh main to a moved main

You fetch, fast-forward your `main` to `origin/main`, and switch to `feature/refund`. The two commits on that branch are the refund change and the test for it. You push the branch with the upstream set. On the remote, `git log main` is still the commit you branched from, and `git log feature/refund` shows your two subjects on top of it. The pull request, opened on the host, records that you want `feature/refund` merged into `main`. CI runs against the feature tip. A reviewer comments. You add a third commit on `feature/refund` and push the same branch. The pull request now shows three commits, because it follows the branch tip. `main` on the remote has still not moved, so production has still not deployed the refund.

When CI is green and the review is approved, the host merges. If you are doing that merge against a bare remote yourself, you update `main`, merge the feature, and push `main`. A fast-forward means the remote `main` log is your three subjects and then the old tip, with no merge subject in between. You delete the local feature label once `main` contains it. The remote branch can be deleted the same way, because the commits are reachable from `main`. The next change starts again at step one, from the `main` you just pushed, not from the `main` you remember from the morning.

### Where this breaks

**Pushing the feature onto `main`.** `git push origin feature/refund:main` moves the deploy branch to your unreviewed tip. The branch existing on the remote is not the same update. Look at `git log main` on the remote after you push. It should still be the old tip.

**Starting from a stale `main`.** Your branch does not contain a commit the team already shipped. The review diff is larger than your change, or you rebuild a bug they already fixed. Update `main` before you branch.

**Force-pushing `main` to fix a review comment.** The comment belongs on the feature branch. Force-pushing `main` rewrites the deploy branch. Push another commit to the feature, or rebase the feature if nobody else is on it, and push the feature.

### How this is used at work

Every later change in this path, a Dockerfile, a Terraform plan, a Kubernetes manifest, is reviewed as a diff on a branch and applied from the commit that lands on `main`. The pull request is the record of who agreed. The tag, when you cut a release, names the `main` commit you deployed. The flow is what makes "the repository" and "what is running" the same commit.

### Which command

| You want | Command | Why |
|---|---|---|
| Start from the team's tip | update `main`, then `git switch -c feature/...` | The branch point is current |
| Publish the branch for review | `git push -u origin feature/...` | Does not move `main` |
| Land it after review, when `main` has not moved | `git switch main && git merge feature/... && git push origin main` | Fast-forward |
| Put the feature on `main` immediately | do not | That skips the review |

The host's merge button is one of three histories, and the team should pick one and keep it. A merge commit records that the feature was joined and keeps the feature commits reachable by their original hashes, which is what you want when those hashes are already in review comments. A squash writes one new commit on `main` and abandons the feature hashes, which is what you want when the branch was full of "fix tests" and the review should land as one subject. A rebase-and-merge fast-forwards `main` along replayed commits, new hashes, straight line. All three start from the same place: the feature branch was pushed, `main` did not move, and the button is what moves it. Pushing `feature:main` yourself skips the button and the checks attached to it.

Branch names in this flow are how a person finds the change, so `feature/refund` is better than `misc` or your own name. The remote will happily store `misc`. The review queue will not tell anyone what it is. Delete the branch after the merge so the queue does not fill with finished work. The commits remain on `main`. A long-lived branch that keeps accumulating unrelated commits is a second `main`, and the conflict you resolve at the end is the whole week's edits instead of one change.

### You can now

- Push a feature branch to a remote without moving `main`.
- Say what a pull request is tracking: the branch, not one frozen commit.
- Fast-forward `main` to the reviewed branch and push that.
- Tell a push of `feature:main` apart from a push of the feature branch.

::: quiz
q: You push `feature/refund` with `git push -u origin feature/refund`. What is true of `origin`'s `main`?
- It fast-forwards to the feature tip, because a push updates `main` by default
+ It stays where it was. You published a different branch
- It is deleted until the pull request is opened
- It now has a merge commit joining the feature
why: The ref you updated is `feature/refund`. `main` moves when you push `main`, or when you push another branch's tip onto the `main` ref on purpose. Publishing a feature branch is what makes a review possible before that happens.
:::

::: quiz
q: A reviewer asks for a change. The feature branch is already pushed. How does the review see the fix?
- Force-push `main` with the fix commit
+ Commit on the same feature branch and push that branch again
- Cherry-pick the fix onto `main` and push `main`
- The pull request is frozen at the first push, so you open a second branch with a new name and abandon the first
why: The pull request follows the branch. A new commit on that branch, pushed, shows up in the review. `main` is still the unmoved deploy branch until the review is finished.
:::

::: shell git
task: `feature/tax` has one commit, `Add tax`, and it is not on the remote yet. Publish that branch to `origin`. `origin`'s `main` should still be only `Start`. `origin`'s `feature/tax` should be `Add tax` then `Start`.
setup:
```bash
git init -q --bare ../origin.git
git clone -q ../origin.git ../seed 2>/dev/null
( cd ../seed && echo v > app.txt && git add . && git commit -qm Start && git push -q origin HEAD:main )
git clone -q ../origin.git . 2>/dev/null
git switch -q main 2>/dev/null || git checkout -q main
git switch -q -c feature/tax
echo tax > tax.txt && git add . && git commit -qm "Add tax"
```
verify:
```bash
# wrong answer tested: git push origin HEAD:main
# which puts "Add tax" on origin's main. The feature branch would be missing
# or main would contain the unreviewed commit.
set -euo pipefail
[ "$(git --git-dir=../origin.git log --format=%s main | tr '\n' '|')" = "Start|" ]
[ "$(git --git-dir=../origin.git log --format=%s feature/tax | tr '\n' '|')" = "Add tax|Start|" ]
```
solution:
```bash
git push -u origin feature/tax
```
hint: Push the branch name you are on. `HEAD:main` updates the remote's `main` instead, which is the deploy branch.
:::

::: shell git
task: Review is done. `feature/tax` is already on `origin`, and `main` has not moved. Fast-forward your `main` to the feature and push `main`. `origin`'s `main` should read `Add the tax note`, then `Start`, with no merge commit.
setup:
```bash
git init -q --bare ../origin.git
git clone -q ../origin.git ../seed 2>/dev/null
( cd ../seed && echo v > app.txt && git add . && git commit -qm Start && git push -q origin HEAD:main )
git clone -q ../origin.git . 2>/dev/null
git switch -q main 2>/dev/null || git checkout -q main
git switch -q -c feature/tax
echo tax > tax.txt && git add . && git commit -qm "Add the tax note"
git push -q -u origin feature/tax
git switch -q main
```
verify:
```bash
# wrong answer tested: git merge --no-ff feature/tax && git push origin main
# which leaves a merge commit, so rev-list --merges on origin/main is 1.
set -euo pipefail
[ "$(git --git-dir=../origin.git log --format=%s main | tr '\n' '|')" = "Add the tax note|Start|" ]
[ "$(git --git-dir=../origin.git rev-list --merges --count main)" = "0" ]
```
solution:
```bash
git merge feature/tax
git push origin main
```
hint: On `main`, a merge of a branch that is ahead of you is a fast-forward. Then push `main`. `--no-ff` would invent a merge commit the task does not want.
:::

::: card
q: A pull request is open from `feature/refund` into `main`. You push another commit to `feature/refund`. What changes, and what does not?
answer: The pull request follows the branch, so the review now includes the new commit. `main` does not move. Production does not deploy the feature until `main` itself is updated.
:::

## Commit hygiene
id: hygiene
stage: team
needs: github-flow
minutes: 40
goal: Keep line endings and binaries predictable, reject a secret before it is committed, and say what a signature does and does not prove.
source: gitattributes | https://git-scm.com/docs/gitattributes
source: Pro Git: Git hooks | https://git-scm.com/book/en/v2/Customizing-Git-Git-Hooks
source: Pro Git: Signing your work | https://git-scm.com/book/en/v2/Git-Tools-Signing-Your-Work

A repository is read on more than one machine. macOS and Linux store text with `\n`. Windows tools often store `\r\n`. If Git converts line endings for some people and not others, a commit that changed nothing a human can see still changes every line, and the review is unreadable. `.gitattributes` in the root of the repository is the place that says how a path is treated, and it is a tracked file, so the rule is the same in every clone.

`*.txt text eol=lf` marks plain text and says the file in the worktree should use LF. `*.jpg binary` marks a JPEG as binary, which turns off line-ending conversion and tells Git not to merge it as text. `git check-attr binary -- photo.jpg` prints `set` when the binary attribute applies, and `unspecified` when it does not. `git check-attr eol -- notes.txt` prints `lf` when the eol attribute says so. A JPEG listed as text will be offered to a merge as lines. A corrupted image is how you notice, after the merge.

### Hooks

A hook is a program Git runs at a moment you can intercept. `pre-commit` runs after you ask to commit and before the commit object is written. A non-zero exit refuses the commit. That is the moment to reject a staged file that contains a secret, while the object does not exist yet. The hook in `.git/hooks/pre-commit` is local. Cloning a repository does not install it, because `.git/hooks` is not a tracked directory. A hook script you commit at `.githooks/pre-commit` is just a file until each clone points Git at it with `git config core.hooksPath .githooks`. The config is local too. A hook is a convenience for the people who installed it. It is not an access control on the remote. The remote can still receive a commit made with `--no-verify`, which skips the hook.

The hook has to be executable. Git runs it, and a hook that is not executable is not run. A commit then succeeds with the secret in it, which looks like the hook passed. `chmod +x` is part of installing it. The script should look at the index, not at whatever happens to be in the worktree, because the commit records the index. `git diff --cached --name-only` lists the staged paths. `git show :path` prints the staged bytes. If those bytes contain the marker you are hunting, exit non-zero and the commit does not happen.

A scanner such as gitleaks is the same idea with a maintained set of patterns. It is a separate program. This course does not install it. A hook that greps for one marker is the mechanism. The product is what you run when the marker list is longer than one word.

### Signing

`git commit -S` attaches a signature to the commit. Verifying it proves that a holder of the matching key signed those bytes. It does not prove the change is correct, kind, or free of a secret. A stolen key signs bad commits that verify. A missing signature on a project that does not require one proves nothing either. Hosted forges can show "verified" next to a commit when the key is registered with the account. Treat that as identity of the signer, and keep the review for everything else. Creating a key needs a passphrase and a secret file this environment does not set up, so signing stays a fact to reason about rather than a command to run here.

If a secret did get committed and pushed, the hook is already too late. Remove it from the tip if you can, and rotate the credential. The old commit still has the bytes. A signature on the removal does not rotate the key.

### What the attributes file is deciding

A line is a pattern, then attributes. `text` means "this is text, so line endings may be normalised". `eol=lf` means "when you check the file out, use LF". `binary` is a shorthand for "not text": do not normalise newlines, and do not offer the file to a textual merge. The attributes travel with the repository because the file is tracked. A setting in your global git config does not. Two clones with the same attributes file and different `core.autocrlf` values still agree on the paths the file mentions, which is why the file exists. Paths it does not mention are still at the mercy of each machine's config.

The hook is a later gate, and it sees the index after you have already staged. If `.gitattributes` is wrong, the hook will not notice a JPEG being merged as text. If the hook is wrong, the attributes will not notice a secret. They catch different mistakes. Neither one rewrites a commit that has already been pushed.

### Where this breaks

**Attributes added after the bad file is committed.** They affect later checkouts and later merges. They do not rewrite the blob that is already in the history.

**A hook that searches the worktree and ignores the index.** A secret sitting staged gets committed, and a secret in an unstaged scratch file blocks a clean commit. Read the index.

**Relying on every teammate's laptop to run the hook.** Someone will clone and not set `core.hooksPath`. A server-side check on the receive, or CI, is what actually binds the team. The local hook is there so you find out before the push, not so you can skip CI.

### How this is used at work

The attributes file is reviewed like any other change, because `eol=lf` on a file that is supposed to stay CRLF will fight a tool on every commit. The hook is in the repository under a hooks directory the setup script points at, and CI runs the same scanner so a skipped hook still fails the pull request. Signatures, when the project uses them, are required by the host on `main`. None of these replace a small commit with a subject that says what the change does. The reviewer still has to read the diff.

### Which command

| You want | Command | Why |
|---|---|---|
| Force LF in text files | `*.txt text eol=lf` in `.gitattributes` | Same bytes on every machine |
| Keep an image out of text merge | `*.jpg binary` | No line-ending conversion, no textual merge |
| See what Git decided | `git check-attr binary -- path` | `set` means the attribute applies |
| Refuse a bad commit locally | executable `pre-commit` exiting non-zero | Runs before the object is written |
| Share the hook script | track it, set `core.hooksPath` | `.git/hooks` is not cloned |
| Prove who signed | verify the signature | Does not prove the change is right |

### You can now

- Write attributes that mark text versus binary, and check them with `git check-attr`.
- Install a pre-commit hook that refuses a staged secret and allows a clean file.
- Explain why a hook in `.git/hooks` does not travel with the clone.
- Say what a commit signature proves, and why a pushed secret still has to be rotated.

::: quiz
q: A commit's signature verifies. What did you learn?
- The change is correct, because a signature is a review
+ Someone with the matching key signed these bytes. The change can still be wrong or can still contain a secret
- The commit has not been pushed, because signed commits stay local
- Git rewrote the history to remove earlier versions of the file
why: Verification checks the signature against the commit contents and the key. It does not run the tests, and it does not look for secrets. A bad change signed with a valid key still verifies.
:::

::: quiz
q: A secret was committed and pushed. The next commit deletes the file. What else has to happen?
- Nothing. The delete removes the bytes from every clone
+ Rotate the credential. The old commit still has the bytes, and anyone who fetched it can read them
- `git commit --amend` on the delete commit, which rewrites the remote
- Add the path to `.gitignore`. Ignore rules rewrite published history
why: A new commit that deletes a path does not change the parent snapshot. Ignore rules only affect untracked names. The credential has to be treated as copied, which means rotating it so the copied value stops working.
:::

::: card
q: You committed `.githooks/pre-commit` and a teammate cloned the repository. Why did their next commit not run that script?
answer: Git runs hooks from `.git/hooks`, or from `core.hooksPath` if that is set. A tracked script is an ordinary file until that config points at its directory. `core.hooksPath` is local and is not copied by clone. `.git/hooks` is not part of the history at all.
:::

::: shell git
task: Write `.gitattributes` so `*.md` is text with LF endings and `*.png` is binary.
setup:
```bash
git init -q
```
verify:
```bash
# wrong answer tested: `*.png text` (binary comes back unspecified)
# and `*.md text` without eol=lf (eol is unspecified, not lf).
set -euo pipefail
[ "$(git check-attr binary -- diagram.png | awk '{print $NF}')" = "set" ]
[ "$(git check-attr eol -- readme.md | awk '{print $NF}')" = "lf" ]
```
solution:
```bash
printf '%s\n' '*.md text eol=lf' '*.png binary' > .gitattributes
```
hint: One line per pattern. `text eol=lf` fixes the line ending. `binary` marks the image. `git check-attr` prints the value Git will use for a path even before that path exists.
:::

::: shell git
task: Install a `pre-commit` hook that exits non-zero when any staged file contains the bytes `SECRET`, and exits zero otherwise. The hook must be executable. It should look at the index, not at unstaged files.
setup:
```bash
git init -q
echo a > a.txt && git add . && git commit -qm Start
```
verify:
```bash
# wrong answer tested: the hook script is correct but not executable.
# Git skips it, so the SECRET commit succeeds.
# Also fails: a hook that always exits 1, so the clean file never commits.
set -euo pipefail
[ -x .git/hooks/pre-commit ]
echo SECRET > leak.txt
git add leak.txt
if git commit -qm nope; then
  echo "hook allowed a staged SECRET" >&2
  exit 1
fi
git reset -q
rm -f leak.txt
echo fine > ok.txt
git add ok.txt
git commit -qm "Add a clean file"
[ "$(git log -1 --format=%s)" = "Add a clean file" ]
```
solution:
```bash
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
bad=0
for f in $(git diff --cached --name-only); do
  if git show ":$f" | grep -q SECRET; then
    echo "blocked $f" >&2
    bad=1
  fi
done
exit $bad
EOF
chmod +x .git/hooks/pre-commit
```
hint: The hook path is `.git/hooks/pre-commit`. It needs a shebang and `chmod +x`, or Git will not run it. Read each staged path with `git show :path`. Exit 1 if the staged bytes contain `SECRET`.
:::

## Project: a shared tax helper
id: p-git
stage: team
needs: hygiene
project: yes
minutes: 70
goal: Take one small repository from a dirty tree to a reviewed, tagged main, including a conflict, a rebase onto a teammate, and a revert.
source: Pro Git: Distributed Git | https://git-scm.com/book/en/v2/Distributed-Git-Distributed-Workflows
source: GitHub flow | https://docs.github.com/en/get-started/using-github/github-flow

The tax helper is a single Python file and a README. It is about to become the repository other people commit to, which means the next hour is not "make the code work". The code is already a few lines. The job is to make the history something you can deploy, review, and undo.

Each step starts from a fresh repository. That is the exercise environment, not the way a real afternoon works. In a real afternoon the same `.git` would still be there and you would keep going. Here you repeat the setup so each step can be checked on its own. The decisions are the ones you would make in that afternoon, in order.

You do not commit build output or a local environment file. `dist/build.js` is produced by a build you can run again. `.env` is a credential. Either one in the history is a file every clone will contain forever. The commit should hold the source, the README, and the ignore rules.

You do not commit the tax change straight onto `main`. You put it on `feature/tax` and merge it once `main` still has nothing newer, so the merge is a fast-forward and the feature name remains as a label you could delete afterwards.

You do resolve a conflict in `rates.yml` by keeping both ideas. One branch changed a number. The other branch added a key. Taking either file whole drops one of those ideas, and the file is the sort of config a whole-file checkout silently damages.

You do not force-push over a teammate. They pushed while you had a local commit. You replay yours on top of theirs and push a fast-forward.

You name the snapshot you would deploy with an annotated tag, `v0.3.0`, on the commit you mean, with a message. A lightweight tag would be a name with no object. The release process asked for the object.

You undo a bad rate that is already on `main` with a revert, so the bad commit stays in the log and the tree goes back to the previous number. A reset would make the bad commit disappear from the branch, which is a rewrite of history the rest of the team already has.

### The order is the point

The ignore file comes before the first `git add`, because the index is what the commit will snapshot, and an ignored name is only skipped when it is not yet tracked. The feature branch comes before the tax commit, because a commit on `main` is a commit you have already decided to ship. The conflict is resolved by reading both parents, not by checking out one of them, because each parent has a line the release needs. The rebase happens before the push, because the remote has already refused a history that would drop the teammate. The tag happens on the commit you just made fast-forward to, not on a later docs commit you have not written yet. The revert happens instead of a reset, because the bad rate is already on the branch other people have.

If you do these in another order the checks still describe the repository you should end with. A tag on the wrong commit fails an exact match. A merge commit where the histories were nested fails the merge count. A secret in the first commit fails the file list. The repository is small so that those failures are about the history and not about the tax arithmetic.

### Where this breaks

**`git add .` before the ignore file exists.** The secret and the build output are in the index, and the commit will contain them. Write the ignore rules first, then add.

**A merge commit where the task is a fast-forward.** `--no-ff` invents a join you were not asked for. The parent count gives it away.

**Tagging with `git tag v0.3.0` and no `-a`.** The name exists. The type is `commit`. The release note has nowhere to live.

### How this is used at work

This is the loop from the first feature through the first bad release. The pull request on a hosted site is the review between the push of `feature/tax` and the fast-forward of `main`. The exercises use a bare remote so there is no network and no `gh`. The refs you push are the same refs. After the tag, a deploy checks out `v0.3.0`. After the bad rate, the deploy checks out the revert. The log still answers "what did we ship, and what did we undo".

The bare remote in these steps is a directory, `../origin.git`, created with `git init --bare`. It has no worktree. You do not edit files there. You push refs to it and you read it with `git --git-dir` or by cloning it. That is the whole of what "the server" means in this project. A hosted remote adds accounts, pull request comments, and CI. It does not add a fourth kind of ref. If a step says the remote `main` must read a certain list of subjects, that list is `git log` in the bare repository, newest first, and a merge subject in that list means a join was created when the task asked for a replay or a fast-forward.

Edge cases the checks care about: an ignore file that names `.env` but not `dist/` still commits the built file. A feature branch that is never merged leaves `main` without `tax.py`. A conflict resolution that keeps the markers and gets staged will not match the three-line file. A pull that merges instead of rebasing puts a merge commit on the remote. A lightweight tag fails the type check. A reset instead of a revert removes the bad subject from the log. Each of those is a plausible way to "finish" the step and still be wrong.

None of the steps need the network, a GitHub account, or `gh`. If a command is refused, read the refusal. A non-fast-forward is a missing fetch or rebase, not a prompt to force-push. A conflict is a file to edit, not a merge to abort and forget. A tag of the wrong type is a tag to delete and recreate with `-a` before anyone deploys the name.

### You can now

- Make a first commit that includes source and ignore rules and excludes a secret and a build artifact.
- Land a one-commit feature as a fast-forward.
- Resolve a two-sided config conflict without taking either file whole.
- Rebase an unpushed commit onto a teammate's push and update the remote.
- Put an annotated tag on the commit you would deploy.
- Revert a published bad commit without dropping it from the log.

::: shell git
task: This directory is the tax helper, and it is not a repository yet. Ignore `.env` and everything under `dist/`. Commit everything else in one commit with the message `Describe the tax helper`. The commit should contain `.gitignore`, `README.md`, and `app.py`.
file: app.py
```
def tax(amount):
    return amount * 0.2
```
file: README.md
```
# tax helper
```
file: .env
```
API_KEY=secret
```
file: dist/build.js
```
console.log("built")
```
verify:
```bash
# wrong answer tested: git add . && git commit -m "Describe the tax helper"
# before any ignore file exists. HEAD then contains .env and dist/build.js.
set -euo pipefail
[ "$(git rev-list --count HEAD)" = "1" ]
[ "$(git log -1 --format=%s)" = "Describe the tax helper" ]
[ "$(git ls-files | LC_ALL=C sort | tr '\n' ' ')" = ".gitignore README.md app.py " ]
git check-ignore -q .env
git check-ignore -q dist/build.js
[ -f .env ]
[ -f dist/build.js ]
```
solution:
```bash
git init
printf '%s\n' '.env' 'dist/' > .gitignore
git add .
git commit -m "Describe the tax helper"
```
hint: Write `.gitignore` before `git add .`. A `dist/` pattern covers `dist/build.js`. The files stay on disk. They are just not in the commit.
:::

::: shell git
task: Add `tax.py` containing exactly `print("tax")` on a branch named `feature/tax`, in one commit. Then fast-forward `main` to that branch. Finish on `main`. `feature/tax` should still exist, and it should be an ancestor of `main`. There should be no merge commit.
setup:
```bash
git init -q
echo 'print("app")' > app.py && git add . && git commit -qm Start
```
verify:
```bash
# wrong answer tested: committing tax.py on main and never creating feature/tax.
# Also fails: git merge --no-ff feature/tax, which writes a merge commit.
set -euo pipefail
[ "$(git branch --show-current)" = "main" ]
git rev-parse -q --verify feature/tax >/dev/null
[ "$(git show main:tax.py)" = 'print("tax")' ]
git merge-base --is-ancestor feature/tax main
[ "$(git rev-list --merges --count main)" = "0" ]
[ "$(git rev-list --count main)" = "2" ]
```
solution:
```bash
git switch -c feature/tax
echo 'print("tax")' > tax.py
git add tax.py
git commit -m "Add the tax command"
git switch main
git merge feature/tax
```
hint: `git switch -c feature/tax` creates the branch and moves you onto it. Commit there, switch back, and merge. `main` has not moved, so the merge fast-forwards.
:::

::: shell git
task: Merge `feature/holiday` into `main`. Keep the holiday rate and the local key. `rates.yml` in the merge commit must be exactly these three lines:

```text
standard: 0.2
reduced: 0.0
local: 0.01
```
setup:
```bash
git init -q
printf '%s\n' 'standard: 0.2' 'reduced: 0.05' > rates.yml
git add . && git commit -qm Base
git switch -qc feature/holiday
printf '%s\n' 'standard: 0.2' 'reduced: 0.0' > rates.yml && git commit -qam "Holiday rate"
git switch -q main
printf '%s\n' 'standard: 0.2' 'reduced: 0.05' 'local: 0.01' > rates.yml && git commit -qam "Local rate"
```
verify:
```bash
# wrong answer tested: git checkout --theirs rates.yml
# which sets reduced to 0.0 and drops local.
# git checkout --ours keeps local and leaves reduced at 0.05.
set -euo pipefail
[ ! -f .git/MERGE_HEAD ]
[ "$(git show HEAD:rates.yml)" = "$(printf '%s\n' 'standard: 0.2' 'reduced: 0.0' 'local: 0.01')" ]
[ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" = "3" ]
```
solution:
```bash
git merge feature/holiday
printf '%s\n' 'standard: 0.2' 'reduced: 0.0' 'local: 0.01' > rates.yml
git add rates.yml
git commit --no-edit
```
hint: Theirs is the holiday rate without `local`. Ours is the local key with the old reduced rate. Write all three lines, add the file, and commit the merge.
:::

::: shell git
task: Your local `main` has `Add the waiver`, which is not on `origin`. A teammate has pushed `Fix the footer` to `origin`'s `main`. Put your commit on top of theirs and update `origin`, with no merge commit. `origin`'s `main` should read `Add the waiver`, then `Fix the footer`, then `Start`.
setup:
```bash
git init -q --bare ../origin.git
git clone -q ../origin.git ../mate 2>/dev/null
( cd ../mate && echo v1 > app.txt && git add . && git commit -qm Start && git push -q origin HEAD:main )
git clone -q ../origin.git . 2>/dev/null
git switch -q main 2>/dev/null || git checkout -q main
echo waiver > waiver.txt && git add . && git commit -qm "Add the waiver"
( cd ../mate && echo foot > footer.txt && git add . && git commit -qm "Fix the footer" && git push -q origin HEAD:main )
```
verify:
```bash
# wrong answer tested: git pull && git push
# which merges and leaves a merge commit on origin.
# git push --force would drop "Fix the footer".
set -euo pipefail
cd ../origin.git
[ "$(git log --format=%s main | tr '\n' '|')" = "Add the waiver|Fix the footer|Start|" ]
[ "$(git rev-list --merges --count main)" = "0" ]
```
solution:
```bash
git pull --rebase
git push
```
hint: A plain push is rejected because the remote has a commit you do not. `git pull --rebase` replays `Add the waiver` on top of `Fix the footer`. Then push. That push is a fast-forward.
:::

::: shell git
task: Tag the current tip as an annotated tag `v0.3.0` with the message `release`. The tag must point at `HEAD`.
setup:
```bash
git init -q
echo a > app.py && git add . && git commit -qm Start
echo b > README.md && git add . && git commit -qm "Document the helper"
```
verify:
```bash
# wrong answer tested: git tag v0.3.0
# which is lightweight, so git cat-file -t prints commit.
# Tagging HEAD~1 fails the exact-match on HEAD.
set -euo pipefail
[ "$(git cat-file -t v0.3.0)" = "tag" ]
[ "$(git describe --tags --exact-match HEAD)" = "v0.3.0" ]
git for-each-ref --format='%(contents)' refs/tags/v0.3.0 | grep -qx release
```
solution:
```bash
git tag -a v0.3.0 -m "release" HEAD
```
hint: `-a` stores a tag object and `-m` stores the message. `HEAD` is the commit `Document the helper`. `git cat-file -t v0.3.0` should print `tag`.
:::

::: shell git
task: `Apply the wrong rate` is already on `main` and set the reduced rate to `0.9`. Revert that commit. Keep `Apply the wrong rate` in the log. `HEAD`'s `rates.yml` should contain `reduced: 0.05`, and the newest subject should be `Revert "Apply the wrong rate"`.
setup:
```bash
git init -q
printf '%s\n' 'reduced: 0.05' > rates.yml && git add . && git commit -qm Start
printf '%s\n' 'reduced: 0.9' > rates.yml && git add . && git commit -qm "Apply the wrong rate"
```
verify:
```bash
# wrong answer tested: git reset --hard HEAD~1
# which restores 0.05 and drops "Apply the wrong rate" from the log.
set -euo pipefail
[ "$(git rev-list --count HEAD)" = "3" ]
[ "$(git log -1 --format=%s)" = 'Revert "Apply the wrong rate"' ]
git log --format=%s | grep -qx "Apply the wrong rate"
git show HEAD:rates.yml | grep -qx 'reduced: 0.05'
```
solution:
```bash
git revert --no-edit HEAD
```
hint: `git revert --no-edit HEAD` adds a commit that undoes the tip. The bad subject stays in `git log`. Reset would take it off the branch.
:::
