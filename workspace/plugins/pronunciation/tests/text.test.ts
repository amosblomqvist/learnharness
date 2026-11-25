import test from "node:test";
import assert from "node:assert/strict";
import { hanAt, hanRunAt, isHan, isHanPhrase } from "../src/han.ts";
import { DOUBLE_TAP_MS, DOUBLE_TAP_PX, MAX_MOVE_PX, MAX_PRESS_MS, isCleanClick, isCleanTap, isRepeatTap, pointInRects } from "../src/gesture.ts";
import { MAX_PHRASE_CHARS } from "../src/contract.ts";

const slice = (text: string, index: number) => { const run = hanRunAt(text, index); return run && text.slice(run.start, run.end); };

test("a run is the unbroken Han text around the clicked character", () => {
  const text = "Say 你好, then 我们一起去银行吧! 3个";
  assert.equal(slice(text, text.indexOf("好")), "你好");
  assert.equal(slice(text, text.indexOf("银")), "我们一起去银行吧");
  assert.equal(slice(text, text.indexOf("个")), "个", "digits end a run");
  assert.equal(slice(text, text.indexOf(",")), undefined);
  assert.equal(slice(text, 0), undefined);
  assert.equal(slice("你好 世界", 1), "你好", "a space ends a run");
  assert.equal(slice("你好，世界", 3), "世界", "full-width punctuation ends a run");
});

test("characters outside the BMP are whole characters, never split", () => {
  const text = "a𠀀𠀁b";
  assert.ok(isHan("𠀀"));
  assert.equal(hanAt(text, 1), "𠀀");
  assert.equal(hanAt(text, 2), undefined, "the low surrogate is not a character start");
  assert.equal(slice(text, 3), "𠀀𠀁");
  assert.equal(slice(text, 1), "𠀀𠀁");
});

test("long runs are trimmed to a window around the click", () => {
  const text = "我".repeat(150) + "你" + "他".repeat(150);
  const at = text.indexOf("你");
  const run = hanRunAt(text, at)!;
  assert.equal(run.end - run.start, MAX_PHRASE_CHARS);
  assert.ok(run.start <= at && at < run.end);
  const near = hanRunAt(text, 2)!;
  assert.deepEqual([near.start, near.end], [0, MAX_PHRASE_CHARS], "a click near the start keeps the start");
  const end = hanRunAt(text, text.length - 1)!;
  assert.deepEqual([end.start, end.end], [text.length - MAX_PHRASE_CHARS, text.length]);
});

test("backend phrase validation accepts only 1..100 Han characters", () => {
  assert.ok(isHanPhrase("银行"));
  assert.ok(isHanPhrase("𠀀"));
  assert.ok(isHanPhrase("我".repeat(MAX_PHRASE_CHARS)));
  for (const value of ["", "银行!", "abc", "我".repeat(MAX_PHRASE_CHARS + 1), "你 好"]) assert.equal(isHanPhrase(value), false, value);
});

test("only a short, still, single, unmodified primary click counts", () => {
  const press = { x: 100, y: 100, time: 1000 };
  const release = { x: 102, y: 101, time: 1200, button: 0, detail: 1, modified: false };
  assert.equal(isCleanClick(press, release, true), true);
  assert.equal(isCleanClick(undefined, release, true), false, "no matching press");
  assert.equal(isCleanClick(press, release, false), false, "text left selected");
  assert.equal(isCleanClick(press, { ...release, detail: 2 }, true), false, "second click of a double-click");
  assert.equal(isCleanClick(press, { ...release, detail: 0 }, true), false, "keyboard or synthetic click");
  assert.equal(isCleanClick(press, { ...release, button: 1 }, true), false);
  assert.equal(isCleanClick(press, { ...release, modified: true }, true), false);
  assert.equal(isCleanClick(press, { ...release, time: 1000 + MAX_PRESS_MS + 1 }, true), false, "long press");
  assert.equal(isCleanClick(press, { ...release, x: 100 + MAX_MOVE_PX + 1 }, true), false, "moved");
  assert.equal(isCleanClick(press, { ...release, x: 100 + MAX_MOVE_PX, y: 100 }, true), true);
});

test("only a short, still tap that leaves nothing selected counts", () => {
  const start = { x: 50, y: 60, time: 2000 };
  const end = { x: 53, y: 64, time: 2150 };
  assert.equal(isCleanTap(start, end, false, true), true);
  assert.equal(isCleanTap(undefined, end, false, true), false, "no touchstart (a second finger cancelled it)");
  assert.equal(isCleanTap(start, end, true, true), false, "a touchmove strayed: scroll or drag");
  assert.equal(isCleanTap(start, end, false, false), false, "long-press selection");
  assert.equal(isCleanTap(start, { ...end, time: 2000 + MAX_PRESS_MS + 1 }, false, true), false, "long press");
  assert.equal(isCleanTap(start, { ...end, x: 50 + MAX_MOVE_PX + 1, y: 60 }, false, true), false, "lifted elsewhere");
  assert.equal(isCleanTap(start, { ...end, time: 1999 }, false, true), false);
});

test("a quick second tap in the same place is the second half of a double tap", () => {
  const first = { x: 100, y: 100, time: 5000 };
  assert.equal(isRepeatTap(undefined, first), false);
  assert.equal(isRepeatTap(first, { x: 110, y: 105, time: 5000 + DOUBLE_TAP_MS }), true);
  assert.equal(isRepeatTap(first, { x: 100, y: 100, time: 5000 + DOUBLE_TAP_MS + 1 }), false, "too slow");
  assert.equal(isRepeatTap(first, { x: 100 + DOUBLE_TAP_PX + 1, y: 100, time: 5100 }), false, "too far");
  assert.equal(isRepeatTap(first, { x: 100, y: 100, time: 4900 }), false);
});

test("a point must be on a character's box", () => {
  const rects = [{ left: 10, right: 20, top: 10, bottom: 30 }];
  assert.ok(pointInRects(15, 20, rects));
  assert.ok(pointInRects(21, 20, rects), "1px tolerance");
  assert.equal(pointInRects(25, 20, rects), false);
  assert.equal(pointInRects(15, 20, []), false);
});
