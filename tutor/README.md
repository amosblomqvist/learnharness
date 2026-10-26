# Tutor

A self-study app for macOS. It has premade modules, real exercises, and spaced reviews. Lessons don't wait on a model, and there is no co-writer and no chat. You read, you answer, and you write code that is checked on your Mac.

- **One goal, the SWE path.** Modules in teaching order: Linux and the shell, Git, Python, **Learn Python: Fantasy Quest**, its **Workshop**, TypeScript, SQL, Containers, Cloud (AWS), Terraform, CI/CD, Kubernetes, **Distributed systems** and more. Drag modules to reorder them. *Add a module* searches the catalogue.
- **Distributed systems, on real servers.** Postgres query plans and locks, PgBouncer pooling, streaming replication, point-in-time restore and promotion; Redis memory limits, replication and failover; a durable queue with `SKIP LOCKED`; retry budgets, circuit breakers, bounded queues, token buckets and nginx rate limits; then the regional arithmetic: latency tails, RTO/RPO, multi-AZ Terraform, alert rules and DR strategy. There are nine checked coding projects, two config exercises and ten live lab drills against real daemons.
- **Learn Python: Fantasy Quest.** A text RPG built one small, checked coding task at a time: variables, functions, strings, lists, dictionaries, errors, type hints, testing, classes, files and JSON, modules, tuples, iterators, generators and decorators. The Workshop then has real projects from a blank folder — a quest-log CLI, an interactive dungeon, and more — checked by hidden acceptance tests.
- **Three screens.** *Path* has one big button that opens the next lesson, or your reviews when 5 or more are due. A module's *map* shows its stages top to bottom and each lesson linked to what it needs. A *lesson* is a short read, then practice steps that open one at a time.
- **Practice is real, not multiple choice only.**
  - *Question*: pick one, then see why.
  - *Predict*: type exactly what the code prints.
  - *Recall*: a flash card.
  - *Write*: Python or TypeScript checked by hidden tests. TypeScript also gets `tsc --strict` and type-level checks.
  - *Terminal*: bash in a throwaway folder with prepared files, and real git.
  - *Config*: Kubernetes YAML, Terraform HCL, IAM JSON and Dockerfiles, parsed and checked rule by rule, with errors given by line number.
- **Answers only after a real try.** A failed attempt shows a hint and a "Show a solution" link. Using the solution still finishes the lesson, but its questions come back sooner.
- **Spaced reviews.** Every question, prediction and recall card from a finished lesson becomes a review card, scheduled with FSRS (the scheduler modern Anki uses). Options are shuffled, so you learn the answer and not its position.
- **Type the docs (optional).** Turn on *Type the docs before each lesson's tasks* on the path, and a lesson's tasks open only after you have typed the human-written page it cites: the Python docs, the TypeScript Handbook, man pages, the Kubernetes docs and so on. When the link points at a section, you type that section, up to about 1,200 words. Wrong keys don't move the cursor, indentation and REPL output are skipped for you, and progress is saved after every paragraph. Pages are fetched from the official site on first use and cached in `~/Library/Application Support/tutor/docs/`; nothing is bundled with the app.
- **Reading modules.** *The Rust Book* (101 sections) and *System design: the originals* (30 articles from Google's SRE book, the Amazon Builders' Library, the Azure Architecture Center and Martin Fowler) have one lesson per page and no tasks. With *Type the docs* on, typing the whole page finishes the lesson. Add them with *Add a module*.
- **Safe.** Code runs under macOS `sandbox-exec`, with no network, no writes outside a scratch folder, and no reading your home folder. Progress is one file: `~/Library/Application Support/tutor/study.json`.
- **The farm.** *Practice Python on the farm* opens Root Access. A lesson finished there is noted on the Python lesson with the same id.

| Shortcut | Does |
|---|---|
| `↵` on the path | Continue |
| `⌘↵` | Run / check the current step |
| `⌘[` or `Esc` | Back |
| `⌘0` | Your path |
| `⌘\` | Show / hide |
| `⌥⌘T` | Keep on top of other apps |

## Install (for a friend)

Tutor runs on **Macs with Apple Silicon** (M1 or newer). Windows isn't supported yet: the exercise sandbox is a macOS feature.

1. On the repository's **Releases** page, download `Tutor-<version>-mac-arm64.zip` and double-click it.
2. Drag **Tutor.app** into Applications.
3. The app isn't notarized, so the first open is blocked. Right-click Tutor.app and choose **Open**, then **Open** again. Or run this in Terminal once:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Tutor.app
   ```
4. For every exercise to work, install these once (the path shows a note if any is missing):
   - **Python 3.12+**, from python.org or with `brew install python`
   - **git**, with `xcode-select --install`

   TypeScript exercises use Tutor's own Node and compiler, so they need nothing extra. The Root Access farm game is built into the app.

Your progress stays on your Mac in `~/Library/Application Support/tutor/study.json`.

To make the shareable build: run `npm run dist`. It builds the app with the farm game inside, from `ROOT_ACCESS_DIR`, or `../root-access`, or `~/Desktop/root-access`. The zip is written to `release/`, and the app installed on your Mac isn't touched.

## The Linux lab

The **Linux servers** and **Server operations** modules run their exercises as root on real Ubuntu 24.04 machines, while you stay on macOS:

- **Lima** runs a small Ubuntu VM (`tutor-lab`) using Apple's virtualization framework. The VM has no access to your Mac's files.
- Inside the VM, **Incus** keeps a template machine with a clean snapshot. Every exercise run copies that snapshot into a fresh system container (real systemd, apt, users, firewall, networking), runs the step's setup, your commands and the check, and then deletes it. On btrfs the copy is instant.
- **Neighbours:** a step with `peer=NAME` gets a second machine on the same network, reachable by that name, so exercises can SSH between machines, back up across the network, ship logs, or balance traffic over two servers.
- **Data-plane services:** the template also ships PostgreSQL 16, Redis 7 and PgBouncer, disabled until a step starts them. The Distributed systems module uses them for real primaries, streaming replicas, promotion, PITR and transaction pooling; nothing is simulated.
- **Live machines:** a `::: term` step gives you a real root shell (xterm.js + node-pty) on a machine that stays up while the step is on screen, with a tab for the neighbour when there is one. **Check** runs the step's verify against what you did.
- **Disk machines:** storage steps (`fullvm`, `disks=2G,1G`) boot a small VM instead of a container, with its own kernel and blank disks (`/dev/vda`, `/dev/vdb`…) to partition, format, mount and put LVM on. This needs nested virtualization, so a Mac with M3 or newer and macOS 15 or newer. On older Macs, those steps say so and everything else works.
- `electron/linuxlab.ts` drives it all.

Set it up once (it downloads about 1.2 GB: Lima, the Ubuntu VM image, a container image and a VM image), either with the step's **Set up the Linux lab** button or in Terminal:

```bash
bash scripts/setup-linux-lab.sh
```

The script is safe to re-run, and picks up where it stopped. It now includes PostgreSQL, Redis and PgBouncer in the template (about 100 MB more), so the data-plane drills do not install anything per step. Tutor starts the VM when a lesson needs it. To stop it, run `~/.local/bin/limactl stop tutor-lab`; to remove everything, run `bash scripts/setup-linux-lab.sh --remove`. `npm run check:study` runs the server tasks against the lab when it exists, and reports them as skipped when it doesn't.

## Modules

Each module is one Markdown file in `src/study/content/`. A module has stages and lessons, and each lesson has steps:

```text
# Module title
id: linux
blurb: one line for the path
why: why it sits where it does in the path
stage: shell | The shell | what you can do after this stage

## Lesson title
id: paths
stage: shell
needs: shell, git/commits        (another module's lesson: module/lesson)
minutes: 15
goal: what you can do after it
source: Title | https://…

The lesson in Markdown.

::: quiz                          (also: predict lang=, card, write lang=, shell, term, config lang=)
q: Question?
- wrong
+ right
why: explanation
:::
```

`parse.ts` documents every step field. Write steps take `starter`, `tests`, `solution` and `hint`, plus `types` for TypeScript type checks, and any number of `wrong:` answers with a fence — in TypeScript a wrong answer may carry `fail: runtime` (tsc takes it, the tests catch it) or `fail: types` (it passes the tests and tsc is what refuses it), which `check:study` enforces. A lesson may also declare `show: expr -> kind`: after Run the app evaluates the expression against your code and draws the result as the world card (`src/study/world.ts`); the checker runs the same fixture against the solution. Shell steps take `file: path`, `setup`, `expect` or `verify`, and `solution`; with `vm` they run on a lab machine, `peer=NAME` adds a neighbour (with `peersetup` and `peerverify`), and `fullvm` or `disks=` make it a disk machine. Term steps (live machines) take the same fields plus `scripted`, a non-interactive version of the solution for the checker. Config steps take `check: <path> <op> <value> | message` lines (see `config.ts` for the path language).

`npm run check:study` validates every module (or `npm run check:study ops ops/lvm` for one module or one lesson). It checks that each predicted output is what the code really prints, that each solution passes and each starter fails, and that every `needs` link resolves. Run it after editing content.

Fantasy Quest, the Workshop and Fantasy Quest: the rebuild are generated, so don't edit `src/study/content/quest.md`, `workshop.md` or `tsquest.md` by hand. Fantasy Quest lessons live in `scripts/quest/chN.py`; Workshop projects are folders under `scripts/workshop/pNN-name/`; the rebuild's lessons live in `scripts/tsquest/chN.py`. Rebuild with `npm run build:quest`, `npm run build:workshop` and `npm run build:tsquest`, then run `npm run check:study quest workshop tsquest`.

The old chat/agent engine (`src/App.tsx`, `src/ui/*`, `electron/chat.ts` and friends) is still in the repo but not in the UI.

## Run it

```bash
npm install
npm start
```

`npm run app` builds a real **Tutor.app** and installs it in /Applications (use this one for Screen Recording permission). `npm run dev` gives hot reload for the UI and restarts Electron when main-process code changes.

First run on macOS:

1. **Screen Recording:** System Settings → Privacy & Security → Screen Recording → enable the app (in dev it's *Electron*, or the terminal you started it from). Restart it afterwards.
2. **Claude plan:** the "Claude · my plan" models drive your installed Claude Code (`~/.local/bin/claude`), so it has to be logged in: `claude auth login`. Usage counts against your plan's normal limits. This is for your own personal use; don't ship a Claude.ai login in something other people use.
3. **Grok subscription:** the "Grok · my subscription" models drive xAI's Grok Build CLI (`~/.local/bin/grok`, install from x.ai/cli, then `grok login`). In Tutor mode Grok runs in its read-only OS sandbox; in Writer mode it can only write inside the project folder.
4. **API keys:** gear icon → paste Anthropic / xAI / OpenAI keys.
5. **Local models:** `ollama pull qwen3` (or any model); they show up in the menu automatically.

### JetBrains (PyCharm / WebStorm)

In the IDE: Settings → Tools → MCP Server → **Enable MCP Server**, and have a project open. Tutor finds it by itself (the IDE chip turns green); pick a specific IDE from that chip if several are running.

## How it's built

```
electron/
  main.ts      window, menu, hotkeys, IPC
  ide.ts       finds running JetBrains IDEs, curated IDE tools with projectPath filled in
  web.ts       page reader (public URLs only)
  conversations.ts  saved chats
  capture.ts   screen capture (hides itself first; long edge ≤ 1568px)
  chat.ts      one turn: Claude Agent SDK (Claude plan), ACP to Grok Build (Grok sub), AI SDK for the rest
  grok.ts      ACP client for `grok agent stdio`, with Grok's sandbox per mode
  changes.ts   before/after of every edited file, diffs, keep/undo
  models.ts    the model menu and provider factory
  tools.ts     list/read/search (+ write/edit in Writer) confined to the project folder
  mcp.ts       MCP clients: Brave (built in) + your settings JSON
  prompts.ts   the Tutor (incl. Learn) and Writer system prompts
  learn.ts     the Learn lens: skill folder, quiz / question cards, diagram checks; served to the
               AI SDK directly, to Claude Code in-process, to Grok over a local MCP server
  diagram.ts   draws Mermaid/SVG in a hidden window (render.html) so the model can look first
  goals.ts     goals and their strategy maps (validated DAG: ids, stages, no cycles), progress
  tutor-tools.ts  Tutor's own tools (cards, diagrams, save_strategy, mark_node, video_transcript),
               served to the AI SDK directly, to Claude Code in-process, to Grok over local MCP
  video.ts     video → timestamped transcript (yt-dlp captions, or whisper.cpp for local files), paged
  handoff.ts   "Ask Tutor" External Tool for JetBrains IDEs, and adding Tutor to the IDE's AI chat
  acp-agent.ts Tutor as an ACP agent for the IDE's AI chat (a socket in the data folder)
  acp-bridge.ts  what the IDE runs (Tutor.app in Node mode) to reach that socket
  lab.ts       sandboxed runs (Python/TS/JS) and the Python tracer behind the stepper
  reviews.ts   FSRS review cards for solid nodes, due lists, stats
  courses.ts   ready-made courses (TypeScript)
  settings.ts  settings + Keychain-encrypted keys
src/           React UI (Vite)
```

Dev checks: `TUTOR_DEMO=1 npx electron .` streams a canned answer (no tokens); `TUTOR_SHOT=out.png` saves a picture of the window and quits; `TUTOR_SELFTEST="claude-plan:claude-haiku-4-5-20251001|writer|…"` runs one turn headless. Add `TUTOR_USERDATA=/tmp/somewhere` so checks never touch your real settings, chats or profile.

## Credits

Started as a fork of [free-cluely](https://github.com/Prat011/free-cluely) (Apache-2.0). See `NOTICE`.
The Learn lens runs the teaching skill from [amosblomqvist/learn](https://github.com/amosblomqvist/learn) by Amos Blomqvist. It isn't copied into this repo: Tutor clones it to your Mac and reads it from there.
