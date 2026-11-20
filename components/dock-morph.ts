/** Private height-only WAAPI owner for DockOverlay. Content fades and plugin
 * animations are deliberately outside this controller's ownership. */
const DURATION = 120;
const EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EPSILON = 1;

/** An important inline height overrides WAAPI without cancelling it. Measuring
 * the actual shell preserves CSS max-height clamps, borders and all children.
 * Restore even when layout throws; no measurement style survives this call. */
export function naturalDockHeight(shell: HTMLElement) {
	const value = shell.style.getPropertyValue("height");
	const priority = shell.style.getPropertyPriority("height");
	try {
		shell.style.setProperty("height", "auto", "important");
		return shell.getBoundingClientRect().height;
	} finally {
		if (value) shell.style.setProperty("height", value, priority);
		else shell.style.removeProperty("height");
	}
}

export function createDockMorph() {
	let previous: { shell: HTMLElement; key: string; height: number } | null = null;
	let owned: {
		shell: HTMLElement; key: string; animation: Animation; opening: boolean;
		target: number; duration: number;
	} | null = null;
	const live = (animation: Animation) => animation.playState !== "finished" && animation.playState !== "idle";
	const cancel = () => {
		owned?.animation.cancel();
		owned = null;
	};
	return {
		/** Offer natural block geometry before starting a transition. Initial
		 * appearance is instant; same-key typing never animates. */
		layout(shell: HTMLElement, key: string, opening: boolean, onNaturalLayout: () => void) {
			if (previous?.shell === shell && previous.key === key) {
				if (owned && live(owned.animation)) return;
				previous.height = shell.getBoundingClientRect().height;
				onNaturalLayout();
				return;
			}
			cancel();
			const height = shell.getBoundingClientRect().height;
			onNaturalLayout();
			if (previous?.shell === shell && Math.abs(previous.height - height) > EPSILON) {
				const animation = shell.animate([
					{ height: `${previous.height}px` }, { height: `${height}px` },
				], { duration: DURATION, easing: EASING });
				owned = { shell, key, animation, opening, target: height, duration: DURATION };
			}
			previous = { shell, key, height };
		},
		/** Called after height constraints, including child-only ResizeObserver
		 * deliveries. Only an already-running opening may change its target. */
		retarget(key: string) {
			const active = owned;
			if (!active || active.key !== key || !active.opening || !live(active.animation)) return;
			const effect = active.animation.effect as KeyframeEffect | null;
			if (!effect) return;
			// Read the visible starting point BEFORE temporarily bypassing WAAPI.
			const visible = active.shell.getBoundingClientRect().height;
			// Keep the original DOCUMENT-TIMELINE completion, not wall time.
			// Pending starts can have null currentTime; no animation time has
			// elapsed yet. A suspended document timeline likewise consumes none.
			const currentTime = active.animation.currentTime;
			const remaining = active.duration - (typeof currentTime === "number" ? currentTime : 0);
			if (remaining <= 0) return;
			const target = naturalDockHeight(active.shell);
			if (Math.abs(target - active.target) <= EPSILON || !live(active.animation)) return;
			// Reset BEFORE shortening duration: otherwise a late retarget could
			// transiently finish the effect at its old currentTime. All writes are
			// synchronous, with the captured visible height as the new first frame.
			active.animation.currentTime = 0;
			effect.setKeyframes([{ height: `${visible}px` }, { height: `${target}px` }]);
			effect.updateTiming({ duration: remaining });
			active.duration = remaining;
			active.target = target;
			if (previous?.key === key) previous.height = target;
		},
		/** Layout-effect cleanup also runs for Activity hide. Reconnection starts
		 * from the preserved DOM without replaying a stale transition. */
		dispose() {
			cancel();
			previous = null;
		},
	};
}
