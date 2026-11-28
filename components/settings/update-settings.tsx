"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { SettingsRow, Toggle } from "./controls.tsx";
import { tr } from "@/src/core";

/** Observational snapshot from electron/main.cjs; never updater permission. */
export type UpdateState = {
	status: "idle" | "checking" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled";
	version: string | null;
	revision: number;
};

export const APP_VERSION = process.env.LH_VERSION ?? "";
const HOMEPAGE = process.env.LH_HOMEPAGE ?? "";
export const MANUAL_UPDATE_HINT = tr("检查时会下载可用的更新。已下载的更新会在你退出应用时安装。", "Checking downloads available updates. Downloaded updates install when you quit the app.");
export const AUTO_UPDATE_HINT = tr("在启动时及每 24 小时检查一次。关闭此项不会停止正在进行或已准备安装的更新。", "Check at startup and every 24 hours. Turning this off does not stop updates already in progress or ready to install.");
const UPDATE_ERROR = tr("无法检查更新。请稍后重试。", "Couldn’t check for updates. Try again later.");

/** Subscribe before requesting the snapshot. IPC replies and pushes can
 * cross; a revision prevents an older reply from hiding a newer event.
 * The banner shares this read-only observer so late loads recover too. */
export function useUpdateState() {
	const [state, setState] = useState<UpdateState | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const lh = window.lh;
		if (!lh) return;
		let live = true;
		let revision = -1;
		const accept = (next: UpdateState) => {
			if (!live || next.revision < revision) return;
			revision = next.revision;
			setState(next);
			setFailed(false);
		};
		const off = lh.onUpdateStatus?.(accept);
		void lh.getUpdateState?.().then(accept).catch(() => {
			if (live && revision === -1) setFailed(true);
		});
		return () => { live = false; off?.(); };
	}, []);
	return { state, failed };
}

export function updateStatusText(state: UpdateState | null): string | null {
	switch (state?.status) {
		case "checking": return tr("正在检查更新…", "Checking for updates…");
		case "downloading": return state.version ? tr(`正在下载版本 ${state.version}…`, `Downloading version ${state.version}…`) : tr("正在下载更新…", "Downloading an update…");
		case "up-to-date": return tr("上次检查时未发现更新的版本。", "No newer version was found at the last check.");
		case "downloaded": return tr(`${state.version ? `版本 ${state.version} ` : "更新"}已准备就绪，将在你退出应用时安装。`, `${state.version ? `Version ${state.version}` : "An update"} is ready. It will install when you quit the app.`);
		case "error": return UPDATE_ERROR;
		default: return null;
	}
}

/** Version information is useful everywhere; update controls only belong
 * to a shell with an available updater. Opening this row never checks. */
export function UpdateSettings({
	autoUpdate,
	onAutoUpdateChange,
	version = APP_VERSION,
	homepage = HOMEPAGE,
}: {
	autoUpdate: boolean;
	onAutoUpdateChange: (on: boolean) => void;
	version?: string;
	homepage?: string;
}) {
	const { state, failed } = useUpdateState();
	const [checkFailed, setCheckFailed] = useState(false);
	useEffect(() => setCheckFailed(false), [state]);
	const active = state !== null && state.status !== "disabled";
	const busy = state?.status === "checking" || state?.status === "downloading";
	const status = state?.status === "downloaded" ? updateStatusText(state)
		: failed || checkFailed ? UPDATE_ERROR : updateStatusText(state);
	const releaseNotes = version && homepage ? `${homepage}/releases/tag/v${version}` : null;
	const check = () => {
		setCheckFailed(false);
		void window.lh?.checkForUpdates?.().catch(() => setCheckFailed(true));
	};

	return (
		<>
			<SettingsRow
				label={tr(`版本 ${version || "未知"}`, `Version ${version || "unknown"}`)}
				testid="row-version"
				hint={
					<>
						{status && <span className="block" role="status" data-testid="update-status">{status}</span>}
						{active && <span className="block">{MANUAL_UPDATE_HINT}</span>}
						{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">{tr("发行说明", "Release notes")}</a>}
					</>
				}
			>
				{active && (state.status === "downloaded" ? (
					<Button type="button" size="xs" className="cursor-pointer" data-testid="update-restart" onClick={() => window.lh?.installUpdate?.()}>{tr("重启", "Restart")}</Button>
				) : (
					<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" data-testid="update-check" disabled={busy} aria-busy={busy} onClick={check}>
						{busy && <BrailleSpinner label={state.status === "downloading" ? tr("正在下载更新", "Downloading update") : tr("正在检查更新", "Checking for updates")} />}
						{tr("检查更新", "Check for updates")}
					</Button>
				))}
			</SettingsRow>
			{active && (
				<SettingsRow label={tr("自动更新", "Automatic updates")} hint={AUTO_UPDATE_HINT} testid="row-auto-update">
					<Toggle checked={autoUpdate} label={tr("自动更新", "auto update")} testid="toggle-auto-update" onChange={onAutoUpdateChange} />
				</SettingsRow>
			)}
		</>
	);
}
