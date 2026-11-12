# Coding questions

A LearnHarness plugin for **teaching questions and coding practice**, with a syntax-colored
code editor, optional starter code, committed Markdown model solutions, and agent-written
tests that run automatically on submission. The agent reviews the exact code, separate
thinking, and recorded test observations. Practice allows repeated attempts; only the
native **conclude** tool assesses and closes the problem.

**Local code execution is not sandboxed.** Before submitting, the learner sees the exact
test command and test code under **Tests that will run on this computer** and must tick
**Run these tests on my computer when I submit**; Submit stays disabled until then.
Teacher test code and learner code then run with LearnHarness's user permissions: they
can access files, network, and installed programs. Environment variables whose names
end in `_KEY`, `_TOKEN` or `_SECRET`, or contain `PASSWORD`, are removed, so saved API
keys are not in the test environment. A temporary working directory, timeout, and output
limits are operational safeguards, not security isolation. Approve only tests you understand.

## Requirements and installation

Requires a matching LearnHarness build with the public native-question grading API
(`registerQuestionType` with `gradeAnswer`), `registerQuestionRenderer`, the practice APIs
`registerProblemType` with `processSubmission` and `registerProblemRenderer`, and
`ctx.ui.mountBadge`/`ctx.ui.mountMarkdown`. Both registrations are required for this version.
Exact placement of Test output and teaching Model solution uses the optional answered/
submitted `footerContainer` slots; compatible hosts without these slots keep a readable
body fallback. The manifest's `minAppVersion: 0.4.1` is only the numeric baseline:
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
practice agent. Practice agents separately receive `coding_problem` (see below). The native tool receives the host's `question`, `type`
(`predict`/`check`), `nodeId`, and this payload:

```ts
{
  language: string;
  starterCode?: string;
  modelSolution: string; // Markdown with fenced solution code and optional explanation
  tests: {
    program: string;
    args: string[];
    code: string;
  };
}
```

Every **new** question requires tests and a nonblank Markdown **modelSolution**, authored
in the original question call. The solution contains fenced model code and may include
an explanation; it is preserved with the question, hidden in the pending UI, and shown
only after submission. It is not executed or automatically tested. Existing questions
without it keep their original data and have no Model solution toggle.

A missing/empty starter starts blank; the learner submits their full code, not a diff. Unchanged starter code is allowed.
Readiness requires non-whitespace code and the ticked test approval, not passing syntax
checks or passing tests. The approval belongs to the open editor only: it is not saved,
and a re-created question card starts unticked.
Editor line endings become LF; other whitespace is preserved.

On a valid submission, before saving and continuing the teacher, the plugin:

1. Creates a fresh `data/test-runs/<questionId>/attempt-…/` working directory.
2. Writes the exact submitted code to **`answer.txt`** as UTF-8.
3. Launches `tests.program` with the literal `tests.args`, **without an implicit shell**,
   and sends `tests.code` to its standard input. The working directory is the fresh run,
   and the environment is the app's without secret-like variables (see above).
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
  "modelSolution": "```python\ndef square(x):\n    return x * x\n```\n\nMultiply the value by itself.",
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

Inside an answered card the order is **original question → submitted code → Your thinking →
Test output → Model solution**. The original saved `input.question` is always rendered
above the code through the public host Markdown renderer, including in existing history;
no new storage, migration, or question regeneration is needed. Both disclosures start closed and use quiet, content-width text buttons
matching the native quiz's **Why** control: inherited UI font, 11px text, and text-only
hover feedback. There is no chevron, uppercase styling, or full-row background. Expanded
labels are **Hide test output** and **Hide model solution**; native button Enter/Space
activation and visible keyboard focus are retained.

Test output appears only for captured text, an error message, or a truncation notice.
Nonempty stdout/stderr use matching code-block frames and code typography, with a 16rem
scrolling cap per stream; whitespace is preserved and empty streams do not get boxes.
Output is never interpreted as HTML. Model solution uses the public host Markdown
renderer, including fenced code and explanation, mounted only while open. Both disclosures
share the optional public `footerContainer`, a generation-owned block below host thinking;
without that
slot the plugin retains readable body fallback rather than moving or querying host DOM.
There is no rerun control, automatic regrading, or reference-solution execution.

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

## Coding practice

Practice agents receive the **coding_problem** posing tool, registered separately as
problem type `code`, label **Coding problem**, contract version 1. The plugin/package name
remains **Coding questions**. Teacher tooling and existing teaching history are unchanged.
The host supplies the common fields:

```ts
{
  statement: string;
  mode: "recall" | "discrimination" | "composition";
  target?: string[];
  modelSolution: string; // committed Markdown solution, revealed only by conclusion
  payload: {
    language: string;
    starterCode?: string;
    tests: { program: string; args: string[]; code: string };
  };
}
```

Language and tests are required. The model solution is a **host common field**, never
repeated inside the plugin payload. It is committed at pose time and never executed.
The statement remains in the host's durable problem card; it is not duplicated on every
submission. The dock uses the same editor, diagnostics and editing keys, followed by
host **Your thinking** and one **Submit** button. There is no reading/reveal stage.

Each nonblank submission runs the same recipe against `answer.txt`, with the same
limits, permissions and cleanup described above. Its fresh attempt directory is grouped
under `data/test-runs/<problemId>/`. The exact submitted code, separate thinking and
`processing: {result: CodingTestResult} | {error: string}` are saved by the host before
one ordinary practice continuation. Test failures and run errors are observations on
accepted attempts, not admission rejections or a final correctness assessment.

The learner can revise and submit repeatedly on the same active problem. Acceptance
retains the editor value/undo state for iteration; only captured thinking that has not
changed is cleared by the host. Native/plugin problems share one active-problem gate.
**Only the existing conclude tool** assesses/closes the problem and reveals the original
committed model solution in the native conclusion card. Passing tests never auto-concludes,
and individual attempts have no Model solution toggle.

Each saved attempt shows read-only code and its Tests passed/Tests failed/Could not run
tests heading badge. The order is **submitted code → Your thinking → Test output**.
Test output uses the same quiet, initially closed disclosure and hidden-empty-output
policy as teaching. It uses the public `mountSubmitted` `footerContainer` below host
images/thinking and `headerContainer` for the badge; either missing slot has body fallback.
Older attempts are never overwritten or reprocessed when a later revision is submitted.
Processing absent from a saved record does not invent a badge or run tests retroactively.

Cancellation follows the host processing signal and existing runner cleanup; no late
result may save after authority is lost. Navigation/disconnection alone does not cancel
accepted work. Explicit retry may execute tests again. Missing/disabled/incompatible
plugins keep an active problem unavailable rather than substituting a native text editor;
the learner can use native practice dismissal. Escape in code leaves for thinking;
Escape outside uses the native practice confirmation/layer precedence.

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

Pending questions/problems and submitted answers/attempts are durable host records. Unsubmitted code
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
smoke requires `LH_STANDALONE` pointing to an **existing matching verified host with
question grading, practice registrations and answered header/footer slots**;
it copies that payload to disposable storage without rebuilding or mutating the source:

```sh
LH_STANDALONE=/path/to/verified/standalone npm run test:native
```

All verification uses temporary learner/auth directories and loopback or faux model fixtures,
never real learner data/accounts or paid provider calls. Earlier nongrading or pre-practice-API
host payloads are not compatible verification targets for this version.

Coverage includes contract/catalog and nine-language parser diagnostics; exact answer
and stdin bytes; literal arguments and inherited environment; fresh workspace cleanup;
launch failures; nonzero exits; output caps/Unicode boundaries; timeout/abort, inherited
pipes, and escaped-session settlement; public grader registration; result parsing;
editor keyboard/readiness/selection/fold behavior; heading-slot badge alignment and
older-host fallback; Why-matched typography, text-only hover, quiet Enter/Space toggles,
silent-run hiding and whitespace/truncation preservation; matching code-block frames and
scrolling; required model-solution schema, hidden pending solution, exact public Markdown
arguments, preserved visible question before code in historical and graded answers,
independent open/close, saved history, footer ordering and mount/abort cleanup. Practice
coverage additionally exercises separate public registration and schemas, real repeated
runner observations and cancellation, controlled submission props without question-only
fields, retained editor state, independent saved attempts, hidden committed solution,
footer ordering, body fallback and per-attempt abort isolation. Host practice tests cover
processing/save/continuation and native conclusion, including footer replay/failure cleanup.
An isolated actual-host/faux-agent integration also activates the real coding backend,
poses through coding_problem, runs real installed Node tests for three accepted attempts,
checks one continuation per attempt and no auto-conclusion on passing tests, then verifies
native conclude reveals the original committed solution.
These browser checks use a disposable host fixture; they are not a packaged-app or
real-provider proof of coding practice.
Focused host tests cover slot-generation isolation, readonly SDK capabilities and actual
host Markdown rendering of model code plus explanation. The native harness covers genuine teacher prediction/check
turns, passing and failing semantic tests using installed Node, a missing-program run
error, canonical/model-facing grading, separate thinking channels, read-only code,
collapsed escaped output, and disabled-plugin occurrence-bound dismissal. No real
microphone, OS IME, paid provider, real-model correctness, signed installer, full Electron
window, or Windows/Linux runtime behavior is claimed.

The teaching packaged-native harness has been updated for the quiet controls and model
solution, but has **not been run for this UI/practice increment** against a new matching
host payload. It does not exercise coding-practice turns.
Earlier grading/header native proof does not establish this increment's native runtime
proof. No application build, packaging, notarization, or installation is part of this
plugin change. Development verification uses focused host tests and the built-plugin
browser fixture; the fixture's Markdown spy is complemented by a real host Markdown
integration test. Slow-run busy-dismiss and stale-confirmation paths retain their existing
focused host coverage.

## API boundary

Only type-only `learnharness-plugin-api` imports and public registration/UI contracts
are used. Backend execution uses Node built-ins, not private host imports. The public
`gradeAnswer`/`processSubmission` hooks supply host-owned await/save lifecycles. Optional
answered/submitted `headerContainer` and `footerContainer` supply bounded mounts beside
the heading and below host thinking. Public `mountMarkdown` renders saved questions and
teaching model solutions; native practice conclusion reveals its committed solution.
The plugin adds no submission interceptor, worker, separate agent, custom question/problem
lifecycle, or conclusion tool. Answers/submissions stay strings; grading/processing remain
separate metadata. Unavailable/disabled behavior and
safe dismissal remain host-owned. If the API cannot support a required behavior, stop
and request an explicit host fix.

Licensed AGPL-3.0-only. Built packages include `THIRD-PARTY-LICENSES.txt` for bundled
CodeMirror/Lezer and supporting libraries.
