# Test-only helper. The caller creates the CLI with Node's detached:true,
# which gives it a separate Windows console. Never signal a shared console.
# https://nodejs.org/api/child_process.html#optionsdetached
# https://learn.microsoft.com/windows/console/generateconsolectrlevent
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$TargetProcessId,
    [Parameter(Mandatory = $true)][string]$ReceiptPath
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $ReceiptPath) { throw 'Receipt already exists' }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class NotiBuddyConsoleInterrupt {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetConsoleProcessList([Out] uint[] processes, uint count);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

    private static void Require(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    public static void Send(uint target) {
        uint helper = (uint)Process.GetCurrentProcess().Id;
        if (target == helper) throw new InvalidOperationException("Refusing to target self");
        // A console may already be absent. AttachConsole must succeed next.
        FreeConsole();
        Require(AttachConsole(target), "Attach target console");
        try {
            // AttachConsole resets control handlers. Ignore Ctrl+C only in this
            // helper, after attaching; the already-running CLI is unaffected.
            Require(SetConsoleCtrlHandler(IntPtr.Zero, true), "Protect helper");
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
            // CTRL_C_EVENT must use group 0. A nonzero group can report success
            // without delivering Ctrl+C. Only the CLI and this helper are here.
            using (Process child = Process.GetProcessById((int)target)) {
                // Acquire the handle before dispatch; the CLI may exit before
                // GetProcessById could find it after the event.
                IntPtr childHandle = child.Handle;
                Require(GenerateConsoleCtrlEvent(0, 0), "Generate CTRL_C_EVENT");
                // Keep the protected helper attached until the target exits.
                if (!child.WaitForExit(3000))
                    throw new TimeoutException("CLI did not exit after console Ctrl+C");
            }
        } finally {
            Require(FreeConsole(), "Detach helper");
        }
    }
}
'@
[NotiBuddyConsoleInterrupt]::Send([uint32]$TargetProcessId)
$receipt = @{
    event = 'CTRL_C_EVENT'
    isolatedConsoleProcesses = 2
    targetPresent = $true
    sent = $true
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($ReceiptPath, $receipt, (New-Object System.Text.UTF8Encoding($false)))
