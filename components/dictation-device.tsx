"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
	DICTATION_DEFAULT_DEVICE_LABEL,
	dictationInputDeviceOptions,
	type DictationInputDevice,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { SettingsMenuTrigger, SettingsRow } from "@/components/settings/controls";
import { SearchMenuList } from "@/components/settings/search-menu-list";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationInputDevice } from "@/components/dictation-preference";

type InputDevicePreference = ReturnType<typeof useDictationInputDevice>;

export function DictationInputDeviceSetting() {
	const preference = useDictationInputDevice();
	const active = useDictationActive();
	return <SettingsRow label="Microphone" testid="row-dictation-device" dimmed={active}>
		<DictationInputDevicePicker preference={preference} disabled={active} />
	</SettingsRow>;
}

/** The live audio-input list, or `undefined` while the first enumeration (and
 *  any permission prompt) is in flight. Stops the throwaway permission stream
 *  immediately — it exists only to unblank the device labels (decision 3),
 *  never to capture. A denied prompt falls through to the fallback labels. */
async function enumerateInputs(requestPermission: boolean): Promise<DictationInputDevice[]> {
	const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
	if (!media?.enumerateDevices) return [];
	try {
		let devices = await media.enumerateDevices();
		// Before mic permission, the platform hides the real inputs: Chromium
		// returns ONE placeholder per kind with an empty deviceId AND empty
		// label, Firefox lists devices with ids but blank labels. Either way,
		// if no usable (id + label) input is present, request access once to
		// reveal the real list — keying only on a blank label would miss
		// Chromium's id-less placeholder and leave just "System default".
		const inputs = devices.filter((d) => d.kind === "audioinput");
		const needsPermission = inputs.length === 0 || inputs.some((d) => !d.deviceId || !d.label);
		if (needsPermission && requestPermission && media.getUserMedia) {
			try {
				const stream = await media.getUserMedia({ audio: true });
				for (const track of stream.getTracks()) track.stop();
				devices = await media.enumerateDevices();
			} catch {
				// Permission denied/dismissed: keep the fallback-labelled list.
			}
		}
		return dictationInputDeviceOptions(devices);
	} catch {
		return [];
	}
}

function DictationInputDevicePicker({ preference, disabled }: {
	preference: InputDevicePreference;
	disabled: boolean;
}) {
	const { inputDeviceId, inputDeviceLabel, language, saving, error, load, save } = preference;
	const [open, setOpen] = useState(false);
	const [devices, setDevices] = useState<DictationInputDevice[] | undefined>(undefined);
	const triggerRef = useRef<HTMLButtonElement>(null);
	// The stored label names the pin even when it is disconnected (the live
	// list can't); fall back to the live label, then the raw id. Before the
	// section loads, show a neutral dash like the language picker.
	const label = language === undefined
		? "—"
		: inputDeviceId
			? (inputDeviceLabel ?? devices?.find((d) => d.deviceId === inputDeviceId)?.label ?? inputDeviceId)
			: DICTATION_DEFAULT_DEVICE_LABEL;

	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	// Enumerate on open (requesting permission once to reveal names) and keep
	// the list fresh while the menu is open as devices come and go.
	useEffect(() => {
		if (!open || disabled) return;
		let live = true;
		void enumerateInputs(true).then((list) => { if (live) setDevices(list); });
		const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
		const onChange = () => void enumerateInputs(false).then((list) => { if (live) setDevices(list); });
		media?.addEventListener?.("devicechange", onChange);
		return () => { live = false; media?.removeEventListener?.("devicechange", onChange); };
	}, [open, disabled]);
	useEffect(() => { if (!open) setDevices(undefined); }, [open]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="dictation-device-menu"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);
	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};
	const pick = async (device: DictationInputDevice) => {
		if (disabled || saving || language === undefined) return;
		// An empty id is "System default" — clear the pin; otherwise store the
		// id WITH its label so the setting can still name a disconnected device.
		const ok = device.deviceId
			? await save(device.deviceId, device.label)
			: await save("");
		if (ok) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return <>
		<Hint label={error ?? `Dictation microphone: ${label}`} side="top">
			<SettingsMenuTrigger
				ref={triggerRef}
				value={label}
				data-testid="dictation-device"
				aria-label={`Dictation microphone: ${label}`}
				aria-expanded={open && !disabled}
				disabled={disabled || saving}
				onKeyDown={(event) => { if (open) closeOnEscape(event); }}
				onClick={() => {
					setOpen((value) => !value);
					if (language === undefined) void load().catch(() => {});
				}}
				className="min-w-20 max-w-[65%]"
			/>
		</Hint>
		{open && !disabled && <MenuShell
			anchorRef={triggerRef}
			testid="dictation-device-menu"
			preferredSide="down"
			menuClass="flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
		>
			<div onKeyDown={(event) => {
				closeOnEscape(event);
				if (event.key === "Enter") {
					// Empty search results must not submit the composer, but a
					// focused option button still needs Enter's native click.
					if (event.target instanceof HTMLInputElement) event.preventDefault();
					event.stopPropagation();
				}
			}}>
				{error && <div role="alert" className="mb-1.5 text-destructive">{error}</div>}
				<SearchMenuList
					items={devices}
					// The synthetic System-default option has an empty deviceId;
					// slug it with a RESERVED token that no real deviceId can be
					// (the platform "default"/"communications" aliases are dropped
					// upstream) so keys and testids never collide.
					itemKey={(device) => device.deviceId || "system-default"}
					searchTerms={(device) => [device.label]}
					isSelected={(device) => (device.deviceId || "") === (inputDeviceId ?? "")}
					onPick={(device) => { void pick(device); }}
					disabled={saving || language === undefined}
					searchTestid="dictation-device-search"
					listTestid="dictation-device-list"
					optionTestid={(device) => `dictation-device-${device.deviceId || "system-default"}`}
					ariaLabel="Search microphones"
					placeholder="Search microphones…"
					loading="Loading microphones…"
					empty="No microphones match."
					renderItem={(device) => <span className="text-card-foreground">{device.label}</span>}
				/>
			</div>
		</MenuShell>}
	</>;
}
