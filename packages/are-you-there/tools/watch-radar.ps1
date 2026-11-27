# Read-only radar watcher. It does NOT open COM5, so it can run while the plugin is using the port.
# It polls the same panel status that the console shows, and logs the exact status/hint returned by
# the plugin. Since 0.7.8 the panel collapses "module says OFF" and "distance beyond maxCm" into one
# NO_NEAR status, so this script cannot separate those two by itself.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\watch-radar.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\watch-radar.ps1 -IntervalSeconds 1 -DurationSeconds 120
# Stop with Ctrl+C. Default log file is next to this script: radar-watch-yyyyMMdd-HHmmss.log

param(
  [string]$Url = 'http://127.0.0.1:17788/api/webui/providers/world%3Aare-you-there/panels/settings/status',
  [string]$OutFile = '',
  [int]$IntervalSeconds = 2,
  [int]$DurationSeconds = 0,
  [switch]$NoConsole
)

$ErrorActionPreference = 'Stop'
if ($IntervalSeconds -lt 1) { $IntervalSeconds = 1 }
if (-not $OutFile) {
  $OutFile = Join-Path $PSScriptRoot ('radar-watch-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
}

$reAbsent    = '\u6CA1\u6D4B\u5230\u4EBA|\u65E0\u4EBA'
$reFar       = '\u8303\u56F4\u4E4B\u5916'
$reCooling   = '\u65E7\u8BFB\u6570'
$reWarming   = '\u8FD8\u6CA1\u5728\u8303\u56F4\u5185'
$reStale     = '\u6536\u4E0D\u5230'
$reDown      = '\u6CA1\u8FDE\u4E0A|\u672A\u8FDE\u63A5'
$rePresent   = '\u6709\u4EBA'
$reAbsentSec = '\u5DF2\u7ECF\s+(\d+)\s*\u79D2\u6CA1\u6D4B\u5230\u4EBA'
$reLastCm    = '\u6700\u8FD1\u4E00\u6B21\u5728\s*(\d+)|(\d+)\s*\u5398\u7C73\u6709\u4EBA'

function Get-Kind {
  param([string]$Text, [string]$Hint)
  if ($Hint -match $reAbsent -or $Text -match $reAbsent) { return 'NO_NEAR' }
  if ($Hint -match $reFar -or $Text -match $reFar) { return 'FAR' }
  if ($Hint -match $reCooling -or $Text -match $reCooling) { return 'COOLING' }
  if ($Hint -match $reWarming -or $Text -match $reWarming) { return 'WARMING' }
  if ($Hint -match $reStale -or $Text -match $reStale) { return 'STALE' }
  if ($Hint -match $reDown -or $Text -match $reDown) { return 'DOWN' }
  if ($Text -match $rePresent) { return 'PRESENT' }
  return 'UNKNOWN'
}

function Get-FieldValue {
  param($Sections, [string]$Key)
  foreach ($s in $Sections) {
    foreach ($f in $s.fields) {
      if ($f.key -eq $Key) { return [string]$f.value }
    }
  }
  return ''
}

$header = 'time | kind | tone | text | hint | absentSec | lastCm | cfgAbsent | cfgBack | maxCm | maxDist | quiet'
Add-Content -LiteralPath $OutFile -Value $header -Encoding UTF8
if (-not $NoConsole) {
  Write-Output ('Logging to: ' + $OutFile)
  Write-Output ('Press Ctrl+C to stop. Interval=' + $IntervalSeconds + 's')
}

$start = Get-Date
while ($true) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  try {
    $payload = Invoke-RestMethod -Uri $Url -TimeoutSec 5
    $radar = @($payload.sections | Where-Object { $_.id -eq 'radar' })[0]
    if ($null -eq $radar) { throw 'radar section not found' }
    $status = $radar.status
    $text = [string]$status.text
    $hint = [string]$status.hint
    $tone = [string]$status.tone
    $kind = Get-Kind -Text $text -Hint $hint

    $absentSec = ''
    if ($hint -match $reAbsentSec) { $absentSec = $Matches[1] }

    $lastCm = ''
    if ($hint -match $reLastCm) {
      if ($Matches[1]) { $lastCm = $Matches[1] }
      elseif ($Matches[2]) { $lastCm = $Matches[2] }
    }

    $line = '{0} | {1} | tone={2} | text={3} | hint={4} | absentSec={5} | lastCm={6} | cfgAbsent={7} | cfgBack={8} | maxCm={9} | maxDist={10} | quiet={11}' -f
      $ts, $kind, $tone, $text, $hint, $absentSec, $lastCm,
      (Get-FieldValue $payload.sections 'radarAbsentSeconds'),
      (Get-FieldValue $payload.sections 'radarBackSeconds'),
      (Get-FieldValue $payload.sections 'radarMaxCm'),
      (Get-FieldValue $payload.sections 'radarMaxDistance'),
      (Get-FieldValue $payload.sections 'radarQuietSeconds')
  } catch {
    $msg = ($_.Exception.Message -replace '\|', '/' -replace '\r?\n', ' ')
    $line = '{0} | HTTP_FAIL | msg={1}' -f $ts, $msg
  }

  Add-Content -LiteralPath $OutFile -Value $line -Encoding UTF8
  if (-not $NoConsole) { Write-Output $line }

  if ($DurationSeconds -gt 0 -and ((Get-Date) - $start).TotalSeconds -ge $DurationSeconds) { break }
  Start-Sleep -Seconds $IntervalSeconds
}
