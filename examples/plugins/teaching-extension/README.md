# Teaching extension example

A deliberately small developer fixture for existing lessons—not an independent
flashcard feature or a code-execution/learner-answer system.

Copy this directory into the plugins directory shown in **Settings → Plugins**,
keeping the `teaching-extension/` folder and its required `dist/manifest.json`. No build
is needed. Refresh and enable **Teaching extension example**. Edit runtime files in
`dist/` and restart LearnHarness after changing loaded code. Preserve sibling
`teaching-extension/data/` when replacing `dist/`; never distribute that persistent data
or place it in `dist/data/`. It is never installed/enabled automatically.

In a teacher or practice session:

1. Explicitly ask to try the teaching-extension echo tool. It returns a native Pi result
   with a custom transcript card; no additional model request is made by the tool.
2. Ask for a `plugin-note` fenced block. Its body is rendered with plain DOM/textContent.
3. Explicitly ask for the **background-worker example** about a topic. The teacher calls
   `teaching_extension_note`, which returns a dispatch acknowledgement immediately.
   A small native worker writes a note and submits a schema/semantically validated result;
   the result arrives later through the existing lesson delivery pipeline.

Step 3 **may incur model cost** and requires a configured cheap model slot with permission
for background use. Its limits (3 model turns, 1,024 output tokens per request, 60 seconds
wall clock) are example choices, not host defaults. Nothing runs automatically merely
because the plugin or its settings is opened.

Disable removes instructions/tools/renderers from future turns and interrupts unfinished
workers. Existing native calls/results remain saved. The original worker call stays a
dispatch acknowledgement; the later result is a separate saved marker. Raw fallback
remains readable without this plugin. Completed task records survive disable/restart.

This is a silent, chrome-less extension: it registers no view, action, or placement.
Its custom `registerSettings((container, signal) => …)` mount is intentionally retained
as an explanatory-content escape hatch. There are no configurable behaviors to expose
as schema settings; opening this content does not start a worker.

Files use only the supported public context, no private app imports or runtime npm install.
The backend has no independent product storage or core learning-data writes. The host
owns task records and usage accounting in the installed workspace's sibling `data/` directory.

Off-network integration coverage: `tests/plugin-teaching-integration.test.ts` loads this
actual external CommonJS backend, constructs the real native teacher, runs a scripted
worker through the inference adapter, observes separate delivery, and round-trips the
native history through the normal stores. This is not a claim of real-provider or human
functional acceptance.
