"use client";

import type { CacheRetention } from "@earendil-works/pi-ai";

const OPTIONS = [
	{ value: undefined, compact: "default", label: "Pi default", description: "Leave the option unset. Pi’s normal behavior and environment override apply." },
	{ value: "none", compact: "not requested", label: "Don’t request caching", description: "Pass Pi’s native none preference. Providers may still cache automatically." },
	{ value: "short", compact: "short", label: "Short retention", description: "Pass Pi’s native short preference. The duration depends on the provider and model." },
	{ value: "long", compact: "long", label: "Long retention", description: "Pass Pi’s native long preference. Cache-write costs may be higher." },
] as const;

export function cacheRetentionLabel(value: CacheRetention | undefined): string {
	return `Cache: ${OPTIONS.find((option) => option.value === value)!.compact}`;
}

export function CacheRetentionMenu({ value, onPick }: {
	value: CacheRetention | undefined;
	onPick: (value: CacheRetention | undefined) => void;
}) {
	return <>
		<div className="border-b border-border px-2 pb-2">
			<p className="text-card-foreground">Cache retention</p>
			<p className="mt-1 text-muted-foreground">Controls the cache-retention preference sent to Pi. Support and duration depend on the provider and model. This does not guarantee a cache hit.</p>
		</div>
		{OPTIONS.map((option) => <button
			key={option.value ?? "default"}
			type="button"
			data-testid={`cache-retention-option-${option.value ?? "default"}`}
			aria-pressed={value === option.value}
			onClick={() => onPick(option.value)}
			className={`rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted ${value === option.value ? "bg-muted/60" : ""}`}
		>
			<span className="flex justify-between gap-2 text-card-foreground"><span>{option.label}</span>{value === option.value && <span aria-hidden>✓</span>}</span>
			<span className="mt-1 block text-muted-foreground">{option.description}</span>
		</button>)}
	</>;
}
