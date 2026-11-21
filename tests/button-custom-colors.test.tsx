import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { compile } from "tailwindcss";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import type { PluginButtonColors } from "../src/core/plugin-ui.ts";

type Props = React.ComponentProps<typeof Button>;
function render(props: Props = {}) {
	const html = renderToStaticMarkup(<Button {...props}>Native action</Button>);
	const { document } = parseHTML(html);
	return { html, button: document.querySelector<HTMLButtonElement>("button")! };
}
const classes = (button: HTMLElement) => button.className.split(" ");
// Linkedom retains cleared properties as `name:`, unlike browser CSSOM.
const variables = (button: HTMLElement) => Object.fromEntries(
	(button.getAttribute("style") ?? "").split(";").filter(Boolean).map(value => {
		const separator = value.indexOf(":"); return [value.slice(0, separator), value.slice(separator + 1)];
	}).filter(([key, value]) => key!.startsWith("--button-custom-") && value !== ""),
);
const theme = "@theme { --spacing: 0.25rem; --color-primary: #123456; --color-primary-foreground: #ffffff; --color-ring: #abcdef; } @tailwind utilities;";

it("custom defaults retain native primary colors, a transparent fixed border, focus geometry and disabled policy without automatic hover", async () => {
	const { button } = render({ variant: "custom" }); const tokens = classes(button);
	for (const token of ["border", "border-transparent", "bg-primary", "text-primary-foreground", "focus-visible:border-ring", "focus-visible:ring-[3px]", "focus-visible:ring-ring/50", "disabled:pointer-events-none", "disabled:opacity-50"]) assert.ok(tokens.includes(token), token);
	assert.equal(tokens.some(token => /^(?:hover|active):/.test(token)), false, "no invented state hue calculations");
	assert.deepEqual(variables(button), {}); assert.equal(button.hasAttribute("style"), false); assert.equal(button.hasAttribute("colors"), false);
	assert.equal(button.dataset.variant, "custom"); assert.equal(button.dataset.slot, "button");
	const compiler = await compile(theme); const css = compiler.build(tokens);
	assert.match(css, /border-width: 1px/); assert.match(css, /border-color: transparent/);
	assert.match(css, /background-color: var\(--color-primary\)/); assert.match(css, /color: var\(--color-primary-foreground\)/);
	assert.match(css, /--tw-ring-color: color-mix\(in oklab, var\(--color-ring\) 50%, transparent\)/);
	assert.match(css, /opacity: 50%/); assert.match(css, /pointer-events: none/);
});

it("empty optional state objects are identical to omitted colors and do not create overriding utilities", () => {
	const defaults = render({ variant: "custom" }).button;
	const empty = render({ variant: "custom", colors: { hover: {}, active: {}, focusVisible: {}, disabled: {} } }).button;
	assert.equal(empty.className, defaults.className); assert.deepEqual(variables(empty), {}); assert.equal(empty.hasAttribute("style"), false);
});

it("only supplied per-property slots create private variables and conditional state classes", () => {
	const colors: PluginButtonColors = { background: "#123456", text: "white", border: "rgb(1 2 3)", hover: { text: "pink" }, active: { border: "blue" }, focusVisible: { ring: "cyan" }, disabled: { background: "gray" } };
	const { button } = render({ variant: "custom", colors }); const tokens = classes(button);
	assert.deepEqual(variables(button), {
		"--button-custom-background": "#123456", "--button-custom-text": "white", "--button-custom-border": "rgb(1 2 3)",
		"--button-custom-hover-text": "pink", "--button-custom-active-border": "blue", "--button-custom-focus-visible-ring": "cyan", "--button-custom-disabled-background": "gray",
	});
	for (const token of ["bg-[color:var(--button-custom-background)]", "text-[color:var(--button-custom-text)]", "border-[color:var(--button-custom-border)]", "hover:text-[color:var(--button-custom-hover-text)]", "active:border-[color:var(--button-custom-active-border)]", "focus-visible:ring-[color:var(--button-custom-focus-visible-ring)]", "disabled:bg-[color:var(--button-custom-disabled-background)]"]) assert.ok(tokens.includes(token), token);
	for (const token of ["hover:bg-", "hover:border-", "active:bg-", "active:text-", "focus-visible:bg-", "focus-visible:text-", "disabled:text-", "disabled:border-"]) assert.equal(tokens.some(value => value.startsWith(token)), false, token);
	assert.ok(tokens.includes("focus-visible:border-ring"), "a ring-only override does not replace the native focus border");
	assert.ok(tokens.includes("focus-visible:ring-[3px]"), "ring color never replaces ring geometry");
	assert.equal(tokens.includes("focus-visible:ring-ring/50"), false, "only the supplied native ring color is replaced");
	assert.equal(button.hasAttribute("colors"), false);
});

it("focus border overrides neither native ring color nor width when ring is omitted", () => {
	const { button } = render({ variant: "custom", colors: { focusVisible: { border: "gold" } } }); const tokens = classes(button);
	assert.ok(tokens.includes("focus-visible:border-[color:var(--button-custom-focus-visible-border)]"));
	assert.equal(tokens.includes("focus-visible:border-ring"), false);
	assert.ok(tokens.includes("focus-visible:ring-ring/50")); assert.ok(tokens.includes("focus-visible:ring-[3px]"));
	assert.deepEqual(variables(button), { "--button-custom-focus-visible-border": "gold" });
});

const fullColors: PluginButtonColors = {
	background: "#101010", text: "#eeeeee", border: "#202020",
	hover: { background: "#303030", text: "#dddddd", border: "#404040" },
	focusVisible: { background: "#505050", text: "#cccccc", border: "#606060", ring: "#abcdef" },
	active: { background: "#707070", text: "#bbbbbb", border: "#808080" },
	disabled: { background: "#909090", text: "#aaaaaa", border: "#a0a0a0" },
};

it("actual Tailwind CSS resolves every color property in disabled > active > focus-visible > hover > normal order", async () => {
	const { button } = render({ variant: "custom", colors: fullColors }); const tokens = classes(button);
	const compiler = await compile(theme); const css = compiler.build([...tokens].reverse());
	assert.equal(Object.keys(variables(button)).length, 16);
	for (const [slot, property] of [["background", "background-color"], ["text", "color"], ["border", "border-color"]]) {
		const positions = ["", "hover-", "focus-visible-", "active-", "disabled-"].map(prefix => {
			const declaration = `${property}: var(--button-custom-${prefix}${slot})`;
			const position = css.indexOf(declaration); assert.ok(position >= 0, declaration); return position;
		});
		assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${property}: Tailwind order, not JSX class order, decides simultaneous states`);
	}
	for (const state of ["hover", "focus-visible", "active", "disabled"]) assert.match(css, new RegExp(`:${state}\\s*\\{`), `actual CSS pseudo-class :${state}`);
	assert.match(css, /@media \(hover: hover\)/);
	assert.match(css, /--tw-ring-color: var\(--button-custom-focus-visible-ring\)/);
	assert.ok(tokens.includes("disabled:opacity-50")); assert.ok(tokens.includes("disabled:pointer-events-none"));
	assert.ok(tokens.includes("focus-visible:ring-[3px]"));
});

it("a partial higher state emits no fallback declaration that could erase another property's lower-state color", async () => {
	const { button } = render({ variant: "custom", colors: { background: "navy", hover: { background: "blue", text: "white" }, focusVisible: { text: "yellow" }, active: { border: "red" }, disabled: { text: "gray" } } });
	const compiler = await compile(theme); const css = compiler.build(classes(button));
	assert.match(css, /background-color: var\(--button-custom-hover-background\)/);
	assert.match(css, /color: var\(--button-custom-focus-visible-text\)/);
	assert.match(css, /border-color: var\(--button-custom-active-border\)/);
	assert.match(css, /color: var\(--button-custom-disabled-text\)/);
	for (const omitted of ["focus-visible-background", "active-background", "active-text", "disabled-background", "disabled-border"]) assert.equal(css.includes(`var(--button-custom-${omitted})`), false, omitted);
	assert.match(css, /border-color: var\(--color-ring\)/, "omitting focus border keeps native focus styling");
});

it("all legacy variants ignore supplied colors entirely and retain their native class output", () => {
	for (const variant of ["default", "destructive", "outline", "secondary", "ghost", "link"] as const) {
		const normal = render({ variant }).button, ignored = render({ variant, colors: fullColors }).button;
		assert.equal(ignored.className, normal.className, variant); assert.deepEqual(variables(ignored), {});
		assert.equal(ignored.hasAttribute("style"), false); assert.equal(ignored.hasAttribute("colors"), false);
	}
	assert.equal(render({ colors: fullColors }).button.className, render().button.className, "omitted variant remains native default");
});

it("native sizes and existing SVG/wrapped-icon padding are unchanged for custom and legacy variants", () => {
	for (const [size, expected] of [["default", ["h-9", "px-4", "py-2", "has-[>svg]:px-3", "has-[>[data-slot=button-icon]]:px-3"]], ["xs", ["h-6", "px-2", "text-xs", "has-[>svg]:px-1.5", "has-[>[data-slot=button-icon]]:px-1.5"]], ["sm", ["h-8", "px-3", "has-[>svg]:px-2.5", "has-[>[data-slot=button-icon]]:px-2.5"]], ["lg", ["h-10", "px-6", "has-[>svg]:px-4", "has-[>[data-slot=button-icon]]:px-4"]], ["icon", ["size-9"]], ["icon-xs", ["size-6"]], ["icon-sm", ["size-8"]], ["icon-lg", ["size-10"]]] as const) {
		for (const variant of ["default", "custom"] as const) {
			const { button } = render({ variant, size }); assert.equal(button.dataset.size, size);
			for (const token of expected) assert.ok(classes(button).includes(token), `${variant}/${size}: ${token}`);
		}
	}
	assert.equal(buttonVariants().includes("hover:bg-primary/90"), true);
	assert.equal(buttonVariants({ variant: "custom" }).includes("hover:"), false);
});

it("native caller className and style overrides still win without forwarding colors to DOM", () => {
	const style = { "--button-custom-background": "rebeccapurple", color: "teal", marginTop: 3 } as React.CSSProperties;
	const { button } = render({ variant: "custom", colors: fullColors, className: "bg-green-500 text-red-500 hover:bg-blue-500 focus-visible:ring-yellow-500 px-1", style });
	const tokens = classes(button);
	for (const token of ["bg-green-500", "text-red-500", "hover:bg-blue-500", "focus-visible:ring-yellow-500", "px-1", "focus-visible:ring-[3px]"]) assert.ok(tokens.includes(token), token);
	for (const token of ["bg-[color:var(--button-custom-background)]", "text-[color:var(--button-custom-text)]", "hover:bg-[color:var(--button-custom-hover-background)]", "focus-visible:ring-[color:var(--button-custom-focus-visible-ring)]"]) assert.equal(tokens.includes(token), false, token);
	assert.equal(variables(button)["--button-custom-background"], "rebeccapurple");
	assert.match(button.getAttribute("style")!, /color:teal/); assert.match(button.getAttribute("style")!, /margin-top:3px/);
	assert.equal(button.hasAttribute("colors"), false);
	const { document } = parseHTML(renderToStaticMarkup(<Button asChild variant="custom" colors={{ text: "pink" }}><a href="/local">Local link</a></Button>));
	assert.equal(document.querySelectorAll("button").length, 0); assert.equal(document.querySelector("a")!.getAttribute("href"), "/local");
	assert.equal(document.querySelector("a")!.hasAttribute("colors"), false);
});

it("color updates preserve the actual button and native click, key, disabled and type behavior", async () => {
	const dom = parseHTML("<!doctype html><html><body><main></main></body></html>");
	const values = { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])); Object.assign(globalThis, values);
	const root = createRoot(document.querySelector("main")!); let clicks = 0; const keys: string[] = [];
	const draw = (colors: PluginButtonColors, disabled = false) => <Button variant="custom" colors={colors} disabled={disabled} type="button" onClick={() => { clicks++; }} onKeyDown={event => keys.push(event.key)}>Action</Button>;
	try {
		await act(async () => root.render(draw({ background: "navy" })));
		const button = document.querySelector("button")!;
		await act(async () => button.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		const enter = new dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(enter, { key: "Enter" });
		await act(async () => button.dispatchEvent(enter));
		assert.equal(clicks, 1); assert.deepEqual(keys, ["Enter"]); assert.equal(enter.defaultPrevented, false, "no custom activation/key handler");
		await act(async () => root.render(draw({ text: "gold", active: { background: "blue" } })));
		assert.equal(document.querySelector("button") === button, true); assert.equal(button.getAttribute("type"), "button");
		assert.deepEqual(variables(button), { "--button-custom-text": "gold", "--button-custom-active-background": "blue" });
		assert.equal(button.style.getPropertyValue("--button-custom-background"), "", "removed normal slots are cleared, not retained as stale overrides");
		await act(async () => root.render(draw({ disabled: { background: "gray" } }, true)));
		await act(async () => button.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal(clicks, 1); assert.equal(button.hasAttribute("disabled"), true);
		assert.ok(classes(button).includes("disabled:pointer-events-none")); assert.ok(classes(button).includes("disabled:opacity-50"));
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
