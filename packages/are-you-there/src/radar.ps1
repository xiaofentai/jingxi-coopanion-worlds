# Streams the presence reading of an HLK-LD2402 24 GHz presence sensor over a USB serial adapter,
# one line per frame (~6 per second, 115200 8N1):
#   READY <port>        the port is open; everything after this is sensor data
#   PRESENT <cm>        someone is inside the configured range
#   ABSENT              nobody inside the configured range
#   CFG <token>         what happened to the max-distance parameter
#   FAIL <token>        fatal; the script exits and the parent restarts it
#
# Kept ASCII-only on purpose: Windows PowerShell 5.1 reads a file without a BOM as the ANSI code
# page, and a non-ASCII comment would break the here-string in idle.ps1 the same way.
#
# Started and stopped by src/radar.ts. -MaxDistance is in 0.1 m units; 0 leaves the module alone.
param(
  [string]$Port = 'auto',
  [int]$MaxDistance = 14,
  [int]$Seconds = 0
)

$ErrorActionPreference = 'Continue'
$out = [Console]::Out

function Emit([string]$line) {
  $out.WriteLine($line)
  $out.Flush()
}

# Command frames are little-endian, framed by FD FC FB FA ... 04 03 02 01.
function Build([int]$cmd, [byte[]]$value) {
  $v = @()
  if ($null -ne $value) { $v = $value }
  $len = 2 + $v.Count
  $f = New-Object System.Collections.Generic.List[byte]
  $f.AddRange([byte[]](0xFD, 0xFC, 0xFB, 0xFA))
  $f.Add([byte]($len -band 0xFF))
  $f.Add([byte](($len -shr 8) -band 0xFF))
  $f.Add([byte]($cmd -band 0xFF))
  $f.Add([byte](($cmd -shr 8) -band 0xFF))
  foreach ($b in $v) { $f.Add([byte]$b) }
  $f.AddRange([byte[]](0x04, 0x03, 0x02, 0x01))
  return ,$f.ToArray()
}

# Sends one command and waits for the ACK frame. Returns the raw ACK bytes, empty on timeout.
function Ask($sp, [int]$cmd, [byte[]]$value, [int]$waitMs) {
  $frame = Build $cmd $value
  $sp.Write($frame, 0, $frame.Length)
  $buf = New-Object System.Collections.Generic.List[byte]
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $waitMs) {
    Start-Sleep -Milliseconds 25
    $n = $sp.BytesToRead
    if ($n -gt 0) {
      $tmp = New-Object byte[] $n
      $read = $sp.Read($tmp, 0, $n)
      for ($i = 0; $i -lt $read; $i++) { $buf.Add($tmp[$i]) }
      $arr = $buf.ToArray()
      if ($arr.Length -ge 9 -and
          $arr[$arr.Length - 4] -eq 0x04 -and $arr[$arr.Length - 3] -eq 0x03 -and
          $arr[$arr.Length - 2] -eq 0x02 -and $arr[$arr.Length - 1] -eq 0x01) { break }
    }
  }
  return ,$buf.ToArray()
}

function Base([int]$cmd) { return ($cmd -band 0xFF) }

# Reads one 4-byte parameter out of an ACK, or -1 when the ACK is not usable.
# Layout: FD FC FB FA | len(2) | cmd(2) | status(2) | value(4) | 04 03 02 01
function Value($ack) {
  if ($null -eq $ack -or $ack.Length -lt 18) { return -1 }
  $head = -1
  for ($i = 0; $i -le $ack.Length - 18; $i++) {
    if ($ack[$i] -eq 0xFD -and $ack[$i + 1] -eq 0xFC -and $ack[$i + 2] -eq 0xFB -and $ack[$i + 3] -eq 0xFA) { $head = $i; break }
  }
  if ($head -lt 0) { return -1 }
  $len = [int]$ack[$head + 4] + ([int]$ack[$head + 5] -shl 8)
  if ($len -lt 8) { return -1 }
  $v = $head + 10
  return [int64]$ack[$v] + ([int64]$ack[$v + 1] -shl 8) + ([int64]$ack[$v + 2] -shl 16) + ([int64]$ack[$v + 3] -shl 24)
}

# Picks the USB serial adapter. Bluetooth links also expose COM ports, so they are excluded.
function Find-Port {
  $found = @()
  foreach ($d in (Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue)) {
    if ($d.Name -match '\(COM(\d+)\)') {
      # Read the group right away: the next -match would clear $Matches.
      $number = $Matches[1]
      $id = [string]$d.PNPDeviceID
      if ($id -like 'BTHENUM*') { continue }
      $score = 0
      if ($id -like 'USB*') { $score += 2 }
      if ($d.Name -match 'USB|CH34|CP21|FT23|Serial') { $score += 1 }
      $found += [pscustomobject]@{ Port = ('COM' + $number); Score = $score }
    }
  }
  $pick = $found | Sort-Object -Property Score -Descending | Select-Object -First 1
  if ($null -eq $pick) { return '' }
  return $pick.Port
}

# Puts the module's max distance where the config asks for it. Every branch ends by leaving the
# configuration mode, otherwise the module stops streaming and this process looks dead.
function Configure($sp, [int]$want) {
  $ack = Ask $sp 0x00FF ([byte[]](0x01, 0x00)) 900
  if ($ack.Length -eq 0) { return 'warn-enable' }
  $read = Ask $sp 0x0008 ([byte[]](0x01, 0x00)) 900
  $now = Value $read
  if ($now -eq [int64]$want) {
    [void](Ask $sp 0x00FE $null 500)
    return ('keep ' + $now)
  }
  $lo = [byte]($want -band 0xFF)
  $hi = [byte](($want -shr 8) -band 0xFF)
  $w = Ask $sp 0x0007 ([byte[]](0x01, 0x00, $lo, $hi, 0x00, 0x00)) 900
  if ($w.Length -eq 0) {
    [void](Ask $sp 0x00FE $null 500)
    return ('warn-write from ' + $now)
  }
  # Persist it: without this the module falls back to its old value on the next power cycle.
  [void](Ask $sp 0x00FD $null 900)
  $back = Value (Ask $sp 0x0008 ([byte[]](0x01, 0x00)) 900)
  [void](Ask $sp 0x00FE $null 500)
  return ('set ' + $now + '->' + $back)
}

$target = $Port
if ($target -eq '' -or $target -eq 'auto') { $target = Find-Port }
if ($target -eq '') { Emit 'FAIL no-port'; exit 1 }

$sp = New-Object System.IO.Ports.SerialPort $target, 115200, 'None', 8, 'One'
$sp.ReadTimeout = 300
$sp.WriteTimeout = 500
$sp.Encoding = [Text.Encoding]::ASCII
try {
  $sp.Open()
} catch {
  $inner = $_.Exception.InnerException
  if ($inner -is [System.UnauthorizedAccessException]) { Emit 'FAIL busy' }
  elseif ($inner -is [System.ArgumentException] -or $inner -is [System.IO.IOException]) { Emit 'FAIL missing' }
  else { Emit 'FAIL open' }
  exit 1
}

Emit ('READY ' + $target)

if ($MaxDistance -gt 0) {
  try { Emit ('CFG ' + (Configure $sp $MaxDistance)) } catch { Emit 'CFG warn-exception' }
}
Start-Sleep -Milliseconds 300
try { $sp.DiscardInBuffer() } catch { }

$sw = [Diagnostics.Stopwatch]::StartNew()
$buf = ''
$sinceFrame = 0

while ($Seconds -le 0 -or $sw.Elapsed.TotalSeconds -lt $Seconds) {
  $raw = ''
  try {
    $raw = $sp.ReadExisting()
  } catch {
    Emit 'FAIL io'
    break
  }
  if ($raw.Length -gt 0) {
    $sinceFrame = 0
    $buf += $raw
    while ($buf.Contains("`n")) {
      $i = $buf.IndexOf("`n")
      $line = $buf.Substring(0, $i).Trim()
      $buf = $buf.Substring($i + 1)
      if ($line -eq 'OFF') {
        Emit 'ABSENT'
      } elseif ($line -match '^distance:\s*(\d+)$') {
        Emit ('PRESENT ' + $Matches[1])
      }
    }
    if ($buf.Length -gt 512) { $buf = '' }
  } else {
    $sinceFrame += 1
    # Nothing for ~2 s in the middle of the stream means the port is gone but the handle is not.
    if ($sinceFrame -gt 40) {
      Emit 'FAIL silent'
      break
    }
  }
  Start-Sleep -Milliseconds 50
}

try { $sp.Close(); $sp.Dispose() } catch { }
