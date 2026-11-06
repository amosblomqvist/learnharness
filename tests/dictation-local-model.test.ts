/**
 * The pure rules behind the Local model list: ordering, search, what a row says about a
 * model, and the transcription language choices.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelListing, formatWait, matchesModelSearch, modelRowInfo, summarizeLanguages, transcriptionChoices } from "../components/settings/dictation-local-model.ts";
import { CATALOG_MODELS, getCatalogModel, type CatalogModel } from "../src/core/index.ts";

test("the model listing orders benchmarked models by accuracy, never repeats a model, and keeps installed ones visible", () => {
	const installed = new Set(["gigaam-v3-e2e-ctc"]);
	const listing = buildModelListing({ preferred: ["en", "de"], installed, currentId: "", query: "" });
	const everyId = [...listing.picks.map((p) => p.model.id), ...listing.others.map((m) => m.id), ...listing.folded.map((m) => m.id)];
	assert.equal(new Set(everyId).size, everyId.length, "each model once");
	assert.equal(everyId.length, CATALOG_MODELS.length, "and all of them somewhere");
	const errors = listing.others.map((m) => listing.benchmarks.get(m.id)?.error).filter((e): e is number => e !== undefined);
	assert.deepEqual(errors, [...errors].sort((a, b) => a - b));
	assert.ok(listing.others.some((m) => m.id === "gigaam-v3-e2e-ctc") && !listing.folded.some((m) => m.id === "gigaam-v3-e2e-ctc"), "an installed model is never folded");
	const inUse = buildModelListing({ preferred: ["en", "de"], installed: new Set(), currentId: "gigaam-v3-e2e-rnnt", query: "" });
	assert.ok(inUse.others.some((m) => m.id === "gigaam-v3-e2e-rnnt"), "nor is the model in use");
});

test("the search matches every word against name, id and family", () => {
	const turbo = getCatalogModel("whisper-large-v3-turbo")!;
	assert.equal(matchesModelSearch(turbo, ""), true);
	assert.equal(matchesModelSearch(turbo, "WHISPER turbo"), true);
	assert.equal(matchesModelSearch(turbo, "whisper parakeet"), false);
	assert.equal(matchesModelSearch(turbo, "  "), true);
});

test("row information names what a model lacks and what it measured", () => {
	const turbo = getCatalogModel("whisper-large-v3-turbo")!;
	const info = modelRowInfo(turbo, ["en", "de"], "cpu");
	assert.deepEqual(info.grades.map((g) => g.language), ["en", "de"]);
	assert.deepEqual(info.missing, []);
	const english = CATALOG_MODELS.find((m: CatalogModel) => m.languages.length === 1 && m.languages[0] === "en")!;
	assert.deepEqual(modelRowInfo(english, ["en", "de"], "cpu").missing, ["German"]);
	assert.equal(formatWait(1.234), "~1.2 s");
	assert.equal(formatWait(12.4), "~12 s");
	assert.equal(formatWait(120), "~2 min");
	assert.deepEqual(transcriptionChoices(english, ["en"]).choices, [{ value: "en", label: "English" }]);
});

test("a list of languages reads as a sentence, and a long one is counted", () => {
	assert.equal(summarizeLanguages(["en"]), "English");
	assert.equal(summarizeLanguages(["en", "de"]), "English and German");
	assert.equal(summarizeLanguages(["en", "de", "fr"]), "English, German, and French");
	assert.equal(summarizeLanguages(["en", "de", "fr", "es"]), "English, German and 2 more");
});
