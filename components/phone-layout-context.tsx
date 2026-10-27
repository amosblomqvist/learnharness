"use client";

import { createContext, useContext, useLayoutEffect, useState } from "react";
import { DESKTOP_LAYOUT, keyboardInset, modelMenuWidth, phoneLayout, type PhoneLayout } from "@/components/phone-layout";

export type LiveLayout = PhoneLayout & {
	coarsePointer: boolean;
	canHover: boolean;
	viewportWidth: number;
};

const SERVER_LAYOUT: LiveLayout = { ...DESKTOP_LAYOUT, coarsePointer: false, canHover: true, viewportWidth: Infinity };

const PhoneLayoutContext = createContext<LiveLayout>(SERVER_LAYOUT);

export function usePhoneLayout(): LiveLayout {
	return useContext(PhoneLayoutContext);
}

function readLayout(): LiveLayout {
	const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
	const canHover = window.matchMedia("(hover: hover)").matches;
	// The preload bridge, not the user agent: other Electron hosts (an
	// editor's embedded browser) have no bridge to widen the window.
	const electron = window.lh !== undefined;
	const width = window.innerWidth;
	return { ...phoneLayout({ width, electron, coarsePointer }), coarsePointer, canHover, viewportWidth: width };
}

function sameLayout(a: LiveLayout, b: LiveLayout): boolean {
	return (
		a.shell === b.shell &&
		a.coarsePointer === b.coarsePointer &&
		a.canHover === b.canHover &&
		a.viewportWidth === b.viewportWidth
	);
}

export type KeyboardInset = { bottomInset: number; dockMaxHeight: number };

const NO_KEYBOARD: KeyboardInset = { bottomInset: 0, dockMaxHeight: Infinity };

const KeyboardInsetContext = createContext<KeyboardInset>(NO_KEYBOARD);

export function useModelMenuWidth(): number {
	return modelMenuWidth(usePhoneLayout().viewportWidth);
}

/** The keyboard's live inset — the docks read it to stay above the keyboard. */
export function useKeyboardInset(): KeyboardInset {
	return useContext(KeyboardInsetContext);
}

function readSafeAreaBottom(probe: HTMLElement): number {
	return Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0;
}

/** Feeds keyboardInset from visualViewport and mirrors the inset into
 *  --lh-keyboard-inset for the CSS-positioned docks. Pinch-zoom also
 *  shrinks the visual viewport, so a zoomed page reads as keyboard-down. */
function KeyboardInsetProvider({ children }: { children: React.ReactNode }) {
	const [inset, setInset] = useState<KeyboardInset>(NO_KEYBOARD);
	useLayoutEffect(() => {
		const vv = window.visualViewport;
		const probe = document.createElement("div");
		probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom)";
		document.body.appendChild(probe);
		const update = () => {
			const layoutHeight = document.documentElement.clientHeight;
			const zoomed = !!vv && vv.scale > 1.01;
			const next = keyboardInset({
				layoutHeight,
				visualHeight: vv && !zoomed ? vv.height : layoutHeight,
				offsetTop: vv && !zoomed ? vv.offsetTop : 0,
				safeAreaBottom: readSafeAreaBottom(probe),
			});
			document.documentElement.style.setProperty("--lh-keyboard-inset", `${next.bottomInset}px`);
			setInset((prev) =>
				prev.bottomInset === next.bottomInset && prev.dockMaxHeight === next.dockMaxHeight ? prev : next,
			);
		};
		update();
		vv?.addEventListener("resize", update);
		vv?.addEventListener("scroll", update);
		window.addEventListener("resize", update);
		return () => {
			vv?.removeEventListener("resize", update);
			vv?.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
			probe.remove();
			document.documentElement.style.removeProperty("--lh-keyboard-inset");
		};
	}, []);
	return <KeyboardInsetContext.Provider value={inset}>{children}</KeyboardInsetContext.Provider>;
}

/** Root-layout provider: the server and first client render are the desktop
 *  layout (hydration matches); the real viewport lands before first paint. */
export function PhoneLayoutProvider({ children }: { children: React.ReactNode }) {
	const [layout, setLayout] = useState<LiveLayout>(SERVER_LAYOUT);
	useLayoutEffect(() => {
		const update = () => {
			const next = readLayout();
			setLayout((prev) => (sameLayout(prev, next) ? prev : next));
		};
		update();
		const pointer = window.matchMedia("(pointer: coarse)");
		const hover = window.matchMedia("(hover: hover)");
		window.addEventListener("resize", update);
		pointer.addEventListener("change", update);
		hover.addEventListener("change", update);
		return () => {
			window.removeEventListener("resize", update);
			pointer.removeEventListener("change", update);
			hover.removeEventListener("change", update);
		};
	}, []);
	return (
		<PhoneLayoutContext.Provider value={layout}>
			<KeyboardInsetProvider>{children}</KeyboardInsetProvider>
		</PhoneLayoutContext.Provider>
	);
}
