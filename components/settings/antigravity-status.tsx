"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ANTIGRAVITY_MINIMUM_CLI_VERSION,
	type AntigravityInstallProgress,
	type AntigravityRuntimeSource,
	type AntigravityStatus,
	type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

export function antigravitySourceLabel(source: AntigravityRuntimeSource): string {
	switch (source) {
		case "managed":
			return "Managed";
		case "cli":
			return "System CLI";
		case "custom":
			return "Custom path";
		case "t3-external":
			return "T3 Code (read-only)";
		case "env":
			return "Env override";
	}
}

export function antigravityInstallPhaseLabel(install: AntigravityInstallProgress): string {
	switch (install.phase) {
		case "downloading": {
			if (
				typeof install.downloadedBytes === "number" &&
				typeof install.totalBytes === "number" &&
				install.totalBytes > 0
			) {
				const pct = Math.min(100, Math.round((install.downloadedBytes / install.totalBytes) * 100));
				const mbDone = (install.downloadedBytes / (1024 * 1024)).toFixed(1);
				const mbTotal = (install.totalBytes / (1024 * 1024)).toFixed(1);
				return `Downloading… ${mbDone} MB / ${mbTotal} MB (${pct}%)`;
			}
			return "Downloading…";
		}
		case "verifying":
			return "Verifying checksum and files…";
		case "extracting":
			return "Extracting runtime…";
		case "validating":
			return "Validating ACP runtime…";
		case "installed":
			return "Installed";
		case "error":
			return install.error || "Installation failed";
		default:
			return "";
	}
}

export function antigravityStatusLabel(status: AntigravityStatus | null): string {
	if (!status) return "Status could not be checked";
	if (status.busy) return antigravityInstallPhaseLabel(status.install) || "Installing…";
	switch (status.state) {
		case "ready":
			return status.version ? `Ready · v${status.version}` : "Ready";
		case "update-required":
			return status.version
				? `Version ${status.version} · update required (v${status.minimumCliVersion}+)`
				: `Update required (v${status.minimumCliVersion}+)`;
		case "error":
			return "Runtime unavailable";
		case "not-installed":
		default:
			return "Not installed";
	}
}

function isValidAntigravityStatus(value: unknown): value is AntigravityStatus {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.enabled !== "boolean") return false;
	if (!["not-installed", "ready", "update-required", "error"].includes(String(v.state))) return false;
	if (
		v.source !== null &&
		!["env", "custom", "managed", "cli", "t3-external"].includes(String(v.source))
	) {
		return false;
	}
	if (v.version !== null && typeof v.version !== "string") return false;
	if (typeof v.managedInstalled !== "boolean" || typeof v.busy !== "boolean") return false;
	if (!v.install || typeof v.install !== "object") return false;
	const install = v.install as Record<string, unknown>;
	if (
		!["idle", "downloading", "verifying", "extracting", "validating", "installed", "error"].includes(
			String(install.phase),
		)
	) {
		return false;
	}
	if (!v.auth || typeof v.auth !== "object" || Array.isArray(v.auth)) return false;
	const auth = v.auth as Record<string, unknown>;
	if (typeof auth.signedIn !== "boolean") return false;
	if (
		!["idle", "starting", "waiting", "verifying", "succeeded", "failed", "cancelled"].includes(
			String(auth.phase),
		)
	) {
		return false;
	}
	return true;
}

export function AntigravityInstallationStatus() {
	const [enabled, setEnabled] = useState(false);
	const [binaryPath, setBinaryPath] = useState("");
	const [draftPath, setDraftPath] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<AntigravityStatus | null>(null);
	const [checking, setChecking] = useState(false);
	const [mutating, setMutating] = useState(false);
	const [authMutating, setAuthMutating] = useState(false);
	const [modelsRefreshing, setModelsRefreshing] = useState(false);
	const [callbackDraft, setCallbackDraft] = useState("");
	const [copied, setCopied] = useState(false);

	const request = useRef<AbortController | null>(null);
	const settingsRead = useRef<AbortController | null>(null);
	const settingsWrite = useRef<AbortController | null>(null);
	const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const openedAttemptRef = useRef<string | null>(null);
	const prevSignedInRef = useRef<boolean | null>(null);

	const applyStatus = useCallback((nextStatus: AntigravityStatus) => {
		setStatus(nextStatus);
		const prevSignedIn = prevSignedInRef.current;
		prevSignedInRef.current = nextStatus.auth.signedIn;
		if (prevSignedIn !== null && prevSignedIn !== nextStatus.auth.signedIn) {
			notifySettingsSaved("antigravity");
		}
	}, []);

	const clearPoll = useCallback(() => {
		if (pollTimer.current !== null) {
			clearTimeout(pollTimer.current);
			pollTimer.current = null;
		}
	}, []);

	const openAuthBrowser = useCallback((attemptId: string | null, authUrl: string | null) => {
		if (!attemptId || !authUrl) return;
		if (openedAttemptRef.current === attemptId) return;
		openedAttemptRef.current = attemptId;
		try {
			if (typeof window !== "undefined" && typeof window.open === "function") {
				window.open(authUrl, "_blank", "noopener,noreferrer");
			}
		} catch {
			// Manual Open link / Copy link remains available in UI
		}
	}, []);

	const read = useCallback(async (markUnloaded = false) => {
		settingsRead.current?.abort();
		const controller = new AbortController();
		settingsRead.current = controller;
		if (markUnloaded) setLoaded(false);
		try {
			const response = await fetch("/api/settings", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("settings unavailable");
			const body = (await response.json()) as { settings: UserSettings | null };
			if (!controller.signal.aborted) {
				const nextEnabled = body.settings?.antigravity?.enabled === true;
				const nextBinaryPath = body.settings?.antigravity?.binaryPath ?? "";
				setEnabled(nextEnabled);
				setBinaryPath(nextBinaryPath);
				setDraftPath(nextBinaryPath);
				setLoaded(true);
				setError(null);
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not load Antigravity settings.");
		}
	}, []);

	useEffect(() => {
		void read(true);
		return () => {
			settingsRead.current?.abort();
			settingsWrite.current?.abort();
			clearPoll();
			if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
		};
	}, [read, clearPoll]);

	useSettingsSaved((section) => {
		if (section === "antigravity") void read(false);
	});

	const refresh = useCallback(
		async (silent = false) => {
			if (!enabled) return;
			request.current?.abort();
			const controller = new AbortController();
			request.current = controller;
			if (!silent) setChecking(true);
			try {
				const response = await fetch("/api/antigravity", {
					cache: "no-store",
					signal: controller.signal,
					headers: { "x-learnharness-antigravity": "1" },
				});
				if (!response.ok) throw new Error("status unavailable");
				const value: unknown = await response.json();
				if (!isValidAntigravityStatus(value)) throw new Error("invalid status");
				if (!controller.signal.aborted) {
					applyStatus(value);
					setError(null);
				}
			} catch {
				if (!controller.signal.aborted) setStatus(null);
			} finally {
				if (!controller.signal.aborted && !silent) setChecking(false);
			}
		},
		[enabled, applyStatus],
	);

	useEffect(() => {
		if (enabled) {
			void refresh();
		} else {
			clearPoll();
			request.current?.abort();
			setStatus(null);
			setChecking(false);
			prevSignedInRef.current = null;
		}
		return () => {
			clearPoll();
			request.current?.abort();
		};
	}, [enabled, refresh, clearPoll]);

	const authInFlight =
		status?.auth.phase === "starting" ||
		status?.auth.phase === "waiting" ||
		status?.auth.phase === "verifying";

	useEffect(() => {
		if (status?.auth.phase === "waiting" && status.auth.authUrl) {
			openAuthBrowser(status.auth.attemptId, status.auth.authUrl);
		}
		if (!authInFlight) {
			setCallbackDraft("");
			setCopied(false);
		}
	}, [status?.auth.phase, status?.auth.attemptId, status?.auth.authUrl, authInFlight, openAuthBrowser]);

	useEffect(() => {
		clearPoll();
		if (!enabled || (!status?.busy && !authInFlight)) return;
		pollTimer.current = setTimeout(() => {
			void refresh(true);
		}, 300);
		return clearPoll;
	}, [enabled, status, authInFlight, refresh, clearPoll]);

	const saveSettings = async (nextEnabled: boolean, nextBinaryPath: string): Promise<boolean> => {
		const controller = new AbortController();
		settingsWrite.current = controller;
		settingsRead.current?.abort();
		setSaving(true);
		setError(null);
		const trimmedPath = nextBinaryPath.trim();
		const payload = trimmedPath
			? { enabled: nextEnabled, binaryPath: trimmedPath }
			: { enabled: nextEnabled };
		try {
			const response = await fetch("/api/settings/antigravity", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			if (!response.ok) throw new Error("settings write failed");
			const body = (await response.json()) as { settings: UserSettings };
			if (typeof body.settings?.antigravity?.enabled !== "boolean") {
				throw new Error("invalid settings response");
			}
			if (!controller.signal.aborted) {
				const savedPath = body.settings.antigravity.binaryPath ?? "";
				setEnabled(body.settings.antigravity.enabled);
				setBinaryPath(savedPath);
				setDraftPath(savedPath);
				notifySettingsSaved("antigravity");
			}
			return true;
		} catch {
			if (!controller.signal.aborted) setError("Could not save Antigravity settings.");
			return false;
		} finally {
			if (!controller.signal.aborted) setSaving(false);
		}
	};

	const startInstall = async () => {
		if (!enabled || mutating || status?.busy) return;
		setMutating(true);
		setError(null);
		try {
			const response = await fetch("/api/antigravity/install", {
				method: "POST",
				headers: { "x-learnharness-antigravity": "1" },
			});
			if (!response.ok) {
				const errBody = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(errBody.error ?? "Install failed.");
			}
			const value: unknown = await response.json();
			if (isValidAntigravityStatus(value)) applyStatus(value);
			else await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not start Antigravity installation.");
		} finally {
			setMutating(false);
		}
	};

	const removeManaged = async () => {
		if (!enabled || mutating || status?.busy || status?.source !== "managed") return;
		setMutating(true);
		setError(null);
		try {
			const response = await fetch("/api/antigravity/install", {
				method: "DELETE",
				headers: { "x-learnharness-antigravity": "1" },
			});
			if (!response.ok) {
				const errBody = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(errBody.error ?? "Remove failed.");
			}
			const value: unknown = await response.json();
			if (isValidAntigravityStatus(value)) applyStatus(value);
			else await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not remove managed Antigravity runtime.");
		} finally {
			setMutating(false);
		}
	};

	const sendAuthAction = async (payload: Record<string, unknown>, fallbackError: string) => {
		if (!enabled || authMutating) return;
		setAuthMutating(true);
		setError(null);
		try {
			const response = await fetch("/api/antigravity/auth", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-learnharness-antigravity": "1",
				},
				body: JSON.stringify(payload),
			});
			if (!response.ok) {
				const errBody = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(errBody.error ?? fallbackError);
			}
			const value: unknown = await response.json();
			if (isValidAntigravityStatus(value)) {
				applyStatus(value);
				if (value.auth.phase === "waiting" && value.auth.authUrl) {
					openAuthBrowser(value.auth.attemptId, value.auth.authUrl);
				}
			} else {
				await refresh();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : fallbackError);
		} finally {
			setAuthMutating(false);
		}
	};

	const refreshModels = async () => {
		if (!enabled || modelsRefreshing || authMutating) return;
		setModelsRefreshing(true);
		setError(null);
		try {
			const response = await fetch("/api/antigravity/models", {
				method: "POST",
				headers: { "x-learnharness-antigravity": "1" },
			});
			if (!response.ok) {
				const errBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
				if (isValidAntigravityStatus(errBody)) {
					applyStatus(errBody);
				}
				throw new Error(
					typeof errBody.error === "string" ? errBody.error : "Could not refresh Antigravity models.",
				);
			}
			const value: unknown = await response.json();
			if (isValidAntigravityStatus(value)) {
				applyStatus(value);
			} else {
				await refresh();
			}
			notifySettingsSaved("antigravity");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not refresh Antigravity models.");
		} finally {
			setModelsRefreshing(false);
		}
	};

	const copyAuthLink = async (authUrl: string) => {
		try {
			await navigator.clipboard?.writeText(authUrl);
			setCopied(true);
			if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
			copiedTimer.current = setTimeout(() => setCopied(false), 2000);
		} catch {
			setError("Could not copy sign-in link to clipboard.");
		}
	};

	const busy = checking || mutating || status?.busy === true;
	const showInstallProgress =
		status !== null &&
		["downloading", "verifying", "extracting", "validating"].includes(status.install.phase);
	const downloadPercent =
		status?.install.phase === "downloading" &&
		typeof status.install.downloadedBytes === "number" &&
		typeof status.install.totalBytes === "number" &&
		status.install.totalBytes > 0
			? Math.min(100, Math.round((status.install.downloadedBytes / status.install.totalBytes) * 100))
			: null;
	const isExternalFallback = status?.source === "t3-external" || status?.source === "cli";
	const showAuthControls =
		status !== null &&
		(status.state === "ready" || status.auth.signedIn || authInFlight);

	return (
		<div className="space-y-2" data-testid="antigravity-installation">
			<div className="flex items-center gap-3">
				<span className="font-prose text-(length:--lh-prose-size) text-foreground">Antigravity</span>
				<Toggle
					label="Antigravity"
					checked={enabled}
					disabled={!loaded || saving}
					onChange={(next) => void saveSettings(next, binaryPath)}
				/>
			</div>
			{error && (
				<p role="alert" className="text-xs text-error">
					{error}
				</p>
			)}
			{enabled && (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<span role="status" className="text-xs text-muted-foreground">
							{checking && !status?.busy ? "Checking…" : antigravityStatusLabel(status)}
						</span>
						{status?.source && (
							<span
								data-testid="antigravity-source-badge"
								className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
							>
								{antigravitySourceLabel(status.source)}
							</span>
						)}
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="cursor-pointer disabled:cursor-not-allowed"
							disabled={busy}
							onClick={() => void refresh()}
							data-testid="antigravity-check-again"
						>
							Check again
						</Button>
						{status !== null && status.source === null && !status.busy && (
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="cursor-pointer disabled:cursor-not-allowed"
								disabled={busy || saving}
								onClick={() => void startInstall()}
								data-testid="antigravity-install"
							>
								Install runtime
							</Button>
						)}
						{isExternalFallback && !status.managedInstalled && !status.busy && (
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="cursor-pointer disabled:cursor-not-allowed"
								disabled={busy || saving}
								onClick={() => void startInstall()}
								data-testid="antigravity-install-managed"
							>
								Install managed copy
							</Button>
						)}
						{status !== null && status.source !== null && (
							<Button
								type="button"
								size="xs"
								variant="ghost"
								className="cursor-pointer text-muted-foreground hover:text-error disabled:cursor-not-allowed"
								disabled={busy || saving || status.source !== "managed"}
								title={
									status.source === "managed"
										? "Remove LearnHarness-managed runtime"
										: "Only LearnHarness-managed installs can be removed"
								}
								onClick={() => void removeManaged()}
								data-testid="antigravity-remove"
							>
								Remove
							</Button>
						)}
					</div>

					{showAuthControls && status && (
						<div className="space-y-2 rounded-sm border border-border/60 bg-muted/20 p-2.5" data-testid="antigravity-auth-panel">
							{status.auth.signedIn ? (
								<div className="space-y-1.5">
									<div className="flex flex-wrap items-center gap-2">
										<span data-testid="antigravity-auth-status" className="text-xs text-foreground">
											Signed in with Google
										</span>
										<Button
											type="button"
											size="xs"
											variant="outline"
											className="cursor-pointer disabled:cursor-not-allowed"
											disabled={authMutating || modelsRefreshing || busy}
											onClick={() => void refreshModels()}
											data-testid="antigravity-refresh-models"
										>
											{modelsRefreshing || status.models?.discovering
												? "Refreshing models…"
												: "Refresh models"}
										</Button>
										<Button
											type="button"
											size="xs"
											variant="ghost"
											className="cursor-pointer text-muted-foreground hover:text-error disabled:cursor-not-allowed"
											disabled={authMutating || modelsRefreshing || busy}
											onClick={() => void sendAuthAction({ action: "logout" }, "Could not sign out of Antigravity.")}
											data-testid="antigravity-sign-out"
										>
											Sign out
										</Button>
									</div>
									{status.models && (
										<p data-testid="antigravity-models-summary" className="text-xs text-muted-foreground">
											{status.models.count > 0
												? `${status.models.count} ${status.models.count === 1 ? "model" : "models"} available`
												: "No models discovered yet"}
										</p>
									)}
									{status.models?.error && (
										<p role="alert" data-testid="antigravity-models-error" className="text-xs text-error">
											{status.models.error}
										</p>
									)}
								</div>
							) : authInFlight ? (
								<div className="space-y-2">
									<div className="flex flex-wrap items-center gap-2">
										<span data-testid="antigravity-auth-status" className="text-xs text-muted-foreground">
											{status.auth.phase === "starting"
												? "Starting Google sign-in…"
												: status.auth.phase === "verifying"
													? "Completing sign-in…"
													: "Waiting for Google sign-in…"}
										</span>
										{status.auth.phase === "waiting" && status.auth.authUrl && (
											<>
												<a
													href={status.auth.authUrl}
													target="_blank"
													rel="noreferrer"
													data-testid="antigravity-auth-open"
													className="text-xs text-foreground underline underline-offset-2"
												>
													Open link ↗
												</a>
												<Button
													type="button"
													size="xs"
													variant="outline"
													className="cursor-pointer disabled:cursor-not-allowed"
													onClick={() => void copyAuthLink(status.auth.authUrl!)}
													data-testid="antigravity-auth-copy"
												>
													{copied ? "Copied" : "Copy link"}
												</Button>
											</>
										)}
										<Button
											type="button"
											size="xs"
											variant="ghost"
											className="cursor-pointer text-muted-foreground disabled:cursor-not-allowed"
											disabled={authMutating}
											onClick={() =>
												void sendAuthAction(
													{ action: "cancel", attemptId: status.auth.attemptId ?? undefined },
													"Could not cancel Google sign-in.",
												)
											}
											data-testid="antigravity-auth-cancel"
										>
											Cancel
										</Button>
									</div>
									{status.auth.phase === "waiting" && (
										<form
											className="flex flex-wrap items-center gap-2"
											onSubmit={(e) => {
												e.preventDefault();
												if (!callbackDraft.trim() || authMutating) return;
												void sendAuthAction(
													{
														action: "callback",
														callbackUrl: callbackDraft,
														attemptId: status.auth.attemptId ?? undefined,
													},
													"Invalid redirect URL.",
												);
											}}
										>
											<input
												type="text"
												value={callbackDraft}
												onChange={(e) => setCallbackDraft(e.target.value)}
												placeholder="Paste redirect URL (http://127.0.0.1:.../)"
												aria-label="Paste redirect URL"
												data-testid="antigravity-auth-callback-input"
												disabled={authMutating}
												className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
											/>
											<Button
												type="submit"
												size="xs"
												variant="outline"
												className="cursor-pointer disabled:cursor-not-allowed"
												disabled={authMutating || !callbackDraft.trim()}
												data-testid="antigravity-auth-callback-submit"
											>
												Submit redirect
											</Button>
										</form>
									)}
								</div>
							) : (
								<div className="space-y-1.5">
									<div className="flex flex-wrap items-center gap-2">
										<Button
											type="button"
											size="xs"
											variant="outline"
											className="cursor-pointer disabled:cursor-not-allowed"
											disabled={authMutating || busy}
											onClick={() =>
												void sendAuthAction({ action: "start" }, "Could not start Google sign-in.")
											}
											data-testid="antigravity-sign-in"
										>
											Sign in with Google
										</Button>
										<span data-testid="antigravity-auth-status" className="text-xs text-muted-foreground">
											Not signed in
										</span>
									</div>
									{status.auth.phase === "failed" && status.auth.error && (
										<p role="alert" data-testid="antigravity-auth-error" className="text-xs text-error">
											{status.auth.error}
										</p>
									)}
								</div>
							)}
						</div>
					)}

					{showInstallProgress && status && (
						<div className="space-y-1" data-testid="antigravity-install-progress">
							<p className="text-xs text-muted-foreground">
								{antigravityInstallPhaseLabel(status.install)}
							</p>
							{downloadPercent !== null && (
								<div
									role="progressbar"
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={downloadPercent}
									className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted"
								>
									<div
										className="h-full bg-foreground transition-all"
										style={{ width: `${downloadPercent}%` }}
									/>
								</div>
							)}
						</div>
					)}

					{!error && status?.error && (
						<p role="alert" data-testid="antigravity-status-error" className="text-xs text-error">
							{status.error}
						</p>
					)}

					<div className="flex flex-wrap items-center gap-2">
						<input
							type="text"
							value={draftPath}
							onChange={(e) => setDraftPath(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !saving) {
									void saveSettings(true, draftPath).then((ok) => {
										if (ok) void refresh();
									});
								}
							}}
							placeholder="Optional custom binary path (e.g. /usr/local/bin/agy)"
							aria-label="Antigravity custom binary path"
							data-testid="antigravity-binary-path"
							disabled={saving || status?.busy === true}
							className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
						/>
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="cursor-pointer disabled:cursor-not-allowed"
							disabled={saving || status?.busy === true || draftPath.trim() === binaryPath}
							onClick={() =>
								void saveSettings(true, draftPath).then((ok) => {
									if (ok) void refresh();
								})
							}
							data-testid="antigravity-binary-save"
						>
							Save path
						</Button>
						{(binaryPath || draftPath) && (
							<Button
								type="button"
								size="xs"
								variant="ghost"
								className="cursor-pointer disabled:cursor-not-allowed"
								disabled={saving || status?.busy === true}
								onClick={() => {
									setDraftPath("");
									if (binaryPath) {
										void saveSettings(true, "").then((ok) => {
											if (ok) void refresh();
										});
									}
								}}
								data-testid="antigravity-binary-clear"
							>
								Clear
							</Button>
						)}
					</div>

					<p className="text-xs leading-relaxed text-muted-foreground">
						Auto-detects <code className="font-mono">LH_ANTIGRAVITY_BIN</code>, custom binary path,
						LearnHarness-managed runtime, <code className="font-mono">agy</code>/
						<code className="font-mono">antigravity</code> CLI (v{ANTIGRAVITY_MINIMUM_CLI_VERSION}+), or
						read-only T3 Code runtime.
					</p>
					<p className="text-xs leading-relaxed text-muted-foreground">
						Antigravity controls billing and quota externally. Verify AI claims independently—they may be
						inaccurate, incomplete, misleading, or outdated.
					</p>
				</>
			)}
		</div>
	);
}
