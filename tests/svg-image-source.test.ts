import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { svgImageSource } from "../lib/svg-image-source.ts";

// svg-image.test.tsx covers component rendering. These pins cover the two
// display-only source repairs directly, including what must stay verbatim.
describe("svgImageSource", () => {
	it("adds the namespace to the first root svg only", () => {
		assert.match(svgImageSource("<svg viewBox='0 0 1 1'></svg>"),
			/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
		assert.equal((svgImageSource("<svg></svg><svg></svg>").match(/xmlns=/g) ?? []).length, 1);
	});

	it("leaves an existing namespace alone, including single quotes", () => {
		assert.equal(svgImageSource(`<svg xmlns='x'></svg>`), `<svg xmlns='x'></svg>`);
		assert.equal(svgImageSource(`<svg xmlns="x"></svg>`), `<svg xmlns="x"></svg>`);
	});

	it("does not mistake xmlns text inside another attribute for a declaration", () => {
		assert.match(svgImageSource(`<svg data-note="xmlns=foo"></svg>`),
			/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
	});

	it("replaces &nbsp; but copies comments, CDATA and processing instructions verbatim", () => {
		assert.equal(
			svgImageSource("<svg><!-- &nbsp; --><![CDATA[&nbsp;]]><?pi &nbsp;?>&nbsp;</svg>"),
			`<svg xmlns="http://www.w3.org/2000/svg"><!-- &nbsp; --><![CDATA[&nbsp;]]><?pi &nbsp;?>&#160;</svg>`,
		);
	});
});
