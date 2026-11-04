/**
 * THE WEAK-MODEL ARGUMENT HEAL (owner, 2026-10-04 — the GLM practice-loop
 * incident): glm-5.3 sent `"mode": "\"recall\""` — a JSON-string-encoded
 * enum — on 19 consecutive `problem` calls; TypeBox's "must be equal to
 * constant" error never named the expected values, so the model re-emitted
 * the identical payload until the dev server was killed.
 *
 * These pins hold the heal that runs at pi's prepareArguments seam (BEFORE
 * validation): string values where the schema expects a literal union /
 * boolean / null / number / array are JSON.parse-d and kept when the
 * parsed value satisfies the schema. Well-formed args pass through
 * untouched (same reference); unhealable values stay for validation to
 * reject honestly — the END-TO-END pins drive pi-ai's own
 * validateToolArguments: the healed args pass where the raw ones threw.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concludeInputObject, problemInputObject } from "../src/agent/tools/practice.ts";
import { healEncodedArguments } from "../src/core/argument-heal.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";

/** The incident's exact mode spelling: the string  "recall"  INCLUDING
 *  its quote characters (what JSON.parse turns back into recall). */
const QUOTED = (s: string) => `"${s}"`;

describe("healEncodedArguments — the GLM incident", () => {
	it("heals the double-encoded mode enum (the exact 19-call loop)", () => {
		const healed = healEncodedArguments({ mode: QUOTED("recall") }, problemInputObject) as {
			mode: unknown;
		};
		assert.equal(healed.mode, "recall");
	});

	it("END-TO-END: the healed args pass pi-ai validation where the raw threw", () => {
		const raw = {
			statement: "Prove that every finite group of prime order is cyclic.",
			mode: QUOTED("recall"), // the incident: every field valid BUT mode
			target: ["group-order"],
			modelSolution: "Let |G| = p. Any x ≠ e generates a subgroup whose order divides p…",
		};
		// The raw shape is the incident: validation throws.
		assert.throws(() => {
			validateToolArguments({ name: "problem", parameters: problemInputObject } as never, {
				id: "call_x",
				type: "toolCall",
				name: "problem",
				arguments: raw,
			} as never);
		});
		const healed = healEncodedArguments(raw, problemInputObject);
		// The healed shape is valid — the loop never starts.
		const validated = validateToolArguments(
			{ name: "problem", parameters: problemInputObject } as never,
			{ id: "call_x", type: "toolCall", name: "problem", arguments: healed } as never,
		);
		assert.equal((validated as { mode: unknown }).mode, "recall");
	});

	it("well-formed args pass through untouched — the SAME reference", () => {
		const args = { mode: "recall", target: ["a"], retest: false };
		assert.equal(healEncodedArguments(args, problemInputObject), args);
		assert.equal(healEncodedArguments(args, concludeInputObject), args);
	});

	it("unhealable values stay — validation rejects them honestly", () => {
		const healed = healEncodedArguments({ mode: QUOTED("bogus") }, problemInputObject) as {
			mode: unknown;
		};
		assert.equal(healed.mode, QUOTED("bogus"));
	});
});

describe("healEncodedArguments — the sibling encodings", () => {
	it("heals the conclude enums (outcome) and the null rung", () => {
		const healed = healEncodedArguments(
			{ outcome: QUOTED("solved"), rung: "null" },
			concludeInputObject,
		) as { outcome: unknown; rung: unknown };
		assert.equal(healed.outcome, "solved");
		assert.equal(healed.rung, null);
	});

	it("heals the rung enum and the stringified boolean retest", () => {
		const healed = healEncodedArguments(
			{ rung: QUOTED("R2"), retest: "true" },
			concludeInputObject,
		) as { rung: unknown; retest: unknown };
		assert.equal(healed.rung, "R2");
		assert.equal(healed.retest, true);
	});

	it("heals a stringified array (the extraction-bug sibling)", () => {
		const healed = healEncodedArguments({ target: '["a","b"]' }, problemInputObject) as {
			target: unknown;
		};
		assert.deepEqual(healed.target, ["a", "b"]);
	});

	it("leaves plain string properties alone (statement is a string schema)", () => {
		const args = { statement: '"not JSON-healed"' };
		const healed = healEncodedArguments(args, problemInputObject) as { statement: unknown };
		// A Type.String property has no literals and no scalar type match —
		// the string passes through as-is (same reference, nothing cloned).
		assert.equal(healed, args);
	});

	it("a worksheet's reference passes through untouched — a string schema has nothing to heal", () => {
		// The sheet is free-form markdown/LaTeX: even text that LOOKS JSON
		// must arrive verbatim, never JSON.parse-d into something else.
		const sheet = '"| rule | form |\\n| --- | --- |"';
		const args = { statement: "1) …", mode: "composition", reference: sheet, modelSolution: "1) …" };
		assert.equal(healEncodedArguments(args, problemInputObject), args);
	});

	it("END-TO-END: the reference survives a healed call (the GLM wobble beside a worksheet)", () => {
		const reference = "| rule | form |\n| --- | --- |\n| difference of squares | $a^2-b^2$ |";
		const healed = healEncodedArguments(
			{
				statement: "1) Factor $x^2-1$.",
				mode: QUOTED("composition"),
				reference,
				modelSolution: "1) $(x-1)(x+1)$.",
			},
			problemInputObject,
		);
		const validated = validateToolArguments(
			{ name: "problem", parameters: problemInputObject } as never,
			{ id: "call_w", type: "toolCall", name: "problem", arguments: healed } as never,
		) as { mode: unknown; reference: unknown };
		assert.equal(validated.mode, "composition");
		assert.equal(validated.reference, reference);
	});

	it("passes non-object shapes through (null, arrays, strings)", () => {
		assert.equal(healEncodedArguments(null, problemInputObject), null);
		const arr = [1, 2];
		assert.equal(healEncodedArguments(arr, problemInputObject), arr);
		assert.equal(healEncodedArguments("mode", problemInputObject), "mode");
	});
});
