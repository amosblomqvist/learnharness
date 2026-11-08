import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDockMorph, naturalDockHeight } from "../components/dock-morph.ts";

// Deterministic CSS/WAAPI geometry seam; browser frame verification is separate.
function fixture() {
	let timeline = 0;
	let natural = 44;
	let visible = 44;
	let cap = Infinity;
	let failMeasurement = false;
	const properties = new Map<string, { value: string; priority: string }>();
	const style = {
		getPropertyValue: (name: string) => properties.get(name)?.value ?? "",
		getPropertyPriority: (name: string) => properties.get(name)?.priority ?? "",
		setProperty: (name: string, value: string, priority = "") => { properties.set(name, { value, priority }); },
		removeProperty: (name: string) => { properties.delete(name); },
	};
	const animations: ReturnType<typeof makeAnimation>[] = [];
	function makeAnimation(frames: Keyframe[], options: KeyframeAnimationOptions) {
		const animation = {
			frames, duration: options.duration, currentTime: 0 as number | null,
			playState: "running", pending: false, cancelled: false, retargets: 0,
			effect: {
				setKeyframes(next: Keyframe[]) { animation.frames = next; animation.retargets++; },
				updateTiming(timing: OptionalEffectTiming) {
					animation.duration = timing.duration;
					// Model the transient finish hazard of shrinking duration before
					// resetting currentTime (including a 90ms -> 30ms retarget).
					if (typeof timing.duration === "number" && animation.currentTime !== null && animation.currentTime >= timing.duration) animation.playState = "finished";
				},
			},
			cancel() { this.cancelled = true; this.playState = "idle"; },
		};
		return animation;
	}
	const shell = {
		style,
		getBoundingClientRect() {
			if (failMeasurement) throw new Error("layout failed");
			const bypass = style.getPropertyValue("height") === "auto" && style.getPropertyPriority("height") === "important";
			const active = animations.at(-1);
			return { height: Math.min(bypass || !active || active.playState === "idle" || active.playState === "finished" ? natural : visible, cap) };
		},
		animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
			const animation = makeAnimation(frames, options);
			animations.push(animation);
			visible = Number.parseFloat(String(frames[0]!.height));
			return animation;
		},
		// A height owner must not enumerate/cancel unrelated shell animations.
		getAnimations() { throw new Error("unrelated animations are not ours"); },
	} as unknown as HTMLElement;
	const morph = createDockMorph();
	let reserves = 0;
	const layout = (key: string, opening: boolean) => morph.layout(shell, key, opening, () => { reserves++; });
	const start = () => {
		layout("question:false", false);
		natural = 211.78;
		layout("question:true", true);
		return animations.at(-1)!;
	};
	return {
		shell, style, morph, animations, layout, start,
		get reserves() { return reserves; },
		get timeline() { return timeline; },
		advance(ms: number) {
			timeline += ms;
			for (const animation of animations) {
				if (animation.playState !== "running" || animation.currentTime === null) continue;
				animation.currentTime += ms;
				if (animation.currentTime >= Number(animation.duration)) animation.playState = "finished";
			}
		},
		set natural(value: number) { natural = value; },
		set visible(value: number) { visible = value; },
		set cap(value: number) { cap = value; },
		set failMeasurement(value: boolean) { failMeasurement = value; },
	};
}

describe("dock opening height retargeting", () => {
	it("retargets late CodeMirror geometry from the visible height on the SAME animation", () => {
		const f = fixture();
		const animation = f.start();
		assert.equal(animation.duration, 120);
		f.advance(10);
		f.visible = 88;
		f.natural = 357.56;
		f.morph.retarget("question:true");
		assert.equal(f.animations.length, 1);
		assert.deepEqual(animation.frames, [{ height: "88px" }, { height: "357.56px" }]);
		assert.equal(animation.duration, 110);
		assert.equal(animation.currentTime, 0);
		assert.equal(animation.cancelled, false);
		assert.equal(f.style.getPropertyValue("height"), "");
	});
	it("preserves the original fake-timeline completion across editor and 29.5px preparation status changes", () => {
		const f = fixture();
		const animation = f.start();
		const originalEnd = f.timeline + Number(animation.duration);
		f.advance(15);
		f.natural = 357.56; f.visible = 120;
		f.morph.retarget("question:true");
		assert.equal(animation.duration, 105);
		f.advance(30);
		f.natural = 387.06; f.visible = 290;
		f.morph.retarget("question:true");
		assert.deepEqual(animation.frames, [{ height: "290px" }, { height: "387.06px" }]);
		assert.equal(f.timeline + Number(animation.duration), originalEnd);
		f.advance(15);
		f.natural = 357.56; f.visible = 330;
		f.morph.retarget("question:true");
		assert.equal(animation.duration, 60);
		assert.equal(f.timeline + Number(animation.duration), originalEnd);
		assert.equal(f.animations.at(-1), animation);
		assert.equal(f.animations.length, 1);
		f.advance(59);
		assert.equal(animation.playState, "running");
		f.advance(1);
		assert.equal(animation.playState, "finished");
		assert.equal(f.timeline, originalEnd);
	});
	it("resets time before shortening a late 90/120ms opening and stays running until the original deadline", () => {
		const f = fixture(); const animation = f.start();
		f.advance(90); f.natural = 357.56; f.visible = 205;
		f.morph.retarget("question:true");
		assert.equal(animation.duration, 30);
		assert.equal(animation.currentTime, 0);
		assert.equal(animation.playState, "running");
		assert.equal(90 + Number(animation.duration), 120);
		assert.deepEqual(animation.frames, [{ height: "205px" }, { height: "357.56px" }]);
	});
	it("does not reset easing/time on identical targets or subpixel observer noise", () => {
		const f = fixture(); const animation = f.start();
		for (const target of [211.78, 212.2, 211.1]) {
			animation.currentTime = 20;
			f.visible = 130; f.natural = target;
			f.morph.retarget("question:true");
		}
		assert.equal(animation.retargets, 0);
		assert.equal(animation.duration, 120);
		assert.equal(animation.currentTime, 20);
	});
	it("keeps a pending start's full duration and the same animation without cancel/play", () => {
		const f = fixture(); const animation = f.start();
		animation.currentTime = null; animation.pending = true;
		f.advance(25); f.natural = 358;
		f.morph.retarget("question:true");
		assert.equal(animation.duration, 120);
		assert.equal(animation.currentTime, 0);
		assert.equal(animation.pending, true);
		assert.equal(animation.cancelled, false);
		assert.equal(f.animations.at(-1), animation);
		animation.pending = false;
		const startedAt = f.timeline;
		f.advance(119);
		assert.equal(animation.playState, "running");
		f.advance(1);
		assert.equal(animation.playState, "finished");
		assert.equal(f.timeline - startedAt, 120);
	});
	it("retargets a still-live animation when wall time advances but document animation time does not", t => {
		const f = fixture(); const animation = f.start();
		f.advance(30);
		t.mock.method(performance, "now", () => 100_000);
		f.natural = 358;
		f.morph.retarget("question:true");
		assert.equal(animation.duration, 90);
		assert.equal(f.timeline + Number(animation.duration), 120);
		assert.equal(f.animations.at(-1), animation);
		assert.equal(animation.cancelled, false);
	});
	for (const ending of ["finished", "idle", "elapsed-currentTime"] as const) {
		it(`never starts a second animation after ${ending}`, () => {
			const f = fixture(); const animation = f.start();
			f.natural = 358;
			if (ending === "elapsed-currentTime") animation.currentTime = 120;
			else animation.playState = ending;
			f.morph.retarget("question:true");
			assert.equal(animation.retargets, 0);
			assert.equal(f.animations.length, 1);
		});
	}
	it("keeps closing at 120ms and does not retarget it", () => {
		const f = fixture(); const opening = f.start();
		opening.playState = "finished";
		f.layout("question:true", true);
		f.natural = 44;
		f.layout("question:false", false);
		const closing = f.animations.at(-1)!;
		f.natural = 90; f.advance(10);
		f.morph.retarget("question:false");
		assert.equal(closing.retargets, 0);
		assert.equal(closing.duration, 120);
		assert.deepEqual(closing.frames, [{ height: "211.78px" }, { height: "44px" }]);
	});
	it("leaves initial appearance and ordinary typing growth unanimated", () => {
		const f = fixture();
		f.natural = 350;
		f.layout("question:true", true);
		f.natural = 380;
		f.layout("question:true", true);
		f.morph.retarget("question:true");
		assert.equal(f.animations.length, 0);
		assert.equal(f.reserves, 2);
		f.natural = 44;
		f.layout("question:false", false);
		assert.equal(f.animations.at(-1)!.frames[0]!.height, "380px");
	});
	it("does not reserve animated intermediate heights, but does reserve settled geometry", () => {
		const f = fixture(); const animation = f.start();
		assert.equal(f.reserves, 2);
		f.layout("question:true", true);
		assert.equal(f.reserves, 2);
		animation.playState = "finished";
		f.layout("question:true", true);
		assert.equal(f.reserves, 3);
	});
	it("uses the retargeted settled height for the next fold and retains warm reopen timing", () => {
		const f = fixture(); const opening = f.start();
		f.advance(10); f.natural = 358;
		f.morph.retarget("question:true");
		opening.playState = "finished";
		f.natural = 44; f.layout("question:false", false);
		assert.deepEqual(f.animations.at(-1)!.frames, [{ height: "358px" }, { height: "44px" }]);
		f.animations.at(-1)!.playState = "finished";
		f.natural = 358; f.layout("question:true", true);
		assert.equal(f.animations.at(-1)!.duration, 120);
		assert.equal(f.animations.at(-1)!.frames[1]!.height, "358px");
	});
	it("cancels only the owned height animation on replacement and rejects stale keys", () => {
		const f = fixture(); const opening = f.start();
		f.natural = 300; f.layout("practice:true", true);
		assert.equal(opening.cancelled, true);
		const replacement = f.animations.at(-1)!;
		f.natural = 400;
		f.morph.retarget("question:true");
		assert.equal(replacement.retargets, 0);
		f.morph.retarget("practice:true");
		assert.equal(replacement.retargets, 1);
	});
	it("disposes on Activity cleanup/unmount and reconnects without replaying a transition", () => {
		const f = fixture(); const animation = f.start();
		f.morph.dispose();
		assert.equal(animation.cancelled, true);
		f.natural = 358;
		f.morph.retarget("question:true");
		assert.equal(animation.retargets, 0);
		f.layout("question:true", true);
		assert.equal(f.animations.length, 1);
		f.morph.dispose();
	});
});

describe("natural shell measurement", () => {
	for (const original of [null, { value: "52px", priority: "" }, { value: "auto", priority: "important" }]) {
		it(`restores the exact inline height and priority: ${JSON.stringify(original)}`, () => {
			const f = fixture(); f.start(); f.natural = 358; f.visible = 80;
			if (original) f.style.setProperty("height", original.value, original.priority);
			assert.equal(naturalDockHeight(f.shell), 358);
			assert.equal(f.style.getPropertyValue("height"), original?.value ?? "");
			assert.equal(f.style.getPropertyPriority("height"), original?.priority ?? "");
		});
	}
	it("restores measurement styles in finally when layout fails", () => {
		const f = fixture(); f.style.setProperty("height", "52px", "important"); f.failMeasurement = true;
		assert.throws(() => naturalDockHeight(f.shell), /layout failed/);
		assert.equal(f.style.getPropertyValue("height"), "52px");
		assert.equal(f.style.getPropertyPriority("height"), "important");
	});
	it("targets the CSS-clamped shell instead of manually adding content, borders or status heights", () => {
		const f = fixture(); const animation = f.start();
		f.advance(10); f.visible = 90; f.natural = 600; f.cap = 300;
		f.morph.retarget("question:true");
		assert.deepEqual(animation.frames, [{ height: "90px" }, { height: "300px" }]);
	});
});
