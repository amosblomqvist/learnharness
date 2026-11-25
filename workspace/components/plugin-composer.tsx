"use client";

import { useEffect, useRef } from "react";
import type { PluginComposerProps, PluginStandardComposerProps } from "@/src/core";
import { Composer } from "@/components/composer";
import { claimPluginInputFocus } from "@/components/plugin-input-focus";
import { PluginModelPicker, PluginThinkingPicker, type PickerCommand } from "@/components/plugin-model-picker";

type Extra = { onError?: (error: unknown) => void };
const reportDefault = (error: unknown) => console.error("Plugin UI callback failed", error);
function run(callback: () => void | Promise<void>, report: (error: unknown) => void) {
	try { void Promise.resolve(callback()).catch(report); } catch (error) { report(error); }
}

/** The exact core composer, with its learning/file defaults explicitly disabled. */
export function PluginComposer({ value, onChange, onSend, busy = false, onStop, canSend, placeholder = "Message…", autoFocus, onError = reportDefault }: PluginComposerProps & Extra) {
	return <Composer value={value} onChange={(next) => run(() => onChange(next), onError)} onSend={() => run(onSend, onError)}
		onStop={() => run(() => onStop?.(), onError)} busy={busy} canSend={canSend ?? value.trim().length > 0}
		placeholder={placeholder} autoFocus={autoFocus} defaultDropTarget={false} fileInsertion={false} />;
}

export function PluginStandardComposer({ composer, model, thinking, onError = reportDefault }: PluginStandardComposerProps & Extra) {
	const root = useRef<HTMLDivElement>(null);
	const modelCommand = useRef<PickerCommand | null>(null);
	const thinkingCommand = useRef<PickerCommand | null>(null);
	useEffect(() => {
		if (!root.current) return;
		return claimPluginInputFocus(root.current, {
			cycleModel: () => modelCommand.current?.invoke(),
			cycleThinking: () => thinkingCommand.current?.invoke(),
		});
	});
	return <div ref={root} data-plugin-standard-composer="">
		<div className="overflow-hidden rounded-2xl border bg-card shadow-lg">
			<PluginComposer {...composer} onError={onError} />
		</div>
		{/* Like the native dock, controls sit below the text-only shell. */}
		<div className="flex items-center justify-end gap-1.5 px-3 pt-2 font-ui text-xs text-muted-foreground">
			<PluginModelPicker {...model} commandRef={modelCommand} onError={onError} />
			<PluginThinkingPicker {...thinking} commandRef={thinkingCommand} onError={onError} />
		</div>
	</div>;
}
