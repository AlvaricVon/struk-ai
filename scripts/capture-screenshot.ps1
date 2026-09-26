<#
.SYNOPSIS
    Captures the StrukAI UI with a finished scan on screen.

.DESCRIPTION
    Opens the app on its auto-scan URL, waits for the warm scan to finish, then
    captures the browser window.

    The window is grabbed with PrintWindow rather than a screen copy, so the
    shot is of the browser even when something else has focus. A CopyFromScreen
    version of this script happily produced a picture of a terminal.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/capture-screenshot.ps1
#>
[CmdletBinding()]
param(
    [string]$Url = 'http://127.0.0.1:5173/?scan=receipt-coffee.png',
    [int]$WaitSeconds = 200,
    [string]$OutputFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public class Win {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);

    /// PW_RENDERFULLCONTENT is what makes this work for a hardware-accelerated
    /// window such as Chrome, which otherwise comes back blank or black.
    public static bool Capture(IntPtr hwnd, string path) {
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return false;
        int w = r.Right - r.Left, ht = r.Bottom - r.Top;
        if (w <= 0 || ht <= 0) return false;

        using (var bmp = new Bitmap(w, ht))
        using (var g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            bool ok;
            try { ok = PrintWindow(hwnd, hdc, 2); }
            finally { g.ReleaseHdc(hdc); }
            if (!ok) return false;
            bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            return true;
        }
    }
}
'@
if (-not ('Win' -as [type])) { Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing }

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { throw "Chrome not found at $chrome" }
if (-not $OutputFile) { $OutputFile = Join-Path $PWD 'docs\screenshot.png' }
New-Item -ItemType Directory -Path (Split-Path $OutputFile) -Force | Out-Null

# Start clean, so a window from an earlier run is not what ends up in the shot.
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "Opening $Url"
Start-Process -FilePath $chrome -ArgumentList @(
    '--start-maximized',
    "--user-data-dir=$env:TEMP\struk-ai-shot",
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    $Url
)

$window = $null
for ($i = 0; $i -lt 30; $i++) {
    $window = Get-Process chrome -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -match 'StrukAI' } |
        Select-Object -First 1
    if ($window) { break }
    Start-Sleep -Seconds 1
}
if (-not $window) { throw 'The browser window never appeared.' }

[void][Win]::ShowWindow($window.MainWindowHandle, 3)   # SW_MAXIMIZE
[void][Win]::SetForegroundWindow($window.MainWindowHandle)
Write-Host "Window ready: $($window.MainWindowTitle)"

Write-Host "Waiting $WaitSeconds seconds for the scan to finish..."
for ($i = 0; $i -lt $WaitSeconds; $i += 20) {
    Start-Sleep -Seconds 20
    Write-Host ("  {0,4}s" -f ($i + 20))
}

if (-not [Win]::Capture($window.MainWindowHandle, $OutputFile)) {
    throw 'PrintWindow failed to capture the browser.'
}
$kb = [int]((Get-Item $OutputFile).Length / 1KB)
Write-Host ("Saved {0} ({1} KB)" -f $OutputFile, $kb)
