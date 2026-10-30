# Lesson transfer (experimental)

Settings → **Lesson transfer** provides **Import** and **Export** for teaching or practice sessions. This is a general LearnHarness feature: reading or backing up a session does not require another app, an account, a provider connection or a compatible Android renderer.

## Choose the right format

| Mode | Contents | Intended use |
| --- | --- | --- |
| Readable Markdown / text | LearnHarness's shared transcript formatter: prose, learner responses, question outcomes and the current pending question. TXT removes generated heading prefixes but retains authored notation, including Markdown and LaTeX. | Reading, sharing text, using your own tools. Not a restorable backup. |
| Native lesson JSON | One original native file, byte-for-byte, including original IDs, unknown fields, tool history, hidden commitments, per-session model preferences and usage. | Inspecting or backing up one session. Does not include graph or external files. |
| Transfer ZIP | Selected original chat files, provenance-selected graph assertions, their required original node/chain definitions, selected notes-source metadata and explicitly selected eligible source files. An inventory includes byte counts and SHA-256 hashes. | Experimental multi-session transfer package. Dependencies and receiver capabilities still need checking. |

Readable exports reuse `sessionMarkdown`, not a second transcript implementation. Structured selected answers export their labels, not `[object Object]`; current learner thinking and older `note` fields are supported. Pending questions use the same pending authority and display parsers as the dock. Unrevealed commitments, explanations, reasoning, service markers and generic tool-result acknowledgements are not serialized into readable text; the extractor keeps its existing tool-note view. A practice solution already revealed by a successful conclusion follows the existing shared formatter's reveal policy. Answered quiz explanations remain omitted by that formatter; this is not an exact rendering of every collapsible UI card.

JSON and ZIP are **private native data**, not sanitized transcripts: they intentionally retain hidden model history and personal lesson contents. Account settings and credential stores are not automatically included. Any source file you deliberately include can itself contain private information. Review its full path before sharing.

## Export and safety

Select up to 100 sessions, choose a format, and click **Export**. Checks run automatically; there is no separate preview button or acknowledgement checkbox. JSON accepts one session. For ZIP, if eligible external files exist, an optional file-selection list appears before download; none are selected automatically. Click **Export** again to include your choices or leave all files out. ZIPs with files are currently for backup/tools, not installation in either app.

The exporter rechecks the snapshot and source metadata at download. Changing lessons or format discards previous file choices and repeats validation. Selected sessions with live generation, compaction, extraction or running background jobs are refused; export does not cancel their work. Snapshot creation and packaging are synchronous relative to in-process writers. This is not a multi-process library locking protocol.

Only absolute PDF, PNG/JPEG/WebP/GIF, TXT and Markdown source paths are eligible. Missing, relative/home-relative, symlink, private/credential-like, library-internal, unsupported-type and oversized sources are reported rather than guessed, followed recursively or silently included. No web URL is fetched. Inline HTML/JS, SVG and image payloads remain inert native record data; the exporter does not execute them or generate an active HTML download.

The ZIP has `manifest.json`, `chats/<native-id>.json`, `graph/nodes.jsonl`, `graph/chains.jsonl`, an optional original `graph/format.json`, optional selected `graph/sources.json`, and optional `files/<index>.<extension>` members. The proposed manifest identifies `learnharness-transfer`, version 1, native chat/graph schema versions, selected IDs, member inventory, source-path associations and a dependency report. Source paths are references, **not extraction/installation destinations**. Graph edges/layout are not exported as independent truth. Other sessions' transcripts and unrelated incident chains are excluded, even when external provenance is retained in required definitions.

Limits: 32 MiB total payload/ZIP, 16,000,000 bytes per native/source member, 512 KiB manifest, 100 sessions/source candidates, 10,000 messages per session or graph assertions per ledger, bounded UTF-8 JSON nesting. Chat schema v1 is supported (including the native convention of an absent version). Unsupported/newer graph versions or malformed graph assertions refuse ZIP; they do not block an otherwise supported text/native-JSON export.

**Completeness is not established:** `report.complete` stays false and `dependencyAudit` stays `partial`. Extraction coverage/checkpoints, running/resumable jobs, pending in-memory learner messages, global settings and credentials are not transferred. Unknown tool dependency schemas and external provenance are reported. There is no claim that this archive is a full library backup, self-contained lesson, automatic continuation permission or universally accepted import format.

## Import ZIP or JSON

Click **Import** and choose a source-free native v1 ZIP (lessons and graph) or a native lesson JSON (one lesson without a graph). Validation and installation run automatically. Only conflicts need another action: choose the local or imported active version for each conflict, then click **Import selected versions**. Both original JSON records are retained; identities are not renamed and duplicate sidebar lessons are not created. Errors block installation without partial changes. Selecting another file clears old conflict decisions.

There is no mandatory preview screen or acknowledgement checkbox. Short explanations state that imported lessons use local model settings and import starts no model requests; incomplete dependencies are still disclosed. A custom English Import button replaces the browser's locale-dependent file-input chrome; the system file dialog still follows the operating system language.

The receiver independently validates ZIP names, duplicate members, declared and actual inflation sizes, inventory hashes, UTF-8/JSON bounds, native identities and graph references/provenance. Sender completeness claims grant no authority. Unsupported versions, source registries and `files/*` are rejected, not extracted or silently discarded. Existing shared node definitions, chain identities and format metadata must agree. Graph assertions cannot depend on skipped conflicting history or relabel existing evidence from replaced messages. Combined ledgers must remain within the native bounds. Incompatible histories must stay in separate libraries rather than be merged by guesswork.

The upload handler rechecks revision, explicit decisions and writer liveness immediately before a synchronous install. All extraction and the selected lessons' generation, compaction and running jobs must be idle. Original lesson bytes and opaque metadata are preserved. Existing graph bytes stay in place and only unseen selected assertion lines are appended. `data/lesson-transfers/` contains retained JSON versions, original inert ZIP/JSON inputs and local explicit-input pause metadata. Saved-version downloads are no longer exposed in Settings; retention remains internal for conflict safety.

A rollback journal covers lesson, graph, marker and version writes. Interrupted installs are rolled back when the chat adapter starts, before serving requests; corrupt recovery state fails closed. This is single-process coordination and process-death recovery, not a multi-process lock or a power-loss guarantee. Do not run two servers against the same library. Preserve the entire data directory when backing it up, including transfer metadata.

New or replaced imported lessons can **continue with your local model settings**. Importing or opening them starts no model request. Automatic continuation, extraction and jobs stay paused until an explicit learner input, such as **Continue**, answering a question or sending a message. Foreign model/provider overrides are not adopted: the local lesson picker wins, otherwise the locally configured conversation model is used. Missing models or credentials open the existing setup flow rather than silently choosing an account. The first accepted input saves that local model choice and releases the pause; ordinary session behavior then resumes. A byte-identical existing local lesson keeps its existing policy. Deletion remains the existing explicit local-only operation; saved versions are not a remote deletion signal.

## Planned local-network sync (not implemented)

The agreed first version replaces manual ZIP handoff, not the importer: selected lessons and native
graph move over a narrow, explicitly enabled HTTPS endpoint. LearnHarness displays a pairing QR with
its local address, certificate fingerprint and short-lived single-use code; Reasoned confirms the
computer/library. The full application UI/API is not exposed to the LAN, and paired access can be revoked.

The phone initiates connections and can **send to the computer or receive from it**. Uploads go directly
through the desktop receiver, without a desktop file-picker step. Both apps must be reachable on the same
local network and LearnHarness must be running. Each exchange remains one-way and user initiated:
identical records are skipped, conflicts require an active-version choice, and both originals survive.
Success requires a committed-install receipt; interrupted transfers and lost acknowledgements must be
safe to retry without duplication. Existing validation and recovery remain authoritative.

No cloud, permanent background sync, automatic merging, deletion propagation or external-file import.
Account settings and credentials stay local; receiving/opening never invokes a model. Continue uses the
destination's local model settings after learner input. Pairing grants neither spend nor blanket overwrite
permission. This network feature still needs implementation and independent acceptance checks.

## Remaining limits

No external-file/source-registry installation or connected Sync. Continuation covers the supported native subset, not every historical tool/artifact or external dependency. Exports containing those broader source members remain useful for backup/tools but are not accepted by this receiver or Reasoned's current receiver. This is not a complete library backup or universal portability guarantee. Browser/Electron import and the full two-app manual conflict workflow remain unverified; synthetic installation evidence below is narrower.

## Offline checks

From the repository root:

```sh
NODE_ENV=test node --import tsx --test tests/lesson-export.test.ts tests/lesson-export-route.test.ts tests/lesson-import.test.ts tests/lesson-import-route.test.ts tests/render-lesson-transfer.test.tsx tests/session-core.test.ts tests/session-markdown.test.ts tests/markdown-export.test.ts
npx tsc --noEmit --incremental false
```

These tests use synthetic temporary libraries. Real HTTP handlers are exercised without a server, with outbound `fetch` forbidden. DOM checks cover the simple English controls, automatic ZIP/JSON import and source-free ZIP export, blocked imports, every conflict decision and invalidation when files/selections change. Optional source files still require explicit selection; there are no acknowledgement checkboxes. Store checks include byte preservation, duplicate imports, shared-graph conflicts, combined bounds, failure rollback and process-death recovery through actual adapter startup. Session checks pause automatic continuation while permitting explicit input. Route checks import/open without generation, reject missing local model configuration without releasing the pause, then continue through the real handler/agent/store with an offline faux engine and locally configured model; original messages and archived bytes survive. Pending imports block background compaction, extraction and job model resolution. The focused continuation/transfer/session, export and compaction selection passed 136 tests; TypeScript and scoped ESLint passed. No live provider requests were made.

A source-free synthetic ZIP passed desktop export → Reasoned's disposable SQLite import/runtime export → this receiver's install/reimport → desktop ZIP re-export → a second disposable Android import/export, with original payload bytes and desktop graph fold checked and zero provider requests. Reasoned's `scripts/check-learnharness-transfer-export.mjs install` exercises the real receiver only in its marked disposable library. Separately, an authored fractions sample ZIP saved through Android's UI installed here with three nodes and one chain, exact lesson bytes and idempotent re-import. Neither check used an installed desktop library. These are bounded store/runtime checks, not real-browser/Electron, continuation or full-suite acceptance.

## Manual check without your installed library

Use a separate development server and an isolated synthetic library. In Bash / Git Bash:

```sh
export LH_DATA_DIR="$(node -p 'require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lh-export-demo-"))')"
export LH_AUTH_FILE="$LH_DATA_DIR/auth.json"
node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const root = process.env.LH_DATA_DIR; if (!root) throw Error("Isolated data directory required"); fs.mkdirSync(path.join(root, "chats"), { recursive: true }); fs.writeFileSync(path.join(root, "chats/chat_export_demo.json"), JSON.stringify({version:1,id:"chat_export_demo",title:"Synthetic export example",createdAt:"2026-10-30T00:00:00Z",updatedAt:"2026-10-30T00:00:00Z",messages:[{id:"example_user",role:"user",content:"Authored offline export example, not learner evidence.",timestamp:1}]})); console.log(root);'
npm run dev
```

Open the development URL, then Settings → Lesson transfer; do not start a lesson or enter credentials. Select **Synthetic export example**. Download each readable variant and JSON. Choose ZIP and click Export; check `manifest.json` and that the chat matches the original file. For an import check, keep using this isolated library: click Import and select a source-free synthetic ZIP or lesson JSON. It installs automatically unless there are conflicts; explicitly choose active versions if prompted. Open the imported lesson and confirm its controls are usable and no generation starts; without configuring a provider or clicking Continue/Send, repeat the import to check no duplicate lesson appears. Test conflicts only with authored copies, never your installed lessons.

Stop the development server afterward. Remove only the printed synthetic directory when finished, and unset `LH_DATA_DIR` and `LH_AUTH_FILE`; do not run cleanup against your real LearnHarness directory.
