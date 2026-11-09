# Captures the primary screen twice, about two seconds apart, downscales both to 64x36 and
# prints how much changed:
#   SHOT <changedPercent> <gapMs>
# or SHOT FAIL <reason>. Nothing is written to disk.
#
# ASCII only: see foreground.ps1 for why.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$Width = 64
$Height = 36
$GapMs = 1800

function Sample-Screen {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $full = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($full)
  try {
    $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $full.Size)
  } finally {
    $graphics.Dispose()
  }
  $small = New-Object System.Drawing.Bitmap $Width, $Height
  $scale = [System.Drawing.Graphics]::FromImage($small)
  try {
    $scale.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $scale.DrawImage($full, 0, 0, $Width, $Height)
  } finally {
    $scale.Dispose()
    $full.Dispose()
  }
  $values = New-Object 'int[]' ($Width * $Height)
  $index = 0
  try {
    for ($y = 0; $y -lt $Height; $y++) {
      for ($x = 0; $x -lt $Width; $x++) {
        $pixel = $small.GetPixel($x, $y)
        $values[$index] = [int](($pixel.R + $pixel.G + $pixel.B) / 3)
        $index++
      }
    }
  } finally {
    $small.Dispose()
  }
  return ,$values
}

try {
  $first = Sample-Screen
  Start-Sleep -Milliseconds $GapMs
  $second = Sample-Screen
} catch {
  $reason = ($_.Exception.Message -replace '[\r\n]+', ' ')
  [Console]::Out.WriteLine('SHOT FAIL ' + $reason)
  exit 0
}

$changed = 0
for ($i = 0; $i -lt $first.Length; $i++) {
  if ([Math]::Abs($first[$i] - $second[$i]) -gt 8) { $changed++ }
}
$percent = [Math]::Round(100.0 * $changed / $first.Length, 1)
[Console]::Out.WriteLine('SHOT ' + $percent + ' ' + $GapMs)
