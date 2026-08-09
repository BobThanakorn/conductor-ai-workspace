[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 240,
  [switch]$SkipBuild,
  [string]$ProjectName = "conductor-fresh-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) $ProjectName
$compose = @("compose", "-p", $ProjectName, "--project-directory", $root, "--env-file", (Join-Path $scratch "fresh.env"), "--profile", "minimal", "-f", (Join-Path $root "compose.yaml"))

New-Item -ItemType Directory -Force -Path $scratch | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $scratch "openai-api-key") | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $scratch "azure-api-key") | Out-Null
@"
CONDUCTOR_IMAGE=conductor-ai-workspace:0.1.0
CONDUCTOR_LANGGRAPH_IMAGE=conductor-langgraph-agent:0.1.0
CONDUCTOR_WEB_PORT=0
CONDUCTOR_COMPANION_PORT=0
CONDUCTOR_LANGGRAPH_COMPANION_PORT=0
OPENAI_API_KEY_FILE=$($scratch.Replace('\', '/'))/openai-api-key
AZURE_AI_FOUNDRY_API_KEY_FILE=$($scratch.Replace('\', '/'))/azure-api-key
AZURE_AI_FOUNDRY_API_KEY=
AZURE_AI_FOUNDRY_ENDPOINT=
AZURE_AI_FOUNDRY_MODEL=
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_AGENT_MODEL=
OPENAI_MODEL=
VLLM_BASE_URL=
VLLM_API_KEY=
CONDUCTOR_MODEL_OPTIONS=
"@ | Set-Content -NoNewline -Path (Join-Path $scratch "fresh.env")

function Invoke-Compose([string[]]$Arguments) {
  & docker @($compose + $Arguments)
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed: $($Arguments -join ' ')" }
}

try {
  Invoke-Compose @("config", "--quiet")
  $upArguments = @("up", "--wait", "--wait-timeout", "$TimeoutSeconds", "-d")
  if (-not $SkipBuild) { $upArguments = @("up", "--build", "--wait", "--wait-timeout", "$TimeoutSeconds", "-d") }
  Invoke-Compose $upArguments

  $webId = (& docker @($compose + @("ps", "-q", "web"))).Trim()
  if (-not $webId) { throw "Fresh-machine smoke did not start web." }
  $port = (& docker port $webId "3000/tcp" | Select-Object -First 1)
  if ($port -notmatch ":(\d+)$") { throw "Unable to resolve the published web port." }
  $webPort = $Matches[1]
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastWebError = ""
  $portalReady = $false
  do {
    try {
      $portal = Invoke-WebRequest -SkipHttpErrorCheck -TimeoutSec 5 -Uri "http://127.0.0.1:$webPort/portal"
      if ($portal.StatusCode -eq 200) { $portalReady = $true; break }
      $lastWebError = "Portal returned HTTP $($portal.StatusCode)."
    } catch { $lastWebError = $_.Exception.Message }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  if (-not $portalReady) {
    & docker @($compose + @("logs", "--tail", "100", "web")) | Out-Host
    throw "Web portal never became ready at http://127.0.0.1:$webPort/portal. Last error: $lastWebError"
  }
  $modelsResponse = Invoke-WebRequest -SkipHttpErrorCheck -TimeoutSec 10 -Uri "http://127.0.0.1:$webPort/api/models"
  if ($modelsResponse.StatusCode -eq 200) {
    $models = $modelsResponse.Content | ConvertFrom-Json
  } elseif ($modelsResponse.StatusCode -eq 503) {
    $providerError = $modelsResponse.Content | ConvertFrom-Json
    if ($providerError.error.code -ne "agent_provider_unconfigured") {
      throw "Provider-unavailable API response has unexpected error code: $($providerError.error.code)"
    }
    $models = $null
  } else {
    throw "Models API returned unexpected HTTP status: $($modelsResponse.StatusCode)"
  }
  if ($models -and @($models.modelStatus.PSObject.Properties | Where-Object { $_.Value -eq "ready" }).Count -ne 0) {
    throw "Fresh-machine smoke unexpectedly reports a ready provider without runtime credentials."
  }
  foreach ($service in @("web", "companion", "companion-langgraph", "agent-langgraph")) {
    $id = (& docker @($compose + @("ps", "-q", $service))).Trim()
    if (-not $id) { throw "Missing required minimal-profile service: $service" }
    $user = (& docker inspect --format '{{.Config.User}}' $id).Trim()
    if (-not $user -or $user -match '^(?:0|root)(?::0)?$') { throw "$service is not running as a non-root user." }
  }
  [pscustomobject]@{ project = $ProjectName; webPort = $webPort; providersReady = 0; providerUnavailable = (-not $models); result = "passed" } | ConvertTo-Json -Compress
} finally {
  & docker @($compose + @("down", "--volumes", "--remove-orphans")) | Out-Host
  Remove-Item -LiteralPath $scratch -Force -Recurse -ErrorAction SilentlyContinue
}
