"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Toggle } from "./controls";
import { tr } from "@/src/core";

export function promptSegmentName(path: string): string {
	const name = (path.split("/").at(-1) ?? "").replace(/\.[^.]+$/, "").replace(/^[\d-]+/, "").replace(/-+/g, " ");
	return name.charAt(0).toUpperCase() + name.slice(1);
}

export function PromptSegmentRow({ path, usageHint, hasOverride, enabled, busy, switching, error, onView, onEdit, onToggle }: {
	path: string;
	usageHint?: string;
	hasOverride: boolean;
	enabled: boolean;
	busy: boolean;
	switching: boolean;
	error?: string;
	onView: (row: HTMLDivElement) => void;
	onEdit: (row: HTMLDivElement) => void;
	onToggle: (enabled: boolean) => void;
}) {
	const name = promptSegmentName(path);
	const row = useRef<HTMLDivElement>(null);
	return <div ref={row} role="group" aria-label={name} tabIndex={-1} data-testid={`prompt-segment-${path}`} className="border-t border-border/50 py-2 font-ui focus-visible:outline-1 focus-visible:outline-ring">
		<div data-testid={`prompt-row-${path}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
			<div className="min-w-0 flex-1 basis-44">
				<p className="font-prose text-(length:--lh-prose-size) text-foreground">{name}</p>
				{usageHint && <p className="mt-0.5 text-xs text-muted-foreground">{usageHint}</p>}
			</div>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => { if (row.current) onView(row.current); }}>{tr("查看默认", "View default")}</Button>
				<Button type="button" size="xs" variant="outline" className={cn("w-[17ch]", switching && !busy && "disabled:opacity-100")} disabled={busy || switching} onClick={() => { if (row.current) onEdit(row.current); }}>
					{hasOverride ? tr("编辑覆盖", "Edit override") : tr("+ 添加覆盖", "+ Add override")}
				</Button>
				<div className="flex items-center gap-2 sm:ml-2">
					<span className="w-[20ch] text-xs text-muted-foreground">{tr("当前使用：", "In use: ")}<span className="text-foreground">{enabled ? tr("你的版本", "Your version") : tr("默认", "Default")}</span></span>
					<span className={cn("flex", !hasOverride && "opacity-40")}>
						<Toggle label={tr(`对 ${name} 使用你的覆盖`, `Use your override for ${name}`)} testid={`toggle-${`use your override for ${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} title={tr("使用你的覆盖代替默认版本", "Use your override instead of the default")} checked={enabled} disabled={!hasOverride || busy || switching} onChange={onToggle} />
					</span>
				</div>
			</div>
		</div>
		{error && <p role="alert" className="mt-1 text-xs text-error">{error}</p>}
	</div>;
}
