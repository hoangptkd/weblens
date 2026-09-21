[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\WebLens'
$programData = 'C:\ProgramData\WebLens'
$runtime = Join-Path $root 'runtime'
$services = Join-Path $programData 'services'
$downloads = Join-Path $programData 'downloads'

function Install-ZipRuntime {
    param([string]$Uri, [string]$Sha256, [string]$Destination, [string]$ArchiveName)
    if (Test-Path -LiteralPath $Destination) { return }
    $archive = Join-Path $downloads $ArchiveName
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $archive
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { throw "Checksum mismatch for $ArchiveName" }
    $expanded = Join-Path $downloads ([IO.Path]::GetFileNameWithoutExtension($ArchiveName))
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
    $children = @(Get-ChildItem -LiteralPath $expanded)
    $source = if ($children.Count -eq 1 -and $children[0].PSIsContainer) { $children[0].FullName } else { $expanded }
    Move-Item -LiteralPath $source -Destination $Destination
}

New-Item -ItemType Directory -Force -Path $root, (Join-Path $root 'releases'), $runtime, $programData, $services, $downloads, (Join-Path $programData 'logs'), (Join-Path $programData 'incoming'), (Join-Path $programData 'caddy') | Out-Null

Install-ZipRuntime -Uri 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip' -Sha256 '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97' -Destination (Join-Path $runtime 'node22') -ArchiveName 'node-v22.23.2-win-x64.zip'
Install-ZipRuntime -Uri 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip' -Sha256 'd35f31e712f0fcf6ac5a093edc90204fbff22f720ba3950bd09d331d5e621636' -Destination (Join-Path $runtime 'jre21') -ArchiveName 'temurin-jre21.zip'
Install-ZipRuntime -Uri 'https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_windows_amd64.zip' -Sha256 '1708333f79e274c7697285afe6d592ab39314e0b131e9ec6bea08ad27df62ebf' -Destination (Join-Path $runtime 'caddy') -ArchiveName 'caddy-2.11.4.zip'

$winsw = Join-Path $runtime 'winsw.exe'
if (-not (Test-Path -LiteralPath $winsw)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile $winsw
}

$serviceNames = 'WebLensBackend', 'WebLensCrawler', 'WebLensCapture', 'WebLensCaddy'
foreach ($serviceName in $serviceNames) {
    $wrapper = Join-Path $services "$serviceName.exe"
    Copy-Item -LiteralPath $winsw -Destination $wrapper -Force
    Copy-Item -LiteralPath (Join-Path 'C:\WebLens\current\infra\production-windows' "$serviceName.xml") -Destination (Join-Path $services "$serviceName.xml") -Force
    if (-not (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
        & $wrapper install
        if ($LASTEXITCODE -ne 0) { throw "Could not install $serviceName" }
    }
    & sc.exe config $serviceName obj= "NT SERVICE\$serviceName"
    if ($LASTEXITCODE -ne 0) { throw "Could not assign virtual account to $serviceName" }
}

& icacls.exe $programData '/inheritance:r' '/grant:r' 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F'
foreach ($serviceName in $serviceNames) {
    & icacls.exe $programData '/grant' "NT SERVICE\${serviceName}:(OI)(CI)RX"
    & icacls.exe (Join-Path $programData 'logs') '/grant' "NT SERVICE\${serviceName}:(OI)(CI)M"
    & icacls.exe (Join-Path $programData 'weblens.env') '/grant' "NT SERVICE\${serviceName}:R"
}
& icacls.exe (Join-Path $programData 'caddy') '/grant' 'NT SERVICE\WebLensCaddy:(OI)(CI)M'

Write-Output 'WebLens Windows runtime and services are installed.'
