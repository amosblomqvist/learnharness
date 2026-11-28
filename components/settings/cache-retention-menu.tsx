"use client";

import type { CacheRetention } from "@earendil-works/pi-ai";
import { tr } from "@/src/core";

const OPTIONS = [
	{ value: undefined, compact: tr("默认", "default"), label: tr("Pi 默认", "Pi default"), description: tr("不设置此选项，沿用 Pi 的常规行为和环境变量覆盖。", "Leave the option unset. Pi’s normal behavior and environment override apply.") },
	{ value: "none", compact: tr("不请求", "not requested"), label: tr("不请求缓存", "Don’t request caching"), description: tr("传递 Pi 原生的 none 偏好。服务商仍可能自动缓存。", "Pass Pi’s native none preference. Providers may still cache automatically.") },
	{ value: "short", compact: tr("短", "short"), label: tr("短期保留", "Short retention"), description: tr("传递 Pi 原生的 short 偏好。保留时长取决于服务商和模型。", "Pass Pi’s native short preference. The duration depends on the provider and model.") },
	{ value: "long", compact: tr("长", "long"), label: tr("长期保留", "Long retention"), description: tr("传递 Pi 原生的 long 偏好。缓存写入费用可能更高。", "Pass Pi’s native long preference. Cache-write costs may be higher.") },
] as const;

export function cacheRetentionLabel(value: CacheRetention | undefined): string {
	return tr(`缓存：${OPTIONS.find((option) => option.value === value)!.compact}`, `Cache: ${OPTIONS.find((option) => option.value === value)!.compact}`);
}

export function CacheRetentionMenu({ value, onPick }: {
	value: CacheRetention | undefined;
	onPick: (value: CacheRetention | undefined) => void;
}) {
	return <>
		<div className="border-b border-border px-2 pb-2">
			<p className="text-card-foreground">{tr("缓存保留", "Cache retention")}</p>
			<p className="mt-1 text-muted-foreground">{tr("控制发送给 Pi 的缓存保留偏好。是否支持及保留时长取决于服务商和模型，且不保证命中缓存。", "Controls the cache-retention preference sent to Pi. Support and duration depend on the provider and model. This does not guarantee a cache hit.")}</p>
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
