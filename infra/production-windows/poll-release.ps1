[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\WebLens'
$incoming = 'C:\ProgramData\WebLens\incoming'
$releases = Join-Path $root 'releases'
$current = Join-Path $root 'current'
$mutex = [Threading.Mutex]::new($false, 'Global\WebLensReleasePoll')

if (-not $mutex.WaitOne(0)) { return }
try {
    $headers = @{ 'User-Agent' = 'WebLens-Deploy-Poll'; 'Accept' = 'application/vnd.github+json' }
    $published = @(Invoke-RestMethod -Uri 'https://api.github.com/repos/hoangptkd/weblens/releases?per_page=5' -Headers $headers -TimeoutSec 20)
    $latest = $published | Where-Object { $_.tag_name -match '^deploy-[0-9a-f]{40}$' -and -not $_.draft -and -not $_.prerelease } | Select-Object -First 1
    if (-not $latest) { return }

    $commit = $latest.tag_name.Substring(7)
    $target = Join-Path $releases $commit
    if ((Test-Path -LiteralPath $current) -and
        ([IO.Path]::GetFullPath(@((Get-Item -LiteralPath $current).Target)[0]) -eq [IO.Path]::GetFullPath($target))) {
        return
    }

    $filename = "weblens-$commit-windows-amd64.zip"
    $asset = @($latest.assets | Where-Object name -eq $filename)
    if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:[0-9a-f]{64}$' -or
        $asset[0].browser_download_url -ne "https://github.com/hoangptkd/weblens/releases/download/$($latest.tag_name)/$filename") {
        throw 'Deployment release asset is missing or invalid'
    }
    $expectedHash = $asset[0].digest.Substring(7)
    New-Item -ItemType Directory -Force -Path $incoming | Out-Null
    $zip = Join-Path $incoming $filename
    if ((Test-Path -LiteralPath $zip) -and
        (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() -ne $expectedHash) {
        Remove-Item -LiteralPath $zip -Force
    }
    if (-not (Test-Path -LiteralPath $zip)) {
        $download = "$zip.download"
        Invoke-WebRequest -UseBasicParsing -Uri $asset[0].browser_download_url -OutFile $download -TimeoutSec 1800
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant() -ne $expectedHash) {
            Remove-Item -LiteralPath $download -Force
            throw 'Deployment release checksum failed'
        }
        Move-Item -LiteralPath $download -Destination $zip
    }

    & (Join-Path $current 'infra\production-windows\deploy.ps1') -ReleaseZip $zip -Commit $commit -ReleaseSha256 $expectedHash
    Write-Output "WebLens release $commit deployed."
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
