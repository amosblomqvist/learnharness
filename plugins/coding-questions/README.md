# Coding questions

A small teacher-only LearnHarness plugin: native coding questions with an editable,
syntax-colored answer and optional starter code. The ordinary teacher reviews the
submission. **No learner code is executed, tested, or automatically graded.**

## Requirements and installation

Requires LearnHarness's public native-question API (`registerQuestionType` and
`registerQuestionRenderer`) and the current host's Enter-to-submit question-key default.
The native-question API first appeared on the plugin-architecture branch at checkpoint
`99373a1`; that older checkpoint alone predates the keyboard default used here.
These capabilities are not available in the released 0.4.1 app. The manifest's
`minAppVersion: 0.4.1` is only the numeric baseline, not a promise that the released
0.4.1 includes these APIs.

Build the package as below, then copy the **contents of the built folder**
`dist/coding-questions/` to the writable plugins directory as `coding-questions/`.
The installed folder must directly contain `manifest.json`, `main.js`, `backend.cjs`,
`styles.css`, and `assets/`. Do not install this source project or its `node_modules`.
Refresh Settings → Plugins, then enable **Coding questions**. Restart LearnHarness
when replacing loaded code. Preserve any existing plugin `data/` during replacement.
App-bundled official distribution is a separate host packaging step.

## Behavior

The plugin contributes `coding_question` only to the **teacher**, not the prober or
practice agent. The teacher chooses it for code-writing/editing predictions or checks.
The native tool receives the host's `question`, `type` (`predict`/`check`), `nodeId`,
and a payload `{ language: string, starterCode?: string }`. A missing/empty starter
starts blank; the learner submits their full code, not a diff. Unchanged starter code
is allowed. The answer must contain a non-whitespace character; it is not graded by
client validation. Editor line endings become LF; other whitespace is preserved.

The host supplies Markdown question presentation, the card, reveal/folding, thinking
and reading-thinking, microphone, model/thinking controls, Submit answer and recovery-only
Dismiss, native
persistence and teacher continuation. **Dictation always targets host thinking,
never code.** The plugin does not opt into answer dictation. Checks retain the host's
reading-before-reveal flow. Submitted code has a read-only highlighted presentation;
the host displays thinking separately.

The lean CodeMirror 6 editor includes line numbers, undo/redo, bracket matching,
four-space Tab indentation and Shift+Enter newline auto-indentation. **Enter submits**
through the host, from both the code editor and host thinking field; **Shift+Enter inserts
a newline**. Cmd/Ctrl+Enter also submits. The plugin handles Tab and Shift+Enter editing
only; it delegates plain Enter to the host and implements no submit action. Shift+Tab keeps the host's
model-thinking shortcut; Escape has no plugin-specific action. Long lines scroll
horizontally. No autocomplete, automatic bracket insertion, diagnostics, formatter,
fold controls, run/copy toolbar, or IDE services are included.

The complete standard `@codemirror/language-data` catalog ships locally. Language
names/aliases load highlighting on demand; unknown languages or failed language loads
remain usable as plain text. There are no downloads, language settings or restrictions.
CodeMirror One Dark syntax colors sit inside a host-themed monospace code-block frame.

Pending questions and submitted answers are durable host records. Unsubmitted code
and thinking use **host in-memory drafts**: folding/remounting while the session model
lives retains drafts, but model-destroying navigation, reload and app restart need not.
The plugin owns no persistent records, backend RPCs, views or settings.

## Development

From this directory, with the matching LearnHarness checkout installed:

```sh
npm run sdk                 # emits matching public declarations into ignored .sdk/
npm ci --ignore-scripts
npm run typecheck            # strict public SDK consumer, skipLibCheck=false
npm test
npm run build
npm run test:browser         # real Chrome, built plugin and disposable local fixture
```

Alternatively copy a matching packaged app's `plugin-authoring/types/` contents into
`.sdk/` before `npm ci`; the runtime plugin never imports the SDK. The build bundles
all JavaScript dependencies, emits ESM frontend/CommonJS backend and local `assets/`
chunks, and includes third-party license notices. No host package/configuration changes
or runtime dependency installation are required.

Browser tests use `CHROME_PATH` if set, otherwise the usual macOS/Linux Chrome paths.
A separate packaged-native smoke takes `LH_STANDALONE` pointing to an existing verified
standalone payload; it copies that payload to disposable storage and never rebuilds or
mutates the source payload:

```sh
LH_STANDALONE=/path/to/verified/standalone npm run test:native
```
All verification must use temporary learner/auth directories and loopback model
fixtures, never real learner data/accounts or paid provider calls.

## Verification checkpoint

Strict SDK type checking, five contract/catalog tests (including loading all 143
catalog entries), scoped ESLint, the production plugin build, and the real-Chrome
built-plugin checks pass. Browser checks cover exact whitespace, readiness, Tab,
plain-Enter delegation/submission without code mutation, Shift+Enter auto-indent,
Cmd/Ctrl+Enter, synthetic composition-marked/229 Enter guards, undo/redo,
selection/controlled updates, inactive editors, local language
loading/failure, unknown-language fallback, no HTML/XML/JSX auto-tag insertion,
read-only answers and late-load/abort cleanup. The dependency audit reports no known
vulnerabilities at this checkpoint.

The earlier source-free packaged checkpoint passed under Electron's Node and real
Chrome: genuine teacher prediction and submitted TEACH CHECK, exact code plus separate
reading/answer thinking, natural fold/selection retention, native field framing and
thinking placement/defaults, then a fresh disabled-plugin check with recovery-only
occurrence-bound dismissal. All five native streams reached `[DONE]`, with no page
errors or off-origin requests; the original verified payload digest was unchanged.
That checkpoint preceded the new Enter default and does not prove the keyboard change.
The revised native harness additionally submits a prediction using plain Enter from
code and a check using plain Enter from host thinking, verifies Shift+Enter newlines,
and probes synthetic composing/229 Enter suppression. It must run against the matching
updated host payload, not the previous checkpoint. No real microphone, OS IME, paid
provider, real-model evaluation, signed installer, full Electron window, or Windows/Linux
runtime behavior is claimed.

## API boundary

Only type-only `learnharness-plugin-api` imports and public registration contracts are
used. No private host modules/React components, DOM injection into host-owned controls,
submission interceptors, workers, separate agents, or custom question lifecycle exist.
Contract version 1 uses a string answer and payload language/optional starter code.
Unavailable/disabled plugin behavior and safe dismissal remain host-owned. If the
public API cannot support a required behavior, stop and request an explicit host fix.

Licensed AGPL-3.0-only. Built packages include `THIRD-PARTY-LICENSES.txt` for bundled
CodeMirror/Lezer and supporting libraries.
