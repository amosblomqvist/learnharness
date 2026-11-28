# Learn from selected materials

Open **Study materials** in the sidebar. Connect a source, browse or search,
select documents, and choose **Review selected materials**. Check the extracted
text and omission notices, optionally enter a learning goal, then choose
**Start learning from selection**. This uses the existing configured learning
model and normal session opening flow; the feature does not introduce model
credentials or a separate billing route.

## Study a whole Obsidian course folder

Connect the vault (rather than just one class folder if you want references to shared
attachments). Browse to the course and choose **Study this folder**. Nested Markdown
notes, PDFs, PPTs and PPTXs start checked. Referenced slides and PDFs elsewhere in
the vault are offered unchecked. Review the list, open an original Markdown note
with **Open in Obsidian**, then choose **Start course lesson**. This opens a teaching
session, not a graph import. The teacher gets the selected paths and reads relevant
files with the existing learner-file tools; contents are not all pasted into the
first message. The eight-document snapshot limit applies to the separate document
review flow.

Slide conversion requires LibreOffice. LearnHarness uses a private temporary
profile and a copy of the deck, then keeps its PDF under the application's
`course-pdfs` data folder so a resumed lesson can still read it. File-access
restrictions must allow that folder as well as the chosen source. Originals are
not written. Hidden paths, symbolic links and remote links are not followed;
unresolved or ambiguous attachment names are reported for review.

## Individual document sources

- **Obsidian:** choose an absolute vault or course folder. Browse one folder at a
  time and select Markdown files. Reading follows the existing file-access policy
  and stays within the configured root. Embedded images/PDFs and linked notes are
  not automatically loaded. The original files are opened read-only.
- **Notion:** save a read-access integration token in Connections and share the
  desired pages with that integration. Search is by page title, not full text.
  Extraction follows paginated/nested text blocks, equations and table rows;
  embedded files and child pages/databases are not a PDF reader or recursive
  workspace import. Inspect omission notices before starting. “Token saved” means
  configured, not a successful authorization check; listing pages verifies access.
- **Zotero:** run Zotero Desktop and enable its local API in Settings → Advanced.
  Open a reference to select a note or an attachment with indexed full text.
  Bibliographic metadata is never substituted for the paper. Requests use only
  loopback GETs on port 23119, without sending local reads through an ambient proxy.

The individual-document snapshot flow accepts up to eight documents and 60,000 extracted characters in
all. Oversize/empty/unreadable content fails explicitly rather than silently
truncating it or starting from metadata. Review is an extracted snapshot: changes
made in the source afterwards require another review. The selected text and its
origin are saved in the new learning conversation and sent to its model when the
opening request runs. Nothing is written back to the source applications.

## Credentials and request boundary

The optional Notion token is stored server-side beside the application's auth
file in `material-sources-credentials.json`, not in public settings or the model
prompt. The UI clears its password field after saving. Disconnect removes the
stored token. The file and its atomic temporary variants are excluded from
packaging/tracing and denied to learner-file tools. Desktop requests require the
existing application capability; browser requests require same-origin access and
an explicit material-request intent header. Remote API error bodies are not echoed.

## Verification

- The course-folder smoke test uses real PPT and PPTX fixtures, checks readable text in both generated PDFs, and inspects the native lesson opening request.
- Six source/HTTP tests cover rooted Markdown reads, traversal refusal, nested
  Notion pagination, indexed Zotero text, credential privacy and selected prompts.
- Production browser acceptance covers browsing, selection, exact text preview,
  the native opening request, exclusion of unselected content, unchanged source
  fixtures, 44px controls and matching search/goal axes at 1440 and 390px widths.
- Typecheck, targeted lint and a production build passed using Next 16.4.6.
- Notion behavior is fixture-tested; a live user integration is still required.
  The browser test blocks inference rather than pretending to validate AI output.

This PR is independent of the Perrin layout and answer-review PRs; it uses the
existing palette and components. No user notes, tokens or library records are
included in the repository.
