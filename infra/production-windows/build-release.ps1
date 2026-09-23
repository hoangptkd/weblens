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
Copy-Item -LiteralPath (Join-Path $repository 'capture-worker\THIRD_PARTY_NOTICES.md') -Destination (Join-Path $staging 'capture-worker\THIRD_PARTY_NOTICES.md')
$camoufoxVersion = '152.0.4'
$camoufoxRelease = 'beta.28'
$camoufoxArchive = Join-Path $staging 'camoufox-win.x86_64.zip'
$camoufoxDestination = Join-Path $staging 'capture-worker\camoufox'
$camoufoxUrl = "https://github.com/daijro/camoufox/releases/download/v$camoufoxVersion-$camoufoxRelease/camoufox-$camoufoxVersion-$camoufoxRelease-win.x86_64.zip"
& curl.exe '--fail' '--location' '--retry' '3' '--output' $camoufoxArchive $camoufoxUrl
if ($LASTEXITCODE -ne 0) { throw 'Camoufox release download failed' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $camoufoxArchive).Hash -ne '386fc2f41139685f9a1a9cef0d024bc041d899c315ea538d561171b5b282e57d') {
    throw 'Camoufox release checksum failed'
}
Expand-Archive -LiteralPath $camoufoxArchive -DestinationPath $camoufoxDestination
Remove-Item -LiteralPath $camoufoxArchive
if (-not (Test-Path -LiteralPath (Join-Path $camoufoxDestination 'camoufox.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $camoufoxDestination 'properties.json') -PathType Leaf)) {
    throw 'Camoufox release is incomplete'
}
@{ version = $camoufoxVersion; release = $camoufoxRelease } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $camoufoxDestination 'version.json') -Encoding ascii
$previousInstallDir = $env:CAMOUFOX_INSTALL_DIR
$previousSmoke = $env:WEBLENS_BROWSER_SMOKE
try {
    $env:CAMOUFOX_INSTALL_DIR = $camoufoxDestination
    $env:WEBLENS_BROWSER_SMOKE = 'true'
    Push-Location (Join-Path $repository 'capture-worker')
    try {
        & node.exe '--test' '--test-name-pattern=browser smoke: engine=camoufox, headless=true' 'dist\browser.test.js'
        if ($LASTEXITCODE -ne 0) { throw 'Windows Camoufox browser smoke failed' }
    } finally { Pop-Location }
} finally {
    $env:CAMOUFOX_INSTALL_DIR = $previousInstallDir
    $env:WEBLENS_BROWSER_SMOKE = $previousSmoke
}
$runtime = @{
    nodeModulesLockSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $staging 'capture-worker\node_modules\.package-lock.json')).Hash.ToLowerInvariant()
    camoufoxExeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $camoufoxDestination 'camoufox.exe')).Hash.ToLowerInvariant()
}
$runtime | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $staging 'capture-worker\runtime.json') -Encoding ascii
Remove-Item -LiteralPath (Join-Path $staging 'capture-worker\node_modules'), $camoufoxDestination -Recurse -Force
$loopbackApi = Get-ChildItem -LiteralPath (Join-Path $repository 'frontend\dist\assets') -Filter '*.js' |
    Select-String -SimpleMatch 'http://localhost:8080', 'http://127.0.0.1:8080' |
    Select-Object -First 1
if ($loopbackApi) { throw 'Frontend production bundle contains a loopback API URL' }
Copy-Item -Path (Join-Path $repository 'frontend\dist\*') -Destination (Join-Path $staging 'frontend') -Recurse
Copy-Item -Path (Join-Path $repository 'infra\production-windows\*') -Destination (Join-Path $staging 'infra\production-windows') -Recurse

@{ commit = $Commit } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $staging 'frontend\release.json') -Encoding ascii
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
