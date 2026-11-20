# Managed agent example

Copy this directory into the plugins directory shown in **Settings → Community plugins**,
keeping the `managed-agent/` folder and its required `dist/manifest.json`. No build is
needed. Refresh and enable **Managed agent example**. Edit runtime files in `dist/`
and restart LearnHarness after changing loaded code. Preserve sibling `managed-agent/data/`
when replacing `dist/`; never distribute that persistent data or place it in `dist/data/`.
Open it using its explicit sidebar or graph action. Registration of the view itself does
not place it anywhere.

This is a small developer example, not a separate showcase application. The host's
`mountStandardComposer` supplies controlled model/thinking selection, text input,
and dictation. Select a configured model (and thinking level if supported), then
click **New conversation**. Those choices apply to the new conversation, not an
existing one. Creating or opening a conversation never runs the agent. Only **Send**,
**Run as background task**, or answering a pending question starts explicit work.
Model requests and dictation may incur configured-provider costs; background work
also needs the configured connection's permission. Stop uses the host composer.

Try asking the agent to ask a question or save a note. Pending questions and the
transcript deliberately remain simple plugin-owned DOM. Navigate away and return
to observe an ongoing run; unmounting the view does not abort backend execution.
All host widgets receive the view's `{ signal }` and are disposed on unmount.

The plugin controls its draft/model/thinking state; widgets do not write host defaults.
The backend persists model/thinking definitions in its own `data/definitions.json`
and demonstration notes in `data/notes.jsonl`; the host persists plugin-owned agent
records separately from learning chats. No core learning data or model defaults are
written. There are no unrelated configurable settings or automatic runs.

Maintainer check **from a LearnHarness repository checkout with its dependencies
installed** (no provider requests; not a command supplied by the downloaded skill):

```sh
node --test examples/plugins/example-ui.test.js
```
