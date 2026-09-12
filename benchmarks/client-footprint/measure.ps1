<#
.SYNOPSIS
  Measures what a MongoDB desktop client costs before you have run a single query: disk, startup,
  memory, process count and whether it opened a connection on its own.

.DESCRIPTION
  Backs the comparison pages under https://monghoul.com/compare/. Nothing is published there that
  this script did not print.

  These are the cheap facts every comparison asserts and none of them measure. "Electron, feels
  sluggish" is not a measurement. This is.

  TWO START TIMES, BECAUSE THERE ARE TWO WINDOWS

  The first version of this script timed the app to owning any WINDOW HANDLE. That is fair between
  two apps that have one window and wrong for the three here that show a splash screen first:
  Studio 3T reached "a window" in 0.13 seconds and its real window several seconds later.

  So both are measured. `SecToAnyWindow` is the first window of any kind, splash included.
  `SecToMainWindow` waits for a window whose title matches `WindowTitle`, which is the app's own
  window. An app with no `WindowTitle` has no splash and no OS-level title, and the two numbers are
  the same by definition. Publish the main-window figure and say which apps show a splash.

  Neither is time to being ready for a query. A window can appear before the app can do anything,
  the gap differs per app, and measuring it needs driving both apps, which is a person's job.

  MEMORY, AND THE PROCESSES THAT ARE EASY TO MISS

  The summed working set of every process the app owns, after the settle window. An Electron app
  spawns several, so summing is the only way to compare it against a single-process one.

  Finding those processes by install directory alone UNDERCOUNTS an app that renders in a runtime
  already on the machine. Monghoul is the case here: the shell and its sidecar live in the install
  directory and its six WebView2 processes live under Program Files, so the first version of this
  script reported 148 MB for an app actually holding about 750 MB. Compass and NoSQLBooster bundle
  Chromium, so their renderers sit inside their own directory and were counted all along.

  `CmdMatch` fixes it. It is a regex over the COMMAND LINE, which is where an out-of-directory
  helper names the app it belongs to, and it is read through Win32_Process outside the polling loop
  because that query is too slow to run every 50 ms.

  CONNECTIONS, COUNTED RATHER THAN ASSUMED

  "Idle, nothing connected" was an instruction to the person running this until a client that
  restores its last session made it false. Established TCP connections owned by the app are
  split in two: a remote port inside `-MongoPorts` is a DATABASE connection and makes the memory
  figure a connected one rather than an idle one. Everything else is counted and not listed,
  because it is update checks, licence checks and, for Monghoul, the shell talking to its own
  sidecar over loopback.

  RUNTIME ARTIFACTS

  What each app ships, rather than what its marketing calls itself. A bundled Chromium leaves
  libEGL, libGLESv2, d3dcompiler, icudtl and ffmpeg behind it. A bundled JVM leaves jvm.dll and its
  class library. An app that leaves neither is using something already on the machine.

  WHAT IT CANNOT MEASURE

  Whether the thing is any good. Autocomplete quality, whether the aggregation builder helps, how it
  behaves against a slow cluster. Those need hands and judgement.

.EXAMPLE
  .\measure.ps1 -Runs 5

.EXAMPLE
  .\measure.ps1 -Runs 5 -Only 'Monghoul|DataGrip' -Json out.json
#>
param(
  [int]$Runs = 5,
  [int]$SettleSeconds = 20,
  # Regex over app names. A whole sweep of six clients takes about 25 minutes, and measuring one
  # client at a time is the normal way to use this.
  [string]$Only = '',
  [string]$Json = '',
  # Remote ports that count as a database connection. The default is the range a local MongoDB or a
  # published container listens on, which is what the connection check is looking for.
  [int[]]$MongoPorts = (27017..27100)
)

$ErrorActionPreference = 'SilentlyContinue'

# Apps to measure.
#
# `Match` is a regex over process names AND `Dir` is the install directory: a process counts only if
# both agree. The match must catch every process the app owns, because an Electron app keeps most of
# its memory in renderers and a GPU process.
#
# `Dir` is also what the disk figure covers, so it is the INSTALL directory and never the settings
# directory. Every one of these apps keeps caches, plugins and indexes somewhere under the user
# profile as well, and that grows with use rather than shipping with the download.
#
# `WindowTitle` is a regex over the main window's title, and it is what separates the real window
# from a splash screen. Leave it out when the app has no splash and no OS-level window title.
$Apps = @(
  @{
    Name        = 'MongoDB Compass'
    Dir         = "$env:LOCALAPPDATA\MongoDBCompass"
    Exe         = "$env:LOCALAPPDATA\MongoDBCompass\app-1.50.0\MongoDBCompass.exe"
    Match       = 'MongoDBCompass'
    WindowTitle = 'MongoDB Compass'
  },
  @{
    Name        = 'Studio 3T'
    Dir         = "${env:ProgramFiles}\3T Software Labs"
    Exe         = "${env:ProgramFiles}\3T Software Labs\Studio 3T\Studio 3T.exe"
    # The process carries the product name, space included. install4j hosts the JVM inside this
    # process rather than spawning java.exe, so there is one process and no helper to catch.
    Match       = '^Studio 3T$'
    WindowTitle = 'Studio 3T for MongoDB'
  },
  @{
    Name        = 'NoSQLBooster'
    Dir         = "$env:LOCALAPPDATA\Programs\nosqlbooster4mongo"
    Exe         = "$env:LOCALAPPDATA\Programs\nosqlbooster4mongo\NoSQLBooster for MongoDB.exe"
    Match       = '^NoSQLBooster for MongoDB$'
    WindowTitle = 'NoSQLBooster for MongoDB'
  },
  @{
    Name        = 'DataGrip'
    Dir         = "${env:ProgramFiles}\JetBrains\DataGrip 2026.2.5"
    Exe         = "${env:ProgramFiles}\JetBrains\DataGrip 2026.2.5\bin\datagrip64.exe"
    # `java` and `jcef_helper` are in the list because the path filter makes them safe: a process
    # counts only when it was launched from the DataGrip directory, so another JVM on the machine
    # is never summed into this figure.
    Match       = '^(datagrip64|datagrip|fsnotifier|jcef_helper|java|WinProcessListHelper)$'
    WindowTitle = 'DataGrip'
  },
  @{
    Name        = 'DbSchema'
    Dir         = "$env:LOCALAPPDATA\Programs\DbSchema"
    Exe         = "$env:LOCALAPPDATA\Programs\DbSchema\DbSchema.exe"
    Match       = '^DbSchema$'
    WindowTitle = '^DbSchema'
  },
  @{
    Name  = 'Monghoul'
    Dir   = "$env:LOCALAPPDATA\Monghoul"
    Exe   = "$env:LOCALAPPDATA\Monghoul\monghoul.exe"
    # Anchored, and NOT a bare `server`. The sidecar really is called server.exe, so an unanchored
    # match caught any process with "server" in its name: on a machine running sqlservr or similar
    # this script would have summed unrelated memory into a published figure, and `Stop-App` would
    # have force-killed it. Matching on the executable's PATH is what makes it safe.
    Match = '^(monghoul|server)$'
    # The WebView2 processes that actually render the interface. They run from the shared runtime
    # under Program Files, so only the command line ties them to this app. The trailing \EBWebView
    # keeps a `com.monghoul.app-dev` instance out of a release measurement.
    CmdMatch = 'com\.monghoul\.app\\EBWebView'
    # No WindowTitle. The window draws its own title bar, so the OS title is empty, and there is no
    # splash screen in front of it.
  }
)

<#
  Every process belonging to the app, identified by its executable PATH and not by its name alone.

  A name match is not safe here: the Monghoul sidecar is literally `server.exe`, and matching that
  loosely reaches other people's software. Filtering on the install directory means a process only
  counts if it was actually launched from the app being measured.
#>
function Get-AppProcess([hashtable]$App) {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessName -match $App.Match -and
      $_.Path -and $_.Path.StartsWith($App.Dir, [StringComparison]::OrdinalIgnoreCase)
    }
}

<#
  Every process the app owns, the ones outside its install directory included.

  This is the set that memory, the process count and the connection check all use. `Get-AppProcess`
  stays the fast path for the window-detection loop, because Win32_Process takes about a second and
  that loop runs every 50 ms.
#>
function Get-AppProcessAll([hashtable]$App) {
  $procs = @(Get-AppProcess $App)
  if ($App.CmdMatch) {
    $extra = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match $App.CmdMatch }
    foreach ($e in $extra) {
      $p = Get-Process -Id $e.ProcessId -ErrorAction SilentlyContinue
      if ($p -and -not ($procs.Id -contains $p.Id)) { $procs += $p }
    }
  }
  $procs
}

function Stop-App([hashtable]$App) {
  Get-AppProcessAll $App | Stop-Process -Force
  Start-Sleep -Seconds 4
}

<#
  Split the app's established TCP connections into database connections and everything else.

  Loopback is kept rather than filtered: a MongoDB container publishes on 127.0.0.1, so dropping
  loopback would hide exactly the connection this check exists to find. The port is what decides,
  not the address.
#>
function Get-AppConnection([hashtable]$App, [int[]]$MongoPorts) {
  $ids = (Get-AppProcessAll $App).Id
  if (-not $ids) { return [PSCustomObject]@{ Mongo = @(); OtherCount = 0 } }
  $established = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
    Where-Object { $ids -contains $_.OwningProcess }
  $mongo = $established | Where-Object { $MongoPorts -contains $_.RemotePort }
  [PSCustomObject]@{
    Mongo      = @($mongo | ForEach-Object { "$($_.RemoteAddress):$($_.RemotePort)" } | Sort-Object -Unique)
    OtherCount = @($established).Count - @($mongo).Count
  }
}

function Get-DiskFootprint([string]$Dir) {
  if (-not (Test-Path $Dir)) { return $null }
  $files = Get-ChildItem $Dir -Recurse -File -ErrorAction SilentlyContinue
  # Files that only ship with a bundled Chromium. Their presence is what makes "it is Electron" a
  # measurement rather than a claim.
  $chromium = ($files | Where-Object {
      $_.Name -match 'libEGL|libGLESv2|d3dcompiler|icudtl|ffmpeg\.dll|chrome_\d+\.pak'
    } | Measure-Object).Count
  # The same test for a bundled Java runtime. `jvm.dll` is the runtime itself, and `modules` is the
  # class library that install4j and the JetBrains runtime both ship beside it.
  $jvm = ($files | Where-Object {
      $_.Name -match '^(jvm\.dll|java\.exe|modules|jrt-fs\.jar)$'
    } | Measure-Object).Count
  [PSCustomObject]@{
    DiskMB            = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 1)
    Files             = $files.Count
    ChromiumArtifacts = $chromium
    JvmArtifacts      = $jvm
  }
}

function Measure-App($App, [int]$Runs, [int]$Settle, [int[]]$MongoPorts) {
  if (-not (Test-Path $App.Exe)) {
    Write-Warning "$($App.Name): not found at $($App.Exe). Adjust the path and rerun."
    return $null
  }

  $disk = Get-DiskFootprint $App.Dir
  $anyTimes = @()
  $mainTimes = @()
  $rams = @()
  $procCount = 0
  $mongoConns = @()
  $otherConns = 0

  for ($i = 0; $i -lt $Runs; $i++) {
    Stop-App $App
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Process $App.Exe | Out-Null

    $anySec = $null
    $mainSec = $null
    while ($sw.Elapsed.TotalSeconds -lt 120 -and ($null -eq $mainSec)) {
      Start-Sleep -Milliseconds 50
      $windows = Get-AppProcess $App | Where-Object { $_.MainWindowHandle -ne 0 }
      if (-not $windows) { continue }

      if ($null -eq $anySec) { $anySec = [math]::Round($sw.Elapsed.TotalSeconds, 3) }

      if (-not $App.WindowTitle) {
        # No splash and no OS title: the first window IS the app's window.
        $mainSec = $anySec
      }
      elseif ($windows | Where-Object { $_.MainWindowTitle -match $App.WindowTitle }) {
        $mainSec = [math]::Round($sw.Elapsed.TotalSeconds, 3)
      }
    }
    $anyTimes += $anySec
    $mainTimes += $mainSec

    Start-Sleep -Seconds $Settle
    $procs = Get-AppProcessAll $App
    $procCount = $procs.Count
    $rams += [math]::Round((($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB), 0)
    $conn = Get-AppConnection $App $MongoPorts
    $mongoConns += $conn.Mongo
    $otherConns = $conn.OtherCount

    Stop-App $App
  }

  $a = $anyTimes | Sort-Object
  $m = $mainTimes | Sort-Object
  $r = $rams | Sort-Object
  [PSCustomObject]@{
    App                = $App.Name
    DiskMB             = $disk.DiskMB
    Files              = $disk.Files
    ChromiumArtifacts  = $disk.ChromiumArtifacts
    JvmArtifacts       = $disk.JvmArtifacts
    Processes          = $procCount
    MedianSecToAnyWindow  = $a[[math]::Floor($a.Count / 2)]
    MedianSecToMainWindow = $m[[math]::Floor($m.Count / 2)]
    AllAnyTimes        = ($anyTimes -join ', ')
    AllMainTimes       = ($mainTimes -join ', ')
    MedianIdleRAM_MB   = $r[[math]::Floor($r.Count / 2)]
    AllRAM             = ($rams -join ', ')
    DbConnections      = (($mongoConns | Sort-Object -Unique) -join ', ')
    OtherConnections   = $otherConns
  }
}

$selected = if ($Only) { $Apps | Where-Object { $_.Name -match $Only } } else { $Apps }
if (-not $selected) { throw "No app matched -Only '$Only'." }

Write-Host "Measuring $Runs runs per app. Each run launches the app and closes it." -ForegroundColor Cyan
Write-Host "Close anything you care about first: this force-stops matching processes.`n"

$results = foreach ($app in $selected) { Measure-App $app $Runs $SettleSeconds $MongoPorts }
$results | Format-List

if ($Json) {
  $results | ConvertTo-Json -Depth 4 | Set-Content -Path $Json -Encoding utf8
  Write-Host "`nWrote $Json"
}

Write-Host "`nTime is to a window, NOT to being ready for a query." -ForegroundColor Yellow
Write-Host "AnyWindow includes a splash screen. MainWindow waits for the app's own window."
Write-Host "Memory is the summed working set of every process the app owns, after the settle window."
Write-Host "A non-empty DbConnections field means the app connected to a database on its own. Its"
Write-Host "memory figure is then not an idle one, and must not be published as one."
