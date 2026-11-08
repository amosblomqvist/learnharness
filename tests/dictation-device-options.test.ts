import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DICTATION_DEFAULT_DEVICE_ID,
	DICTATION_DEFAULT_DEVICE_LABEL,
	dictationInputDeviceOptions,
} from "../src/core/dictation.ts";

/** A minimal enumerateDevices() entry — only the fields the mapping reads. */
function device(partial: Partial<MediaDeviceInfo>): MediaDeviceInfo {
	return { deviceId: "", kind: "audioinput", label: "", groupId: "g", toJSON() { return this; }, ...partial } as MediaDeviceInfo;
}

test("an empty device list still offers System default", () => {
	assert.deepEqual(dictationInputDeviceOptions([]), [
		{ deviceId: DICTATION_DEFAULT_DEVICE_ID, label: DICTATION_DEFAULT_DEVICE_LABEL },
	]);
});

test("audio inputs are kept in order under System default; other kinds drop", () => {
	const options = dictationInputDeviceOptions([
		device({ deviceId: "cam", kind: "videoinput", label: "FaceTime HD" }),
		device({ deviceId: "mic-a", label: "MacBook Microphone" }),
		device({ deviceId: "spk", kind: "audiooutput", label: "MacBook Speakers" }),
		device({ deviceId: "mic-b", label: "USB Mic" }),
	]);
	assert.deepEqual(options, [
		{ deviceId: "", label: DICTATION_DEFAULT_DEVICE_LABEL },
		{ deviceId: "mic-a", label: "MacBook Microphone" },
		{ deviceId: "mic-b", label: "USB Mic" },
	]);
});

test("duplicate ids and empty ids are dropped", () => {
	const options = dictationInputDeviceOptions([
		device({ deviceId: "", label: "blank id" }),
		device({ deviceId: "mic-a", label: "First" }),
		device({ deviceId: "mic-a", label: "Duplicate" }),
	]);
	assert.deepEqual(options.map((o) => o.deviceId), ["", "mic-a"]);
	assert.equal(options[1]!.label, "First");
});

test("the platform default/communications aliases are dropped (System default covers them)", () => {
	const options = dictationInputDeviceOptions([
		device({ deviceId: "default", label: "Default - Headphones" }),
		device({ deviceId: "communications", label: "Communications - Headphones" }),
		device({ deviceId: "mic-a", label: "Real Mic" }),
	]);
	assert.deepEqual(options, [
		{ deviceId: "", label: DICTATION_DEFAULT_DEVICE_LABEL },
		{ deviceId: "mic-a", label: "Real Mic" },
	]);
});

test("blank labels (no permission yet) get a stable numbered fallback", () => {
	const options = dictationInputDeviceOptions([
		device({ deviceId: "mic-a", label: "" }),
		device({ deviceId: "mic-b", label: "   " }),
		device({ deviceId: "mic-c", label: "Named" }),
	]);
	assert.deepEqual(options.slice(1), [
		{ deviceId: "mic-a", label: "Microphone 1" },
		{ deviceId: "mic-b", label: "Microphone 2" },
		{ deviceId: "mic-c", label: "Named" },
	]);
});
