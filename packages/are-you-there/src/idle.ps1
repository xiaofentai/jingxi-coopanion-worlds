# Reports how long the keyboard and mouse have been idle, one line per reading:
#   IDLE <ms>
# Prints FAIL when GetLastInputInfo cannot be read.
#
# Started and stopped by src/idle.ts. Kept ASCII-only on purpose: Windows PowerShell 5.1 reads a
# file without a BOM as the ANSI code page, and non-ASCII comments then break the here-string below.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AreYouThereIdle {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static long IdleMs() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return -1;
    // dwTime is a 32-bit tick count and wraps after 49.7 days, so wrap the difference too
    long tick = (long)(uint)Environment.TickCount;
    long delta = tick - (long)info.dwTime;
    return delta < 0 ? delta + 4294967296L : delta;
  }
}
"@
while ($true) {
  $ms = [AreYouThereIdle]::IdleMs()
  if ($ms -lt 0) {
    [Console]::Out.WriteLine('FAIL')
  } else {
    [Console]::Out.WriteLine('IDLE ' + $ms)
  }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 2000
}
