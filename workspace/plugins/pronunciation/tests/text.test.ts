import test from "node:test";
import assert from "node:assert/strict";
import { hanAt, hanRunAt, isHan, isHanPhrase } from "../src/han.ts";
import { MAX_MOVE_PX, MAX_PRESS_MS, isCleanClick, pointInRects } from "../src/gesture.ts";
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

test("a point must be on a character's box", () => {
  const rects = [{ left: 10, right: 20, top: 10, bottom: 30 }];
  assert.ok(pointInRects(15, 20, rects));
  assert.ok(pointInRects(21, 20, rects), "1px tolerance");
  assert.equal(pointInRects(25, 20, rects), false);
  assert.equal(pointInRects(15, 20, []), false);
});
