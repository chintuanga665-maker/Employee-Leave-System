$ErrorActionPreference = 'Stop'

# Stop only Node-based web/API servers listening on ELMS' local development ports.
$ports = @(4000) + @(5173..5180)
$connections = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains $_.LocalPort })
$processes = @(Get-CimInstance Win32_Process)
$processById = @{}
foreach ($process in $processes) { $processById[[int]$process.ProcessId] = $process }
$stopIds = [System.Collections.Generic.HashSet[int]]::new()

foreach ($connection in $connections) {
  $ownerId = [int]$connection.OwningProcess
  $owner = $processById[$ownerId]
  if (-not $owner) { continue }

  if ($owner.Name -ne 'node.exe' -or $owner.CommandLine -notmatch '(?i)(vite|server\.js|concurrently|npm-cli\.js)') {
    Write-Warning "Port $($connection.LocalPort) is used by $($owner.Name) (PID $ownerId); leaving it alone."
    continue
  }

  [void]$stopIds.Add($ownerId)
  Write-Host "Stopping ELMS Node server on port $($connection.LocalPort) (PID $ownerId)."

  # Include nearby Node launcher processes so watchers do not restart the same server.
  $parentId = [int]$owner.ParentProcessId
  for ($depth = 0; $depth -lt 4 -and $parentId -gt 0; $depth++) {
    $parent = $processById[$parentId]
    if (-not $parent -or $parent.Name -ne 'node.exe') { break }
    if ($parent.CommandLine -notmatch '(?i)(concurrently|npm-cli\.js|npm run)') { break }
    [void]$stopIds.Add($parentId)
    $parentId = [int]$parent.ParentProcessId
  }
}

if ($stopIds.Count -gt 0) {
  foreach ($processId in $stopIds) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 800
}

$remaining = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains $_.LocalPort })
if ($remaining.Count -gt 0) {
  $remaining | ForEach-Object { Write-Warning "Port $($_.LocalPort) is still busy (PID $($_.OwningProcess))." }
  Write-Error 'Close the listed program or its terminal, then run npm run dev:reset again.'
  exit 1
}

Write-Host 'Starting the current ELMS frontend and API...'
npm run dev
