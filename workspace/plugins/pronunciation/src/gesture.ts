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

/** A second tap this soon and this close is the second half of a double tap. */
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 20;
/** A tap's own click is ignored for this long after its touchend. */
export const TOUCH_CLICK_MS = 1000;

export interface Tap { x: number; y: number; time: number }

/**
 * A short, still, one-finger tap that leaves no text selected. `moved` is true
 * once any touchmove strayed more than MAX_MOVE_PX (a scroll or a drag).
 */
export function isCleanTap(start: Press | undefined, end: Tap, moved: boolean, selectionCollapsed: boolean): boolean {
  if (!start || moved || !selectionCollapsed) return false;
  if (end.time - start.time > MAX_PRESS_MS || end.time < start.time) return false;
  return Math.hypot(end.x - start.x, end.y - start.y) <= MAX_MOVE_PX;
}

/** Whether `tap` repeats `previous` closely enough to be a double tap. */
export function isRepeatTap(previous: Tap | undefined, tap: Tap): boolean {
  if (!previous || tap.time < previous.time || tap.time - previous.time > DOUBLE_TAP_MS) return false;
  return Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_PX;
}

/** Whether a client point lies inside any of the rectangles (1px tolerance). */
export function pointInRects(x: number, y: number, rects: Iterable<{ left: number; right: number; top: number; bottom: number }>): boolean {
  for (const rect of rects) if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return true;
  return false;
}
