/** Bounded plugin-question v1 contracts and browser-safe saved-authority helpers. */
import type { Static, TSchema } from "typebox";
import type { PluginCleanup } from "./plugins.ts";
import { validatePluginSchema } from "./plugin-validation.ts";
import { Format } from "typebox/format";
import { validatePluginSubmissionImages, type PluginSubmissionImages } from "./plugin-submissions.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PluginQuestionVariant = "probe" | "teach";
export type PluginQuestionInput<Q = JsonValue> = { question: string; payload: Q } & (
	| { type?: never; nodeId?: never }
	| { type: "predict" | "check"; nodeId: string }
);
export interface PluginQuestionValidationContext<Q = JsonValue> {
	readonly chatId: string;
	readonly variant: PluginQuestionVariant;
	readonly contractVersion: number;
	readonly input: PluginQuestionInput<Q>;
}
export interface PluginQuestionAnswerValidationContext<Q = JsonValue, A = JsonValue> extends PluginQuestionValidationContext<Q> {
	readonly questionId: string;
	readonly answer: A;
}
export interface PluginQuestionTypeDefinition<Q extends TSchema = TSchema, A extends TSchema = TSchema> {
	id: string;
	label: string;
	contractVersion: number;
	incompatibleContractVersions?: number[];
	showThinking: boolean;
	questionSchema: Q;
	answerSchema: A;
	probe?: { toolName: string; description: string };
	teach?: { toolName: string; description: string };
	validateQuestion?: (context: PluginQuestionValidationContext<Static<Q>>) => undefined | string[];
	validateAnswer?: (context: PluginQuestionAnswerValidationContext<Static<Q>, Static<A>>) => undefined | string[];
}
export type PluginQuestionAnswerState = { status: "empty" } | { status: "unready" | "ready"; value: JsonValue };
export interface PluginQuestionMountContext<Q = JsonValue> {
	readonly input: PluginQuestionInput<Q>;
	readonly chatId: string;
	readonly questionId: string;
	readonly contractVersion: number;
	readonly variant: PluginQuestionVariant;
	readonly signal: AbortSignal;
}
export interface PluginQuestionEditorProps<Q = JsonValue> extends PluginQuestionMountContext<Q> {
	readonly active: boolean;
	readonly answer: PluginQuestionAnswerState;
	/** Synchronous publication; stale mount publications are ignored by the host. */
	onChange(answer: PluginQuestionAnswerState): void;
}
export type PluginQuestionEditorKey = "Tab" | "Enter" | "Shift+Enter" | "Escape";
export interface PluginQuestionEditorHandle {
	update(props: { answer: PluginQuestionAnswerState; active: boolean }): void;
	focus(): void;
	/** Optional editing override. Omission or "pass" uses host defaults:
	 * Enter submits, Shift+Enter keeps native newline editing, Tab cycles fields.
	 * Meta/Ctrl+Enter remains reserved host submission. */
	handleKeyDown?(key: PluginQuestionEditorKey): "handled" | "pass";
	appendTranscript?(text: string): void | Promise<void>;
	dispose(): void;
}
export interface PluginQuestionRenderer<Q = JsonValue, A = JsonValue> {
	id: string;
	supportedContractVersions: number[];
	mountQuestion?(container: HTMLElement, context: PluginQuestionMountContext<Q>): void | PluginCleanup | Promise<void | PluginCleanup>;
	mountAnswerEditor(container: HTMLElement, context: PluginQuestionEditorProps<Q>): PluginQuestionEditorHandle | Promise<PluginQuestionEditorHandle>;
	mountAnswered?(container: HTMLElement, context: PluginQuestionMountContext<Q> & { readonly answer: A }): void | PluginCleanup | Promise<void | PluginCleanup>;
}
export interface PluginQuestionOccurrence {
	messageId: string;
	contentIndex: number;
	toolCallId: string;
	toolName: string;
}
/** Visibility only: an unsuccessful attempt never grants pending authority. */
export interface PluginQuestionAttempt {
	protocolVersion: 1;
	pluginId: string;
	typeId: string;
	label: string;
	variant: PluginQuestionVariant;
}
export interface PluginQuestionSnapshot extends PluginQuestionAttempt {
	questionId: string;
	occurrence: PluginQuestionOccurrence;
	contractVersion: number;
	input: PluginQuestionInput;
	questionSchema: TSchema;
	answerSchema: TSchema;
	showThinking: boolean;
	requiresAnswerRefinement: boolean;
}
export type PluginQuestionOccurrenceMap = Record<string, PluginQuestionAttempt | PluginQuestionSnapshot>;
export interface PluginQuestionAnswer {
	kind: "plugin-question";
	questionId: string;
	pluginId: string;
	typeId: string;
	contractVersion: number;
	answer: JsonValue;
	thinking?: string;
	readingThinking?: string;
	images?: PluginSubmissionImages;
	answeredAt: string;
}
/** Unreadable annotations remain classified as questions: never expose raw input. */
export type PluginQuestionAnnotationRead =
	| { status: "absent" }
	| { status: "attempt"; attempt: PluginQuestionAttempt }
	| { status: "posed"; snapshot: PluginQuestionSnapshot }
	| { status: "unreadable";
		identity?: { questionId: string; occurrence: PluginQuestionOccurrence; pluginId: string; typeId: string; contractVersion: number };
		/** Only available after matching a supplied canonical native occurrence. */
		binding?: { occurrence: PluginQuestionOccurrence; questionId?: string };
	};
export type PluginQuestionValidationResult<T> = { ok: true; value: T } | { ok: false; problems: string[] };
export interface PluginQuestionCancellation {
	kind: "plugin-question-cancelled";
	/** Omitted only when the question is unreadable: explicit dismissal or protocol cancellation, with an exact occurrence binding. */
	questionId?: string;
	occurrence: PluginQuestionOccurrence;
	reason: "dismissed" | "incompatible" | "unreadable-protocol";
}

export function preparePluginQuestionType<Q extends TSchema, A extends TSchema>(definition: PluginQuestionTypeDefinition<Q, A>): PluginQuestionTypeDefinition<Q, A> {
	return prepareDefinition(definition);
}
export function createPluginQuestionParameters(definition: PluginQuestionTypeDefinition, variant: PluginQuestionVariant): TSchema {
	return parametersFor(definition, variant);
}
export function validatePluginQuestionInput(definition: PluginQuestionTypeDefinition, context: { chatId: string; variant: PluginQuestionVariant; input: unknown }): PluginQuestionValidationResult<PluginQuestionInput> {
	return validateInput(definition, context);
}
export function validatePluginQuestionAnswer(snapshot: PluginQuestionSnapshot, context: { chatId: string; answer: unknown }, definition?: PluginQuestionTypeDefinition): PluginQuestionValidationResult<JsonValue> {
	return validateAnswer(snapshot, context, definition);
}
export function readPluginQuestionAnnotation(value: unknown, expectedOccurrence?: PluginQuestionOccurrence): PluginQuestionAnnotationRead {
	try { return readAnnotation(value, expectedOccurrence); } catch { return { status: "unreadable" }; }
}
export function readPluginQuestionMessageAnnotation(message: unknown, contentIndex: number): PluginQuestionAnnotationRead {
	try { return readMessageAnnotation(message, contentIndex); } catch { return { status: "unreadable" }; }
}
export function readPluginQuestionSnapshot(value: unknown, expectedOccurrence?: PluginQuestionOccurrence): PluginQuestionSnapshot | null {
	const result = readPluginQuestionAnnotation(value, expectedOccurrence);
	return result.status === "posed" ? result.snapshot : null;
}
export function readPluginQuestionAnswer(value: unknown, snapshot?: PluginQuestionSnapshot): PluginQuestionAnswer | null {
	return readAnswer(value, snapshot);
}
export function readPluginQuestionCancellation(value: unknown, snapshot?: PluginQuestionSnapshot): PluginQuestionCancellation | null {
	return readCancellation(value, snapshot);
}
export function pluginQuestionOccurrenceKey(occurrence: PluginQuestionOccurrence): string {
	return JSON.stringify([occurrence.messageId, occurrence.contentIndex, occurrence.toolCallId, occurrence.toolName]);
}
export function samePluginQuestionOccurrence(left: PluginQuestionOccurrence, right: PluginQuestionOccurrence): boolean {
	return left.messageId === right.messageId && left.contentIndex === right.contentIndex && left.toolCallId === right.toolCallId && left.toolName === right.toolName;
}

const localId = /^[A-Za-z0-9_-]{1,128}$/;
const pluginId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const nativeToolName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const version = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const variantOf = (value: unknown): value is PluginQuestionVariant => value === "probe" || value === "teach";

/** Copy only finite JSON, without invoking getters, toJSON, or coercion. */
export function clonePluginQuestionJson(value: unknown): JsonValue {
	return cloneJson(value);
}
function cloneJson(value: unknown, schemaNodes?: Set<object>): JsonValue {
	const active = new Set<object>();
	function copy(item: unknown): JsonValue {
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (typeof item !== "object" || item === null || (!Array.isArray(item) && !record(item)) || active.has(item)) throw new Error("Plugin question data must be finite JSON");
		active.add(item);
		try {
			const descriptors = Object.getOwnPropertyDescriptors(item);
			if (Array.isArray(item)) {
				const keys = Reflect.ownKeys(descriptors);
				if (keys.length !== item.length + 1) throw new Error("Plugin question arrays must be dense JSON arrays");
				const result: JsonValue[] = [];
				for (let i = 0; i < item.length; i++) {
					const descriptor = descriptors[String(i)];
					if (!descriptor || !own(descriptor, "value") || !descriptor.enumerable) throw new Error("Plugin question arrays must contain JSON values");
					result.push(copy(descriptor.value));
				}
				return result;
			}
			const result: Record<string, JsonValue> = {};
			for (const key of Reflect.ownKeys(descriptors)) {
				const descriptor = descriptors[key as string]!;
				// Installed TypeBox branding is descriptive, non-enumerable metadata,
				// never a persisted validation rule. Only strip it at schema positions.
				if (schemaNodes?.has(item) && own(descriptor, "value") && !descriptor.enumerable &&
					((key === "~kind" && typeof descriptor.value === "string") ||
					((key === "~optional" || key === "~readonly") && typeof descriptor.value === "boolean") ||
					(key === "~unsafe" && descriptor.value === null))) continue;
				if (typeof key !== "string" || !own(descriptor, "value") || !descriptor.enumerable) throw new Error("Plugin question objects must have ordinary JSON properties");
				Object.defineProperty(result, key, { value: copy(descriptor.value), enumerable: true, configurable: true, writable: true });
			}
			return result;
		} finally { active.delete(item); }
	}
	return copy(value);
}
export function isPluginQuestionJson(value: unknown): value is JsonValue {
	try { clonePluginQuestionJson(value); return true; } catch { return false; }
}
/** Freeze owned copies, never plugin-owned input objects. */
export function freezePluginQuestionValue<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freezePluginQuestionValue(child);
		Object.freeze(value);
	}
	return value;
}

const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaChildren = new Set(["additionalProperties", "additionalItems", "unevaluatedProperties", "unevaluatedItems", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema"]);
const jsonTypes = new Set(["object", "array", "boolean", "integer", "number", "null", "string"]);
const builtinFormats: Record<string, (value: string) => boolean> = {
	"date-time": Format.IsDateTime, date: Format.IsDate, duration: Format.IsDuration,
	email: Format.IsEmail, hostname: Format.IsHostname, "idn-email": Format.IsIdnEmail,
	"idn-hostname": Format.IsIdnHostname, ipv4: Format.IsIPv4, ipv6: Format.IsIPv6,
	"iri-reference": Format.IsIriReference, iri: Format.IsIri,
	"json-pointer-uri-fragment": Format.IsJsonPointerUriFragment, "json-pointer": Format.IsJsonPointer,
	regex: Format.IsRegex, "relative-json-pointer": Format.IsRelativeJsonPointer,
	time: Format.IsTime, "uri-reference": Format.IsUriReference, "uri-template": Format.IsUriTemplate,
	uri: Format.IsUri, url: Format.IsUrl, uuid: Format.IsUuid,
};
/** Walk schema positions only; annotation/const/enum data is not a schema. */
function walkSchema(value: unknown, visit: (node: Record<string, unknown>) => void, seen = new Set<object>()): void {
	if (typeof value === "boolean") return;
	if (!record(value)) throw new Error("Plugin question schema must be a JSON schema");
	if (seen.has(value)) return;
	seen.add(value);
	visit(value);
	for (const [key, child] of Object.entries(value)) {
		if (schemaMaps.has(key) || key === "dependencies") {
			if (!record(child)) throw new Error("Malformed plugin question schema map");
			for (const item of Object.values(child)) {
				if (key === "dependencies" && Array.isArray(item) && item.every(entry => typeof entry === "string")) continue;
				walkSchema(item, visit, seen);
			}
		} else if (schemaLists.has(key) || (key === "items" && Array.isArray(child))) {
			if (!Array.isArray(child)) throw new Error("Malformed plugin question schema list");
			child.forEach(item => walkSchema(item, visit, seen));
		} else if (schemaChildren.has(key) || key === "items") walkSchema(child, visit, seen);
	}
}
function pointerTarget(root: unknown, ref: unknown): unknown {
	if (typeof ref !== "string" || !ref.startsWith("#")) throw new Error("Plugin question schemas require self-contained local JSON Pointer references");
	let path: string;
	try { path = decodeURIComponent(ref.slice(1)); } catch { throw new Error("Malformed plugin question schema reference"); }
	if (path === "") return root;
	if (!path.startsWith("/")) throw new Error("Plugin question schema anchors are not supported");
	let current = root;
	for (const part of path.slice(1).split("/")) {
		if (/~(?![01])/u.test(part)) throw new Error("Malformed plugin question JSON Pointer");
		const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
		if ((typeof current !== "object" || current === null) || !own(current, key)) throw new Error("Unresolved plugin question schema reference");
		current = (current as Record<string, unknown>)[key];
	}
	if (typeof current !== "boolean" && !record(current)) throw new Error("Plugin question schema reference must target a schema");
	return current;
}
/** Compile the exact persistable representation, not the original runtime object. */
export function preparePluginQuestionSchema(schema: unknown): TSchema {
	const brandingNodes = new Set<object>();
	walkSchema(schema, node => { brandingNodes.add(node); });
	const saved = cloneJson(schema, brandingNodes);
	const nodes = new Set<unknown>();
	walkSchema(saved, node => { nodes.add(node); });
	walkSchema(saved, node => {
		for (const forbidden of ["$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveAnchor", "$recursiveRef"]) {
			if (own(node, forbidden)) throw new Error(`Plugin question schema does not support ${forbidden}`);
		}
		if (own(node, "type")) {
			const types = Array.isArray(node.type) ? node.type : [node.type];
			if (!types.length || types.some(type => typeof type !== "string" || !jsonTypes.has(type))) throw new Error("Plugin question schemas support JSON types only");
		}
		if (own(node, "format") && (typeof node.format !== "string" || !own(builtinFormats, node.format) || Format.Get(node.format) !== builtinFormats[node.format])) throw new Error("Unsupported plugin question schema format");
		if (own(node, "$ref")) {
			const target = pointerTarget(saved, node.$ref);
			if (typeof target !== "boolean" && !nodes.has(target)) throw new Error("Plugin question references must target schema positions");
		}
	});
	validatePluginSchema(saved);
	return freezePluginQuestionValue(saved) as TSchema;
}

function prepareDefinition<Q extends TSchema, A extends TSchema>(definition: PluginQuestionTypeDefinition<Q, A>): PluginQuestionTypeDefinition<Q, A> {
	if (!record(definition) || typeof definition.id !== "string" || !localId.test(definition.id)) throw new Error("Invalid plugin question type id");
	if (!text(definition.label) || !version(definition.contractVersion) || typeof definition.showThinking !== "boolean") throw new Error("Invalid plugin question label, contractVersion or showThinking");
	if (!definition.probe && !definition.teach) throw new Error("Plugin question requires a probe or teach variant");
	const variants: Pick<PluginQuestionTypeDefinition, "probe" | "teach"> = {};
	for (const variant of ["probe", "teach"] as const) {
		const tool = definition[variant];
		if (tool === undefined) continue;
		if (!record(tool) || typeof tool.toolName !== "string" || !nativeToolName.test(tool.toolName) || !text(tool.description)) throw new Error(`Invalid plugin question ${variant} tool`);
		variants[variant] = { toolName: tool.toolName, description: tool.description };
	}
	const incompatible = definition.incompatibleContractVersions === undefined ? undefined : clonePluginQuestionJson(definition.incompatibleContractVersions) as number[];
	if (incompatible !== undefined && (!Array.isArray(incompatible) || incompatible.some(item => !version(item) || item === definition.contractVersion))) throw new Error("Invalid incompatibleContractVersions");
	for (const key of ["validateQuestion", "validateAnswer"] as const) {
		const callback = definition[key];
		if (callback !== undefined && (typeof callback !== "function" || ["[object AsyncFunction]", "[object GeneratorFunction]", "[object AsyncGeneratorFunction]"].includes(Object.prototype.toString.call(callback)))) throw new Error(`Plugin question ${key} must be synchronous`);
	}
	return freezePluginQuestionValue({
		id: definition.id, label: definition.label, contractVersion: definition.contractVersion,
		showThinking: definition.showThinking,
		questionSchema: preparePluginQuestionSchema(definition.questionSchema) as Q,
		answerSchema: preparePluginQuestionSchema(definition.answerSchema) as A,
		...variants,
		...(incompatible !== undefined ? { incompatibleContractVersions: [...new Set(incompatible)] } : {}),
		...(definition.validateQuestion ? { validateQuestion: definition.validateQuestion } : {}),
		...(definition.validateAnswer ? { validateAnswer: definition.validateAnswer } : {}),
	});
}
function parametersFor(definition: PluginQuestionTypeDefinition, variant: PluginQuestionVariant): TSchema {
	if (!variantOf(variant) || !definition[variant]) throw new Error("Plugin question variant is not registered");
	const payload = clonePluginQuestionJson(preparePluginQuestionSchema(definition.questionSchema));
	walkSchema(payload, node => {
		if (own(node, "$ref")) node.$ref = `#/properties/payload${(node.$ref as string).slice(1)}`;
	});
	const parameters = {
		type: "object", additionalProperties: false,
		properties: {
			question: { type: "string", pattern: "\\S" }, payload,
			...(variant === "teach" ? { type: { type: "string", enum: ["predict", "check"] }, nodeId: { type: "string", pattern: "\\S" } } : {}),
		},
		required: variant === "teach" ? ["type", "nodeId", "question", "payload"] : ["question", "payload"],
	};
	validatePluginSchema(parameters);
	return freezePluginQuestionValue(parameters) as TSchema;
}
function problems<T>(message: string): PluginQuestionValidationResult<T> { return { ok: false, problems: [message] }; }
function schemaAccepts(schema: unknown, value: JsonValue): boolean {
	return validatePluginSchema(preparePluginQuestionSchema(schema)).Check(value);
}
function refinement(callback: ((context: never) => unknown) | undefined, context: unknown): string[] {
	if (!callback) return [];
	try {
		const result = callback(freezePluginQuestionValue(context) as never);
		if (result === undefined) return [];
		// A thenable list is still asynchronous and cannot grant acceptance.
		if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
			if (result instanceof Promise) void result.catch(() => {});
			return ["Plugin question validation must be synchronous."];
		}
		if (Array.isArray(result) && result.every(text)) return [...result];
		return ["Plugin question validation must synchronously return a list of readable problems or undefined."];
	} catch { return ["Plugin question validation failed."]; }
}
function validateInput(definition: PluginQuestionTypeDefinition, context: { chatId: string; variant: PluginQuestionVariant; input: unknown }): PluginQuestionValidationResult<PluginQuestionInput> {
	try {
		const input = clonePluginQuestionJson(context.input);
		if (!variantOf(context.variant) || !definition[context.variant] || !validatePluginSchema(parametersFor(definition, context.variant)).Check(input)) return problems("Question does not satisfy its saved input contract.");
		const accepted = freezePluginQuestionValue(input) as PluginQuestionInput;
		const errors = refinement(definition.validateQuestion, { chatId: context.chatId, variant: context.variant, contractVersion: definition.contractVersion, input: accepted });
		return errors.length ? { ok: false, problems: errors } : { ok: true, value: accepted };
	} catch { return problems("Question must be finite JSON satisfying its input contract."); }
}
function validateAnswer(snapshot: PluginQuestionSnapshot, context: { chatId: string; answer: unknown }, definition?: PluginQuestionTypeDefinition): PluginQuestionValidationResult<JsonValue> {
	try {
		const saved = readPluginQuestionSnapshot(snapshot);
		if (!saved) return problems("Question contract is unreadable.");
		const answer = clonePluginQuestionJson(context.answer);
		if (!schemaAccepts(saved.answerSchema, answer)) return problems("Answer does not satisfy the saved answer contract.");
		if (saved.requiresAnswerRefinement && (!definition || definition.id !== saved.typeId || definition.contractVersion !== saved.contractVersion || !definition.validateAnswer)) return problems("The required question validation implementation is unavailable.");
		const accepted = freezePluginQuestionValue(answer);
		const errors = saved.requiresAnswerRefinement ? refinement(definition!.validateAnswer, { chatId: context.chatId, questionId: saved.questionId, variant: saved.variant, contractVersion: saved.contractVersion, input: saved.input, answer: accepted }) : [];
		return errors.length ? { ok: false, problems: errors } : { ok: true, value: accepted };
	} catch { return problems("Answer must be finite JSON satisfying its saved contract."); }
}

function occurrenceOf(value: unknown): PluginQuestionOccurrence | null {
	if (!record(value) || !text(value.messageId) || !Number.isSafeInteger(value.contentIndex) || (value.contentIndex as number) < 0 || !text(value.toolCallId) || !text(value.toolName)) return null;
	return { messageId: value.messageId, contentIndex: value.contentIndex as number, toolCallId: value.toolCallId, toolName: value.toolName };
}
function identityOf(value: unknown, expected?: PluginQuestionOccurrence): Extract<PluginQuestionAnnotationRead, { status: "unreadable" }>["identity"] {
	if (!record(value) || !text(value.questionId) || typeof value.pluginId !== "string" || !pluginId.test(value.pluginId) || typeof value.typeId !== "string" || !localId.test(value.typeId) || !version(value.contractVersion)) return undefined;
	const occurrence = occurrenceOf(value.occurrence);
	if (!occurrence || (expected && !samePluginQuestionOccurrence(occurrence, expected))) return undefined;
	return freezePluginQuestionValue({ questionId: value.questionId, occurrence, pluginId: value.pluginId, typeId: value.typeId, contractVersion: value.contractVersion });
}
const snapshotFields = ["questionId", "occurrence", "contractVersion", "input", "questionSchema", "answerSchema", "showThinking", "requiresAnswerRefinement"];
function readAnnotation(value: unknown, expected?: PluginQuestionOccurrence): PluginQuestionAnnotationRead {
	if (value === undefined) return { status: "absent" };
	const identity = identityOf(value, expected);
	const embeddedOccurrence = record(value) ? occurrenceOf(value.occurrence) : null;
	const binding = expected && embeddedOccurrence && samePluginQuestionOccurrence(embeddedOccurrence, expected)
		? freezePluginQuestionValue({ occurrence: embeddedOccurrence, ...(record(value) && text(value.questionId) ? { questionId: value.questionId } : {}) })
		: undefined;
	const unreadable = (): PluginQuestionAnnotationRead => ({ status: "unreadable", ...(identity ? { identity } : {}), ...(binding ? { binding } : {}) });
	try {
		const brandingNodes = new Set<object>();
		if (record(value)) {
			for (const key of ["questionSchema", "answerSchema"]) if (own(value, key)) walkSchema(value[key], node => { brandingNodes.add(node); });
		}
		const saved = cloneJson(value, brandingNodes);
		if (!record(saved) || saved.protocolVersion !== 1 || typeof saved.pluginId !== "string" || !pluginId.test(saved.pluginId) || typeof saved.typeId !== "string" || !localId.test(saved.typeId) || !text(saved.label) || !variantOf(saved.variant)) return unreadable();
		const attempt: PluginQuestionAttempt = { protocolVersion: 1, pluginId: saved.pluginId, typeId: saved.typeId, label: saved.label, variant: saved.variant };
		if (!snapshotFields.some(key => own(saved, key))) return { status: "attempt", attempt: freezePluginQuestionValue(attempt) };
		if (!identity || typeof saved.showThinking !== "boolean" || typeof saved.requiresAnswerRefinement !== "boolean") return unreadable();
		const questionSchema = preparePluginQuestionSchema(saved.questionSchema);
		const answerSchema = preparePluginQuestionSchema(saved.answerSchema);
		// Read historical schemas only; no current callbacks or tool-name lookup.
		const historicalDefinition: PluginQuestionTypeDefinition = {
			id: attempt.typeId, label: attempt.label, contractVersion: identity.contractVersion,
			questionSchema, answerSchema, showThinking: saved.showThinking,
			[attempt.variant]: { toolName: identity.occurrence.toolName, description: attempt.label },
		};
		const input = validateInput(historicalDefinition, { chatId: "", variant: attempt.variant, input: saved.input });
		if (!input.ok) return unreadable();
		return { status: "posed", snapshot: freezePluginQuestionValue({ ...attempt, ...identity, input: input.value, questionSchema, answerSchema, showThinking: saved.showThinking, requiresAnswerRefinement: saved.requiresAnswerRefinement }) };
	} catch { return unreadable(); }
}
function readMessageAnnotation(message: unknown, contentIndex: number): PluginQuestionAnnotationRead {
	if (!record(message) || !own(message, "lhQuestions")) return { status: "absent" };
	const map = message.lhQuestions;
	if (!record(map)) return { status: "unreadable" };
	if (!own(map, String(contentIndex))) return { status: "absent" };
	if (message.role !== "assistant" || !text(message.id) || !Number.isSafeInteger(contentIndex) || contentIndex < 0 || !Array.isArray(message.content)) return { status: "unreadable" };
	const call: unknown = message.content[contentIndex];
	if (!record(call) || call.type !== "toolCall" || !text(call.id) || !text(call.name)) return { status: "unreadable" };
	const result = readAnnotation(map[String(contentIndex)], { messageId: message.id, contentIndex, toolCallId: call.id, toolName: call.name });
	return result.status === "absent" ? { status: "unreadable" } : result;
}
function readAnswer(value: unknown, snapshot?: PluginQuestionSnapshot): PluginQuestionAnswer | null {
	try {
		const saved = clonePluginQuestionJson(value);
		if (!record(saved) || saved.kind !== "plugin-question" || !text(saved.questionId) || typeof saved.pluginId !== "string" || !pluginId.test(saved.pluginId) || typeof saved.typeId !== "string" || !localId.test(saved.typeId) || !version(saved.contractVersion) || !own(saved, "answer") || !text(saved.answeredAt) || !Number.isFinite(Date.parse(saved.answeredAt))) return null;
		for (const key of ["thinking", "readingThinking"] as const) if (own(saved, key) && typeof saved[key] !== "string") return null;
		const images = own(saved, "images") ? validatePluginSubmissionImages(saved.images) : undefined;
		if (snapshot) {
			const canonical = readPluginQuestionSnapshot(snapshot);
			if (!canonical || saved.questionId !== canonical.questionId || saved.pluginId !== canonical.pluginId || saved.typeId !== canonical.typeId || saved.contractVersion !== canonical.contractVersion) return null;
			if (own(saved, "thinking") && !canonical.showThinking) return null;
			if (own(saved, "readingThinking") && (canonical.variant !== "teach" || canonical.input.type !== "check")) return null;
			if (images?.thinking?.length && !canonical.showThinking) return null;
			if (images?.readingThinking?.length && (canonical.variant !== "teach" || canonical.input.type !== "check")) return null;
			if (!schemaAccepts(canonical.answerSchema, saved.answer as JsonValue)) return null;
		}
		const { images: _images, ...fields } = saved;
		return freezePluginQuestionValue({ ...fields, ...(images && Object.keys(images).length ? { images } : {}) }) as unknown as PluginQuestionAnswer;
	} catch { return null; }
}
function readCancellation(value: unknown, snapshot?: PluginQuestionSnapshot): PluginQuestionCancellation | null {
	try {
		const saved = clonePluginQuestionJson(value);
		if (!record(saved) || saved.kind !== "plugin-question-cancelled" || !["dismissed", "incompatible", "unreadable-protocol"].includes(saved.reason as string)) return null;
		const occurrence = occurrenceOf(saved.occurrence);
		if (!occurrence || (own(saved, "questionId") ? !text(saved.questionId) : saved.reason === "incompatible")) return null;
		if (snapshot && (!samePluginQuestionOccurrence(occurrence, snapshot.occurrence) || (saved.questionId !== undefined && saved.questionId !== snapshot.questionId) || (saved.questionId === undefined && snapshot.questionId !== undefined))) return null;
		return freezePluginQuestionValue({ kind: "plugin-question-cancelled", occurrence, reason: saved.reason, ...(saved.questionId !== undefined ? { questionId: saved.questionId } : {}) }) as PluginQuestionCancellation;
	} catch { return null; }
}
