"use client";

import { useRef, useState } from "react";
import type { PluginSettingsRow, PluginSettingsSchema } from "@/src/core";
import { CommitInput, SettingsRow, SettingsSlider, ThinSelect, Toggle } from "@/components/settings/controls";

function SchemaRow({ row, onError }: { row: PluginSettingsRow; onError?: (error: unknown) => void }) {
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	const changing = useRef(false);
	const change = async (value: string | number | boolean): Promise<boolean> => {
		if (changing.current || row.disabled) return false;
		try {
			// The discriminant controls the editor; no coercion outside that editor.
			const validate = row.validate as ((value: typeof row.value) => string | undefined) | undefined;
			const message = validate?.(value);
			if (message) { setError(message); return false; }
			if (typeof value === "number" && (!Number.isFinite(value) ||
				("min" in row && row.min !== undefined && value < row.min) ||
				("max" in row && row.max !== undefined && value > row.max))) {
				setError("Value is outside the allowed range."); return false;
			}
			setError(undefined);
			changing.current = true;
			const result = (row.onChange as (value: typeof row.value) => void | Promise<void>)(value);
			// Disabling a native range mid-gesture cancels its drag. Synchronous
			// controlled acknowledgements need no pending state; async saves do.
			if (result && typeof result.then === "function") {
				setPending(true);
				await result;
			}
			return true;
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
			onError?.(error);
			return false;
		} finally { changing.current = false; setPending(false); }
	};
	const disabled = row.disabled || pending;
	let control;
	switch (row.type) {
		case "toggle": control = <Toggle label={row.label} checked={row.value} disabled={disabled} onChange={(value) => { void change(value); }} />; break;
		case "dropdown": control = <ThinSelect ariaLabel={row.label} value={row.value} disabled={disabled} onChange={(value) => { void change(value); }}>
			{row.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
		</ThinSelect>; break;
		case "slider": control = <SettingsSlider label={row.label} showLabel={false} value={row.value} min={row.min} max={row.max} step={row.step} disabled={disabled} onChange={(value) => { void change(value); }} />; break;
		case "number": control = <CommitInput ariaLabel={row.label} type="number" value={String(row.value)} min={row.min} max={row.max} step={row.step} disabled={disabled} onCommit={(value) => change(value.trim() ? Number(value) : NaN)} />; break;
		case "text": control = <CommitInput ariaLabel={row.label} value={row.value} disabled={disabled} onCommit={(value) => change(value)} />; break;
	}
	return <div data-plugin-setting={row.key}>
		<SettingsRow label={row.label} hint={row.description} dimmed={disabled}>{control}</SettingsRow>
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
	</div>;
}

/** Shared by imperative ctx.ui mounts and the host's declarative settings pages. */
export function PluginSettingsRows({ schema, onError }: { schema: PluginSettingsSchema; onError?: (error: unknown) => void }) {
	return <div className="flex flex-col gap-2">{schema.rows.map((row) => <SchemaRow key={row.key} row={row} onError={onError} />)}</div>;
}
