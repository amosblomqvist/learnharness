# Keep the job handle outside the worker. Windows closes it even if this
# keeper is forcibly terminated, killing every adapter descendant. The worker
# waits for assignment before it may spawn an adapter (no inheritance race).
# https://learn.microsoft.com/windows/win32/procthread/job-objects
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class LearnHarnessAcpJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool ok) {
        if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    static void Pump(Stream source, Stream target) {
        var buffer = new byte[8192];
        int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
            target.Write(buffer, 0, count);
            target.Flush();
        }
    }
    public static int Run(string node, string worker, string ready) {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) Check(false);
        Process process = null;
        try {
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            process = Process.Start(new ProcessStartInfo(node, "\"" + worker + "\"") {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            });
            Check(AssignProcessToJobObject(job, process.Handle));
            var running = process;
            var input = new Thread(() => {
                try { Pump(Console.OpenStandardInput(), running.StandardInput.BaseStream); }
                catch (IOException) { }
                finally { try { running.StandardInput.Close(); } catch (IOException) { } }
            });
            var output = new Thread(() => { try { Pump(running.StandardOutput.BaseStream, Console.OpenStandardOutput()); } catch (IOException) { } });
            var error = new Thread(() => { try { Pump(running.StandardError.BaseStream, Console.OpenStandardError()); } catch (IOException) { } });
            input.IsBackground = output.IsBackground = error.IsBackground = true;
            input.Start(); output.Start(); error.Start();
            File.WriteAllText(ready, "assigned");
            process.WaitForExit();
            output.Join(1000); error.Join(1000);
            return process.ExitCode;
        } finally {
            // Also cover a failed assignment: the worker has not been released.
            if (process != null && !process.HasExited) process.Kill();
            TerminateJobObject(job, 1);
            var deadline = DateTime.UtcNow.AddSeconds(5);
            Accounting info;
            while (QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)
                && info.ActiveProcesses != 0 && DateTime.UtcNow < deadline) Thread.Sleep(10);
            CloseHandle(job);
            if (process != null) process.Dispose();
        }
    }
}
'@
$exitCode = [LearnHarnessAcpJob]::Run($env:LH_ACP_NODE, $env:LH_ACP_WORKER, $env:LH_ACP_READY)
exit $exitCode
