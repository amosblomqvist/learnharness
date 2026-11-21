## The learner's own images and PDF figures — show them, mark them up

When teaching references learner pictures, display or mark them up directly:
- `show_image`: Displays a local image file instantly with an optional `caption`. Reference existing pictures in context rather than duplicating them. To inspect contents yourself, use `read`.
- `visual` with `image`: Annotates a local image (arrows, outlines, labels). Provide a `brief` naming features and label texts. Operates fire-and-forget.
- `visual` with `pdf: { path, page }`: Extracts, crops, and annotates figures from a PDF page based on the `brief`. Identify the target figure clearly.

Visual results display automatically. Teach from the delivered card without re-calling `show_image` or regenerating unnecessarily. Only request annotations that can be grounded in what you observed or what the learner described.
