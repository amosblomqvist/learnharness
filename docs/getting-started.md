# Getting started

Download LearnHarness from [learnharness.ai](https://learnharness.ai) or [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases). For running from source, see [Development](development.md).

## Connect models

Open **Settings → Providers** and configure a connection:

- **Provider API keys:** use your own account and pay that provider's rates.
- **Subscription connections:** ChatGPT, GitHub Copilot, and Grok use their respective sign-in flows and account limits. They do not silently fall back to API-key billing.
- **[Claude Code](claude-code.md):** use a separately installed and authenticated CLI. Its own configuration controls routing and billing; this is not a subscription-only guarantee.
- **[Custom endpoint](custom-providers.md):** connect one OpenAI-compatible server, including a local model server. LearnHarness does not install or download models.

Choose **Strong**, **Cheap**, and **Vision** models in Settings. There are no factory model selections. New sessions start with Strong; background roles use their assigned slots or role overrides. A model selected inside an existing session belongs to that session and does not change background-role choices.

Optional web search supports Tavily, Brave, Exa, Firecrawl, and hosted Ollama search; configure a key for the engine you want to use. Research can still fetch known URLs without a search key. Dictation can use a Deepgram service key or a local server, as described below.

## Start a session

Choose **Teach** and describe what you want to understand. The agent probes your starting point, presents a plan, and teaches through explanations and checks. Reply naturally to accept or revise the plan.

Use the thinking fields to explain your reasoning, uncertainty, or reaction—not only your selected answer. You can type or dictate. Your confidence is self-reported, not an independent assessment.

Choose **Practice** for problems rather than a lesson. Start from selected graph material or describe material directly. Submit your thinking as you work; the model's committed solution is revealed when the problem concludes. Use **Next problem** when ready to continue.

Sessions are saved locally, including earlier messages when context is compacted. The [keyboard guide](keyboard.md) covers submission, focus, question controls, and cancellation.

## Dictation

Open **Settings → Providers → Dictation → + Add a provider**, then choose **Deepgram** or **Local**. Each choice opens its own settings. Saved providers appear as collapsed rows; click a row to edit. Use the **Active** selector on a saved row to choose the dictation engine. Adding or editing settings never switches the active provider.

For **Deepgram**, create a [Deepgram API key](https://console.deepgram.com/) with the **Member role or higher**, required for [short-lived token minting](https://developers.deepgram.com/reference/auth/tokens/grant). Save the key and choose the cloud language in its editor, then select **Active** on the Deepgram row when you want to use it. **Multilingual** supports automatic recognition and mixed-language speech. Audio streams directly from your browser to Deepgram using a short-lived token. A `403 Insufficient permissions` error during token minting can mean the key's role is insufficient.

For **Local**, start your own server and enter its complete transcription URL. Click **Save**, then select **Active** on its saved row to use it:

| Server | Example transcription URL | Model |
| --- | --- | --- |
| llama.cpp | `http://localhost:8080/v1/audio/transcriptions` | An audio-capable model such as LFM3-Audio, with its required audio components |
| whisper.cpp | `http://localhost:8081/inference` | A Whisper model loaded by whisper-server |

Saved local dictation settings collapse into a summary row showing the server, URL, model, language, and key status. Click the row to edit the saved values. Use **Save** or **Cancel** beneath the fields. **Delete** removes the Local configuration and its saved bearer key. Deleting an active Local provider leaves dictation unconfigured; select another provider explicitly to resume.

The URL is used exactly as entered; the app does not append a path. Custom server paths and HTTP(S) hosts are supported. The optional model ID is sent with each upload; whisper.cpp normally uses the model loaded at startup. Leave the bearer key blank for a keyless server. Saved keys live in private credential storage and apply only to their exact endpoint URL; changing URLs requires entering a key for the new destination. Use **Remove key** to return to keyless access.

Each provider has its own **Language** dropdown with the same search and keyboard controls. Local defaults to **Auto-detect** (`auto`). Search for a language such as French, or type a backend-specific language code and choose **Use language code**. Local changes are saved with the server configuration; Deepgram saves its language when selected. This is independent of Deepgram's language and multilingual setting; recognition quality and language support depend on the backend/model. Use an up-to-date llama.cpp build with LFM3-Audio support. The app does not install servers or download models.

Use the microphone or **Mod+D** to start and stop either mode. Review the text before sending. **Esc discards the recording or pending transcript**, including an upload already in progress. Enter during dictation waits for its completion before submitting.

Local mode records 16 kHz mono PCM WAV in memory and uploads it through the app server only after you stop. Recording stops at **10 minutes**; transcription has a **5-minute timeout**. Errors are shown without automatically falling back to Deepgram. The app does not save recordings to disk; the backend may have its own storage policy. Local dictation does not contact Deepgram for tokens or audio.

In the desktop app, the app server runs on your machine. If LearnHarness is hosted elsewhere, `localhost` in the transcription URL refers to that hosting machine. The custom dictation endpoint is independent of your custom LLM endpoint.

## Use local files in a session

In the desktop app, use the paperclip's **Files** or **Folder** choice, or drag files/folders into the content area, to insert their local paths. Files supports any file type and multiple selections; Folder attaches one directory path, including an empty folder, without expanding or reading its contents. Newly picked or dropped known folders get a trailing directory separator so their Folder icon survives saved messages and reloads; files stay unchanged. Older unmarked paths are not retrospectively classified. The agent can then locate/read supported content on the machine running LearnHarness under the existing file-access guards; attaching a path does not grant permissions. This is **not an upload**: originals stay where they are. Ordinary browsers cannot expose these local paths through the picker or drag-and-drop; you can paste a full path instead.

The teacher can show a local raster image or request an annotated visual based on it. Displayed/annotated pictures are saved as session-owned snapshots, so those saved results no longer depend on the original file. This does not snapshot every file attachment. Offline regression tests cover snapshot/payload behavior, not the quality of model-generated annotations.

File tools are read-only but have broad filesystem access under the server's user; they are not confined to a selected folder. The sensitive-path guard blocks known credential/private locations, not all sensitive content. Review what you make available: file content read by an agent may be sent to its configured model provider. See [file-access boundaries](architecture.md#file-access-and-external-services).

## Extract into the graph

For lessons, attach material to a session instead. Use the graph's **Extract files… → Files** or **Folder** picker for Markdown, plain text, or PDFs. This is a separate import flow, not the session's path attachments. Each supported file is uploaded for processing; folders organize imported sources.

- Files are limited to **25 MiB each**. Imports queue independently, with up to three files in flight.
- PDF conversion is local text extraction, not OCR. Image-only pages are skipped and counted; scanner text can be inaccurate. Check the import's notices.
- Imported text then goes through model-based proposition/chain extraction. Local PDF conversion does not make the whole import offline.
- Completed chunks survive later failures. Retry is explicit and reprocesses the file; unchanged content is not automatically skipped. The file queue does not survive a page reload.

The graph stores propositions and reasoning chains with source provenance, **not mastery scores**. A proposition's presence is not proof that you understood or retained it. Automatic session extraction can be disabled independently of graph rendering.

## Data, privacy, and usage

Chats, graph records, settings, and credentials live on your machine. Packaged desktop data normally lives under:

| OS | Learning-data folder |
| --- | --- |
| macOS | `~/Library/Application Support/LearnHarness/data` |
| Windows | `%APPDATA%\LearnHarness\data` |
| Linux | `$XDG_CONFIG_HOME/LearnHarness/data`, or `~/.config/LearnHarness/data` |

API-key files sit beside `data`, not inside it. They are plaintext with restrictive file permissions, not an encrypted vault. Keep complete profiles private; do not share credential files or raw debug captures in bug reports.

**Local storage does not mean local-only processing.** Configured models, subscription/CLI services, web research, and dictation can receive content. A local custom model is a separate setup choice, not an offline guarantee for other enabled services.

Click the context/cost row beneath the composer for Session stats. Dollar figures estimate known API costs; subscription, CLI, and custom-endpoint usage are not treated as free. See [context, caching, and costs](compaction-accounting.md) for the details.

Packaged apps support updates under **Settings → General**. Development builds do not run the updater. Report problems through [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues), with reproduction steps and the app/OS version rather than private learning records or keys.
