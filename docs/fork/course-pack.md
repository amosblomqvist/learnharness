# Course packs

This guide is for the personal fork. LearnHarness itself is unchanged in license and authorship. See [NOTICE](../../NOTICE).

A course pack is a folder of numbered chapters. Each chapter is a directory whose name starts with a number, such as `01. Boxes`, and contains `Readme.md`. Images next to that file (`png`, `jpg`, `gif`, `webp`, `svg`) are copied with it. Anything else in the folder is ignored. The first preset is [system-design-notes](https://github.com/liquidslr/system-design-notes). The preset does not contain the notes.

## Import on Windows

Daily use is the web dev server. The desktop installer is a separate packaging step and is not required to study.

1. Install Node.js 22 or newer (upstream CI uses Node 26).
2. In a terminal, from this repository:

```bat
npm ci
npm run dev
```

3. Open `http://localhost:3000/courses`.

Clone the notes somewhere outside this repository. Do not copy them into the LearnHarness tree and do not commit them.

```bat
git clone https://github.com/liquidslr/system-design-notes.git %USERPROFILE%\src\system-design-notes
```

On the Courses page, paste the full path, for example `C:\Users\you\src\system-design-notes`, and choose **Import local folder**.

**Download from GitHub** fetches `https://codeload.github.com/liquidslr/system-design-notes/tar.gz/refs/heads/main` at that moment, extracts it in a temporary directory, and deletes the archive. Use a local clone when you want updates from `git pull` without another download.

Imported chapters are copied into the app data directory:

- `npm run dev`: `<this repo>\data\courses\` (gitignored)
- Packaged Electron: `LH_DATA_DIR` is `<userData>\data`. On Windows, Electron's userData for this app is typically `%APPDATA%\LearnHarness`, so the copies land in `%APPDATA%\LearnHarness\data\courses\`.

Check for updates on the course card. Unchanged chapters are not copied again and are not sent to the model. A changed chapter replaces its copied files. Review cards and the list of past sessions stay. A chapter that disappears from the folder is marked removed; its card is kept and it leaves today's queue.

The checkbox **Also extract propositions into the knowledge graph** runs the existing notes importer on each changed chapter. Leave it off unless a model is configured. It does one extraction run per changed chapter and can take a long time across a full set of chapters. If the model is not configured, the chapter files are still imported and the graph error is stored on the chapter. Run **Check for updates** with the box checked after models are set; chapters whose extracted hash does not match the file are tried again.

If File access in Settings is restricted, add the course data folder (or your clone) to the allowed folders. Otherwise the teacher cannot read the quoted path.

## Study and practice

**Study** creates a normal teaching session. The opening message quotes the copied `Readme.md` and the chapter directory. The usual loop runs: measure, plan, teach. Sending that message needs a configured Strong model, the same as any other session. With no model, the draft stays in the composer and setup opens.

**Practice** creates a practice session over the same file. For the system-design preset, the opening asks for one interview-style problem and names the chapter's frame: requirements, estimation, high-level design, deep dive, wrap-up. Other courses get an open retrieval prompt instead. A heading's Practice button adds that heading as the focus.

Practice results stay in the session. They are not copied into the review card. Upstream practice records are session evidence, not mastery, and this fork does not change that.

## Review scheduling

Scheduling is SM-2. It is a short public formula (Wozniak, 1990) with no trained weights, so it can run locally and be tested exactly. FSRS would need a set of default weights this app has no reason to ship.

Each chapter has a card. Each `##` heading, up to 12, has its own card. The buttons map to SM-2 grades: Again 1, Hard 3, Good 4, Easy 5.

- A grade below 3 resets repetitions and sets the interval to 1 day.
- Otherwise the first interval is 1 day, the second is 6 days, and later intervals are the previous interval times the ease, rounded.
- Ease starts at 2.5 and moves by `0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)`, with a floor of 1.3. The interval uses the ease from before this review.

A card is due on the UTC day stored on it. **Today's review** lists due chapter cards and due heading cards. Removed chapters and retired headings (a heading that disappeared on re-import) stay in the file but are not queued.

Status, per chapter:

| Status | When |
| --- | --- |
| Not started | No linked session and no review card |
| Learning | A teaching or practice session exists, or a card exists, and nothing due is mastered |
| Review due | The chapter card or an active heading card is due. This wins over mastered |
| Mastered | The chapter card has interval of at least 21 days, at least 3 repetitions, last grade at least 4 (Good), and it is not due. Graded headings must meet the same bar. Headings you have not graded do not block this |

The knowledge graph does not store how well you know something. **In the knowledge graph** only means the notes importer has propositions for that chapter. It does not by itself change the status.

Dates are UTC days, so a review taken late in the evening in Japan can already be "tomorrow" in UTC.

## Sync from upstream

Keep the public repository as a fetch-only remote. Do not push to it, and do not open an upstream pull request from this fork.

```bat
git remote add upstream https://github.com/amosblomqvist/learnharness.git
git fetch upstream
git merge upstream/main
```

Optional, so a push cannot hit upstream:

```bat
git remote set-url --push upstream DISABLE_PUSH_DO_NOT_PUBLISH
```

On a conflict, take upstream's version for files this fork did not add, and keep the course-pack files listed in [NOTICE](../../NOTICE). `README.md`, `docs/README.md`, `docs/architecture.md`, and `components/sidebar.tsx` are the likely overlap.

## License

LearnHarness is AGPL-3.0-only, copyright Amos Blomqvist. This fork is a modification of that work. Personal use on your own machine does not by itself distribute the program. If you do distribute it, including letting other people use a copy over a network, AGPL-3.0's source-offer terms apply to the whole application.

Do not redistribute system-design-notes, or any other notes you import. That repository has no license, and the notes summarize a copyrighted book. The importer only reads them on your machine and stores the copy under your local app data.

## Desktop build

`npm run desktop:dist` in upstream is the signed macOS path. It is not the Windows build. Upstream's packaging notes say to build on Windows, run the shared prep steps in [Desktop builds and releases](../desktop-release.md), then:

```bat
npx electron-builder --win --x64 --publish never
```

That command was not run in this fork's development environment.
