"use client";

/**
 * Makes copying rendered math paste as its TeX source. KaTeX's `copy-tex`
 * contrib installs ONE global `copy` listener on `document` when it is first
 * imported (it has no teardown), so loading it from a mount-once effect is
 * enough: later imports hit the module cache and add nothing. Renders null.
 */

import { useEffect } from "react";

export default function CopyMathAsTex() {
	useEffect(() => {
		// A failed chunk load just leaves the default copy behavior in place.
		import("katex/contrib/copy-tex").catch(() => {});
	}, []);
	return null;
}
