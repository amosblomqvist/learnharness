import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type, type TSchema } from "typebox";
import { Format } from "typebox/format";
import { validatePluginSchema } from "../src/core/plugin-validation.ts";
import {
	clonePluginQuestionJson, createPluginQuestionParameters, isPluginQuestionJson,
	pluginQuestionOccurrenceKey, preparePluginQuestionSchema, preparePluginQuestionType,
	readPluginQuestionAnnotation, readPluginQuestionAnswer, readPluginQuestionCancellation,
	readPluginQuestionMessageAnnotation, readPluginQuestionSnapshot, samePluginQuestionOccurrence,
	validatePluginQuestionAnswer, validatePluginQuestionInput,
	type PluginQuestionAnswer, type PluginQuestionSnapshot, type PluginQuestionTypeDefinition,
} from "../src/core/plugin-questions.ts";

const occurrence = { messageId: "assistant-1", contentIndex: 1, toolCallId: "call-1", toolName: "ask_example" };
function at(value: unknown, ...path: (string | number)[]): unknown {
	return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], value);
}
function definition(overrides: Partial<PluginQuestionTypeDefinition> = {}): PluginQuestionTypeDefinition {
	return { id: "example", label: "Example", contractVersion: 2, showThinking: false,
		questionSchema: Type.Object({ source: Type.String() }), answerSchema: Type.Any(),
		probe: { toolName: "ask_example", description: "Ask an example question" }, ...overrides };
}
function snapshot(overrides: Partial<PluginQuestionSnapshot> = {}): PluginQuestionSnapshot {
	return { protocolVersion: 1, questionId: "question-1", occurrence, pluginId: "example-plugin", typeId: "example", label: "Example", variant: "probe",
		contractVersion: 2, input: { question: "  Keep *Markdown* exactly.\n", payload: { source: "  const x = 1;\n\n" } },
		questionSchema: Type.Object({ source: Type.String() }), answerSchema: Type.Any(), showThinking: false, requiresAnswerRefinement: false, ...overrides };
}
function answer(overrides: Partial<PluginQuestionAnswer> = {}): PluginQuestionAnswer {
	return { kind: "plugin-question", questionId: "question-1", pluginId: "example-plugin", typeId: "example", contractVersion: 2, answer: false, answeredAt: "2026-11-02T10:00:00.000Z", ...overrides };
}
function message(annotation: unknown, extra = {}) {
	return { role: "assistant", id: "assistant-1", content: [{ type: "text", text: "intro" }, { type: "toolCall", id: "call-1", name: "ask_example", arguments: {} }], lhQuestions: { "1": annotation }, ...extra };
}

describe("plugin question finite JSON boundary", () => {
	it("preserves code strings and all falsy/empty JSON values without coercion", () => {
		const value = { text: "  a\n\tb\n", zero: 0, nope: false, nil: null, blank: "", list: [], obj: {} };
		assert.deepEqual(clonePluginQuestionJson(value), value);
		assert.notEqual(clonePluginQuestionJson(value), value);
		const protoKey = JSON.parse('{"__proto__":{"safe":true}}');
		assert.deepEqual(clonePluginQuestionJson(protoKey), protoKey);
		assert.equal(Object.getPrototypeOf(clonePluginQuestionJson(protoKey)), Object.prototype);
	});
	it("rejects lossy stringify values, runtime objects, sparse arrays, properties and cycles", () => {
		const cyclic: unknown[] = []; cyclic.push(cyclic);
		const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("must not run"); } });
		for (const invalid of [undefined, NaN, Infinity, -Infinity, 1n, Symbol(), () => {}, new Date(), /x/, new Map(), [undefined], { x: undefined }, [, 1], cyclic, accessor, Object.create({ inherited: true }), Object.assign([], { extra: 1 }), { [Symbol("x")]: 1 }, Object.defineProperty({}, "hidden", { value: 1 })]) {
			assert.equal(isPluginQuestionJson(invalid), false);
			assert.throws(() => clonePluginQuestionJson(invalid));
		}
	});
	it("copies repeated non-cyclic objects without retaining plugin references", () => {
		const shared = { x: 1 };
		const result = clonePluginQuestionJson([shared, shared]);
		assert.deepEqual(result, [{ x: 1 }, { x: 1 }]);
		assert.notEqual((result as unknown[])[0], shared);
	});
});

describe("plugin question persisted schema contracts", () => {
	it("compiles frozen persisted TypeBox schemas rather than plugin-owned objects", () => {
		const original = definition();
		const prepared = preparePluginQuestionType(original);
		assert.notEqual(prepared, original);
		assert.notEqual(prepared.questionSchema, original.questionSchema);
		assert.equal(Object.isFrozen(prepared), true);
		assert.equal(Object.isFrozen(at(prepared.questionSchema, "properties")), true);
		assert.equal(Object.isFrozen(original), false);
		assert.equal(validatePluginSchema(prepared.questionSchema).Check({ source: "hi" }), true);
	});
	it("accepts standard TypeBox unions/optional/readonly/unsafe branding without persisting it", () => {
		const schema = Type.Object({ value: Type.Union([Type.String(), Type.Null()]), optional: Type.Optional(Type.Boolean()), immutable: Type.Readonly(Type.Integer()) });
		const prepared = preparePluginQuestionType(definition({ questionSchema: schema, answerSchema: Type.Union([Type.Boolean(), Type.Integer(), Type.Null()]) }));
		assert.deepEqual(Reflect.ownKeys(prepared.questionSchema).sort(), ["properties", "required", "type"]);
		assert.equal(validatePluginSchema(prepared.questionSchema).Check({ value: null, immutable: 1 }), true);
		assert.equal(validatePluginSchema(prepared.questionSchema).Check({ value: [], immutable: 1 }), false);
		assert.deepEqual(preparePluginQuestionSchema(Type.Unsafe({ type: "string" })), { type: "string" });
		const invalidBranding = Object.defineProperty({ type: "string" }, "~runtimeValidation", { value: () => true });
		assert.throws(() => preparePluginQuestionSchema(invalidBranding));
		assert.throws(() => clonePluginQuestionJson(Type.String()));
	});
	it("requires explicit variant enrollment, thinking, positive versions and valid ids/tool names", () => {
		for (const invalid of [{ id: "with space" }, { id: "a".repeat(129) }, { label: "  " }, { contractVersion: 0 }, { contractVersion: 1.5 }, { contractVersion: Number.MAX_SAFE_INTEGER + 1 }, { showThinking: undefined }, { probe: undefined }, { probe: { toolName: "1bad", description: "ok" } }, { teach: { toolName: "valid", description: " " } }, { incompatibleContractVersions: [2] }, { incompatibleContractVersions: [-1] }, { incompatibleContractVersions: new Array(1) }]) {
			assert.throws(() => preparePluginQuestionType(definition(invalid as Partial<PluginQuestionTypeDefinition>)));
		}
		const prepared = preparePluginQuestionType(definition({ probe: undefined, teach: { toolName: "teach_only", description: "Teach only" }, incompatibleContractVersions: [1, 1] }));
		assert.equal(prepared.probe, undefined);
		assert.deepEqual(prepared.incompatibleContractVersions, [1]);
		assert.throws(() => createPluginQuestionParameters(prepared, "probe"));
	});
	it("rejects async and generator refinements at registration", () => {
		for (const callback of [async () => undefined, function* () { yield "not sync"; }, async function* () { yield "not sync"; }]) {
			assert.throws(() => preparePluginQuestionType(definition({ validateQuestion: callback as never })), /synchronous/);
		}
	});
	it("rejects external/anchor/dynamic references, runtime objects, JSON type extensions and custom formats", () => {
		for (const schema of [{ $ref: "https://example.com/schema" }, { $ref: "other.json#/$defs/x" }, { $ref: "#anchor" }, { $id: "local", type: "string" }, { $anchor: "local" }, { $dynamicRef: "#x" }, { $recursiveRef: "#" }, { $recursiveAnchor: true }, { $dynamicAnchor: "x" }, { type: "bigint" }, { type: "function" }, { type: "undefined" }, { type: "symbol" }, { type: "string", pattern: /x/ }, { type: "string", format: "custom-runtime-format" }, { type: "string", callback: () => true }, { const: undefined }, { minimum: NaN }]) {
			assert.throws(() => preparePluginQuestionSchema(schema), JSON.stringify(schema));
		}
	});
	it("uses installed built-in formats and rejects mutable runtime replacements", () => {
		const schema = { type: "string", format: "email" };
		assert.equal(validatePluginSchema(preparePluginQuestionSchema(schema)).Check("user@example.com"), true);
		const builtin = Format.Get("email")!;
		try {
			Format.Set("email", () => true);
			assert.throws(() => preparePluginQuestionSchema(schema), /format/);
		} finally { Format.Set("email", builtin); }
	});
	it("does not interpret literal/annotation data as schema keywords", () => {
		const value = { $id: "literal", $ref: "external", format: "custom", type: "function" };
		const schema = preparePluginQuestionSchema({ const: value, default: value, examples: [value] });
		assert.equal(validatePluginSchema(schema).Check(value), true);
	});
	it("keeps standalone local references meaningful after payload embedding", () => {
		const schema = { type: "object", $defs: { "value/with~name": { type: "integer", minimum: 1 } }, properties: { value: { $ref: "#/$defs/value~1with~0name" } }, required: ["value"], additionalProperties: false } as unknown as TSchema;
		const registered = preparePluginQuestionType(definition({ questionSchema: schema }));
		const native = createPluginQuestionParameters(registered, "probe");
		assert.equal(validatePluginSchema(registered.questionSchema).Check({ value: 3 }), true);
		assert.equal(validatePluginSchema(native).Check({ question: "Q", payload: { value: 3 } }), true);
		assert.equal(validatePluginSchema(native).Check({ question: "Q", payload: { value: 0 } }), false);
		assert.equal(at(registered.questionSchema, "properties", "value", "$ref"), "#/$defs/value~1with~0name");
		assert.equal(at(native, "properties", "payload", "properties", "value", "$ref"), "#/properties/payload/$defs/value~1with~0name");
	});
	it("rebases recursive root refs and leaves literal refs unchanged", () => {
		const schema = { type: "object", properties: { next: { anyOf: [{ type: "null" }, { $ref: "#" }] }, literal: { const: { $ref: "not-a-schema-ref" } } }, required: ["next"] } as unknown as TSchema;
		const native = createPluginQuestionParameters(preparePluginQuestionType(definition({ questionSchema: schema })), "probe");
		assert.equal(at(native, "properties", "payload", "properties", "next", "anyOf", 1, "$ref"), "#/properties/payload");
		assert.equal(at(native, "properties", "payload", "properties", "literal", "const", "$ref"), "not-a-schema-ref");
		assert.equal(validatePluginSchema(native).Check({ question: "Recursive?", payload: { next: { next: null } } }), true);
	});
	it("rejects malformed or unresolved pointer refs and malformed installed-compiler keywords", () => {
		for (const schema of [{ $ref: "#/%ZZ" }, { $ref: "#/$defs/missing" }, { $defs: { a: { type: "string" } }, $ref: "#/$defs/~2" }, { type: 4 }, { properties: [] }, { required: 7 }, { items: 4 }]) assert.throws(() => preparePluginQuestionSchema(schema));
	});
});

describe("plugin question synchronous historical validation", () => {
	it("preserves common/payload fields and deeply freezes refinement input", () => {
		let seen = false;
		const registered = preparePluginQuestionType(definition({ validateQuestion(context) {
			seen = true;
			assert.equal(context.chatId, "chat-1");
			assert.equal(context.contractVersion, 2);
			assert.equal(Object.isFrozen(context), true);
			assert.equal(Object.isFrozen(context.input.payload), true);
			return undefined;
		} }));
		const input = { question: "  Preserve\n", payload: { source: "  x\n\n" } };
		assert.deepEqual(validatePluginQuestionInput(registered, { chatId: "chat-1", variant: "probe", input }), { ok: true, value: input });
		assert.equal(seen, true);
		assert.equal(Object.isFrozen(input), false);
	});
	it("validates native probe/teach shapes without flattening payload or accepting blank questions", () => {
		const both = definition({ teach: { toolName: "teach_example", description: "Teach" } });
		for (const input of [{ question: " \n", payload: { source: "x" } }, { question: "Q", payload: { source: 1 } }, { question: "Q", payload: { source: "x" }, nodeId: "unexpected" }]) assert.equal(validatePluginQuestionInput(both, { chatId: "c", variant: "probe", input }).ok, false);
		for (const input of [{ question: "Q", payload: { source: "x" } }, { type: "other", nodeId: "node", question: "Q", payload: { source: "x" } }, { type: "check", nodeId: " ", question: "Q", payload: { source: "x" } }]) assert.equal(validatePluginQuestionInput(both, { chatId: "c", variant: "teach", input }).ok, false);
		assert.equal(validatePluginQuestionInput(both, { chatId: "c", variant: "teach", input: { type: "check", nodeId: "node", question: "Q", payload: { source: "x" } } }).ok, true);
	});
	it("returns readable authoring problems and rejects unsupported thenable/invalid results", () => {
		const input = snapshot().input;
		assert.deepEqual(validatePluginQuestionInput(definition({ validateQuestion: () => ["Fix the input"] }), { chatId: "c", variant: "probe", input }), { ok: false, problems: ["Fix the input"] });
		for (const result of [false, "problem", [""], [7], { then() {} }, Object.assign([], { then() {} }), Promise.resolve(undefined), Promise.reject(new Error("unsupported async rejection"))]) assert.equal(validatePluginQuestionInput(definition({ validateQuestion: (() => result) as never }), { chatId: "c", variant: "probe", input }).ok, false);
	});
	it("accepts finite false/zero/null/empty answers exactly and rejects lossy data", () => {
		for (const value of [false, 0, null, "", [], {}, "  const answer = 0;\n"]) assert.deepEqual(validatePluginQuestionAnswer(snapshot(), { chatId: "c", answer: value }), { ok: true, value });
		for (const value of [undefined, Infinity, NaN, new Date(), { a: undefined }]) assert.equal(validatePluginQuestionAnswer(snapshot(), { chatId: "c", answer: value }).ok, false);
	});
	it("historical answer schema governs even if current definition changes", () => {
		const saved = snapshot({ answerSchema: Type.Integer() });
		const current = definition({ answerSchema: Type.String() });
		assert.equal(validatePluginQuestionAnswer(saved, { chatId: "c", answer: 0 }, current).ok, true);
		assert.equal(validatePluginQuestionAnswer(saved, { chatId: "c", answer: "0" }, current).ok, false);
	});
	it("runs required same-contract refinements only, freezing historical arguments", () => {
		let count = 0;
		const current = definition({ validateAnswer(context) {
			count++;
			assert.equal(context.questionId, "question-1");
			assert.equal(Object.isFrozen(context.input.payload), true);
			assert.equal(Object.isFrozen(context.answer), true);
			return ["An authoring constraint is unmet"];
		} });
		assert.equal(validatePluginQuestionAnswer(snapshot(), { chatId: "c", answer: {} }, current).ok, true);
		assert.equal(count, 0);
		const saved = snapshot({ requiresAnswerRefinement: true });
		assert.equal(validatePluginQuestionAnswer(saved, { chatId: "c", answer: {} }).ok, false);
		assert.equal(validatePluginQuestionAnswer(saved, { chatId: "c", answer: {} }, { ...current, contractVersion: 3 }).ok, false);
		assert.deepEqual(validatePluginQuestionAnswer(saved, { chatId: "c", answer: {} }, current), { ok: false, problems: ["An authoring constraint is unmet"] });
		assert.equal(count, 1);
	});
});

describe("plugin question saved occurrence authority", () => {
	it("attempts have visibility but never pending snapshot authority", () => {
		const { protocolVersion, pluginId, typeId, label, variant } = snapshot();
		const attempt = { protocolVersion, pluginId, typeId, label, variant };
		assert.equal(readPluginQuestionAnnotation(attempt).status, "attempt");
		assert.equal(readPluginQuestionSnapshot(attempt), null);
		assert.equal(readPluginQuestionMessageAnnotation(message(attempt), 1).status, "attempt");
	});
	it("adopts only full validated snapshots with exact structural native binding", () => {
		const result = readPluginQuestionMessageAnnotation(message(snapshot()), 1);
		assert.equal(result.status, "posed");
		assert.equal(readPluginQuestionSnapshot(snapshot())?.input.question, "  Keep *Markdown* exactly.\n");
		assert.equal(Object.isFrozen(readPluginQuestionSnapshot(snapshot())!.input.payload), true);
		for (const changed of [{ messageId: "other" }, { contentIndex: 0 }, { toolCallId: "other" }, { toolName: "other" }]) {
			const wrong = snapshot({ occurrence: { ...occurrence, ...changed } });
			const result = readPluginQuestionMessageAnnotation(message(wrong), 1);
			assert.equal(result.status, "unreadable");
			if (result.status === "unreadable") assert.equal(result.identity, undefined);
		}
	});
	it("malformed entries including explicit undefined always suppress generic traces", () => {
		for (const malformed of [undefined, null, false, 1, [], {}, { protocolVersion: 99 }, { ...snapshot(), input: { question: " ", payload: {} } }, { ...snapshot(), answerSchema: { $ref: "external" } }]) {
			assert.equal(readPluginQuestionMessageAnnotation(message(malformed), 1).status, "unreadable");
		}
		assert.equal(readPluginQuestionMessageAnnotation(message(snapshot(), { lhQuestions: null }), 1).status, "unreadable");
		assert.equal(readPluginQuestionMessageAnnotation({ role: "assistant", content: [] }, 1).status, "absent");
		assert.equal(readPluginQuestionMessageAnnotation(message(snapshot()), 0).status, "absent");
	});
	it("preserves exact minimum identity for unreadable protocols only when bound", () => {
		const unknown = { ...snapshot(), protocolVersion: 99 };
		const result = readPluginQuestionMessageAnnotation(message(unknown), 1);
		assert.equal(result.status, "unreadable");
		if (result.status === "unreadable") assert.deepEqual(result.identity, { questionId: "question-1", occurrence, pluginId: "example-plugin", typeId: "example", contractVersion: 2 });
		const wrong = readPluginQuestionAnnotation(unknown, { ...occurrence, messageId: "different" });
		if (wrong.status === "unreadable") assert.equal(wrong.identity, undefined);
	});
	it("exposes ID-less unreadable binding only after matching a canonical occurrence", () => {
		const unknown = { protocolVersion: 99, occurrence };
		const raw = readPluginQuestionAnnotation(unknown);
		assert.equal(raw.status, "unreadable");
		if (raw.status === "unreadable") { assert.equal(raw.binding, undefined); assert.equal(raw.identity, undefined); }
		const bound = readPluginQuestionMessageAnnotation(message(unknown), 1);
		assert.equal(bound.status, "unreadable");
		if (bound.status === "unreadable") { assert.deepEqual(bound.binding, { occurrence }); assert.equal(bound.identity, undefined); }
		const knownId = readPluginQuestionMessageAnnotation(message({ ...unknown, questionId: "readable-id" }), 1);
		if (knownId.status === "unreadable") assert.deepEqual(knownId.binding, { occurrence, questionId: "readable-id" });
		const mismatched = readPluginQuestionAnnotation(unknown, { ...occurrence, messageId: "different" });
		if (mismatched.status === "unreadable") assert.equal(mismatched.binding, undefined);
		const noEmbeddedBinding = readPluginQuestionMessageAnnotation(message({ protocolVersion: 99 }), 1);
		if (noEmbeddedBinding.status === "unreadable") assert.equal(noEmbeddedBinding.binding, undefined);
	});
	it("malformed runtime annotations fail closed without throwing or exposing arguments", () => {
		const hostile = Object.defineProperty({}, "questionId", { get() { throw new Error("unreadable"); } });
		assert.equal(readPluginQuestionAnnotation(hostile).status, "unreadable");
		assert.equal(readPluginQuestionMessageAnnotation(message(hostile), 1).status, "unreadable");
	});
	it("partial posed annotations do not silently downgrade to attempts", () => {
		const { protocolVersion, pluginId, typeId, label, variant } = snapshot();
		assert.equal(readPluginQuestionAnnotation({ protocolVersion, pluginId, typeId, label, variant, questionId: "partial" }).status, "unreadable");
	});
	it("identity keys distinguish historical duplicate call ids at each exact occurrence", () => {
		for (const changed of [{ messageId: "new" }, { contentIndex: 2 }, { toolName: "other" }]) {
			const next = { ...occurrence, ...changed };
			assert.equal(samePluginQuestionOccurrence(occurrence, next), false);
			assert.notEqual(pluginQuestionOccurrenceKey(occurrence), pluginQuestionOccurrenceKey(next));
		}
	});
	it("reads accepted envelopes independently from cancellation and binds canonical identity", () => {
		assert.deepEqual(readPluginQuestionAnswer(answer(), snapshot()), answer());
		for (const changed of [{ questionId: "new" }, { pluginId: "other" }, { typeId: "other" }, { contractVersion: 3 }, { thinking: "injected" }, { readingThinking: "injected" }, { answeredAt: "invalid" }, { answer: undefined }]) assert.equal(readPluginQuestionAnswer(answer(changed), snapshot()), null);
		const check = snapshot({ variant: "teach", input: { ...snapshot().input, type: "check", nodeId: "node" }, showThinking: true });
		assert.equal(readPluginQuestionAnswer(answer({ thinking: "", readingThinking: "" }), check)?.thinking, "");
		assert.equal(readPluginQuestionAnswer(answer({ answer: "not integer" }), snapshot({ answerSchema: Type.Integer() })), null);
	});
	it("requires exact cancellation bindings and never presents host cancellation as an answer", () => {
		const cancellation = { kind: "plugin-question-cancelled", questionId: "question-1", occurrence, reason: "dismissed" };
		assert.deepEqual(readPluginQuestionCancellation(cancellation, snapshot()), cancellation);
		assert.equal(readPluginQuestionAnswer(cancellation, snapshot()), null);
		assert.equal(readPluginQuestionCancellation({ ...cancellation, occurrence: { ...occurrence, messageId: "old" } }, snapshot()), null);
		assert.equal(readPluginQuestionCancellation({ ...cancellation, questionId: undefined }), null);
		assert.equal(readPluginQuestionCancellation({ kind: "plugin-question-cancelled", occurrence, reason: "dismissed" }, snapshot()), null);
		assert.notEqual(readPluginQuestionCancellation({ kind: "plugin-question-cancelled", occurrence, reason: "unreadable-protocol" }), null);
	});
	it("recognizes exact ID-less manual dismissal of an unreadable question without weakening known-contract identity", () => {
		const cancellation = { kind: "plugin-question-cancelled", occurrence, reason: "dismissed" };
		assert.deepEqual(readPluginQuestionCancellation(cancellation), cancellation);
		assert.equal(readPluginQuestionCancellation(cancellation, snapshot()), null);
		assert.equal(readPluginQuestionCancellation({ ...cancellation, reason: "incompatible" }), null);
		assert.equal(readPluginQuestionCancellation({ ...cancellation, occurrence: { toolCallId: occurrence.toolCallId } }), null);
		assert.equal(readPluginQuestionAnswer(cancellation), null);
	});
});
