[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReleaseZip,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{7,40}$')][string]$Commit,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ReleaseSha256
)

$ErrorActionPreference = 'Stop'
$root = 'C:\WebLens'
$releases = Join-Path $root 'releases'
$current = Join-Path $root 'current'
$release = Join-Path $releases $Commit
$serviceNames = 'WebLensCrawler', 'WebLensCapture', 'WebLensBackend', 'WebLensCaddy'
$mutex = [Threading.Mutex]::new($false, 'Global\WebLensDeployment')

function Set-CurrentRelease([string]$Target) {
    $resolvedRoot = [IO.Path]::GetFullPath($releases) + [IO.Path]::DirectorySeparatorChar
    $resolvedTarget = [IO.Path]::GetFullPath($Target)
    if (-not $resolvedTarget.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release target is outside the releases directory'
    }
    if (Test-Path -LiteralPath $current) {
        $currentItem = Get-Item -LiteralPath $current -Force
        if (-not ($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Current release path is not a junction'
        }
        [IO.Directory]::Delete($current)
    }
    New-Item -ItemType Junction -Path $current -Target $resolvedTarget | Out-Null
}

function Wait-Health([string]$Url, [int]$Attempts = 30) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            if ($Url.StartsWith('https://')) {
                & curl.exe --fail --silent --show-error --insecure --max-time 5 $Url --output NUL
                if ($LASTEXITCODE -eq 0) { return }
            } else {
                $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
                if ($response.StatusCode -eq 200) { return }
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw "Health check failed: $Url"
}

if (-not $mutex.WaitOne(0)) { throw 'Another WebLens deployment is running' }
try {
    $actualReleaseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ReleaseZip).Hash
    if ($actualReleaseHash -ne $ReleaseSha256) { throw 'Release archive checksum failed' }
    $previous = $null
    if (Test-Path -LiteralPath $current) { $previous = (Get-Item -LiteralPath $current).Target }
    if (-not (Test-Path -LiteralPath $release)) {
        New-Item -ItemType Directory -Force -Path $release | Out-Null
        Expand-Archive -LiteralPath $ReleaseZip -DestinationPath $release
    }
    $stopOrder = @($serviceNames)
    [array]::Reverse($stopOrder)
    foreach ($name in $stopOrder) { Stop-Service -Name $name -Force -ErrorAction SilentlyContinue }
    Set-CurrentRelease $release

    try {
        & (Join-Path $current 'infra\production-windows\run-service.ps1') 'crawler-migrate-postgres'
        if ($LASTEXITCODE -ne 0) { throw 'Crawler PostgreSQL migration failed' }
        foreach ($name in $serviceNames) { Start-Service -Name $name }
        Wait-Health 'http://127.0.0.1:8081/health/ready' 90
        Wait-Health 'http://127.0.0.1:8082/health/ready' 90
        Wait-Health 'http://127.0.0.1:8080/actuator/health' 90
        Wait-Health 'https://127.0.0.1/'
    } catch {
        foreach ($name in $stopOrder) { Stop-Service -Name $name -Force -ErrorAction SilentlyContinue }
        if ($previous -and (Test-Path -LiteralPath $previous)) {
            Set-CurrentRelease $previous
            foreach ($name in $serviceNames) { Start-Service -Name $name -ErrorAction SilentlyContinue }
        }
        throw
    }

    $keep = @($release)
    if ($previous -and $previous -ne $release) { $keep += $previous }
    Get-ChildItem -LiteralPath $releases -Directory | Where-Object { $_.FullName -notin $keep } | ForEach-Object {
        $resolved = [IO.Path]::GetFullPath($_.FullName)
        if ($resolved.StartsWith(([IO.Path]::GetFullPath($releases) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
            try {
                Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
            } catch {
                Write-Warning "Old release cleanup is deferred: $resolved"
            }
        }
    }
    Write-Output "WebLens release $Commit is healthy."
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
