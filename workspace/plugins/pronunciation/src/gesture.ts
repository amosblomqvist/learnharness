/** Rules that keep a click on Chinese text from playing by accident. */

export const MAX_MOVE_PX = 5;
export const MAX_PRESS_MS = 500;

/** Controls, inputs and editors where a click means something else. */
export const INTERACTIVE_SELECTOR = [
  "a[href]", "button", "input", "textarea", "select", "option", "label", "summary",
  "[contenteditable]:not([contenteditable='false'])",
  ...["button", "link", "option", "radio", "checkbox", "switch", "tab", "menuitem", "menuitemradio", "menuitemcheckbox",
    "slider", "spinbutton", "textbox", "searchbox", "combobox", "listbox", "treeitem", "gridcell"].map(role => `[role='${role}']`),
].join(", ");

export interface Press { x: number; y: number; time: number }
export interface Release { x: number; y: number; time: number; button: number; detail: number; modified: boolean }

/**
 * A short, still, unmodified primary click that is not part of a double-click.
 * `selectionCollapsed` is false when the click left text selected (a drag-select).
 */
export function isCleanClick(press: Press | undefined, release: Release, selectionCollapsed: boolean): boolean {
  if (!press || release.button !== 0 || release.modified || !selectionCollapsed) return false;
  // `detail` counts consecutive clicks; 0 comes from keyboard or synthetic clicks.
  if (release.detail !== 1) return false;
  if (release.time - press.time > MAX_PRESS_MS || release.time < press.time) return false;
  return Math.hypot(release.x - press.x, release.y - press.y) <= MAX_MOVE_PX;
}

/** Whether a client point lies inside any of the rectangles (1px tolerance). */
export function pointInRects(x: number, y: number, rects: Iterable<{ left: number; right: number; top: number; bottom: number }>): boolean {
  for (const rect of rects) if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return true;
  return false;
}
