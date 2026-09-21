[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{7,40}$')][string]$Commit,
    [string]$OutputDirectory = "$PSScriptRoot\..\..\artifacts"
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$staging = Join-Path ([IO.Path]::GetTempPath()) "weblens-$Commit"
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging, $output, (Join-Path $staging 'backend'), (Join-Path $staging 'crawler'), (Join-Path $staging 'capture-worker'), (Join-Path $staging 'frontend'), (Join-Path $staging 'infra\production-windows') | Out-Null

Copy-Item -LiteralPath (Get-ChildItem -LiteralPath (Join-Path $repository 'backend\target') -Filter '*.jar' | Where-Object Name -NotMatch '\.original$' | Select-Object -First 1).FullName -Destination (Join-Path $staging 'backend\weblens-backend.jar')
Copy-Item -LiteralPath (Join-Path $repository 'crawler\weblens-crawler.exe') -Destination (Join-Path $staging 'crawler\weblens-crawler.exe')
Copy-Item -LiteralPath (Join-Path $repository 'capture-worker\dist') -Destination (Join-Path $staging 'capture-worker\dist') -Recurse
Copy-Item -LiteralPath (Join-Path $repository 'capture-worker\migrations') -Destination (Join-Path $staging 'capture-worker\migrations') -Recurse
Copy-Item -LiteralPath (Join-Path $repository 'capture-worker\node_modules') -Destination (Join-Path $staging 'capture-worker\node_modules') -Recurse
Copy-Item -LiteralPath (Join-Path $repository 'capture-worker\package.json') -Destination (Join-Path $staging 'capture-worker\package.json')
Copy-Item -Path (Join-Path $repository 'frontend\dist\*') -Destination (Join-Path $staging 'frontend') -Recurse
Copy-Item -Path (Join-Path $repository 'infra\production-windows\*') -Destination (Join-Path $staging 'infra\production-windows') -Recurse

@{ commit = $Commit; createdAt = [DateTime]::UtcNow.ToString('O'); platform = 'windows-amd64' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging 'release.json') -Encoding UTF8
Push-Location $staging
try {
    Get-ChildItem -File -Recurse | Where-Object Name -ne 'SHA256SUMS' | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
        "$hash  $relative"
    } | Set-Content -LiteralPath 'SHA256SUMS' -Encoding ascii
} finally { Pop-Location }

$zip = Join-Path $output "weblens-$Commit-windows-amd64.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal
Write-Output $zip
