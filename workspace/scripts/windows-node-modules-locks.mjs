/**
 * Detect running processes that hold native binaries in a node_modules tree.
 *
 * `npm ci` deletes node_modules before installing. Windows refuses to delete a
 * loaded .node/.dll/.exe, so npm fails half way with EPERM and leaves a broken
 * install. Checking first lets the launcher refuse before anything changes.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync } from "node:fs";
import * as path from "node:path";

const BINARY = /\.(node|dll|exe)$/i;
const LOCKED_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

// Restart Manager names the processes using a file without administrator rights.
const HOLDERS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class LearnHarnessLockHolders {
	[StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }
	[StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public FILETIME ProcessStartTime; }
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
		public RM_UNIQUE_PROCESS Process;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
		public int ApplicationType;
		public uint AppStatus;
		public uint TSSessionId;
		[MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
	}
	[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
	[DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
	[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint processes, RM_UNIQUE_PROCESS[] ids, uint services, string[] serviceNames);
	[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
	public static int[] Find(string[] files) {
		uint handle;
		int result = RmStartSession(out handle, 0, new StringBuilder(33));
		if (result != 0) throw new Exception("RmStartSession failed (" + result + ")");
		try {
			result = RmRegisterResources(handle, (uint)files.Length, files, 0, null, 0, null);
			if (result != 0) throw new Exception("RmRegisterResources failed (" + result + ")");
			uint needed = 0, count = 0, reasons = 0;
			RM_PROCESS_INFO[] info = null;
			while (true) {
				result = RmGetList(handle, out needed, ref count, info, ref reasons);
				if (result == 0) break;
				if (result != 234) throw new Exception("RmGetList failed (" + result + ")");
				count = needed;
				info = new RM_PROCESS_INFO[count];
			}
			var ids = new List<int>();
			for (int i = 0; i < count; i++) if (!ids.Contains(info[i].Process.dwProcessId)) ids.Add(info[i].Process.dwProcessId);
			return ids.ToArray();
		} finally { RmEndSession(handle); }
	}
}
'@
# Windows PowerShell 5.1 emits a JSON array as one object; the pipeline unrolls it into paths.
$files = [string[]]@([Console]::In.ReadToEnd() | ConvertFrom-Json | ForEach-Object { $_ })
$holders = foreach ($id in [LearnHarnessLockHolders]::Find($files)) {
	$process = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
	[pscustomobject]@{ pid = $id; name = [string]$process.Name; commandLine = [string]$process.CommandLine }
}
ConvertTo-Json -Compress -InputObject @($holders)
} catch {
	[Console]::Error.WriteLine($_.Exception.Message)
	exit 1
}
`;

/** Native binaries under `directory` that cannot be opened for writing. */
export function findLockedFiles(directory) {
	const locked = [];
	if (!existsSync(directory)) return locked;
	const pending = [directory];
	while (pending.length) {
		const current = pending.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const filename = path.join(current, entry.name);
			// Dirent reports junctions and symlinks as links, so they are never followed.
			if (entry.isDirectory()) pending.push(filename);
			else if (entry.isFile() && BINARY.test(entry.name)) {
				try { closeSync(openSync(filename, "r+")); }
				catch (error) { if (LOCKED_CODES.has(error.code)) locked.push(filename); }
			}
		}
	}
	return locked.sort();
}

/** Processes holding any of `files`, as `{ pid, name, commandLine }`. Throws if Windows cannot say. */
export function findLockHolders(files) {
	const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const command = Buffer.from(HOLDERS_SCRIPT, "utf16le").toString("base64");
	const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", command], {
		input: JSON.stringify(files), encoding: "utf8", windowsHide: true, timeout: 60000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `PowerShell exited with ${result.status}.`);
	return JSON.parse(result.stdout);
}

/** Throw a readable error, before anything is deleted, if `directory` has locked binaries. */
export function assertNodeModulesUnlocked(directory, { findHolders = findLockHolders } = {}) {
	const locked = findLockedFiles(directory);
	if (!locked.length) return;
	const lines = [`Dependencies need reinstalling, but these programs are using files in ${directory}:`];
	let holders = [];
	try { holders = findHolders(locked); }
	catch (error) { lines.push(`  (Windows could not name the programs: ${error.message.split("\n")[0]})`); }
	if (holders.length) {
		for (const { pid, name, commandLine } of holders) lines.push(`  PID ${String(pid).padEnd(7)} ${name.padEnd(14)} ${commandLine || ""}`.trimEnd());
	} else {
		for (const filename of locked.slice(0, 10)) lines.push(`  ${path.relative(directory, filename)}`);
		if (locked.length > 10) lines.push(`  ...and ${locked.length - 10} more`);
	}
	lines.push("Close them (or close the LearnHarness window if it is open), then launch again. Nothing was changed.");
	throw new Error(lines.join("\n"));
}
