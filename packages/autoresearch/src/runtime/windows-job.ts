// A Job Object owns the complete Windows descendant tree. The application is
// suspended until assignment, so it cannot race an untracked descendant spawn.
export const WINDOWS_JOB_RUNNER = String.raw`
param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public static class DurableJobRunner {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public uint cb; public IntPtr reserved; public IntPtr desktop; public IntPtr title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking;
    public uint active; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long a,b,c,d; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string exe, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO start, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int value);
  public static bool Cancelled = false;
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string exe, string command, string cwd, string cancelPath) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool assigned = false;
    try {
      EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.basic.flags = 0x2000;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
      STARTUPINFO startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
      startup.flags = 0x100; startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
      Check(CreateProcess(exe, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref startup, out process));
      Check(AssignProcessToJobObject(job, process.process)); assigned = true;
      if (ResumeThread(process.thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      while (WaitForSingleObject(process.process, 50) == 258) {
        if (File.Exists(cancelPath)) { Cancelled = true; Check(TerminateJobObject(job, 137)); break; }
      }
      uint exitCode; Check(GetExitCodeProcess(process.process, out exitCode));
      // Root exit does not prove descendants stopped: terminate and account for
      // the entire owned job before issuing the completion certificate.
      Check(TerminateJobObject(job, 137));
      DateTime limit = DateTime.UtcNow.AddSeconds(10);
      while (true) {
        ACCOUNTING accounting;
        Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
        if (accounting.active == 0) break;
        if (DateTime.UtcNow > limit) throw new Exception("job tree termination unconfirmed");
        Thread.Sleep(20);
      }
      return Cancelled ? 137 : unchecked((int)exitCode);
    } finally {
      if (process.process != IntPtr.Zero && !assigned) TerminateProcess(process.process, 137);
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      CloseHandle(job);
    }
  }
}
'@ | Out-Null
$exitCode = [DurableJobRunner]::Run($config.executable, $config.commandLine, $config.cwd, $config.cancelPath)
$result = @{nonce=$config.nonce; treeStopped=$true; exitCode=$exitCode; cancelled=[DurableJobRunner]::Cancelled} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($config.resultPath, $result, (New-Object System.Text.UTF8Encoding $false))
`

export function windowsCommandLine(executable: string, args: string[]): string {
  return [executable, ...args].map(value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&') + '"').join(' ')
}
