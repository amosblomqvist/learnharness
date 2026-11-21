# Shared Memory

A LearnHarness plugin that sends knowledge-graph propositions to a **shared memory**:
a memory store outside LearnHarness that coding agents share, served by a
shared-memory MCP server. Each proposition becomes one memory. Nothing is sent
automatically: you choose what to send, and writes to shared memory cannot be undone.

The plugin only writes to shared memory. Reading shared memory back into lessons is
out of scope. It never writes LearnHarness learning data: the graph is read through
the read-only `ctx.learning.graph()`.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| URL | `http://127.0.0.1:7820/mcp` | MCP endpoint (Streamable HTTP). Must be an `http` or `https` URL. |
| Scope | `project:learning` | Scope of every memory written. Must not be blank. |

There are no other settings. Each write has a fixed 15-second deadline, including
connecting. If the shared-memory server runs on another machine, forward it to
`127.0.0.1:7820` (for example with SSH port forwarding) and keep the default URL.

## States

The plugin compares the graph with its **sent record** (what was sent, with which
content, and which memory it became) and gives every proposition a state:

| State | Meaning | Listed |
| --- | --- | --- |
| Unsent | Never sent, or retired and now back in the graph | Yes |
| Changed | Sent, but its content differs from what was sent | Yes |
| Removed from graph | Sent, but no longer in the graph | Yes |
| Sent | Content matches what was sent | No |
| Retired | Its retirement memory was written | No |

Content means the statement, aliases, premises of the chains concluding it, sources
and cluster name; a hash of it (the fingerprint) is kept in the sent record. A
proposition that leaves the graph without ever being sent is simply forgotten.

## What is written

Each proposition is written with the shared-memory `write` tool:

- `title`: the proposition name.
- `content`: the statement, then `別名: …` when it has aliases, then a
  `## 前提（この命題を導く推論の連鎖）` section with one bulleted list per chain that
  concludes it (omitted without chains), then a `## 出典` section listing each
  source session as `<title> (<date the proposition was recorded>)` and each
  imported note by its file name.
- `scope`: the configured scope; `kind`: `semantic`; `provenance`: `agent_inferred`;
  `source_agent`: `learnharness`.
- `tags`: `learnharness`, plus the cluster name when the proposition belongs to a
  labeled cluster.
- `supersedes`: the previous memory id when sending a changed proposition, a
  retirement, or a proposition that returned after retirement. A first send has none.
- `source_path` is never sent: learning-data paths are local to this computer.

Sending a removed proposition writes a retirement memory titled `廃止: <name>` with
the body `LearnHarness の知識グラフから消えたため廃止した。`, superseding the last memory.

## Backend operations

The backend registers five operations with `ctx.handle`:

| Operation | Input | Result |
| --- | --- | --- |
| `list` | none | `{ items, progress }`. `items` holds unsent, changed and removed propositions as `{ id, name, statement, state, reason? }` (`statement` is `null` once removed). `progress` is `{ sending: false }` or `{ sending: true, total, done, stopping }`. |
| `send` | `{ ids }` | Writes the selected propositions one at a time, in order. Returns `{ stopped, total, done, results }`; each result has `id` and `outcome` (`written`, `failed`, `skipped` for propositions with nothing to send, or `not-sent` after a stop). |
| `stop` | none | Returns at once (`{ stopping }`). The write in flight finishes and is recorded if it succeeds; propositions whose turn has not come are not written and keep their state. |
| `get-settings` | none | `{ url, scope }` |
| `set-settings` | `{ url?, scope? }` | Validates, saves and returns `{ url, scope }`. Invalid values are refused and nothing is saved. |

While sending, the backend emits `progress` notifications (`{ sending, total, done,
stopping }`) after each proposition and a `finished` notification
(`{ stopped, total, done }`) at the end. Notifications are live only, so `list`
also reports progress for a view opened mid-send.

Only successful writes change the sent record. A failed proposition keeps its state
and is listed with a reason: `unreachable` (cannot connect), `timeout` (no answer
within 15 seconds) or `rejected` (the server's message, verbatim, for example when
it detects a secret). Activation does not contact shared memory, so the plugin
enables even while the server is down.

## Screens

- **Send to Shared Memory** is a view opened from a sidebar action of the same name.
  It shows the backend's `list` as it is: each proposition with its state and, after a
  failed send, the reason. Tick the propositions to send, or use **Select all**, then
  press **Send selected**. While sending it shows how many of the selected are done
  (from the `progress` notifications; a view opened mid-send reads the same from
  `list`). **Stop** calls `stop` and returns at once; the stop shows in the send result
  or the `finished` notification. The list is read again after every send and on
  reconnect. The view decides no state itself.
- **Settings** has two rows, URL and Scope. Values are read with `get-settings` and
  saved with `set-settings`; a refused save shows as an error and the row keeps its
  last saved value.

## Data

The sent record and the settings are JSON files in `ctx.dataDirectory`, written
atomically (temporary file, then rename). They survive app updates and
disable/enable. Failure reasons are kept in memory only.

## Build

Install the locked development dependencies, then build from this folder:

```sh
npm ci
npm run build
```

The build writes `dist/manifest.json`, `dist/main.js` (the browser module, ES module),
`dist/styles.css`, `dist/backend.cjs` (the backend bundled with
the MCP SDK client, Node built-ins external), `dist/backend.cjs.LEGAL.txt`,
`dist/LICENSE` and `dist/README.md`. The legal file is generated: it lists every
third-party package esbuild bundled, with its version, declared license and license
file text. The build fails if a bundled package has no license file. It refuses a
linked `dist/` and any `dist/data/` entry.

## Tests

```sh
npm test
```

The tests call `activate(ctx)` with a fake context (a stub graph and a temporary data
directory) and a loopback fake shared-memory MCP server that can accept, reject or
delay writes. They check operation results, notifications and the write calls the
fake server received. One test waits for the 15-second timeout. They never contact a
real shared-memory server.

## License

AGPL-3.0-only. See [LICENSE](LICENSE). Bundled third-party licenses are listed in
the generated `dist/backend.cjs.LEGAL.txt`.
