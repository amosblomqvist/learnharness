"use client";

import { useEffect, useRef, useState } from "react";
import {
	fuzzyScore,
	isValidClaudeConfigDir,
	type ClaudeCodeProfile,
	type ClaudeCodeProfilesResponse,
	type ClaudeCodeProfileSource,
} from "@/src/core";

export type ClaudeProfileMenuEntry =
	| {
			kind: "default";
			label: string;
			displayPath: string;
			inherited: boolean;
			exists: boolean;
			hasSettings: boolean;
			hasCredentials: boolean;
			email?: string;
			subscriptionPlan?: string;
	  }
	| {
			kind: "profile";
			profile: ClaudeCodeProfile;
	  }
	| {
			kind: "custom";
			value: string;
	  };

const SOURCE_ORDER: Record<ClaudeCodeProfileSource, number> = {
	configured: 0,
	env: 1,
	default: 2,
	discovered: 3,
};

function normalizeMatchPath(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "/" || trimmed === "~") return trimmed;
	return trimmed.replace(/[\\/]+$/, "");
}

function pathBasename(value: string): string {
	const normalized = normalizeMatchPath(value);
	const parts = normalized.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? normalized;
}

const KNOWN_PLAN_LABELS = new Map<string, string>([
	["pro", "Pro"],
	["max", "Max"],
	["team", "Team"],
	["enterprise", "Enterprise"],
	["free", "Free"],
	["subscription", "Subscription"],
	["stripe_subscription", "Subscription"],
]);

export function normalizeNonEmptyMeta(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

export function formatClaudeSubscriptionPlan(plan: unknown): string | undefined {
	const normalized = normalizeNonEmptyMeta(plan);
	if (!normalized) return undefined;
	const known = KNOWN_PLAN_LABELS.get(normalized.toLowerCase());
	return known ?? normalized;
}

export function formatClaudeProfileAccountMeta(
	profile: { email?: unknown; subscriptionPlan?: unknown } | null | undefined,
): string | null {
	if (!profile) return null;
	const email = normalizeNonEmptyMeta(profile.email);
	const plan = formatClaudeSubscriptionPlan(profile.subscriptionPlan);
	const parts = [email, plan].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(" · ") : null;
}

function expandTildeFromDefaultDir(target: string, defaultDir: string | undefined): string | null {
	if (target !== "~" && !target.startsWith("~/") && !target.startsWith("~\\")) {
		return null;
	}
	if (!defaultDir) return null;
	const normalizedDefault = normalizeMatchPath(defaultDir);
	const match = /^(.*?)([\\/])\.claude$/.exec(normalizedDefault);
	if (!match) return null;
	const [, homePrefix, sep] = match;
	if (homePrefix === undefined || sep === undefined) return null;
	const home = homePrefix === "" ? sep : homePrefix;
	if (target === "~") return home;
	const rest = target.slice(2).replace(/^[\\/]+/, "");
	if (!rest) return home;
	const normalizedRest = sep === "\\" ? rest.replace(/\//g, "\\") : rest.replace(/\\/g, "/");
	return home === sep ? `${sep}${normalizedRest}` : `${home}${sep}${normalizedRest}`;
}

export function findMatchingClaudeProfile(
	configDir: string | undefined,
	data: ClaudeCodeProfilesResponse | null,
): ClaudeCodeProfile | undefined {
	if (!configDir || !data) return undefined;
	const target = normalizeMatchPath(configDir);
	if (!target) return undefined;
	const expandedTarget = expandTildeFromDefaultDir(target, data.defaultDir);
	return data.profiles.find((profile) => {
		const pPath = normalizeMatchPath(profile.path);
		const pDisplay = normalizeMatchPath(profile.displayPath);
		return (
			pPath === target ||
			pDisplay === target ||
			(expandedTarget !== null && (pPath === expandedTarget || pDisplay === expandedTarget))
		);
	});
}

export function findActiveClaudeProfile(
	configDir: string | undefined,
	data: ClaudeCodeProfilesResponse | null,
): ClaudeCodeProfile | undefined {
	if (!data) return undefined;
	if (configDir) {
		return findMatchingClaudeProfile(configDir, data);
	}
	if (data.inheritedEnvDir) {
		const target = normalizeMatchPath(data.inheritedEnvDir);
		return data.profiles.find((profile) => normalizeMatchPath(profile.path) === target);
	}
	const defaultTarget = normalizeMatchPath(data.defaultDir);
	return (
		data.profiles.find((profile) => profile.source === "default") ??
		data.profiles.find((profile) => normalizeMatchPath(profile.path) === defaultTarget)
	);
}

export function claudeProfileTriggerLabel(
	configDir: string | undefined,
	data: ClaudeCodeProfilesResponse | null,
): string {
	if (configDir) {
		const match = findMatchingClaudeProfile(configDir, data);
		return match?.label ?? pathBasename(configDir);
	}
	if (data?.inheritedEnvDir) {
		return "Default (inherited)";
	}
	return "Default (.claude)";
}

export function claudeProfileHint(
	configDir: string | undefined,
	data: ClaudeCodeProfilesResponse | null,
): { text: string; warning: boolean } {
	if (configDir) {
		const match = findMatchingClaudeProfile(configDir, data);
		const display = match?.displayPath ?? configDir;
		if (match && !match.exists) {
			return { text: `${display} · directory not found`, warning: true };
		}
		return { text: display, warning: false };
	}
	if (data?.inheritedEnvDir) {
		const match = data.profiles.find(
			(profile) => normalizeMatchPath(profile.path) === normalizeMatchPath(data.inheritedEnvDir!),
		);
		return {
			text: `Inherited CLAUDE_CONFIG_DIR: ${match?.displayPath ?? data.inheritedEnvDir}`,
			warning: false,
		};
	}
	return { text: "CLAUDE_CONFIG_DIR (optional)", warning: false };
}

/** Pure: custom CLAUDE_CONFIG_DIR candidate when the user types a valid path
 *  that does not already match an existing discovered/known profile. */
export function claudeProfileCustomCandidate(
	query: string,
	data: ClaudeCodeProfilesResponse | null,
): string | null {
	const trimmed = query.trim();
	if (!trimmed || !isValidClaudeConfigDir(trimmed)) return null;
	const normalized = normalizeMatchPath(trimmed);
	const existing = (data?.profiles ?? []).some(
		(profile) =>
			normalizeMatchPath(profile.path) === normalized ||
			normalizeMatchPath(profile.displayPath) === normalized,
	);
	return existing ? null : trimmed;
}

/** Pure: computes the filtered, ranked menu entries for the searchable
 *  Claude Code profile dropdown (Default row, discovered/configured/env
 *  profiles, and optional custom path action). Exported for tests. */
export function claudeProfileMenuEntries(
	query: string,
	data: ClaudeCodeProfilesResponse | null,
): ClaudeProfileMenuEntry[] {
	const inherited = Boolean(data?.inheritedEnvDir);
	const defaultProfile = data?.profiles.find((p) => p.source === "default");
	const inheritedProfile = data?.inheritedEnvDir
		? data.profiles.find(
				(p) => normalizeMatchPath(p.path) === normalizeMatchPath(data.inheritedEnvDir!),
			)
		: undefined;

	const defaultEmail = normalizeNonEmptyMeta(inherited ? inheritedProfile?.email : defaultProfile?.email);
	const defaultPlan = formatClaudeSubscriptionPlan(
		inherited ? inheritedProfile?.subscriptionPlan : defaultProfile?.subscriptionPlan,
	);

	const defaultEntry: Extract<ClaudeProfileMenuEntry, { kind: "default" }> = inherited
		? {
				kind: "default",
				label: "Default (inherited)",
				displayPath: inheritedProfile?.displayPath ?? data!.inheritedEnvDir!,
				inherited: true,
				exists: inheritedProfile?.exists ?? true,
				hasSettings: inheritedProfile?.hasSettings ?? false,
				hasCredentials: inheritedProfile?.hasCredentials ?? false,
				...(defaultEmail ? { email: defaultEmail } : {}),
				...(defaultPlan ? { subscriptionPlan: defaultPlan } : {}),
			}
		: {
				kind: "default",
				label: "Default (.claude)",
				displayPath: defaultProfile?.displayPath ?? "~/.claude",
				inherited: false,
				exists: defaultProfile?.exists ?? false,
				hasSettings: defaultProfile?.hasSettings ?? false,
				hasCredentials: defaultProfile?.hasCredentials ?? false,
				...(defaultEmail ? { email: defaultEmail } : {}),
				...(defaultPlan ? { subscriptionPlan: defaultPlan } : {}),
			};

	const candidates = (data?.profiles ?? []).filter((profile) =>
		inherited ? true : profile.source !== "default",
	);

	const scored = candidates
		.map((profile) => {
			const searchEmail = normalizeNonEmptyMeta(profile.email);
			const searchPlan = formatClaudeSubscriptionPlan(profile.subscriptionPlan);
			return {
				profile,
				score: fuzzyScore(
					query,
					profile.label,
					profile.displayPath,
					profile.path,
					profile.source,
					...(searchEmail ? [searchEmail] : []),
					...(searchPlan ? [searchPlan] : []),
				),
			};
		})
		.filter((item): item is { profile: ClaudeCodeProfile; score: number } => item.score !== null)
		.sort(
			(a, b) =>
				b.score - a.score ||
				SOURCE_ORDER[a.profile.source] - SOURCE_ORDER[b.profile.source] ||
				a.profile.label.localeCompare(b.profile.label),
		)
		.map(({ profile }): ClaudeProfileMenuEntry => ({ kind: "profile", profile }));

	const defaultTerms = inherited
		? [
				defaultEntry.label,
				defaultEntry.displayPath,
				"default",
				"inherited",
				"env",
				"reset",
				...(defaultEmail ? [defaultEmail] : []),
				...(defaultPlan ? [defaultPlan] : []),
			]
		: [
				defaultEntry.label,
				defaultEntry.displayPath,
				data?.defaultDir ?? "~/.claude",
				"default",
				"reset",
				...(defaultEmail ? [defaultEmail] : []),
				...(defaultPlan ? [defaultPlan] : []),
			];

	const entries: ClaudeProfileMenuEntry[] = [];
	if (query.trim() === "" || fuzzyScore(query, ...defaultTerms) !== null) {
		entries.push(defaultEntry);
	}
	entries.push(...scored);

	const custom = claudeProfileCustomCandidate(query, data);
	if (custom !== null) {
		entries.push({ kind: "custom", value: custom });
	}
	return entries;
}

function entryKey(entry: ClaudeProfileMenuEntry): string {
	switch (entry.kind) {
		case "default": return "__default__";
		case "profile": return `profile:${entry.profile.path}`;
		case "custom": return `custom:${entry.value}`;
	}
}

function entryTestid(entry: ClaudeProfileMenuEntry): string {
	switch (entry.kind) {
		case "default": return "claude-profile-option-default";
		case "profile": return `claude-profile-option-${entry.profile.label.replace(/[^a-z0-9-]/gi, "_")}`;
		case "custom": return "claude-profile-option-custom";
	}
}

function profileStatusBadges(profile: Pick<ClaudeCodeProfile, "exists" | "source" | "hasSettings" | "hasCredentials">): string {
	if (!profile.exists) return "missing";
	const parts: string[] = [];
	if (profile.source === "env") parts.push("env");
	if (profile.hasSettings) parts.push("settings");
	if (profile.hasCredentials) parts.push("credentials");
	return parts.join(" · ");
}

/** Searchable Claude Code profile dropdown body — mirrors FontMenuList's
 *  single-input fuzzy-search + arrow-walk + Enter + custom-entry contract. */
export function ClaudeProfileMenuList({
	data,
	configuredDir,
	loading,
	disabled = false,
	error,
	onPick,
}: {
	data: ClaudeCodeProfilesResponse | null;
	configuredDir: string | undefined;
	loading: boolean;
	disabled?: boolean;
	error?: string | null;
	/** Receives the selected configDir path, or null to reset to default/inherited. */
	onPick: (configDir: string | null) => void;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);

	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const entries = claudeProfileMenuEntries(query, data);
	const matchedConfigured = findMatchingClaudeProfile(configuredDir, data);
	const trimmedQuery = query.trim();

	const pickEntry = (entry: ClaudeProfileMenuEntry) => {
		if (disabled) return;
		if (entry.kind === "default") onPick(null);
		else if (entry.kind === "profile") onPick(entry.profile.path);
		else onPick(entry.value);
	};

	const isEntrySelected = (entry: ClaudeProfileMenuEntry): boolean => {
		if (entry.kind === "default") return !configuredDir;
		if (entry.kind === "profile") {
			if (!configuredDir) return false;
			if (matchedConfigured) return matchedConfigured.path === entry.profile.path;
			const target = normalizeMatchPath(configuredDir);
			return (
				normalizeMatchPath(entry.profile.path) === target ||
				normalizeMatchPath(entry.profile.displayPath) === target
			);
		}
		return false;
	};

	return (
		<>
			{error && <div role="alert" className="mb-1.5 text-error">{error}</div>}
			<input
				type="text"
				ref={searchRef}
				data-testid="claude-profile-search"
				aria-label="Search Claude Code profiles or enter path"
				value={query}
				disabled={disabled}
				onChange={(event) => {
					setQuery(event.target.value);
					setMenuIdx(null);
				}}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						event.stopPropagation();
						if (disabled || entries.length === 0) return;
						setMenuIdx((i) =>
							event.key === "ArrowDown"
								? Math.min((i ?? -1) + 1, entries.length - 1)
								: Math.max((i ?? entries.length) - 1, 0),
						);
					} else if (event.key === "Enter") {
						const chosen = entries[menuIdx ?? 0];
						event.preventDefault();
						event.stopPropagation();
						if (!disabled && chosen !== undefined) {
							pickEntry(chosen);
						}
					}
				}}
				placeholder="Search profiles or enter ~/path…"
				className="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
			/>
			{loading && !data && (
				<div className="px-2 py-3 text-center text-muted-foreground">Scanning profiles…</div>
			)}
			{(!loading || data) && entries.length === 0 && (
				<div data-testid="claude-profile-empty" className="px-2 py-3 text-center text-muted-foreground">
					{trimmedQuery.length > 0 && !isValidClaudeConfigDir(trimmedQuery)
						? "No matching profiles. Enter an absolute path or ~/… to use a custom directory."
						: "No profiles match."}
				</div>
			)}
			<ul ref={listRef} data-testid="claude-profile-list" className="flex max-h-72 flex-col overflow-y-auto px-1">
				{entries.map((entry, i) => {
					const selected = isEntrySelected(entry);
					const accountMeta = entry.kind === "default"
						? formatClaudeProfileAccountMeta(entry)
						: entry.kind === "profile"
							? formatClaudeProfileAccountMeta(entry.profile)
							: null;
					return (
						<li key={entryKey(entry)}>
							<button
								type="button"
								data-testid={entryTestid(entry)}
								data-idx={i}
								disabled={disabled}
								onClick={() => pickEntry(entry)}
								className={`flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
									i === menuIdx ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
								}${selected && i !== menuIdx ? " bg-muted/60" : ""}`}
							>
								{entry.kind === "default" && (
									<>
										<span className="flex items-center justify-between gap-2">
											<span className="truncate text-card-foreground">{entry.label}</span>
											<span className="shrink-0 text-muted-foreground">
												{entry.inherited ? "env" : "default"}
												{selected && <span aria-hidden className="ml-1">✓</span>}
											</span>
										</span>
										<span className="truncate font-mono text-[11px] text-muted-foreground">
											{entry.displayPath}
										</span>
										{accountMeta && (
											<span data-testid="claude-profile-account-meta" className="truncate text-[11px] text-muted-foreground">
												{accountMeta}
											</span>
										)}
									</>
								)}
								{entry.kind === "profile" && (
									<>
										<span className="flex items-center justify-between gap-2">
											<span className="truncate text-card-foreground">{entry.profile.label}</span>
											<span className={`shrink-0 ${entry.profile.exists ? "text-muted-foreground" : "text-error"}`}>
												{profileStatusBadges(entry.profile)}
												{selected && <span aria-hidden className="ml-1">✓</span>}
											</span>
										</span>
										<span className="truncate font-mono text-[11px] text-muted-foreground">
											{entry.profile.displayPath}
										</span>
										{accountMeta && (
											<span data-testid="claude-profile-account-meta" className="truncate text-[11px] text-muted-foreground">
												{accountMeta}
											</span>
										)}
									</>
								)}
								{entry.kind === "custom" && (
									<>
										<span className="flex items-center justify-between gap-2">
											<span className="truncate text-card-foreground">Use “{entry.value}”</span>
											<span className="shrink-0 text-muted-foreground">custom</span>
										</span>
										<span className="truncate font-mono text-[11px] text-muted-foreground">
											Custom CLAUDE_CONFIG_DIR
										</span>
									</>
								)}
							</button>
						</li>
					);
				})}
			</ul>
			<div className="mt-1 border-t px-2 pt-1.5 text-[11px] text-muted-foreground">
				Type an absolute path or <span className="font-mono">~/…</span> to use a custom directory.
			</div>
		</>
	);
}
