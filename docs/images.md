# Chat images

Learners can paste images, choose files or drop files into the composer on Home, the new-session page and an existing chat. Image-only messages are supported. Unsupported drops show an error without navigating away.

## Storage and delivery

Images use native image blocks in the existing chat record. There is no attachment service or second store. Client-only preview ids are stripped before sending. The server validates the bytes without re-encoding them, so optimistic messages match the persisted record.

A new session with images is created first, then its first input is posted through the normal chat handler. Navigation waits for the write-ahead ACK and uses a plain chat URL. Image bytes never enter a URL or a transient cross-page map. Known pre-write refusals retain the draft and can reuse the empty session while its model selection is unchanged. Uncertain failures do not reuse a possibly-written session.

Existing chats keep attachments until the POST is accepted. Images added after that send stay in the draft. Images cannot enter the text-only steering queue during a running turn; they wait for the response to finish.

## Bounds

- PNG, JPEG, GIF and WebP input; animated formats use their first frame when normalized.
- At most 4 images, 5 MiB each and 10 MiB total per message.
- Raw files up to 20 MiB and 25 megapixels; header inspection precedes decoding.
- Normalized output fits within 2048 pixels per side. The server also enforces a 16384-pixel hard side limit on wire input.
- A streamed chat request body is bounded at 16 MiB, before JSON parsing.

## Agent output

Image reads are detected by their bytes and normalized locally using the existing canvas dependency. Legacy BMP files are supported by the read tool and converted to PNG.

The prober and teacher have a synchronous `pdf_view` tool. It takes `path`, a 1-based `page`, optional `dpi` from 72 to 300 (default 150), and an optional `crop` with `x`, `y`, `width` and `height` as page fractions. Crop coordinates start at the displayed page's top-left after rotation. The rectangle must lie inside the page. PDFs are bounded at 100 MiB and 5000 pages; a public call renders one page or crop. Rendering is local and makes no additional model request.

Tool images are projected from native content blocks, never copied into tool details. They appear during streaming and after reload, with source/page/crop captions. Clicking a draft or transcript image opens the shared viewer with zoom, pan, fit/reset and download.

A fresh image send to a known text-only conversation model returns 422 before any message is persisted. No model switch or paid fallback happens automatically. Existing history and tool images follow the SDK's text-placeholder behavior when the selected model cannot see images.

## Text views

Compaction summaries and default markdown formatting use image markers without base64. Explicit session markdown exports embed image data URLs so the export keeps its images.
