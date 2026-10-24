/** A malformed input event (the honest 400, the orphan-trap discipline).
 *  Its own module so the image rules (images.ts) can refine it without an
 *  import cycle through input-events.ts. */
export class ChatInputError extends Error {}
