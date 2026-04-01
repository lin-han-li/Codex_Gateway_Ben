param(
  [switch]$PushBranch,
  [switch]$CreateReleaseTag,
  [string]$Tag,
  [switch]$SkipChecks,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string[]]$Command
  )

  $rendered = ($Command | ForEach-Object {
      if ($_ -match "\s") { '"' + $_ + '"' } else { $_ }
    }) -join " "
  Write-Host "==> $Label" -ForegroundColor Cyan
  Write-Host "    $rendered" -ForegroundColor DarkGray

  if ($DryRun) {
    return
  }

  $commandArgs = if ($Command.Length -gt 1) { @($Command[1..($Command.Length - 1)]) } else { @() }
  & $Command[0] @commandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

function Get-GitOutput {
  param([Parameter(Mandatory = $true)][string[]]$Command)
  $output = & git @Command
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Command -join ' ') failed with exit code $LASTEXITCODE"
  }
  return ($output | Out-String).Trim()
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$package = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "Unable to read version from package.json"
}

$branch = Get-GitOutput @("branch", "--show-current")
$remoteUrl = Get-GitOutput @("remote", "get-url", "origin")
$defaultTag = "v$version"
$releaseTag = if ([string]::IsNullOrWhiteSpace($Tag)) { $defaultTag } else { $Tag.Trim() }

if ($CreateReleaseTag -and $releaseTag -ne $defaultTag) {
  throw "Release tag $releaseTag does not match package.json version $version. Expected $defaultTag."
}

$githubActionsUrl = $null
if ($remoteUrl -match '^https://github\.com/(?<slug>[^/]+/[^/.]+)(?:\.git)?$') {
  $githubActionsUrl = "https://github.com/$($matches.slug)/actions/workflows/build-desktop.yml"
}

Write-Host ""
Write-Host "Codex Gateway cross-platform release helper" -ForegroundColor Green
Write-Host "Repository : $repoRoot"
Write-Host "Branch     : $branch"
Write-Host "Version    : $version"
Write-Host "Origin     : $remoteUrl"
if ($githubActionsUrl) {
  Write-Host "Actions    : $githubActionsUrl"
}
Write-Host ""

if (-not $SkipChecks) {
  Invoke-Step "Version sync check" @("node", "scripts/assert-release-version-sync.mjs")
  Invoke-Step "Release gate" @("bun", "run", "gate:release")
}

if ($PushBranch) {
  Invoke-Step "Push current branch" @("git", "push", "origin", "HEAD")
}

if ($CreateReleaseTag) {
  $localTag = & git tag --list $releaseTag
  if ($LASTEXITCODE -ne 0) {
    throw "git tag --list failed with exit code $LASTEXITCODE"
  }
  if (-not [string]::IsNullOrWhiteSpace(($localTag | Out-String).Trim())) {
    Write-Host "Tag $releaseTag already exists locally. Skipping local tag creation." -ForegroundColor Yellow
  } else {
    Invoke-Step "Create local release tag" @("git", "tag", $releaseTag)
  }
  Invoke-Step "Push release tag" @("git", "push", "origin", $releaseTag)
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
if (-not $PushBranch -and -not $CreateReleaseTag) {
  Write-Host "No remote actions were triggered. Re-run with -PushBranch and/or -CreateReleaseTag when you're ready." -ForegroundColor Yellow
}
if ($githubActionsUrl) {
  Write-Host "Open GitHub Actions: $githubActionsUrl"
}
Write-Host "Tag to use for release builds: $releaseTag"
