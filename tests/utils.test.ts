import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cn } from "../lib/utils.ts";

describe("cn", () => {
	it("joins class names", () => {
		assert.equal(cn("flex", "items-center", "gap-2"), "flex items-center gap-2");
	});

	it("drops falsy values", () => {
		assert.equal(cn("flex", false, null, undefined, "", "gap-2"), "flex gap-2");
	});

	it("lets a later Tailwind class win over an earlier conflicting one", () => {
		assert.equal(cn("p-2", "p-4"), "p-4");
		assert.equal(cn("text-sm text-red-500", "text-lg"), "text-red-500 text-lg");
	});
});
