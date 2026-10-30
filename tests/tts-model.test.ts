/**
 * resolveTtsModel: which model read-aloud really uses (ElevenLabs voice slice 9).
 * A saved listed model wins; else v4 Turbo, else Flash v2.5, else the first
 * listed; with no list, the saved model or v4 Turbo.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlainTtsId, resolveTtsModel, resolveTtsVoice } from "../src/core/index.ts";

describe("resolveTtsVoice", () => {
	const ALICE = "Xb7hH8MSUJpSbSDYk0k2";
	const table: Array<[string, string | undefined, string[], string]> = [
		["saved and listed", "clone1", [ALICE, "clone1"], "clone1"],
		["unset, Alice listed", undefined, [ALICE, "clone1"], ALICE],
		["saved no longer on the account: Alice", "gone", [ALICE, "clone1"], ALICE],
		["unset, Alice not listed: still Alice", undefined, ["clone1"], ALICE],
		["saved unlisted and Alice not listed: Alice", "gone", ["clone1"], ALICE],
		["list unavailable, saved is trusted", "clone1", [], "clone1"],
		["list unavailable, nothing saved", undefined, [], ALICE],
	];
	for (const [name, saved, listed, expected] of table) {
		it(name, () => assert.equal(resolveTtsVoice(saved, listed), expected));
	}
});

describe("resolveTtsModel", () => {
	const table: Array<[string, string | undefined, string[], string]> = [
		["saved and listed", "eleven_v4", ["eleven_v4_turbo", "eleven_v4"], "eleven_v4"],
		["unset, v4 turbo listed", undefined, ["eleven_flash_v2_5", "eleven_v4_turbo"], "eleven_v4_turbo"],
		["saved no longer listed, v4 turbo listed", "gone", ["eleven_flash_v2_5", "eleven_v4_turbo"], "eleven_v4_turbo"],
		["unset, only flash listed", undefined, ["eleven_v3", "eleven_flash_v2_5"], "eleven_flash_v2_5"],
		["saved unlisted, only flash listed", "gone", ["eleven_v3", "eleven_flash_v2_5"], "eleven_flash_v2_5"],
		["neither default listed: the first", undefined, ["eleven_v3", "eleven_multilingual_v2"], "eleven_v3"],
		["saved unlisted, neither default: the first", "gone", ["eleven_v3", "eleven_multilingual_v2"], "eleven_v3"],
		["list unavailable, saved", "eleven_v4", [], "eleven_v4"],
		["list unavailable, nothing saved", undefined, [], "eleven_v4_turbo"],
	];
	for (const [name, saved, listed, expected] of table) {
		it(name, () => assert.equal(resolveTtsModel(saved, listed), expected));
	}
});

describe("isPlainTtsId", () => {
	it("accepts provider ids and rejects path or space tricks", () => {
		assert.equal(isPlainTtsId("Xb7hH8MSUJpSbSDYk0k2"), true);
		assert.equal(isPlainTtsId("eleven_v4_turbo"), true);
		for (const bad of ["", "a b", "../x", "a/b", 5, undefined, "x".repeat(101)]) assert.equal(isPlainTtsId(bad), false);
	});
});
