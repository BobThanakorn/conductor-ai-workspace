[CmdletBinding()]
param(
  [string]$OutputDirectory = "artifacts/container-evidence",
  [string[]]$Images,
  [switch]$AggregateOnly
)

$ErrorActionPreference = "Stop"
$expectedImages = @(
  "conductor-ai-workspace:0.1.0",
  "conductor-langgraph-agent:0.1.0",
  "conductor-mcp-gateway:2026.08.09",
  "conductor-agent-pydanticai:0.1.0",
  "conductor-agent-microsoft-framework:0.1.0",
  "conductor-agent-crewai:0.1.0",
  "conductor-agent-llamaindex:0.1.0",
  "conductor-agent-haystack:0.1.0",
  "conductor-agent-semantic-kernel:0.1.0"
)
$selectedImages = if ($Images -and $Images.Count -gt 0) { @($Images) } else { $expectedImages }
$unknownImages = @($selectedImages | Where-Object { $_ -notin $expectedImages })
if ($unknownImages.Count -gt 0) {
  throw "Unsupported image(s): $($unknownImages -join ', ')"
}

$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root $OutputDirectory
New-Item -ItemType Directory -Force -Path $output | Out-Null

function Get-EvidencePaths([string]$Image) {
  $safe = $Image -replace '[^A-Za-z0-9._-]', '_'
  return @{
    inspect = Join-Path $output "$safe.inspect.json"
    history = Join-Path $output "$safe.history.txt"
    sbom = Join-Path $output "$safe.sbom.spdx.json"
    vulnerabilities = Join-Path $output "$safe.vulnerabilities.sarif"
  }
}

function Test-ImageEvidence([string]$Image) {
  $paths = Get-EvidencePaths $Image
  foreach ($path in $paths.Values) {
    if (-not (Test-Path $path) -or (Get-Item $path).Length -eq 0) {
      throw "missing or empty $path"
    }
  }

  $savedInspect = Get-Content -Raw $paths.inspect | ConvertFrom-Json
  $savedId = @($savedInspect)[0].Id
  $currentId = (& docker image inspect --format '{{.Id}}' $Image 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $currentId) { throw "image inspect failed" }
  if ($savedId -ne $currentId) { throw "evidence image ID $savedId does not match current image ID $currentId" }

  $sourceDigest = $null
  if ($Image -eq "conductor-ai-workspace:0.1.0") {
    $sourceDigest = (& node (Join-Path $root "scripts/source-digest.mjs") $root).Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceDigest -notmatch '^[a-f0-9]{64}$') { throw "host source digest failed" }
    $imageSourceDigest = (& docker run --rm --network none --entrypoint cat $Image /app/.conductor-source-digest 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or $imageSourceDigest -notmatch '^[a-f0-9]{64}$') { throw "image source digest is missing" }
    if ($sourceDigest -ne $imageSourceDigest) { throw "image source digest $imageSourceDigest does not match reviewed source digest $sourceDigest" }
  }

  $user = (& docker image inspect --format '{{.Config.User}}' $Image 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $user -or $user -match '^(?:0|root)(?::0)?$') {
    throw "root/default user"
  }
  $history = Get-Content -Raw $paths.history
  if ($history -match '(?i)(private[_-]?key|api[_-]?key|password|bearer\s+[A-Za-z0-9])') {
    throw "secret marker in history"
  }
  (Get-Content -Raw $paths.sbom | ConvertFrom-Json) | Out-Null
  (Get-Content -Raw $paths.vulnerabilities | ConvertFrom-Json) | Out-Null

  return [pscustomobject]@{
    image = $Image
    imageId = $currentId
    status = "passed"
    user = $user
    inspect = "produced"
    history = "produced"
    sbom = "produced"
    vulnerabilities = "produced"
    sourceDigest = $sourceDigest
  }
}

if (-not $AggregateOnly) {
  foreach ($image in $selectedImages) {
    $paths = Get-EvidencePaths $image
    Remove-Item -Force -ErrorAction SilentlyContinue $paths.inspect,$paths.history,$paths.sbom,$paths.vulnerabilities
    $cache = Join-Path ([System.IO.Path]::GetTempPath()) "conductor-scout-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $cache | Out-Null
    $previousCache = $env:DOCKER_SCOUT_CACHE_DIR
    try {
      $env:DOCKER_SCOUT_CACHE_DIR = $cache
      $inspect = & docker image inspect $image 2>$null
      if ($LASTEXITCODE -ne 0) { throw "image inspect failed" }
      $inspect | Set-Content $paths.inspect
      $history = & docker history --no-trunc $image
      if ($LASTEXITCODE -ne 0) { throw "history failed" }
      $history | Set-Content $paths.history
      & docker scout sbom "local://$image" --format spdx --output $paths.sbom
      if ($LASTEXITCODE -ne 0) { throw "Scout SBOM failed (exit $LASTEXITCODE)" }
      & docker scout cves "local://$image" --format sarif --output $paths.vulnerabilities
      if ($LASTEXITCODE -ne 0) { throw "Scout CVE failed (exit $LASTEXITCODE)" }
      Test-ImageEvidence $image | Out-Null
    } finally {
      if ($previousCache) { $env:DOCKER_SCOUT_CACHE_DIR = $previousCache } else { Remove-Item Env:DOCKER_SCOUT_CACHE_DIR -ErrorAction SilentlyContinue }
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $cache
    }
  }
}

if ($Images -and $Images.Count -gt 0 -and -not $AggregateOnly) {
  $partialStatuses = @($selectedImages | ForEach-Object { Test-ImageEvidence $_ })
  @{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    images = $partialStatuses
    complete = $true
    scope = "selected-images"
  } | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $output 'partial-summary.json')
  return
}

$statuses = @()
$failed = $false
foreach ($image in $expectedImages) {
  try {
    $statuses += Test-ImageEvidence $image
  } catch {
    $statuses += [pscustomobject]@{ image = $image; status = "failed"; error = $_.Exception.Message }
    $failed = $true
  }
}

$summary = @{
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  images = $statuses
  complete = ($statuses.Count -eq $expectedImages.Count -and -not $failed)
}
$summary | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $output 'summary.json')
if ($failed -or $statuses.Count -ne $expectedImages.Count) {
  throw "Container evidence is incomplete; inspect summary.json for all image statuses."
}
