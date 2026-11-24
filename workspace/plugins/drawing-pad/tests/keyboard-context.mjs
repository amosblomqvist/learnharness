// The disposable fixture supplies the real host manager to the real Keyboard
// section without mounting Next's router/SSE providers. No plugin code uses it.
import { useSyncExternalStore } from "react";

export function usePlugins() {
  const manager = window.fixture.actionManager();
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  return { manager, snapshot, uiStore: null };
}
