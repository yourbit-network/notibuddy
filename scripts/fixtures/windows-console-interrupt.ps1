# Test-only helper: allocate a new console explicitly, launch the CLI there,
# wait for the harness to reach its stall, and deliver an actual Ctrl+C event.
# Node/libuv detached mode alone can create a process without any console.
# https://learn.microsoft.com/windows/console/generateconsolectrlevent
param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ((Test-Path -LiteralPath $config.receipt) -or (Test-Path -LiteralPath $config.trigger)) {
    throw 'Control files already exist'
}

$probeStage = 'compile'
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class NotiBuddyConsoleResult {
    public int ExitCode;
    public string Stdout;
    public string Stderr;
}
public static class NotiBuddyConsoleInterrupt {
    public static string Stage = "allocate-console";
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetConsoleProcessList([Out] uint[] processes, uint count);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

    private static void Require(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    // Windows argv quoting, including embedded quotes and trailing backslashes.
    private static string Quote(string value) {
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            quoted.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            quoted.Append(c);
            slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static NotiBuddyConsoleResult Run(string node, string[] args, string cwd, string trigger) {
        FreeConsole();
        Require(AllocConsole(), "Allocate isolated console");
        Process child = null;
        try {
            // AllocConsole resets handlers; do not let the child inherit ignore.
            Require(SetConsoleCtrlHandler(IntPtr.Zero, false), "Enable child Ctrl+C");
            ProcessStartInfo info = new ProcessStartInfo(node);
            info.Arguments = String.Join(" ", Array.ConvertAll(args, Quote));
            info.WorkingDirectory = cwd;
            info.UseShellExecute = false;
            info.CreateNoWindow = false;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            Stage = "start-cli";
            child = Process.Start(info);
            child.StandardInput.Close();
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            // This changes only the helper; the CLI is already running.
            Require(SetConsoleCtrlHandler(IntPtr.Zero, true), "Protect helper");
            Stopwatch waiting = Stopwatch.StartNew();
            Stage = "wait-trigger";
            while (!File.Exists(trigger)) {
                if (child.HasExited) throw new InvalidOperationException("CLI exited before interruption");
                if (waiting.ElapsedMilliseconds > 25000) throw new TimeoutException("Missing interruption trigger");
                Thread.Sleep(10);
            }
            uint helper = (uint)Process.GetCurrentProcess().Id;
            Stage = "inspect-console";
            uint target = (uint)child.Id;
            uint[] processes = new uint[3];
            uint count = GetConsoleProcessList(processes, (uint)processes.Length);
            bool targetPresent = false, helperPresent = false;
            if (count == 2) {
                for (int i = 0; i < 2; i++) {
                    targetPresent |= processes[i] == target;
                    helperPresent |= processes[i] == helper;
                }
            }
            if (count != 2 || !targetPresent || !helperPresent)
                throw new InvalidOperationException("Refusing to signal a non-isolated console");
            // CTRL_C_EVENT must use group 0; nonzero can succeed without delivery.
            Stage = "send-ctrl-c";
            Require(GenerateConsoleCtrlEvent(0, 0), "Generate CTRL_C_EVENT");
            Stage = "wait-cli-exit";
            if (!child.WaitForExit(3000)) throw new TimeoutException("CLI did not exit after Ctrl+C");
            return new NotiBuddyConsoleResult {
                ExitCode = child.ExitCode, Stdout = stdout.Result, Stderr = stderr.Result
            };
        } finally {
            // Cleanup only this helper's child on a failed test.
            if (child != null) {
                if (!child.HasExited) { child.Kill(); child.WaitForExit(3000); }
                child.Dispose();
            }
            Require(FreeConsole(), "Detach helper");
        }
    }
}
'@
$probeStage = 'run'
$result = [NotiBuddyConsoleInterrupt]::Run($config.node, [string[]]$config.args, $config.cwd, $config.trigger)
$receipt = @{
    consoleEvent = @{event = 'CTRL_C_EVENT'; isolatedConsoleProcesses = 2; targetPresent = $true; sent = $true}
    exitCode = $result.ExitCode
    stdout = $result.Stdout
    stderr = $result.Stderr
} | ConvertTo-Json -Compress
# This private temporary record is checked and deleted by the parent harness.
# Only the sanitized pass/failure receipt is retained in the CI log.
[System.IO.File]::WriteAllText($config.receipt, $receipt, (New-Object System.Text.UTF8Encoding($false)))
} catch {
    if ($probeStage -eq 'run') { $probeStage = [NotiBuddyConsoleInterrupt]::Stage }
    $exception = $_.Exception.GetBaseException()
    $failure = @{stage = $probeStage; kind = $exception.GetType().FullName}
    if ($exception -is [System.ComponentModel.Win32Exception]) { $failure.nativeCode = $exception.NativeErrorCode }
    # Fixed stage, exception type and numeric OS code only; no command/profile data.
    $receipt = @{failure = $failure} | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($config.receipt, $receipt, (New-Object System.Text.UTF8Encoding($false)))
    exit 1
}
