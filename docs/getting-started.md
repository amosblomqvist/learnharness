# Getting started

Download LearnHarness from [learnharness.ai](https://learnharness.ai) or [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases). For running from source, see [Development](development.md).

## Connect models

Open **Settings → Providers** and configure a connection:

- **Provider API keys:** use your own account and pay that provider's rates.
- **Subscription connections:** ChatGPT, GitHub Copilot, and Grok use their respective sign-in flows and account limits. They do not silently fall back to API-key billing.
- **[Claude Code](claude-code.md):** use a separately installed and authenticated CLI. Its own configuration controls routing and billing; this is not a subscription-only guarantee.
- **[Custom endpoint](custom-providers.md):** connect one OpenAI-compatible server, including a local model server. LearnHarness does not install or download models.

Choose **Strong**, **Cheap**, and **Vision** models in Settings. There are no factory model selections. New sessions start with Strong; background roles use their assigned slots or role overrides. A model selected inside an existing session belongs to that session and does not change background-role choices.

Optional web search supports Tavily, Brave, Exa, Firecrawl, and hosted Ollama search; configure a key for the engine you want to use. Research can still fetch known URLs without a search key. Dictation uses Deepgram, Groq, or a speech model on this computer, set up below.

## Start a session

Choose **Teach** and describe what you want to understand. The agent probes your starting point, presents a plan, and teaches through explanations and checks. Reply naturally to accept or revise the plan.

Use the thinking fields to explain your reasoning, uncertainty, or reaction—not only your selected answer. You can type or dictate. Your confidence is self-reported, not an independent assessment.

Choose **Practice** for problems rather than a lesson. Start from selected graph material or describe material directly. Submit your thinking as you work; the model's committed solution is revealed when the problem concludes. Use **Next problem** when ready to continue.

Sessions are saved locally, including earlier messages when context is compacted. The [keyboard guide](keyboard.md) covers submission, focus, question controls, and cancellation.

## Dictation

Choose the engine under **Settings → Providers → Dictation → Engine**: Deepgram, Groq (Whisper), or Local (on this device). Deepgram is the default; existing setups keep working unchanged.

**Deepgram**

1. Create a [Deepgram API key](https://console.deepgram.com/) with the **Member role or higher**, required for [short-lived token minting](https://developers.deepgram.com/reference/auth/tokens/grant).
2. Add it under **Settings → Providers → Dictation** and choose the language below the key. **Multilingual** supports automatic recognition and mixed-language speech.
3. Use the microphone or **Mod+D** to start and stop. Review the text before sending. **Esc cancellation discards the pending transcript**; stop normally to keep it.

Audio streams from your browser directly to Deepgram using a short-lived token. A `403 Insufficient permissions` error while obtaining that token can mean the key's role is insufficient.

**Groq (Whisper)**

1. Add a [Groq API key](https://console.groq.com/keys) in the **Groq** row of the same Dictation group. It is the key the Groq model provider already uses (`GROQ_API_KEY`), so a key you added under **Model API keys** works here too.
2. Set **Engine** to **Groq (Whisper)**, then choose a model: **Whisper Large v3 Turbo** (default, faster) or **Whisper Large v3** (most accurate). The language setting still applies; regional variants such as English (GB) use the base language, and **Multilingual** lets Whisper detect the language.
3. Start and stop as above. Groq transcribes while you speak: LearnHarness sends a piece of 12 to 18 seconds at a time in the background and holds the text. Nothing appears until you stop. Then it shows **Finishing transcription…** and inserts the whole text once, in order. **Esc** while recording discards the recording.

With Groq, the recording goes from your browser to the LearnHarness server on this machine, which uploads each part to Groq with your key. The key never reaches the browser, and LearnHarness does not write the recording to disk. Groq's own terms and usage limits apply to your account.

**Local (on this device)**

Local transcribes on this computer with a speech model you download once. The audio never leaves the machine, and it needs no key and no internet after the download. Pick it from **Engine**, then:

1. **Preferred languages.** Choose the languages you speak. They decide which models are recommended and which languages Auto can pick from. Keep at least one.
2. **Pick a model.** The list shows the models recommended for your languages first (**Best**, **Fast**, **Accurate**), then every other model, with a filter box. Each row shows an accuracy grade from A to F for your languages, a speed meter, the download size, and the model's licence. **How to read the ratings** explains them. The speed figures depend on whether this computer has graphics acceleration; the list says which it assumes.
3. **Download, then Use.** **Download** shows progress and a **Cancel**. A cancelled or interrupted download keeps what it has and offers **Resume**. The file is checked against its SHA-256 before it counts as installed. **Use** makes it the model for dictation. **Delete** removes the file.
4. Start and stop as above.

Good to know:

- **Where models live.** In `stt-models/` inside the data folder (see [Data, privacy, and usage](#data-privacy-and-usage)). Models range from tens of megabytes to several gigabytes. Downloads run on the server and carry on if you close Settings.
- **Licences.** Each model has its own licence, shown in its row. **Custom licence** links to the model's page on Hugging Face. LearnHarness ships none of these models; it bundles only the small Silero voice detector. The notices for the code and data it builds on are in [on-device dictation licences](local-stt-licenses.md).
- **Transcription language.** **Auto detect** works out the language of each take from your preferred languages. Some models detect it themselves. For the others, Auto needs a 27 MB language detector, which Settings offers to download beside the row. Without it, Local transcribes in your first preferred language and says so. Pick a fixed language instead if you always dictate in one. A model that supports only one language has no such row.
- **Chinese output.** When Chinese is a preferred language, **Chinese output** chooses **Simplified** or **Traditional (Taiwan)** characters. Text containing kana (Japanese) is left alone.
- **Warm-up.** When recording starts, LearnHarness loads the model in the background, so a large model's load time overlaps your speech. The first dictation after a while can still take a moment to finish.
- **Memory.** The model stays loaded for ten idle minutes, then is unloaded. The next dictation loads it again.
- **No model chosen.** The bar says **Choose a local model in Settings → Dictation first.** Click it to open Settings.
- Local uses the same chunking, 20-minute limit, retry, **Retry**, **Dismiss**, and Esc behavior as Groq, described next.

**Chunked dictation (Groq and Local)**

Both engines cut the recording into pieces and transcribe them while you speak. A small voice detector (Silero VAD) runs on this machine and finds the pauses. It needs no key and no download. LearnHarness cuts each piece at a pause between 12 and 18 seconds, preferring a long pause close to 15 seconds. If there is no pause, it cuts at 15 seconds. Pieces with no speech are not transcribed, and a final fragment under a third of a second is ignored. The pieces are joined in order, without an extra space between Chinese, Japanese, or Thai characters.

- A dictation stops and transcribes what it has after 20 minutes. That keeps the audio held in memory to about 38 MB and, for Groq, a run well inside the free-tier limits (about 7,200 audio-seconds an hour when this was written; check your account).
- If a part fails, for example on a rate limit or a dropped connection, LearnHarness tries it again twice on its own. If it still fails, **nothing is inserted**. The message appears in the dictation bar beside **Retry** and **Dismiss**. **Retry** sends only the parts that failed, then inserts the whole text.
- The audio stays in memory until the text is inserted, you press **Dismiss**, you start a new recording, or you leave the page. **Esc** while it is finishing stops the waiting but keeps the audio for **Retry**.
- While audio is kept, Enter in the composer or a question box does not send, so an answer never goes out without what you said. Dismiss it to send what you typed.
- If the voice detector cannot answer, LearnHarness cuts at 15 seconds and sends the piece anyway, so no speech is lost.

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

Downloaded dictation models for the Local engine are stored in `stt-models/` inside this folder; they can be several gigabytes, and **Delete** in Settings removes them. API-key files sit beside `data`, not inside it. They are plaintext with restrictive file permissions, not an encrypted vault. Keep complete profiles private; do not share credential files or raw debug captures in bug reports.

**Local storage does not mean local-only processing.** Configured models, subscription/CLI services, web research, and Deepgram or Groq dictation can receive content. Local dictation keeps audio on this machine. A local custom model is a separate setup choice, not an offline guarantee for other enabled services.

Click the context/cost row beneath the composer for Session stats. Dollar figures estimate known API costs; subscription, CLI, and custom-endpoint usage are not treated as free. See [context, caching, and costs](compaction-accounting.md) for the details.

Packaged apps support updates under **Settings → General**. Development builds do not run the updater. Report problems through [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues), with reproduction steps and the app/OS version rather than private learning records or keys.
