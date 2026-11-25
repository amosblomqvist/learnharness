/**
 * THE WEAK-MODEL ARGUMENT HEAL — the pure core (owner, 2026-10-09 —
 * generalize the 2026-10-04 practice heal; see agent/tools/heal.ts for
 * the registry-wide wiring story). Lives in core because BOTH seams need
 * it (the tool-parts law: display parses mirror boundary coercion or a
 * healed-at-boundary call whose record keeps the RAW arguments renders
 * as an invisible pending quiz):
 *
 *   - the agent boundary: pi's prepareArguments seam, BEFORE TypeBox
 *     validation (withArgumentHeal / healToolRecord);
 *   - the display parse: tool-parts' parseQuizInput, before
 *     boundaryParse — the persisted record keeps raw arguments, so the
 *     same wobble heals on read.
 *
 * Born of the GLM incident (owner, 2026-10-04): 19 consecutive rejected
 * `problem` calls, every one carrying `"mode": "\"recall\""` — a
 * JSON-string-encoded enum — while TypeBox's error text `must be equal
 * to constant` never named the expected values, so the model re-emitted
 * the identical payload each time; the 2026-10-09 whitehead session ran
 * the same loop on quiz `type` for ten turns. A STRING value where the
 * schema expects a literal union / boolean / null / number / array is
 * JSON.parse-d and kept when the parsed value satisfies the expectation.
 * Well-formed args pass through UNTOUCHED (same reference); unhealable
 * values stay for validation to reject honestly.
 */

/** One property schema of a TypeBox object (the shapes this fork emits:
 * literal unions carry anyOf[{const}], scalars carry type). */
type PropSchema = {
	type?: string;
	const?: unknown;
	anyOf?: PropSchema[];
};

/** The literal values a property accepts ([] when it is not a literal
 *  union / bare literal). */
function literalsOf(prop: PropSchema): unknown[] {
	if (prop.anyOf) return prop.anyOf.flatMap((m) => literalsOf(m));
	return "const" in prop ? [prop.const] : [];
}

/** Does the property accept null (Type.Null standalone or as a union
 *  member)? */
function acceptsNull(prop: PropSchema): boolean {
	if (prop.type === "null") return true;
	return (prop.anyOf ?? []).some((m) => m.type === "null");
}

/** JSON.parse that never throws (undefined for malformed input). */
function tryParse(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

export function healEncodedArguments(
	args: unknown,
	schema: { properties?: Record<string, PropSchema> },
): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const properties = schema.properties;
	if (!properties) return args;
	let healed: Record<string, unknown> | null = null;
	for (const [key, prop] of Object.entries(properties)) {
		const raw = (args as Record<string, unknown>)[key];
		if (typeof raw !== "string") continue;
		const parsed = tryParse(raw);
		let fixed: unknown;
		const literals = literalsOf(prop);
		if (literals.length > 0) {
			if (literals.includes(raw)) continue; // already a valid member
			if (literals.includes(parsed)) fixed = parsed;
		}
		// The literal branch does not cover null (Type.Null carries no
		// const) — a union of literals ∪ null must also accept "null".
		if (fixed === undefined && acceptsNull(prop) && parsed === null) fixed = null;
		if (fixed === undefined && prop.type === "boolean" && typeof parsed === "boolean") {
			fixed = parsed;
		}
		if (
			fixed === undefined &&
			(prop.type === "number" || prop.type === "integer") &&
			typeof parsed === "number"
		) {
			fixed = parsed;
		}
		if (fixed === undefined && prop.type === "array" && Array.isArray(parsed)) fixed = parsed;
		if (fixed !== undefined) {
			healed ??= { ...(args as Record<string, unknown>) };
			healed[key] = fixed;
		}
	}
	return healed ?? args;
}
