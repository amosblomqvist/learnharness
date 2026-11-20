"use client";

import type { RecordsSettings } from "@/src/core";
import { recordExtractionEnabled } from "@/src/core";
import type { FrontendPlugin } from "@/components/plugin-manager";
import { PluginMountPoint } from "@/components/plugins";
import { PluginSettingsRows } from "@/components/plugin-ui-host";
import { SettingsRow, SettingsSection, Toggle } from "./controls";

/**
 * Host-owned record lifecycle (session/record kinds stage C, owner C4/q54):
 * one extraction switch per record kind the plugin registers — the plugin
 * record's counterpart of the graph's Extraction row. Persisted by the host
 * in settings.records; absent = on. Off = no trigger, no ring, manual
 * extract refused. Undefined `records` = settings not loaded yet.
 */
export function RecordExtractionRows({ plugin, records, onChange }: {
	plugin: FrontendPlugin;
	records: RecordsSettings | undefined;
	onChange: (next: RecordsSettings) => void;
}) {
	const kinds = plugin.info.recordKinds ?? [];
	if (kinds.length === 0) return null;
	return <div data-testid="record-extraction-rows" className="flex flex-col gap-2">
		{kinds.map((kind) => {
			const on = recordExtractionEnabled(records ? { records } : null, kind.id);
			return <SettingsRow key={kind.id} label={`Extraction into ${kind.label}`} hint={`Off = ${kind.label} stops growing`} testid={`record-extraction-${kind.id}`} dimmed={records === undefined}>
				<Toggle
					checked={on}
					disabled={records === undefined}
					label={`${kind.label} extraction enabled`}
					onChange={(next) => {
						if (!records) return;
						const { [kind.id]: current, ...rest } = records;
						onChange({ ...rest, [kind.id]: { ...current, extraction: next } });
					}}
				/>
			</SettingsRow>;
		})}
	</div>;
}

/** Plugin persistence belongs to the registration; the host only presents it. */
export function PluginSettingsPage({ plugin, records, onRecordsChange }: {
	plugin: FrontendPlugin;
	/** The settings record's records section (stage C); undefined while loading. */
	records?: RecordsSettings;
	onRecordsChange?: (next: RecordsSettings) => void;
}) {
	const { info, settings } = plugin;
	const name = info.manifest?.name ?? info.id;
	const hostRows = (info.recordKinds?.length ?? 0) > 0;
	return <SettingsSection title={name} testid={`section-plugin-${info.id}`}>
		{plugin.error && <p role="alert" className="break-words text-xs text-destructive">{plugin.error}</p>}
		{hostRows && <RecordExtractionRows plugin={plugin} records={records} onChange={(next) => onRecordsChange?.(next)} />}
		{plugin.phase === "loading" ? <p role="status" className="text-xs text-muted-foreground">Loading plugin settings…</p>
			: plugin.phase === "error" ? !plugin.error && <p role="alert" className="text-xs text-destructive">Plugin settings could not be loaded.</p>
				: !settings ? !hostRows && <p className="text-xs text-muted-foreground">No settings available.</p>
					: typeof settings === "function" ? <PluginMountPoint pluginId={info.id} mount={settings} label={`${name} settings`} />
						: <PluginSettingsRows schema={settings} />}
	</SettingsSection>;
}
