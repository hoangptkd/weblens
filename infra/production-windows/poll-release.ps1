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
    $published = Invoke-RestMethod -Uri 'https://api.github.com/repos/hoangptkd/weblens/releases?per_page=5' -Headers $headers -TimeoutSec 20
    $latest = $published |
        Where-Object { $_.tag_name -match '^deploy-[0-9a-f]{40}$' -and -not $_.draft -and -not $_.prerelease } |
        Sort-Object -Property published_at -Descending |
        Select-Object -First 1
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
        $asset[0].size -le 0 -or $asset[0].size -gt 2147483648 -or
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
        $part = "$zip.part"
        $writer = [IO.File]::Open($download, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            for ([long]$start = 0; $start -lt $asset[0].size; $start += 1MB) {
                $end = [long][math]::Min($start + 1MB - 1, $asset[0].size - 1)
                $complete = $false
                for ($attempt = 1; $attempt -le 5; $attempt++) {
                    $status = & curl.exe --fail --location --retry 2 --silent --show-error --max-time 20 --range "$start-$end" --max-filesize ($end - $start + 1) --output $part --write-out '%{http_code}' $asset[0].browser_download_url
                    if ($LASTEXITCODE -eq 0 -and $status.Trim() -eq '206' -and
                        (Get-Item -LiteralPath $part).Length -eq ($end - $start + 1)) {
                        $complete = $true
                        break
                    }
                    Start-Sleep -Seconds 2
                }
                if (-not $complete) { throw 'Deployment release range download failed' }
                $reader = [IO.File]::OpenRead($part)
                try { $reader.CopyTo($writer) } finally { $reader.Dispose() }
                Remove-Item -LiteralPath $part -Force
            }
        } finally { $writer.Dispose() }
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
