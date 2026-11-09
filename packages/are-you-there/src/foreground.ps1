# Prints the window in the foreground, one line:
#   FG <pid> <processName> | <windowTitle>
# or FG NONE when there is no foreground window.
#
# ASCII only: Windows PowerShell 5.1 reads a file without a BOM as the ANSI code page and
# non-ASCII text breaks the here-string below.
#
# Output must be UTF-8: the calling Node process decodes stdout as UTF-8, while PowerShell would
# otherwise use the console code page and turn any non-ASCII window title into garbage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AreYouThereForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$handle = [AreYouThereForeground]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) {
  [Console]::Out.WriteLine('FG NONE')
  exit 0
}
$title = New-Object System.Text.StringBuilder 512
[void][AreYouThereForeground]::GetWindowText($handle, $title, $title.Capacity)
$processId = 0
[void][AreYouThereForeground]::GetWindowThreadProcessId($handle, [ref]$processId)
$name = 'unknown'
try { $name = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }
$clean = $title.ToString() -replace '[\r\n]+', ' '
[Console]::Out.WriteLine('FG ' + $processId + ' ' + $name + ' | ' + $clean)
