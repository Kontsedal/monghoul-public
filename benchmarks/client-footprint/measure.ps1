<#
.SYNOPSIS
  Measures what a MongoDB desktop client costs before you have run a single query: disk, startup,
  memory and process count.

.DESCRIPTION
  Backs https://monghoul.com/compare/mongodb-compass/. Nothing is published there that this script
  did not print.

  These are the cheap facts every comparison asserts and none of them measure. "Electron, feels
  sluggish" is not a measurement. This is.

  WHAT IT MEASURES HONESTLY

  Time is measured to the app owning a WINDOW HANDLE, not to the app being ready for a query. Those
  are different things and the gap is not the same for every client, so read the number as "how long
  before something appears" rather than "how long before you can work". A fair comparison of time to
  interactive needs driving both apps, which is a person's job.

  Memory is the summed working set of every process the app owns, 20 seconds after the window
  appears, with no connection open. An Electron app spawns several, so summing is the only way to
  compare it against a single-process one.

  WHAT IT CANNOT MEASURE

  Whether the thing is any good. Autocomplete quality, whether the aggregation builder helps, how it
  behaves against a slow cluster. Those need hands and judgement.

.EXAMPLE
  .\measure.ps1 -Runs 5
#>
param(
  [int]$Runs = 5,
  [int]$SettleSeconds = 20
)

$ErrorActionPreference = 'SilentlyContinue'

# Apps to measure. `Match` is a regex over process names, and it must catch EVERY process the app
# owns: Electron's renderers and GPU process are where most of the memory is, and a match that only
# finds the main process reports a number that is wrong by a factor of several.
$Apps = @(
  @{
    Name  = 'MongoDB Compass'
    Dir   = "$env:LOCALAPPDATA\MongoDBCompass"
    Exe   = "$env:LOCALAPPDATA\MongoDBCompass\app-1.50.0\MongoDBCompass.exe"
    Match = 'MongoDBCompass'
  },
  @{
    Name  = 'Monghoul'
    Dir   = "$env:LOCALAPPDATA\Monghoul"
    Exe   = "$env:LOCALAPPDATA\Monghoul\monghoul.exe"
    Match = 'monghoul|server'
  }
)

function Stop-App([string]$Match) {
  Get-Process | Where-Object { $_.ProcessName -match $Match } | Stop-Process -Force
  Start-Sleep -Seconds 4
}

function Get-DiskFootprint([string]$Dir) {
  if (-not (Test-Path $Dir)) { return $null }
  $files = Get-ChildItem $Dir -Recurse -File -ErrorAction SilentlyContinue
  # Files that only ship with a bundled Chromium. Their presence is what makes "it is Electron" a
  # measurement rather than a claim.
  $chromium = ($files | Where-Object {
      $_.Name -match 'libEGL|libGLESv2|d3dcompiler|icudtl|ffmpeg\.dll|chrome_\d+\.pak'
    } | Measure-Object).Count
  [PSCustomObject]@{
    DiskMB            = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 1)
    Files             = $files.Count
    ChromiumArtifacts = $chromium
  }
}

function Measure-App($App, [int]$Runs, [int]$Settle) {
  if (-not (Test-Path $App.Exe)) {
    Write-Warning "$($App.Name): not found at $($App.Exe). Adjust the path and rerun."
    return $null
  }

  $disk = Get-DiskFootprint $App.Dir
  $times = @()
  $rams = @()
  $procCount = 0

  for ($i = 0; $i -lt $Runs; $i++) {
    Stop-App $App.Match
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Process $App.Exe | Out-Null

    $win = $null
    while ($sw.Elapsed.TotalSeconds -lt 90 -and -not $win) {
      Start-Sleep -Milliseconds 50
      $win = Get-Process |
        Where-Object { $_.ProcessName -match $App.Match -and $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
    }
    $times += [math]::Round($sw.Elapsed.TotalSeconds, 3)

    Start-Sleep -Seconds $Settle
    $procs = Get-Process | Where-Object { $_.ProcessName -match $App.Match }
    $procCount = $procs.Count
    $rams += [math]::Round((($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB), 0)

    Stop-App $App.Match
  }

  $t = $times | Sort-Object
  $r = $rams | Sort-Object
  [PSCustomObject]@{
    App               = $App.Name
    DiskMB            = $disk.DiskMB
    Files             = $disk.Files
    ChromiumArtifacts = $disk.ChromiumArtifacts
    Processes         = $procCount
    MedianSecToWindow = $t[[math]::Floor($t.Count / 2)]
    AllTimes          = ($times -join ', ')
    MedianIdleRAM_MB  = $r[[math]::Floor($r.Count / 2)]
    AllRAM            = ($rams -join ', ')
  }
}

Write-Host "Measuring $Runs runs per app. Each run launches the app and closes it." -ForegroundColor Cyan
Write-Host "Close anything you care about first: this force-stops matching processes.`n"

$results = foreach ($app in $Apps) { Measure-App $app $Runs $SettleSeconds }
$results | Format-List

Write-Host "`nTime is to the app owning a window handle, NOT to being ready for a query." -ForegroundColor Yellow
Write-Host "Memory is the summed working set of every process the app owns, idle, no connection open."
