[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('backend', 'crawler', 'crawler-migrate-postgres', 'capture', 'caddy')]
    [string]$Service
)

$ErrorActionPreference = 'Stop'
$root = 'C:\WebLens'
$current = Join-Path $root 'current'
$environmentFile = 'C:\ProgramData\WebLens\weblens.env'

if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw "Missing production environment file: $environmentFile"
}

foreach ($line in Get-Content -LiteralPath $environmentFile) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { throw 'Invalid line in production environment file' }
    [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1), 'Process')
}

switch ($Service) {
    'backend' {
        Set-Location (Join-Path $current 'backend')
        & (Join-Path $root 'runtime\jre21\bin\java.exe') '-Xms256m' '-Xmx1280m' '-jar' 'weblens-backend.jar'
    }
    'crawler' {
        Set-Location (Join-Path $current 'crawler')
        & '.\weblens-crawler.exe'
    }
    'crawler-migrate-postgres' {
        Set-Location (Join-Path $current 'crawler')
        & '.\weblens-crawler.exe' 'migrate-postgres'
    }
    'capture' {
        Set-Location (Join-Path $current 'capture-worker')
        & (Join-Path $root 'runtime\node22\node.exe') 'dist\index.js'
    }
    'caddy' {
        $env:XDG_DATA_HOME = 'C:\ProgramData\WebLens\caddy\data'
        $env:XDG_CONFIG_HOME = 'C:\ProgramData\WebLens\caddy\config'
        Set-Location (Join-Path $current 'infra\production-windows')
        & (Join-Path $root 'runtime\caddy\caddy.exe') 'run' '--config' 'Caddyfile' '--adapter' 'caddyfile'
    }
}

exit $LASTEXITCODE
