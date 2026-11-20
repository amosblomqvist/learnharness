"use client";

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { FolderOpenIcon, HardDriveIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "./controls.tsx";

export type DataMigrationMode = "copy" | "switch";

export interface DataDirectoryStatus {
	currentDir: string;
	defaultDir: string;
	isCustom: boolean;
	configuredDir: string | null;
	unavailableConfiguredDir: string | null;
}

export const DATA_DIR_HINT =
	"Chats, knowledge graph, settings, themes, prompts, and plugins are stored here. API keys and subscription logins stay on this machine.";

export function DataDirectoryConfirmBody({
	currentDir,
	targetPath,
	onTargetPathChange,
	isReset,
	canBrowse,
	onBrowse,
	copyMode,
	onCopyModeChange,
	deleteOld,
	onDeleteOldChange,
	busy,
	error,
	onCancel,
	onConfirm,
	renderFrame,
}: {
	currentDir: string;
	targetPath: string;
	onTargetPathChange: (next: string) => void;
	isReset: boolean;
	canBrowse: boolean;
	onBrowse?: () => void;
	copyMode: DataMigrationMode;
	onCopyModeChange: (mode: DataMigrationMode) => void;
	deleteOld: boolean;
	onDeleteOldChange: (deleteOld: boolean) => void;
	busy: boolean;
	error: string;
	onCancel: () => void;
	onConfirm: () => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}) {
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={isReset ? "Reset data directory" : "Change data directory"}
			data-testid="data-dir-confirm-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[34rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-foreground">
				{isReset ? "Reset to default data folder?" : "Change data folder"}
			</h2>
			<p className="mt-1 text-xs text-muted-foreground">
				All app data will use the selected folder. API keys and subscription logins remain on this machine.
			</p>

			<div className="mt-3 flex flex-col gap-2 text-xs">
				<div>
					<span className="block text-[11px] uppercase tracking-wider text-muted-foreground">Current folder</span>
					<p className="mt-0.5 break-all rounded-sm border border-border/60 bg-background/60 px-2.5 py-1.5 font-mono text-xs text-muted-foreground" data-testid="data-dir-dialog-current">
						{currentDir}
					</p>
				</div>

				<div>
					<label htmlFor="data-dir-target-input" className="block text-[11px] uppercase tracking-wider text-muted-foreground">
						New folder
					</label>
					<div className="mt-0.5 flex items-center gap-2">
						<input
							id="data-dir-target-input"
							type="text"
							value={targetPath}
							readOnly={isReset}
							disabled={busy}
							onChange={(e) => onTargetPathChange(e.target.value)}
							placeholder="/Volumes/ExternalDrive/LearnHarnessData"
							aria-label="New data directory path"
							data-testid="data-dir-target-input"
							className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 read-only:opacity-80"
						/>
						{!isReset && canBrowse && onBrowse && (
							<Button
								type="button"
								size="xs"
								variant="outline"
								disabled={busy}
								data-testid="data-dir-browse"
								onClick={onBrowse}
								className="h-8 shrink-0 cursor-pointer"
							>
								<FolderOpenIcon className="size-3.5" aria-hidden="true" />
								Browse…
							</Button>
						)}
					</div>
				</div>
			</div>

			<div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Data migration options">
				<div className="rounded-lg border border-border/60 px-3.5 py-3">
					<label className="flex cursor-pointer items-start gap-2.5">
						<input
							type="radio"
							name="data-dir-copy-mode"
							value="copy"
							checked={copyMode === "copy"}
							disabled={busy}
							data-testid="data-dir-mode-copy"
							onChange={() => onCopyModeChange("copy")}
							className="mt-0.5 size-4 shrink-0 accent-primary"
						/>
						<span className="min-w-0">
							<span className="block text-xs font-medium text-foreground">
								Copy existing data into the new folder
							</span>
							<span className="mt-0.5 block text-xs text-muted-foreground">
								All your chats, knowledge graph, settings, themes, prompts, and plugins will be copied to the new folder before switching.
							</span>
						</span>
					</label>

					{copyMode === "copy" && (
						<div
							className="mt-2.5 ml-6 flex flex-col gap-1.5 border-l border-border/70 pl-3"
							role="radiogroup"
							aria-label="Old directory cleanup"
							data-testid="data-dir-old-cleanup-group"
						>
							<label className="flex cursor-pointer items-start gap-2">
								<input
									type="radio"
									name="data-dir-old-data"
									value="keep"
									checked={!deleteOld}
									disabled={busy}
									data-testid="data-dir-keep-old"
									onChange={() => onDeleteOldChange(false)}
									className="mt-0.5 size-3.5 shrink-0 accent-primary"
								/>
								<span className="min-w-0 text-xs">
									<span className="font-medium text-foreground">Keep old data in the previous folder (Default)</span>
									<span className="block text-[11px] text-muted-foreground">
										Leaves your existing data in the previous folder as a backup.
									</span>
								</span>
							</label>
							<label className="flex cursor-pointer items-start gap-2">
								<input
									type="radio"
									name="data-dir-old-data"
									value="delete"
									checked={deleteOld}
									disabled={busy}
									data-testid="data-dir-delete-old"
									onChange={() => onDeleteOldChange(true)}
									className="mt-0.5 size-3.5 shrink-0 accent-primary"
								/>
								<span className="min-w-0 text-xs">
									<span className="font-medium text-foreground">Delete old data after copying</span>
									<span className="block text-[11px] text-muted-foreground">
										Removes LearnHarness data from the previous folder once everything is copied.
									</span>
								</span>
							</label>
						</div>
					)}
				</div>

				<label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-3.5 py-3">
					<input
						type="radio"
						name="data-dir-copy-mode"
						value="switch"
						checked={copyMode === "switch"}
						disabled={busy}
						data-testid="data-dir-mode-switch"
						onChange={() => onCopyModeChange("switch")}
						className="mt-0.5 size-4 shrink-0 accent-primary"
					/>
					<span className="min-w-0">
						<span className="block text-xs font-medium text-foreground">
							Switch to the folder as-is (do not copy)
						</span>
						<span className="mt-0.5 block text-xs text-muted-foreground">
							Uses whatever data is already in the selected folder (or starts empty) and keeps the old folder untouched.
						</span>
					</span>
				</label>
			</div>

			{error && (
				<p role="alert" data-testid="data-dir-confirm-error" className="mt-3 text-xs text-error">
					{error}
				</p>
			)}

			<div className="mt-4 flex justify-end gap-2">
				<Button
					type="button"
					size="xs"
					variant="ghost"
					disabled={busy}
					data-testid="data-dir-cancel"
					onClick={onCancel}
					className="cursor-pointer"
				>
					Cancel
				</Button>
				<Button
					type="button"
					size="xs"
					disabled={busy || !targetPath.trim()}
					data-testid="data-dir-confirm"
					onClick={onConfirm}
					className="cursor-pointer"
				>
					{busy
						? copyMode === "copy"
							? "Copying & switching…"
							: "Switching…"
						: copyMode === "copy"
							? deleteOld
								? "Copy, switch & delete old"
								: "Copy & switch"
							: "Switch folder"}
				</Button>
			</div>
		</div>
	);

	return renderFrame ? renderFrame(frame) : frame;
}

export function DataDirectorySettings({
	onChanged,
}: {
	onChanged?: () => void;
}) {
	const [status, setStatus] = useState<DataDirectoryStatus | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [isReset, setIsReset] = useState(false);
	const [targetPath, setTargetPath] = useState("");
	const [copyMode, setCopyMode] = useState<DataMigrationMode>("copy");
	const [deleteOld, setDeleteOld] = useState(false);
	const [busy, setBusy] = useState(false);
	const [dialogError, setDialogError] = useState("");

	const canBrowse = typeof window !== "undefined" && typeof window.lh?.chooseAttachmentFolder === "function";

	const loadStatus = useCallback(async () => {
		try {
			const res = await fetch("/api/settings/data-dir", { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as DataDirectoryStatus;
			setStatus(data);
			setLoadError(null);
		} catch {
			setLoadError("Could not read current data directory.");
		}
	}, []);

	useEffect(() => {
		void loadStatus();
	}, [loadStatus]);

	const openChangeDialog = async () => {
		setIsReset(false);
		setCopyMode("copy");
		setDeleteOld(false);
		setDialogError("");
		const pick = typeof window !== "undefined" ? window.lh?.chooseAttachmentFolder : undefined;
		if (pick) {
			try {
				const chosen = await pick();
				if (chosen === null) return;
				setTargetPath(chosen);
			} catch {
				setTargetPath(status?.currentDir ?? "");
			}
		} else {
			setTargetPath(status?.currentDir ?? "");
		}
		setDialogOpen(true);
	};

	const openResetDialog = () => {
		if (!status) return;
		setIsReset(true);
		setTargetPath(status.defaultDir);
		setCopyMode("copy");
		setDeleteOld(false);
		setDialogError("");
		setDialogOpen(true);
	};

	const browseInDialog = async () => {
		const pick = typeof window !== "undefined" ? window.lh?.chooseAttachmentFolder : undefined;
		if (!pick || busy) return;
		try {
			const chosen = await pick();
			if (chosen) {
				setTargetPath(chosen);
				setDialogError("");
			}
		} catch {
			/* ignore picker error */
		}
	};

	const runConfirm = async () => {
		if (busy) return;
		const trimmed = targetPath.trim();
		if (!trimmed) return;
		setBusy(true);
		setDialogError("");
		try {
			const payload = isReset
				? { action: "reset" as const, copyMode, deleteOld: copyMode === "copy" ? deleteOld : false }
				: { action: "change" as const, path: trimmed, copyMode, deleteOld: copyMode === "copy" ? deleteOld : false };
			const res = await fetch("/api/settings/data-dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const body = (await res.json().catch(() => ({}))) as Partial<DataDirectoryStatus> & { error?: unknown };
			if (!res.ok) {
				setDialogError(typeof body.error === "string" ? body.error : `Could not change data folder (${res.status})`);
				return;
			}
			if (typeof body.currentDir === "string" && typeof body.defaultDir === "string") {
				setStatus({
					currentDir: body.currentDir,
					defaultDir: body.defaultDir,
					isCustom: Boolean(body.isCustom),
					configuredDir: body.configuredDir ?? null,
					unavailableConfiguredDir: body.unavailableConfiguredDir ?? null,
				});
			} else {
				await loadStatus();
			}
			setDialogOpen(false);
			onChanged?.();
		} catch (err) {
			setDialogError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<SettingsRow
				label="Data directory"
				testid="row-data-directory"
				hint={
					<>
						{status ? (
							<span className="block break-all font-mono text-xs text-foreground" data-testid="data-dir-current">
								{status.currentDir}{" "}
								<span className="font-ui text-[11px] text-muted-foreground" data-testid="data-dir-badge">
									({status.isCustom ? "Custom" : "Default"})
								</span>
							</span>
						) : loadError ? (
							<span className="block text-error" role="alert" data-testid="data-dir-error">
								{loadError}
							</span>
						) : (
							<span className="block">Loading data folder…</span>
						)}
						<span className="mt-0.5 block">{DATA_DIR_HINT}</span>
					</>
				}
			>
				<div className="flex items-center gap-2">
					{status?.isCustom && (
						<Button
							type="button"
							size="xs"
							variant="ghost"
							className="cursor-pointer"
							data-testid="data-dir-reset"
							onClick={openResetDialog}
						>
							Reset to default
						</Button>
					)}
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="cursor-pointer"
						data-testid="data-dir-change"
						disabled={!status}
						onClick={() => void openChangeDialog()}
					>
						Change…
					</Button>
				</div>
			</SettingsRow>

			{dialogOpen && status && (
				<DataDirectoryConfirmBody
					currentDir={status.currentDir}
					targetPath={targetPath}
					onTargetPathChange={(next) => {
						setTargetPath(next);
						setDialogError("");
					}}
					isReset={isReset}
					canBrowse={canBrowse}
					onBrowse={() => void browseInDialog()}
					copyMode={copyMode}
					onCopyModeChange={setCopyMode}
					deleteOld={deleteOld}
					onDeleteOldChange={setDeleteOld}
					busy={busy}
					error={dialogError}
					onCancel={() => {
						if (!busy) setDialogOpen(false);
					}}
					onConfirm={() => void runConfirm()}
					renderFrame={(frame) => (
						<HostDialog
							open
							frame={frame}
							onClose={() => {
								if (busy) return "blocked";
								setDialogOpen(false);
								return "closed";
							}}
							backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
						>
							{frame.props.children}
						</HostDialog>
					)}
				/>
			)}
		</>
	);
}

/** Pure body for the unavailable-data-directory startup prompt (e.g. external drive unplugged). */
export function UnavailableDataDirectoryBody({
	unavailableDir,
	defaultDir,
	choosingFolder,
	folderDraft,
	onFolderDraftChange,
	canBrowse,
	onBrowse,
	busy,
	error,
	onRetry,
	onStartChooseFolder,
	onApplyChosenFolder,
	onUseDefault,
	renderFrame,
}: {
	unavailableDir: string;
	defaultDir: string;
	choosingFolder: boolean;
	folderDraft: string;
	onFolderDraftChange: (next: string) => void;
	canBrowse: boolean;
	onBrowse?: () => void;
	busy: boolean;
	error: string;
	onRetry: () => void;
	onStartChooseFolder: () => void;
	onApplyChosenFolder: () => void;
	onUseDefault: () => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}) {
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Data folder unavailable"
			data-testid="data-dir-unavailable-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[34rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-5 shadow-xl"
		>
			<div className="flex items-center gap-2 text-sm font-semibold text-foreground">
				<HardDriveIcon className="size-4 text-warning" aria-hidden="true" />
				<h2>Data folder unavailable</h2>
			</div>
			<p className="mt-2 text-xs text-muted-foreground">
				LearnHarness could not access your configured data folder. If it is on an external drive, reconnect the drive and click{" "}
				<span className="font-medium text-foreground">Retry</span>, select the folder where your data is stored, or switch back to the default local data folder.
			</p>
			<p
				className="mt-2 break-all rounded-sm border border-border/60 bg-background/60 px-2.5 py-1.5 font-mono text-xs text-foreground"
				data-testid="data-dir-unavailable-path"
			>
				{unavailableDir}
			</p>

			{choosingFolder && (
				<div className="mt-3 flex flex-col gap-1.5">
					<label htmlFor="data-dir-recovery-input" className="text-[11px] uppercase tracking-wider text-muted-foreground">
						Select data folder
					</label>
					<div className="flex items-center gap-2">
						<input
							id="data-dir-recovery-input"
							type="text"
							value={folderDraft}
							disabled={busy}
							onChange={(e) => onFolderDraftChange(e.target.value)}
							placeholder="/Volumes/ExternalDrive/LearnHarnessData"
							aria-label="Recovery data folder path"
							data-testid="data-dir-recovery-input"
							className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none"
						/>
						{canBrowse && onBrowse && (
							<Button
								type="button"
								size="xs"
								variant="outline"
								disabled={busy}
								data-testid="data-dir-recovery-browse"
								onClick={onBrowse}
								className="h-8 shrink-0 cursor-pointer"
							>
								Browse…
							</Button>
						)}
						<Button
							type="button"
							size="xs"
							disabled={busy || !folderDraft.trim()}
							data-testid="data-dir-recovery-apply"
							onClick={onApplyChosenFolder}
							className="h-8 shrink-0 cursor-pointer"
						>
							Use folder
						</Button>
					</div>
				</div>
			)}

			{error && (
				<p role="alert" data-testid="data-dir-unavailable-error" className="mt-3 text-xs text-error">
					{error}
				</p>
			)}

			<div className="mt-4 flex flex-wrap items-center justify-end gap-2">
				<Button
					type="button"
					size="xs"
					variant="ghost"
					disabled={busy}
					title={defaultDir}
					data-testid="data-dir-unavailable-default"
					onClick={onUseDefault}
					className="cursor-pointer"
				>
					Use default folder
				</Button>
				<Button
					type="button"
					size="xs"
					variant="outline"
					disabled={busy}
					data-testid="data-dir-unavailable-choose"
					onClick={onStartChooseFolder}
					className="cursor-pointer"
				>
					Choose folder…
				</Button>
				<Button
					type="button"
					size="xs"
					disabled={busy}
					data-testid="data-dir-unavailable-retry"
					onClick={onRetry}
					className="cursor-pointer"
				>
					{busy ? "Checking…" : "Retry"}
				</Button>
			</div>
		</div>
	);

	return renderFrame ? renderFrame(frame) : frame;
}

/** Startup guard for web/dev sessions when the configured custom data directory is unavailable. */
export function DataDirectoryStartupGuard() {
	const [status, setStatus] = useState<DataDirectoryStatus | null>(null);
	const [choosingFolder, setChoosingFolder] = useState(false);
	const [folderDraft, setFolderDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let alive = true;
		fetch("/api/settings/data-dir", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<DataDirectoryStatus>) : null))
			.then((data) => {
				if (alive && data?.unavailableConfiguredDir) {
					setStatus(data);
					setFolderDraft(data.unavailableConfiguredDir);
				}
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	if (!status?.unavailableConfiguredDir) return null;

	const canBrowse = typeof window !== "undefined" && typeof window.lh?.chooseAttachmentFolder === "function";

	const postAction = async (payload: Record<string, unknown>) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const res = await fetch("/api/settings/data-dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const body = (await res.json().catch(() => ({}))) as Partial<DataDirectoryStatus> & { error?: unknown };
			if (!res.ok) {
				setError(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
				return;
			}
			setStatus(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleChoose = async () => {
		const pick = typeof window !== "undefined" ? window.lh?.chooseAttachmentFolder : undefined;
		if (pick) {
			try {
				const chosen = await pick();
				if (chosen) {
					setFolderDraft(chosen);
					await postAction({ action: "change", path: chosen, copyMode: "switch" });
				}
				return;
			} catch {
				/* fall through to text input */
			}
		}
		setChoosingFolder(true);
	};

	return (
		<UnavailableDataDirectoryBody
			unavailableDir={status.unavailableConfiguredDir}
			defaultDir={status.defaultDir}
			choosingFolder={choosingFolder}
			folderDraft={folderDraft}
			onFolderDraftChange={(next) => {
				setFolderDraft(next);
				setError("");
			}}
			canBrowse={canBrowse}
			onBrowse={() => void handleChoose()}
			busy={busy}
			error={error}
			onRetry={() => void postAction({ action: "retry-configured" })}
			onStartChooseFolder={() => void handleChoose()}
			onApplyChosenFolder={() => void postAction({ action: "change", path: folderDraft.trim(), copyMode: "switch" })}
			onUseDefault={() => void postAction({ action: "use-default" })}
			renderFrame={(frame) => (
				<HostDialog
					open
					frame={frame}
					onClose={() => "blocked"}
					backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
				>
					{frame.props.children}
				</HostDialog>
			)}
		/>
	);
}
