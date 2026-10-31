// Hands a new session's first message from the Learn tab to the chat screen
// without putting it in the route URL. In memory only: the chat screen sends
// it once and clears it.
const pending = new Map<string, string>();

export function stashOpening(chatId: string, text: string): void {
  pending.set(chatId, text);
}

export function takeOpening(chatId: string): string | undefined {
  const text = pending.get(chatId);
  pending.delete(chatId);
  return text;
}
