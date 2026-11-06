# Coding questions

A teacher-only LearnHarness plugin with a syntax-colored code editor, optional starter
code, and teacher-written tests that run automatically on submission. The teacher then
reviews the exact answer, separate thinking, and recorded test outcome.

**Local code execution is not sandboxed.** Teacher test code and learner code run with
LearnHarness's user permissions and inherited environment: they can access files,
network, and installed programs. A temporary working directory, timeout, and output
limits are operational safeguards, not security isolation. Use only with code you trust.

## Requirements and installation

Requires a matching LearnHarness build with the public native-question grading API
(`registerQuestionType` with `gradeAnswer`), `registerQuestionRenderer`, and
`ctx.ui.mountBadge`. The manifest's `minAppVersion: 0.4.1` is only the numeric baseline:
the released 0.4.1 app does **not** provide these newer APIs.

Runtimes, compilers, shells, and any required libraries must already be installed on
the user's machine. This plugin bundles none of them and installs nothing. Programs
resolve through the app process's **PATH**, which may differ from an interactive
terminal, or through an explicit executable path supplied by the teacher. There is no
version-checker tool, runtime catalog, package installer, or per-language runner table.

Build the package as below. The output is this project's **`dist/`**, containing
`manifest.json`, `main.js`, `backend.cjs`, `styles.css`, and `assets/`. For distribution,
copy those **`dist/` contents** into `<learning data>/plugins/coding-questions/dist/`,
not directly into `coding-questions/`. Do not distribute source, `node_modules`, or data.
Alternatively keep this source project at `<learning data>/plugins/coding-questions/`
and build in that workspace: the host always finds `dist/manifest.json` there.
No separate development registration is needed; a root-only manifest is not loaded.
Refresh Settings → Plugins after installation, then enable **Coding questions**.
Restart LearnHarness when replacing already loaded code. Build cleanup replaces only
`dist/` and refuses symlinked `dist/` or misplaced `dist/data/`; preserve persistent
sibling `coding-questions/data/` during replacement. App-bundled official distribution
is a separate host packaging step.

## Question and test contract

The plugin contributes `coding_question` only to the **teacher**, not the prober or
practice agent. The native tool receives the host's `question`, `type`
(`predict`/`check`), `nodeId`, and this payload:

```ts
{
  language: string;
  starterCode?: string;
  tests: {
    program: string;
    args: string[];
    code: string;
  };
}
```

Every **new** question requires tests. A missing/empty starter starts blank; the
learner submits their full code, not a diff. Unchanged starter code is allowed.
Readiness requires non-whitespace code, not passing syntax checks or passing tests.
Editor line endings become LF; other whitespace is preserved.

On a valid submission, before saving and continuing the teacher, the plugin:

1. Creates a fresh `data/test-runs/<questionId>/attempt-…/` working directory.
2. Writes the exact submitted code to **`answer.txt`** as UTF-8.
3. Launches `tests.program` with the literal `tests.args`, **without an implicit shell**,
   and sends `tests.code` to its standard input. The working directory is the fresh run.
4. Records the exit status and up to **64 KiB per stream** of stdout/stderr, draining
   excess output. Text is decoded as UTF-8; truncated incomplete final characters are
   omitted. Enforces a **30-second** process deadline.
5. Removes the attempt directory, including compiler output and other files written
   inside it. Empty question directories can remain. The host saves the accepted
   answer and grading outcome and continues the ordinary teacher.

There is no language-specific execution convention to maintain. The teacher chooses
an installed interpreter or shell and writes the complete driver/test code. For example,
Python tests can be supplied in the original tool call as:

```json
{
  "language": "Python",
  "starterCode": "def square(x):\n    pass\n",
  "tests": {
    "program": "python3",
    "args": ["-"],
    "code": "from pathlib import Path\nnamespace = {}\nexec(compile(Path('answer.txt').read_text(encoding='utf-8'), 'answer.txt', 'exec'), namespace)\nassert namespace['square'](3) == 9\nassert namespace['square'](-2) == 4\nprint('Two supplied tests passed')\n"
  }
}
```

For C++, the teacher can choose `program: "sh"`, `args: ["-s"]` and send a shell
script that writes a small test driver including `answer.txt`, invokes the user's
compiler, then runs the executable. JavaScript can use `node` with `["-"]`; other
languages use whichever installed tools can interpret or compile the supplied driver.
The teacher is responsible for genuinely checking the answer and exiting nonzero
on test failure. A shell is an explicit program choice, never runner interpolation.
Tests must not install/download runtimes, compilers, or packages or change machine
configuration. No separate teacher tool call or workspace-management step is needed.

### Results and lifecycle

The saved grading result has this product-owned JSON shape:

```ts
{
  status: "passed" | "failed" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  message?: string;
}
```

Exit 0 shows a green **Tests passed** badge; nonzero shows red **Tests failed**.
Missing programs, launch errors, timeouts, or unexpected signal termination show
neutral **Could not run tests**. An unexpected grader/workspace failure is recorded by
the host as `grading.error` and also gets the neutral presentation. All these completed
outcomes accept the answer and continue the teacher; they are not validation rejections.
They describe the supplied tests, **not correct/incorrect**, and there is no score.

The badge sits immediately after **Coding question** in the host's heading, like a
native question result. The optional public `mountAnswered` `headerContainer` slot is
owned by that mount's host generation; older hosts without it retain body-position
fallback. No surrounding host DOM is queried or modified.

The initially closed **Test output** disclosure has native-looking hover/focus feedback
and a rotating chevron. It retains native `<details>/<summary>` expansion and keyboard
activation semantics. Stdout and stderr use the same read-only code-block frames as
submitted code, with plain text, error messages, and explicit truncation notices. Each
stream retains its 16rem scrolling height cap. Output is never interpreted as HTML.
There is no rerun control or automatic regrading.

The host owns submission admission, persistence, and continuation. Stop, plugin
disable, and lost submission authority cancel grading without saving an answer;
navigation alone does not cancel it. Failed-save/cancelled submissions require an
explicit learner retry, which may run tests again. Tests should therefore be retry-safe;
execution is not an exactly-once guarantee. Outside the code editor, Escape offers the
host's existing **Dismiss this question?** confirmation. Cancel/Escape keeps the draft;
confirmation skips only the captured question occurrence, without starting a teacher
turn. If tests are running, the same server request validates the target, parks its
dismissal, and stops the run before returning. A stale confirmation cannot stop or
skip a successor question. Normal overlay/dictation Escape priority remains intact.
Process-tree termination is best-effort:
POSIX process groups are killed, but a process that creates a separate session may
survive; Windows tree termination uses `taskkill` and has not been verified. Escaped
processes cannot keep the runner waiting indefinitely on inherited output pipes after
the deadline or cancellation. Files written outside the run directory are not removed.

Historical questions without the saved grading requirement remain ungraded; they
are not retroactively executed or rewritten. New graded snapshots use the host's
protocol 2, while this plugin's compatible question contract remains version 1.
**Do not downgrade the host with graded questions pending:** an older host can cancel
an unreadable protocol-2 question rather than merely displaying it as unavailable.

## Editor and native question behavior

The host supplies Markdown question presentation, the card, reveal/folding, thinking
and reading-thinking, microphone, model/thinking controls, Submit answer and
recovery-only Dismiss, native persistence, and teacher continuation. **Dictation always
targets host thinking, never code.** Checks retain reading-before-reveal. The host
places the learner's thinking separately from the plugin's code/result presentation.

The lean CodeMirror 6 editor includes quiet line numbers, undo/redo, bracket matching,
four-space Tab indentation and newline auto-indentation. **Enter and Shift+Enter insert
a newline inside code**; **Cmd/Ctrl+Enter submits** through the host. Host thinking
keeps Enter-to-submit and Shift+Enter-to-newline. The plugin handles editing keys only
and implements no submit action. **Escape in the active code editor moves focus to
Your thinking**, without opening the dismissal dialog or changing the draft. From
there Enter submits; Tab continues the host field cycle (reading thinking → code →
Your thinking for checks; code → Your thinking for predictions). Tab inside code
still indents. Shift+Tab keeps the host's model-thinking shortcut. This is field
navigation only, not an app-wide browser Tab-order redesign. Long lines scroll horizontally. No autocomplete,
automatic bracket insertion, formatter, fold controls, run/copy toolbar, or IDE services
are included.

### Live syntax feedback

Python, JavaScript, TypeScript, C, C++, Java, Rust, Go, and JSON get advisory syntax
feedback from bundled parsers. Catalog aliases such as `js`, `ts`, and `cpp` follow the
canonical language policy. After a 300ms typing pause, parser problems appear as red
underlines or point markers with a **“Syntax problem.”** hover message. There is no
extra gutter, problems panel, shortcut, automatic fix, or code modification. Saved
read-only answers do not show diagnostics.

This is parser feedback, not compiler validation or type checking. An unmarked answer
may still contain errors; large answers use the available parsed region without
forcing a full-document parse. Other languages retain highlighting only; in particular,
the bundled SQL parser is not a SQL validator. Diagnostics never block submission.

The full standard `@codemirror/language-data` catalog ships locally. Language aliases
load highlighting on demand; unknown languages or failed loads remain usable as plain
text. There are no highlighting downloads, language settings, or language restrictions.
CodeMirror One Dark colors sit inside a host-themed monospace frame.

Pending questions and submitted answers are durable host records. Unsubmitted code
and thinking use **host in-memory drafts**: folding/remounting while the session model
lives retains drafts, but model destruction, reload, and app restart need not. The
plugin has no custom durable answer store, backend RPCs, views, or settings.

## Development and verification

From this directory, with the matching LearnHarness checkout installed:

```sh
npm run sdk                  # matching public declarations into ignored .sdk/
npm ci --ignore-scripts
npm run typecheck            # strict public SDK consumer, skipLibCheck=false
npm test                     # includes real local Node processes and 30-second limits
npm run build
npm run test:browser          # real Chrome, built plugin and disposable local fixture
```

Alternatively copy matching packaged `plugin-authoring/types/` contents into `.sdk/`.
The runtime plugin never imports the SDK. The build bundles JavaScript dependencies,
emits ESM frontend/CommonJS backend and local `assets/` chunks, and includes third-party
license notices. No host package/configuration changes or runtime installs are required.

Browser tests use `CHROME_PATH` or the usual macOS/Linux Chrome paths. A packaged-native
smoke requires `LH_STANDALONE` pointing to a **matching grading-capable verified host**;
it copies that payload to disposable storage without rebuilding or mutating the source:

```sh
LH_STANDALONE=/path/to/verified/standalone npm run test:native
```

All verification uses temporary learner/auth directories and loopback model fixtures,
never real learner data/accounts or paid provider calls. Earlier nongrading host
payloads are not sufficient proof for this feature.

Coverage includes contract/catalog and nine-language parser diagnostics; exact answer
and stdin bytes; literal arguments and inherited environment; fresh workspace cleanup;
launch failures; nonzero exits; output caps/Unicode boundaries; timeout/abort, inherited
pipes, and escaped-session settlement; public grader registration; result parsing;
editor keyboard/readiness/selection/fold behavior; heading-slot badge alignment and
older-host fallback; output disclosure hover/focus/chevron and Enter/Space activation;
matching code-block frames and scrolling; saved history and mount/abort cleanup. The native harness covers genuine teacher prediction/check
turns, passing and failing semantic tests using installed Node, a missing-program run
error, canonical/model-facing grading, separate thinking channels, read-only code,
collapsed escaped output, and disabled-plugin occurrence-bound dismissal. No real
microphone, OS IME, paid provider, real-model correctness, signed installer, full Electron
window, or Windows/Linux runtime behavior is claimed.

The fresh packaged-native check passed under Electron's Node runtime and real Chrome:
all eight expected streams reached `[DONE]`; genuine passing, failing, and missing-program
outcomes reached saved answers and the next teacher request; badges appeared in the
host heading; closed output expanded into escaped code-block frames; trusted Escape/Tab
navigation, Cancel/dialog Escape draft preservation, healthy confirmed skip, and disabled
recovery dismissal passed without extra teacher turns. There were no page errors,
off-origin requests, or media attempts, and the verified source payload stayed unchanged.
The slow-run busy-dismiss and stale-confirmation safety paths have focused host coverage,
not an additional slow-run scenario in this product-native harness. Local evidence:
`/private/tmp/lh-coding-native-9Lecpr/evidence.json`.

## API boundary

Only type-only `learnharness-plugin-api` imports and public registration/UI contracts
are used. Backend execution uses Node built-ins, not private host imports. The optional
public `gradeAnswer` hook supplies the host-owned await/save lifecycle, and the optional
answered-only `headerContainer` supplies a bounded heading suffix mount; the plugin adds
no submission interceptor, worker, separate agent, or custom question lifecycle. The
answer stays a string; grading is separate metadata. Unavailable/disabled behavior and
safe dismissal remain host-owned. If the API cannot support a required behavior, stop
and request an explicit host fix.

Licensed AGPL-3.0-only. Built packages include `THIRD-PARTY-LICENSES.txt` for bundled
CodeMirror/Lezer and supporting libraries.
