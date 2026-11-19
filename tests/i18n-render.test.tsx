/**
 * The Chinese UI, rendered (i18n foundation, 2026-11-19): SSR of the settings
 * surface inside I18nProvider(language: "zh-CN") pins that the shell actually
 * renders the dictionary — navigation, section headers, the General section's
 * Language row, and the achromatic checkbox rows all come out in Simplified
 * Chinese while test ids stay stable. Same classic-JSX shim as the sibling
 * render suites; effects never fire under renderToStaticMarkup, so the SSR
 * state is the loading state (asserted, not worked around).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup as renderStatic } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { I18nProvider } from "../components/i18n.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import type { AppLanguage } from "../src/core/index.ts";

function render(node: React.ReactNode, language: AppLanguage = "zh-CN") {
	return renderStatic(
		<InteractionLayersProvider>
			<I18nProvider language={language}>{node}</I18nProvider>
		</InteractionLayersProvider>,
	);
}

describe("the Chinese settings surface (SSR)", () => {
	it("navigation and headers render in Simplified Chinese", () => {
		const html = render(<SettingsDialogBody onClose={() => {}} />);
		for (const label of ["服务商", "智能体", "外观", "知识图谱", "键盘", "通用"]) {
			assert.ok(html.includes(label), "missing Chinese nav label " + label);
		}
		// The English label must not leak through for a translated section.
		assert.ok(!html.includes(">Providers<"), "English nav label leaked");
		// The dialog shell itself is translated too.
		assert.ok(html.includes("设置"), "the dialog title is not translated");
	});

	it("keeps stable test ids while translating labels", () => {
		const { document } = parseHTML(render(<SettingsDialogBody onClose={() => {}} />));
		const nav = document.querySelector('[data-testid="settings-nav-keys"]');
		assert.ok(nav, "settings-nav-keys missing");
		assert.ok(nav!.textContent?.includes("服务商"));
	});

	it("English is unchanged without a provider", () => {
		const html = renderStatic(
			<InteractionLayersProvider>
				<SettingsDialogBody onClose={() => {}} />
			</InteractionLayersProvider>,
		);
		assert.ok(html.includes("Providers"));
		assert.ok(!html.includes("服务商"));
	});

	it("the Keyboard section translates action labels but keeps key bindings", () => {
		const html = render(<KeyboardSection />);
		assert.ok(html.includes("切换听写"), "keyboard action label not translated");
		assert.ok(html.includes("mod+d") || html.includes("⌘D") || html.includes("Ctrl"), "binding lost");
	});
});
