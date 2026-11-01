import assert from "node:assert/strict";
import { it } from "node:test";
import { createKnowledgePickerForegroundStore } from "../components/knowledge-picker-foreground.tsx";

it("reservation snapshots modal versions but leaves origins usable until activation", () => {
	const store = createKnowledgePickerForegroundStore(); let suspended = 0;
	const origin = store.createModal(() => { suspended++; }); origin.activate();
	const picker = store.reservePicker(() => {});
	assert.equal(origin.isSuspended(), false); assert.equal(origin.canHandle(), true);
	picker.activate(); assert.equal(suspended, 1); assert.equal(origin.isSuspended(), true);
	assert.equal(origin.canHandle(), false); assert.equal(picker.isForeground(), true);
	picker.release(); assert.equal(origin.isSuspended(), false); assert.equal(origin.canHandle(), true);
});

it("a same-instance explicit activation wins synchronously over a pending or active selector", () => {
	for (const alreadyActive of [false, true]) {
		const store = createKnowledgePickerForegroundStore();
		const origin = store.createModal(); origin.activate();
		const picker = store.reservePicker(() => {}); if (alreadyActive) picker.activate();
		origin.activate(); picker.activate();
		assert.equal(origin.isSuspended(), false); assert.equal(origin.canHandle(), true);
		assert.equal(picker.isForeground(), false); assert.equal(picker.canRestoreFocus(), false);
		origin.close(); assert.equal(picker.isForeground(), true);
	}
});

it("a newer modal remains above a delayed selector and closing it resumes selector ownership", () => {
	const store = createKnowledgePickerForegroundStore(); const origin = store.createModal(); origin.activate();
	const picker = store.reservePicker(() => {}); const later = store.createModal(); later.activate();
	picker.activate(); assert.equal(origin.isSuspended(), true); assert.equal(later.isSuspended(), false);
	assert.equal(later.canHandle(), true); assert.equal(picker.isForeground(), false);
	later.close(); assert.equal(picker.isForeground(), true);
});

it("there is one lease, replacement never resumes an old selector, and stale release is harmless", () => {
	const store = createKnowledgePickerForegroundStore(); let superseded = 0;
	const first = store.reservePicker(() => { superseded++; }); first.activate();
	const next = store.reservePicker(() => {}); assert.equal(superseded, 1);
	assert.equal(first.owns(), false); assert.equal(first.activate(), false); assert.equal(first.canRestoreFocus(), false);
	const revision = store.getSnapshot(); first.release(); assert.equal(store.getSnapshot(), revision);
	next.activate(); assert.equal(next.isForeground(), true); first.release(); assert.equal(next.isForeground(), true);
	next.release(); next.release(); assert.equal(first.owns(), false); assert.equal(store.hasActivePicker(), false);
	assert.equal(first.canRestoreFocus(), false, "superseded leases never regain focus authority after the replacement closes");
});

it("Settings cancellation invalidates active/pending leases before the modal's normal activation", () => {
	for (const active of [false, true]) {
		const store = createKnowledgePickerForegroundStore(); const settings = store.createModal(); settings.activate();
		let cancelled = 0; const picker = store.reservePicker(() => { cancelled++; }); if (active) picker.activate();
		store.cancelPicker(); settings.activate();
		assert.equal(cancelled, 1); assert.equal(picker.owns(), false); assert.equal(picker.activate(), false);
		assert.equal(picker.canRestoreFocus(), false); assert.equal(settings.isSuspended(), false); assert.equal(settings.canHandle(), true);
		picker.release(); settings.close(); assert.equal(store.hasActivePicker(), false);
	}
});

it("closing a suspended origin cannot resurrect it when its selector releases", () => {
	const store = createKnowledgePickerForegroundStore(); const origin = store.createModal(); origin.activate();
	const picker = store.reservePicker(() => {}); picker.activate(); origin.close(); picker.release();
	assert.equal(origin.canHandle(), false); assert.equal(origin.isSuspended(), false);
});

it("focus restoration yields to newer leases and modal activations, including after release", () => {
	const store = createKnowledgePickerForegroundStore(); const origin = store.createModal(); origin.activate();
	const picker = store.reservePicker(() => {}); picker.activate();
	assert.equal(origin.canRestoreFocus(), false); assert.equal(picker.canRestoreFocus(), true);
	picker.release(); assert.equal(picker.canRestoreFocus(), true);
	const later = store.createModal(); later.activate(); assert.equal(picker.canRestoreFocus(), false);
	later.close(); const next = store.reservePicker(() => {}); assert.equal(picker.canRestoreFocus(), false);
	next.release(); assert.equal(origin.canRestoreFocus(), true);
	assert.equal(picker.canRestoreFocus(), false, "even a naturally released lease loses restoration authority after a new claim");
});
