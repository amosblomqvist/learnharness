/**
 * xAI sign-in markup. The Settings row is label left, actions right, and
 * any status under that row. The setup dialog keeps the stacked control.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { XAI_OAUTH_ROW_LABEL, XaiSignInBody } from "../components/xai-sign-in.tsx";
import { XAI_SIGN_IN_LABEL, type XaiSignInView } from "../src/core/xai-sign-in.ts";

function htmlFor(view: XaiSignInView, layout: "stack" | "row") {
	return renderToStaticMarkup(<XaiSignInBody view={view} busy={false} layout={layout} onAction={() => {}} />);
}

describe("XaiSignInBody row", () => {
	it("signed out is the provider row with the sign-in button on the right", () => {
		const html = htmlFor({ phase: "signed-out", actions: ["start"] }, "row");
		const label = html.indexOf(XAI_OAUTH_ROW_LABEL);
		const button = html.indexOf(`data-testid="xai-sign-in-start"`);
		assert.ok(label >= 0 && label < button);
		assert.ok(html.includes(XAI_SIGN_IN_LABEL));
		assert.equal(html.includes("xai-sign-in-line"), false);
	});

	it("signed in puts Sign in again and Sign out on the row", () => {
		const html = htmlFor({ phase: "signed-in", notice: null, actions: ["start", "sign-out"] }, "row");
		const label = html.indexOf(XAI_OAUTH_ROW_LABEL);
		const again = html.indexOf("Sign in again");
		const out = html.indexOf("Sign out");
		assert.ok(label >= 0 && label < again && again < out);
		assert.equal(html.includes("xai-sign-in-line"), false);
	});

	it("a signed-in notice sits under the action row", () => {
		const html = htmlFor(
			{ phase: "signed-in", notice: { kind: "refresh-failed" }, actions: ["start", "sign-out"] },
			"row",
		);
		const out = html.indexOf("Sign out");
		const line = html.indexOf('data-testid="xai-sign-in-line"');
		assert.ok(out >= 0 && line > out);
		assert.ok(html.includes("Sign in again, or sign out"));
	});

	it("pending keeps the code under the row and Cancel on the right", () => {
		const html = htmlFor(
			{
				phase: "pending",
				userCode: "ABCD-1234",
				verificationUri: "https://auth.x.ai/device",
				expiresAt: 1,
				actions: ["cancel"],
			},
			"row",
		);
		const label = html.indexOf(XAI_OAUTH_ROW_LABEL);
		const cancel = html.indexOf("Cancel");
		const line = html.indexOf('data-testid="xai-sign-in-line"');
		const code = html.indexOf("ABCD-1234");
		assert.ok(label >= 0 && label < cancel && cancel < line && line < code);
	});

	it("the stacked control has no provider-row label", () => {
		const html = htmlFor({ phase: "denied", actions: ["start"] }, "stack");
		assert.equal(html.includes(XAI_OAUTH_ROW_LABEL), false);
		const line = html.indexOf('data-testid="xai-sign-in-line"');
		const retry = html.indexOf("Try again");
		assert.ok(line >= 0 && line < retry);
	});
});
